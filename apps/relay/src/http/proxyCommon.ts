// @effect-diagnostics nodeBuiltinImport:off -- Shared Node HTTP response piping for reverse proxy and hook handlers.
import type * as NodeHttp from "node:http";

import { RelayEndpointKey, type TunnelHttpHeader } from "@t3tools/contracts/agentVelaRelay";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { WebSocketServer } from "ws";

import type { AuthService } from "../auth/AuthService.ts";
import type { ResolvedRelayConfig } from "../config.ts";
import type { EnvironmentService } from "../environments/EnvironmentService.ts";
import type { TunnelHttpStreamResponse } from "../tunnel/codec.ts";
import type { TunnelHub } from "../tunnel/TunnelHub.ts";
import type { RelayRateLimiter } from "./rateLimit.ts";

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const STRIPPED_PROXY_PREFIXES = ["proxy-", "cf-", "x-forwarded-", "x-b3-"];

const decodeEndpointKey = Schema.decodeUnknownSync(RelayEndpointKey);

export interface RelayProxyDeps {
  readonly config: ResolvedRelayConfig;
  readonly auth: typeof AuthService.Service;
  readonly environments: typeof EnvironmentService.Service;
  readonly tunnelHub: typeof TunnelHub.Service;
  readonly rateLimiter: typeof RelayRateLimiter.Service;
  readonly proxyWss: WebSocketServer;
  readonly tunnelWss: WebSocketServer;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

export function parseEndpointKeySafe(rawKey: string): RelayEndpointKey | null {
  try {
    return decodeEndpointKey(rawKey);
  } catch {
    return null;
  }
}

export function parseEndpointProxyTarget(rawUrl: string): {
  readonly endpointKey: RelayEndpointKey;
  readonly targetPath: string;
  readonly pathPrefix: string;
} | null {
  const queryIndex = rawUrl.indexOf("?");
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : rawUrl.slice(queryIndex);
  if (pathname !== "/e" && !pathname.startsWith("/e/")) {
    return null;
  }
  const rest = pathname.slice("/e/".length);
  if (rest.length === 0) {
    return null;
  }
  const slashIndex = rest.indexOf("/");
  const rawKey = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  const innerPath = slashIndex === -1 ? "/" : rest.slice(slashIndex);
  const endpointKey = parseEndpointKeySafe(rawKey);
  if (!endpointKey) {
    return null;
  }
  return {
    endpointKey,
    targetPath: `${innerPath || "/"}${search}`,
    pathPrefix: `/e/${endpointKey}`,
  };
}

export function sanitizeHeadersForTunnel(
  incoming: NodeHttp.IncomingHttpHeaders,
  dropSet: ReadonlySet<string>,
): Array<TunnelHttpHeader> {
  const connectionRaw = typeof incoming.connection === "string" ? incoming.connection : "";
  const nominated = new Set(
    connectionRaw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers: Array<TunnelHttpHeader> = [];
  for (const [name, rawVal] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      dropSet.has(lower) ||
      nominated.has(lower) ||
      STRIPPED_PROXY_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
      rawVal === undefined
    ) {
      continue;
    }
    if (Array.isArray(rawVal)) {
      for (const value of rawVal) {
        headers.push([lower, value]);
      }
    } else {
      headers.push([lower, rawVal]);
    }
  }
  return headers;
}

export function sendJsonError(
  res: NodeHttp.ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

export async function pipeTunnelHttpResponse(
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  tunnelRes: TunnelHttpStreamResponse,
  extraHeaders?: Record<string, string>,
): Promise<void> {
  const grouped = new Map<string, string | Array<string>>();
  for (const [name, value] of tunnelRes.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "content-length") {
      continue;
    }
    const existing = grouped.get(lower);
    if (existing === undefined) {
      grouped.set(lower, value);
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      grouped.set(lower, [existing, value]);
    }
  }
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      grouped.set(key.toLowerCase(), value);
    }
  }
  const outgoing: Record<string, string | Array<string>> = {};
  for (const [key, value] of grouped.entries()) {
    outgoing[key] = value;
  }
  res.writeHead(tunnelRes.status, outgoing);
  if ((req.method ?? "GET").toUpperCase() === "HEAD") {
    tunnelRes.abort();
    res.end();
    return;
  }
  try {
    for await (const chunk of tunnelRes.body) {
      if (res.writableEnded || res.destroyed) {
        tunnelRes.abort();
        break;
      }
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          const onDone = () => {
            res.off("drain", onDone);
            res.off("close", onDone);
            resolve();
          };
          res.once("drain", onDone);
          res.once("close", onDone);
        });
      }
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } catch {
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}
