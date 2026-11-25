// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Rate limiter reads remote socket IPs and fixed wall-clock bucket windows.
import type * as NodeHttp from "node:http";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayConfig } from "../config.ts";

interface BucketState {
  readonly count: number;
  readonly resetAtMs: number;
}

const MAX_BUCKETS = 10_000;

export function extractClientIp(req: NodeHttp.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const firstXff = typeof xff === "string" ? xff.split(",")[0]?.trim() : undefined;
    if (firstXff && firstXff.length > 0) {
      return firstXff;
    }
    const xReal = req.headers["x-real-ip"];
    if (typeof xReal === "string" && xReal.trim().length > 0) {
      return xReal.trim();
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

class SlidingFixedCounter {
  private readonly buckets = new Map<string, BucketState>();

  allow(
    key: string,
    limit: number,
    windowMs: number,
    nowMs = Date.now(),
  ): {
    readonly allowed: boolean;
    readonly retryAfterSeconds: number;
  } {
    if (this.buckets.size >= MAX_BUCKETS) {
      this.evictExpired(nowMs);
    }
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAtMs <= nowMs) {
      this.buckets.set(key, { count: 1, resetAtMs: nowMs + windowMs });
      return { allowed: true, retryAfterSeconds: Math.ceil(windowMs / 1_000) };
    }
    if (existing.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1_000)),
      };
    }
    this.buckets.set(key, { count: existing.count + 1, resetAtMs: existing.resetAtMs });
    return { allowed: true, retryAfterSeconds: 1 };
  }

  private evictExpired(nowMs: number): void {
    for (const [key, value] of this.buckets.entries()) {
      if (value.resetAtMs <= nowMs) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size >= MAX_BUCKETS) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey !== undefined) {
        this.buckets.delete(oldestKey);
      }
    }
  }
}

export class RelayRateLimiter extends Context.Service<
  RelayRateLimiter,
  {
    readonly allowAuth: (clientKey: string) => {
      readonly allowed: boolean;
      readonly retryAfterSeconds: number;
    };
    readonly allowDpop: (clientKey: string) => {
      readonly allowed: boolean;
      readonly retryAfterSeconds: number;
    };
    readonly allowProxy: (clientKey: string) => {
      readonly allowed: boolean;
      readonly retryAfterSeconds: number;
    };
  }
>()("agent-vela-relay/http/rateLimit/RelayRateLimiter") {}

export const layerRelayRateLimiter = Layer.effect(
  RelayRateLimiter,
  Effect.gen(function* () {
    const config = yield* RelayConfig;
    const authCounter = new SlidingFixedCounter();
    const dpopCounter = new SlidingFixedCounter();
    const proxyCounter = new SlidingFixedCounter();
    const loginWindowMs = config.rateLimit.loginWindowSeconds * 1_000;

    return RelayRateLimiter.of({
      allowAuth: (key) => authCounter.allow(key, config.rateLimit.loginMaxAttempts, loginWindowMs),
      allowDpop: (key) => dpopCounter.allow(key, config.rateLimit.dpopMaxAttempts, 60_000),
      allowProxy: (key) => proxyCounter.allow(key, config.rateLimit.proxyMaxRequests, 60_000),
    });
  }),
);
