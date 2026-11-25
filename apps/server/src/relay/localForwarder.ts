// @effect-diagnostics nodeBuiltinImport:off -- LocalForwarder proxies multiplexed tunnel streams to localhost Node HTTP and ws sockets.
import * as NodeHttp from "node:http";

import type {
  TunnelOpenHttpPayload,
  TunnelOpenWsPayload,
  TunnelStreamResetCode,
} from "@t3tools/contracts/agentVelaRelay";
import {
  applyWindowUpdate,
  createTunnelCreditWindow,
  recordReceivedBytes,
  type RelayTunnelFrame,
} from "@t3tools/shared/relayTunnelProtocol";
import * as Effect from "effect/Effect";
import { type RawData, WebSocket } from "ws";

import {
  buildForwardedHeaders,
  decompressTunnelPayload,
  incomingHeadersToTuples,
  isSafeLocalPath,
  rawDataToUint8Array,
  sanitizeWsCloseCode,
} from "./tunnelCodec.ts";
import {
  type LocalFlowControlHost,
  type LocalStreamFlowState,
  sendLocalDataChunked,
} from "./tunnelFlowControl.ts";

const LOCAL_REQUEST_TIMEOUT_MS = 30_000;
const LOCAL_WS_HANDSHAKE_TIMEOUT_MS = 15_000;
const utf8Decoder = new TextDecoder();

export interface ActiveLocalStream extends LocalStreamFlowState {
  readonly onFrame: (frame: RelayTunnelFrame) => void;
  readonly notifyCredit: () => void;
  readonly destroy: () => void;
}

export interface LocalForwarderHost extends LocalFlowControlHost {
  readonly localHost: string;
  readonly localPort: number;
  readonly sendReset: (streamId: number, code: TunnelStreamResetCode, message?: string) => void;
  readonly unregisterStream: (streamId: number) => void;
}

function stripIpv6Brackets(host: string): string {
  return host.replace(/^\[|\]$/gu, "");
}

function formatWsAuthorityHost(host: string): string {
  const bare = stripIpv6Brackets(host);
  return bare.includes(":") ? `[${bare}]` : bare;
}

function errorCodeFromErrno(err: unknown): TunnelStreamResetCode {
  const code = (err as { readonly code?: string } | null)?.code;
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENOTFOUND") {
    return "origin_unreachable";
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return "origin_timeout";
  }
  return "internal_error";
}

function responseHasBody(
  method: string,
  status: number,
  headers: NodeHttp.IncomingHttpHeaders,
): boolean {
  if (method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200)) {
    return false;
  }
  return headers["content-length"] !== "0";
}

function receiveFrameBytes(
  host: LocalForwarderHost,
  stream: ActiveLocalStream,
  frame: Extract<RelayTunnelFrame, { readonly type: "data" }>,
): Uint8Array | null {
  try {
    const recv = Effect.runSync(recordReceivedBytes(stream.recvWindow, frame.payload.byteLength));
    stream.recvWindow = recv.window;
    const plain = decompressTunnelPayload(
      frame.payload,
      frame.compressed,
      host.negotiated.maxFrameBytes,
    );
    if (recv.creditToSend > 0) {
      host.sendFrame({
        type: "window_update",
        streamId: stream.streamId,
        creditBytes: recv.creditToSend,
      });
    }
    return plain;
  } catch (cause) {
    host.sendReset(stream.streamId, "protocol_error", String(cause));
    stream.destroy();
    return null;
  }
}

function handleCommonControlFrame(
  stream: ActiveLocalStream,
  frame: RelayTunnelFrame,
  onRst: () => void,
): boolean {
  if (frame.type === "window_update") {
    stream.sendWindow = Effect.runSync(applyWindowUpdate(stream.sendWindow, frame.creditBytes));
    stream.notifyCredit();
    return true;
  }
  if (frame.type === "rst") {
    onRst();
    return true;
  }
  return false;
}

