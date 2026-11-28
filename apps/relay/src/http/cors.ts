// @effect-diagnostics nodeBuiltinImport:off -- CORS helpers write headers directly to Node HTTP responses.
import type * as NodeHttp from "node:http";

import {
  RELAY_PRESENCE_EVENTS_PATH,
  RELAY_TUNNEL_CONNECT_PATH,
} from "@t3tools/contracts/agentVelaRelay";

export const RELAY_API_CORS_ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export const RELAY_API_CORS_ALLOWED_HEADERS = [
  "authorization",
  "b3",
  "cache-control",
  "content-type",
  "dpop",
  "traceparent",
  "tracestate",
] as const;

export const RELAY_API_CORS_EXPOSED_HEADERS = [
  "retry-after",
  "traceparent",
  "www-authenticate",
] as const;

export const RELAY_API_CORS_MAX_AGE_SECONDS = 600;

export const RELAY_API_CORS_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": RELAY_API_CORS_EXPOSED_HEADERS.join(", "),
};

export function isRelayBrowserApiPath(pathname: string): boolean {
  if (pathname === "/health" || pathname === RELAY_PRESENCE_EVENTS_PATH) {
    return true;
  }
  if (pathname === RELAY_TUNNEL_CONNECT_PATH || pathname.startsWith("/v1/hooks/")) {
    return false;
  }
  return pathname.startsWith("/v1/");
}

export function applyRelayApiCorsHeaders(res: NodeHttp.ServerResponse): void {
  for (const [name, value] of Object.entries(RELAY_API_CORS_RESPONSE_HEADERS)) {
    res.setHeader(name, value);
  }
}

export function writeRelayApiCorsPreflight(
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
): void {
  const rawPna = req.headers["access-control-request-private-network"];
  const allowPrivateNetwork = typeof rawPna === "string" && rawPna.trim().toLowerCase() === "true";
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": RELAY_API_CORS_ALLOWED_METHODS.join(", "),
    "access-control-allow-headers": RELAY_API_CORS_ALLOWED_HEADERS.join(", "),
    "access-control-max-age": String(RELAY_API_CORS_MAX_AGE_SECONDS),
    vary: "Access-Control-Request-Private-Network",
    ...(allowPrivateNetwork ? { "access-control-allow-private-network": "true" } : {}),
  });
  res.end();
}
