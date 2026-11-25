// @effect-diagnostics nodeBuiltinImport:off -- Live webhook forwarder reads Node request bodies and generates delivery ids via node:crypto.
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";

import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import type {
  AgentVelaRelayHookDeliveryProofPayload,
  RelayEndpointKey,
  TunnelHttpMethod,
} from "@t3tools/contracts/agentVelaRelay";
import { RELAY_HOOK_DELIVERY_HEADER, RELAY_HOOK_DELIVERY_TYP } from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";

import {
  HOP_BY_HOP_HEADERS,
  parseEndpointKeySafe,
  pipeTunnelHttpResponse,
  sanitizeHeadersForTunnel,
  sendJsonError,
  type RelayProxyDeps,
} from "./proxyCommon.ts";

const RELAY_HOOK_MAX_BODY_BYTES = 1_048_576;
const HOOK_METHODS = new Set(["GET", "POST", "PUT", "PATCH"]);

const HOOK_DROPPED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "host",
  "content-length",
  "cookie",
  "x-real-ip",
  "x-t3-relay-delivery-id",
  "x-t3-relay-received-at",
  RELAY_HOOK_DELIVERY_HEADER,
  "traceparent",
  "tracestate",
  "b3",
]);

export function parseHookForwardTarget(rawUrl: string): {
  readonly endpointKey: RelayEndpointKey;
  readonly hookId: string;
  readonly rawHookId: string;
  readonly rawToken: string;
  readonly search: string;
} | null {
  const queryIndex = rawUrl.indexOf("?");
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : rawUrl.slice(queryIndex);
  if (!pathname.startsWith("/v1/hooks/")) {
    return null;
  }
  const segments = pathname.split("/");
  if (segments.length !== 6) {
    return null;
  }
  const [, , , rawKey, rawHookId, rawToken] = segments;
  if (!rawKey || !rawHookId || !rawToken) {
    return null;
  }
  const endpointKey = parseEndpointKeySafe(rawKey);
  if (!endpointKey) {
    return null;
  }
  try {
    const hookId = decodeURIComponent(rawHookId);
    const token = decodeURIComponent(rawToken);
    if (hookId.trim().length === 0 || token.trim().length === 0) {
      return null;
    }
    return { endpointKey, hookId, rawHookId, rawToken, search };
  } catch {
    return null;
  }
}

async function readCappedNodeBody(
  req: NodeHttp.IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Array<Buffer> = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new Error("payload_too_large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function handleHookHttpForward(
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  deps: RelayProxyDeps,
): Promise<boolean> {
  const target = parseHookForwardTarget(req.url ?? "/");
  if (!target) {
    return false;
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (!HOOK_METHODS.has(method)) {
    sendJsonError(res, 404, { error: "hook_not_found" });
    return true;
  }
  const rate = deps.rateLimiter.allowProxy(`hook:${target.endpointKey}`);
  if (!rate.allowed) {
    sendJsonError(
      res,
      429,
      { code: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds },
      { "retry-after": String(rate.retryAfterSeconds) },
    );
    return true;
  }
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > RELAY_HOOK_MAX_BODY_BYTES) {
    sendJsonError(res, 413, { error: "payload_too_large" });
    return true;
  }

  let bodyBytes: Uint8Array;
  try {
    bodyBytes =
      method === "GET"
        ? new Uint8Array(0)
        : await readCappedNodeBody(req, RELAY_HOOK_MAX_BODY_BYTES);
  } catch {
    sendJsonError(res, 413, { error: "payload_too_large" });
    return true;
  }

  const env = await deps.runPromise(deps.environments.findByEndpointKey(target.endpointKey));
  if (!env) {
    sendJsonError(res, 404, { error: "hook_not_found" });
    return true;
  }

  const deliveryId = NodeCrypto.randomUUID();
  const now = await deps.runPromise(DateTime.now);
  const receivedAt = IsoDateTime.make(DateTime.formatIso(now));
  const nowSec = Math.floor(now.epochMilliseconds / 1_000);
  const proofPayload: AgentVelaRelayHookDeliveryProofPayload = {
    iss: deps.auth.relayIssuer,
    aud: `t3-env:${env.environmentId}`,
    sub: env.environmentId,
    jti: NodeCrypto.randomUUID(),
    iat: nowSec,
    exp: nowSec + 300,
    environmentId: env.environmentId,
    deliveryId: TrimmedNonEmptyString.make(deliveryId),
    receivedAt,
    hookId: TrimmedNonEmptyString.make(target.hookId),
  };
  const proof = await deps.runPromise(
    deps.auth.signRelayProof({
      typ: RELAY_HOOK_DELIVERY_TYP,
      payload: proofPayload as unknown as Record<string, unknown>,
    }),
  );

  const publicParsed = new URL(deps.config.publicUrl);
  const externalProto = publicParsed.protocol === "https:" ? "https" : "http";
  const headers = sanitizeHeadersForTunnel(req.headers, HOOK_DROPPED_HEADERS);
  headers.push(
    ["x-t3-relay-delivery-id", deliveryId],
    ["x-t3-relay-received-at", receivedAt],
    [RELAY_HOOK_DELIVERY_HEADER, proof],
  );

  try {
    const tunnelRes = await deps.runPromise(
      deps.tunnelHub.openHttpByEndpointKey(target.endpointKey, {
        method: method as TunnelHttpMethod,
        path: `/api/hooks/${target.rawHookId}/${target.rawToken}${target.search}`,
        headers,
        body: bodyBytes,
        externalHost: publicParsed.host,
        externalProto,
        pathPrefix: env.endpoint.pathPrefix,
        timeoutMs: deps.config.tunnel.proxyTimeoutMs,
      }),
    );
    await pipeTunnelHttpResponse(req, res, tunnelRes, {
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    });
  } catch (cause) {
    const tag = (cause as { _tag?: string } | null)?._tag;
    sendJsonError(res, tag === "RelayEndpointTimedOutError" ? 504 : 503, {
      error: tag === "RelayEndpointTimedOutError" ? "endpoint_timed_out" : "tunnel_disconnected",
    });
  }
  return true;
}