export function openLocalHttpStream(
  host: LocalForwarderHost,
  streamId: number,
  payload: TunnelOpenHttpPayload,
): ActiveLocalStream | null {
  if (!isSafeLocalPath(payload.path)) {
    host.sendReset(streamId, "protocol_error", "Unsafe request path");
    return null;
  }
  const initialWindow = host.negotiated.initialStreamWindowBytes;
  const abortController = new AbortController();
  let closed = false;
  let activeRes: NodeHttp.IncomingMessage | null = null;
  let reqEnded = !payload.hasBody;
  let sendChain = Promise.resolve();

  const headers = buildForwardedHeaders({
    headers: payload.headers,
    externalHost: payload.externalHost,
    externalProto: payload.externalProto,
    pathPrefix: payload.pathPrefix,
    ...(payload.remoteAddr ? { remoteAddr: payload.remoteAddr } : {}),
    isWebSocket: false,
  });

  const req = NodeHttp.request({
    hostname: stripIpv6Brackets(host.localHost),
    port: host.localPort,
    method: payload.method,
    path: payload.path,
    headers,
    timeout: LOCAL_REQUEST_TIMEOUT_MS,
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    abortController.abort();
    req.destroy();
    activeRes?.destroy();
    host.unregisterStream(streamId);
  };

  req.on("timeout", () => {
    if (closed) return;
    host.sendReset(streamId, "origin_timeout", "Local HTTP request timed out");
    cleanup();
  });

  req.on("error", (err) => {
    if (closed) return;
    host.sendReset(streamId, errorCodeFromErrno(err), err.message);
    cleanup();
  });

  req.on("response", (res) => {
    if (closed) return;
    activeRes = res;
    const status = res.statusCode ?? 502;
    const hasBody = responseHasBody(payload.method, status, res.headers);
    host.sendFrame({
      type: "http_response",
      streamId,
      payload: {
        status,
        headers: incomingHeadersToTuples(res.headers, { excludeContentLength: hasBody }),
        hasBody,
      },
    });
    if (!hasBody) {
      cleanup();
      return;
    }
    res.on("data", (chunk: Buffer) => {
      if (closed) return;
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (stream.sendWindow.sendAvailableBytes < bytes.byteLength) {
        res.pause();
      }
      sendChain = sendChain
        .then(async () => {
          if (closed) return;
          await sendLocalDataChunked(host, stream, bytes, false, false, abortController.signal);
          if (!closed && stream.sendWindow.sendAvailableBytes > 0) {
            res.resume();
          }
        })
        .catch(() => cleanup());
    });
    res.on("end", () => {
      sendChain = sendChain
        .then(() => {
          if (closed) return;
          host.sendFrame({ type: "end", streamId, payload: {} });
          cleanup();
        })
        .catch(() => cleanup());
    });
    res.on("error", (err) => {
      if (closed) return;
      host.sendReset(streamId, errorCodeFromErrno(err), err.message);
      cleanup();
    });
  });

  const stream: ActiveLocalStream = {
    streamId,
    kind: "http",
    sendWindow: createTunnelCreditWindow(initialWindow),
    recvWindow: createTunnelCreditWindow(initialWindow),
    notifyCredit: () => {
      if (activeRes && stream.sendWindow.sendAvailableBytes > 0) {
        activeRes.resume();
      }
    },
    destroy: cleanup,
    onFrame: (frame) => {
      if (closed) return;
      if (handleCommonControlFrame(stream, frame, cleanup)) return;
      if (frame.type === "data") {
        const plain = receiveFrameBytes(host, stream, frame);
        if (!plain) return;
        if (plain.byteLength > 0) req.write(plain);
        if (frame.endStream && !reqEnded) {
          reqEnded = true;
          req.end();
        }
        return;
      }
      if (frame.type === "end" && !reqEnded) {
        reqEnded = true;
        req.end();
      }
    },
  };

  if (!payload.hasBody) {
    reqEnded = true;
    req.end();
  }
  return stream;
}

function attachLocalWsEvents(input: {
  readonly host: LocalForwarderHost;
  readonly stream: ActiveLocalStream;
  readonly ws: WebSocket;
  readonly cleanup: () => void;
  readonly signal: AbortSignal;
}): void {
  const { host, stream, ws, cleanup, signal } = input;
  let sendChain = Promise.resolve();
  let upgradeHeaders: Array<readonly [string, string]> = [];
  let opened = false;

  ws.on("upgrade", (res) => {
    upgradeHeaders = incomingHeadersToTuples(res.headers, { excludeContentLength: true });
  });

  ws.on("open", () => {
    if (signal.aborted) {
      ws.terminate();
      return;
    }
    opened = true;
    host.sendFrame({
      type: "ws_accept",
      streamId: stream.streamId,
      payload: {
        ok: true,
        ...(ws.protocol ? { protocol: ws.protocol } : {}),
        headers: upgradeHeaders.map(([k, v]) => [k, v] as [string, string]),
      },
    });
  });

  ws.on("unexpected-response", (_req, res) => {
    if (!opened && !signal.aborted) {
      host.sendFrame({
        type: "ws_accept",
        streamId: stream.streamId,
        payload: {
          ok: false,
          status: res.statusCode ?? 502,
          message: res.statusMessage || "Rejected",
        },
      });
    }
    cleanup();
  });

  ws.on("message", (raw: RawData, isBinary: boolean) => {
    if (signal.aborted) return;
    const bytes = rawDataToUint8Array(raw);
    if (stream.sendWindow.sendAvailableBytes < bytes.byteLength) ws.pause();
    sendChain = sendChain
      .then(async () => {
        if (signal.aborted) return;
        await sendLocalDataChunked(host, stream, bytes, false, !isBinary, signal);
        if (!signal.aborted && stream.sendWindow.sendAvailableBytes > 0) ws.resume();
      })
      .catch(() => cleanup());
  });

  ws.on("close", (code, reasonBuf) => {
    sendChain = sendChain
      .then(() => {
        if (signal.aborted) return;
        if (!opened) {
          host.sendReset(
            stream.streamId,
            "origin_unreachable",
            "Local WebSocket closed before open",
          );
        } else {
          host.sendFrame({
            type: "end",
            streamId: stream.streamId,
            payload: {
              closeCode: sanitizeWsCloseCode(code),
              closeReason: reasonBuf.toString("utf8").slice(0, 120),
            },
          });
        }
        cleanup();
      })
      .catch(() => cleanup());
  });

  ws.on("error", (err) => {
    if (signal.aborted) return;
    if (!opened) {
      host.sendFrame({
        type: "ws_accept",
        streamId: stream.streamId,
        payload: { ok: false, status: 502, message: err.message },
      });
    } else {
      host.sendReset(stream.streamId, errorCodeFromErrno(err), err.message);
    }
    cleanup();
  });
}

function toWsRequestHeaders(headers: NodeHttp.OutgoingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
  }
  return out;
}

