// @effect-diagnostics nodeBuiltinImport:off -- Reverse proxy bridges Node HTTP/WS sockets directly onto TunnelHub.
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

import type { TunnelHttpMethod } from "@t3tools/contracts/agentVelaRelay";
import type { WebSocket } from "ws";

import { RELAY_API_CORS_RESPONSE_HEADERS } from "./cors.ts";
import {
  HOP_BY_HOP_HEADERS,
  parseEndpointProxyTarget,
  pipeTunnelHttpResponse,
  sanitizeHeadersForTunnel,
  sendJsonError,
  type RelayProxyDeps,
} from "./proxyCommon.ts";
import { extractClientIp } from "./rateLimit.ts";

export type { RelayProxyDeps } from "./proxyCommon.ts";

const FORWARDED_METHODS = new Set<TunnelHttpMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

function writeRejectSocketHttp(socket: NodeStream.Duplex, status: number, message: string): void {
  const reason = status === 404 ? "Not Found" : status === 504 ? "Gateway Timeout" : "Bad Gateway";
  const body = JSON.stringify({ code: "proxy_error", status, message });
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  socket.destroy();
}

function methodHasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function buildForwardedRequestMeta(
  req: NodeHttp.IncomingMessage,
  pathPrefix: string,
  deps: RelayProxyDeps,
) {
  const publicParsed = new URL(deps.config.publicUrl);
  const externalProto = (publicParsed.protocol === "https:" ? "https" : "http") as "http" | "https";
  const externalHost =
    !deps.config.trustProxy && req.headers.host ? req.headers.host : publicParsed.host;
  const clientIp = extractClientIp(req, deps.config.trustProxy);
  const headers = sanitizeHeadersForTunnel(req.headers, new Set([...HOP_BY_HOP_HEADERS, "host"]));
  headers.push(
    ["x-forwarded-host", externalHost],
    ["x-forwarded-proto", externalProto],
    ["x-forwarded-prefix", pathPrefix],
    ["x-real-ip", clientIp],
  );
  return { externalHost, externalProto, clientIp, headers };
}

export async function handleEndpointHttpProxy(
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  deps: RelayProxyDeps,
): Promise<boolean> {
  const target = parseEndpointProxyTarget(req.url ?? "/");
  if (!target) {
    return false;
  }
  const errorCorsHeaders =
    target.targetPath.split("?", 1)[0] === "/mcp" ? undefined : RELAY_API_CORS_RESPONSE_HEADERS;
  const method = (req.method ?? "GET").toUpperCase() as TunnelHttpMethod;
  if (!FORWARDED_METHODS.has(method)) {
    sendJsonError(res, 405, { code: "method_not_allowed" }, errorCorsHeaders);
    return true;
  }
  const rate = deps.rateLimiter.allowProxy(target.endpointKey);
  if (!rate.allowed) {
    sendJsonError(
      res,
      429,
      { code: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds },
      { ...errorCorsHeaders, "retry-after": String(rate.retryAfterSeconds) },
    );
    return true;
  }

  const meta = buildForwardedRequestMeta(req, target.pathPrefix, deps);
  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) {
      abortController.abort();
    }
  };
  res.once("close", onClose);
  try {
    const tunnelRes = await deps.runPromise(
      deps.tunnelHub.openHttpByEndpointKey(target.endpointKey, {
        method,
        path: target.targetPath,
        headers: meta.headers,
        body: methodHasBody(method) ? req : null,
        externalHost: meta.externalHost,
        externalProto: meta.externalProto,
        pathPrefix: target.pathPrefix,
        remoteAddr: meta.clientIp,
        timeoutMs: deps.config.tunnel.proxyTimeoutMs,
        signal: abortController.signal,
      }),
    );
    await pipeTunnelHttpResponse(req, res, tunnelRes);
  } catch (cause) {
    const tag = (cause as { _tag?: string } | null)?._tag;
    if (tag === "RelayNotFoundError") {
      sendJsonError(res, 404, { code: "not_found", resource: "environment" }, errorCorsHeaders);
    } else if (tag === "RelayEndpointTimedOutError") {
      sendJsonError(res, 504, { code: "endpoint_timed_out" }, errorCorsHeaders);
    } else {
      sendJsonError(res, 502, { code: "tunnel_offline" }, errorCorsHeaders);
    }
  } finally {
    res.off("close", onClose);
  }
  return true;
}

export async function handleRelayUpgrade(
  req: NodeHttp.IncomingMessage,
  socket: NodeStream.Duplex,
  head: Buffer,
  deps: RelayProxyDeps,
): Promise<void> {
  const rawUrl = req.url ?? "/";
  const pathname = rawUrl.split("?", 1)[0] ?? "/";
  if (pathname === "/v1/tunnel/connect") {
    deps.tunnelWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      deps.tunnelHub.acceptSocket(ws);
    });
    return;
  }

  const target = parseEndpointProxyTarget(rawUrl);
  if (!target) {
    writeRejectSocketHttp(socket, 404, "WebSocket route not found");
    return;
  }

  const meta = buildForwardedRequestMeta(req, target.pathPrefix, deps);
  const rawProtocols = req.headers["sec-websocket-protocol"];
  const protocols =
    typeof rawProtocols === "string"
      ? rawProtocols
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

  try {
    const accepted = await deps.runPromise(
      deps.tunnelHub.openWsByEndpointKey(target.endpointKey, {
        path: target.targetPath,
        headers: meta.headers,
        protocols,
        externalHost: meta.externalHost,
        externalProto: meta.externalProto,
        pathPrefix: target.pathPrefix,
        remoteAddr: meta.clientIp,
        timeoutMs: deps.config.tunnel.proxyTimeoutMs,
      }),
    );
    if (socket.destroyed) {
      accepted.abortBeforeAttach();
      return;
    }
    if (accepted.protocol) {
      req.headers["sec-websocket-protocol"] = accepted.protocol;
    } else {
      delete req.headers["sec-websocket-protocol"];
    }
    deps.proxyWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      accepted.attachClientSocket(ws);
    });
  } catch (cause) {
    const err = cause as { _tag?: string; message?: string } | null;
    if (err?._tag === "RelayNotFoundError") {
      writeRejectSocketHttp(socket, 404, "Environment not found");
    } else if (err?._tag === "RelayEndpointTimedOutError") {
      writeRejectSocketHttp(socket, 504, "Environment timed out");
    } else {
      writeRejectSocketHttp(socket, 502, err?.message ?? "Tunnel offline");
    }
  }
}