export function openLocalWsStream(
  host: LocalForwarderHost,
  streamId: number,
  payload: TunnelOpenWsPayload,
): ActiveLocalStream | null {
  if (!isSafeLocalPath(payload.path)) {
    host.sendReset(streamId, "protocol_error", "Unsafe WebSocket path");
    return null;
  }
  const initialWindow = host.negotiated.initialStreamWindowBytes;
  const abortController = new AbortController();
  let closed = false;

  const headers = buildForwardedHeaders({
    headers: payload.headers,
    externalHost: payload.externalHost,
    externalProto: payload.externalProto,
    pathPrefix: payload.pathPrefix,
    ...(payload.remoteAddr ? { remoteAddr: payload.remoteAddr } : {}),
    isWebSocket: true,
  });

  const wsUrl = `ws://${formatWsAuthorityHost(host.localHost)}:${host.localPort}${payload.path}`;
  const ws = new WebSocket(wsUrl, [...payload.protocols], {
    headers: toWsRequestHeaders(headers),
    perMessageDeflate: false,
    handshakeTimeout: LOCAL_WS_HANDSHAKE_TIMEOUT_MS,
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    abortController.abort();
    if (ws.readyState === ws.CONNECTING || ws.readyState === ws.OPEN) {
      ws.terminate();
    }
    host.unregisterStream(streamId);
  };

  const stream: ActiveLocalStream = {
    streamId,
    kind: "ws",
    sendWindow: createTunnelCreditWindow(initialWindow),
    recvWindow: createTunnelCreditWindow(initialWindow),
    notifyCredit: () => {
      if (stream.sendWindow.sendAvailableBytes > 0 && ws.readyState === ws.OPEN) {
        ws.resume();
      }
    },
    destroy: cleanup,
    onFrame: (frame) => {
      if (closed) return;
      if (handleCommonControlFrame(stream, frame, cleanup)) return;
      if (frame.type === "data") {
        const plain = receiveFrameBytes(host, stream, frame);
        if (!plain) return;
        if (ws.readyState === ws.OPEN) {
          ws.send(frame.wsText ? utf8Decoder.decode(plain) : plain, { binary: !frame.wsText });
        }
        return;
      }
      if (frame.type === "end") {
        if (ws.readyState === ws.OPEN) {
          ws.close(
            sanitizeWsCloseCode(frame.payload.closeCode),
            frame.payload.closeReason?.slice(0, 120) ?? "",
          );
        } else if (ws.readyState === ws.CONNECTING) {
          ws.terminate();
        }
        cleanup();
      }
    },
  };

  attachLocalWsEvents({ host, stream, ws, cleanup, signal: abortController.signal });
  return stream;
}
