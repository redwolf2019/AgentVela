// @effect-diagnostics nodeBuiltinImport:off -- Tunnel codec compresses/decompresses binary tunnel frames via node:zlib.
import type * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import type { TunnelHttpHeader } from "@t3tools/contracts/agentVelaRelay";
import {
  decodeRelayTunnelFrame,
  encodeRelayTunnelFrame,
  type RelayTunnelFrame,
} from "@t3tools/shared/relayTunnelProtocol";
import * as Effect from "effect/Effect";
import type { RawData } from "ws";

const HOP_BY_HOP_HEADERS = new Set([
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

const STRIPPED_FORWARDED_PREFIXES = ["x-forwarded-", "cf-", "proxy-", "x-b3-"];
const WS_HANDSHAKE_DROP_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "host",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);
const HTTP_FORWARD_DROP_HEADERS = new Set([...HOP_BY_HOP_HEADERS, "host"]);

export function rawDataToUint8Array(raw: RawData): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return Buffer.concat(raw);
}

export function encodeFrameSync(frame: RelayTunnelFrame, maxFrameBytes: number): Uint8Array {
  return Effect.runSync(encodeRelayTunnelFrame(frame, { maxFrameBytes }));
}

export function decodeFrameSync(bytes: Uint8Array, maxFrameBytes: number): RelayTunnelFrame {
  return Effect.runSync(decodeRelayTunnelFrame(bytes, { maxFrameBytes }));
}

export function compressDataIfSmaller(
  payload: Uint8Array,
  compressionEnabled: boolean,
): { readonly bytes: Uint8Array; readonly compressed: boolean } {
  if (!compressionEnabled || payload.byteLength < 512) {
    return { bytes: payload, compressed: false };
  }
  const deflated = NodeZlib.deflateRawSync(payload);
  if (deflated.byteLength >= payload.byteLength) {
    return { bytes: payload, compressed: false };
  }
  return {
    bytes: new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength),
    compressed: true,
  };
}

export function decompressTunnelPayload(
  payload: Uint8Array,
  compressed: boolean,
  maxFrameBytes: number,
): Uint8Array {
  if (!compressed) return payload;
  const inflated = NodeZlib.inflateRawSync(payload, { maxOutputLength: maxFrameBytes * 4 });
  return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
}

export function sanitizeWsCloseCode(code?: number): number {
  if (
    code === undefined ||
    !Number.isInteger(code) ||
    code < 1000 ||
    code > 4999 ||
    code === 1004 ||
    code === 1005 ||
    code === 1006 ||
    code === 1015
  ) {
    return 1000;
  }
  return code;
}

export function isSafeLocalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

function appendOutgoingHeader(out: NodeHttp.OutgoingHttpHeaders, key: string, value: string): void {
  const existing = out[key];
  if (existing === undefined) {
    out[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    out[key] = [String(existing), value];
  }
}

export function buildForwardedHeaders(input: {
  readonly headers: ReadonlyArray<TunnelHttpHeader>;
  readonly externalHost: string;
  readonly externalProto: "http" | "https";
  readonly pathPrefix: string;
  readonly remoteAddr?: string;
  readonly isWebSocket: boolean;
}): NodeHttp.OutgoingHttpHeaders {
  const dropSet = input.isWebSocket ? WS_HANDSHAKE_DROP_HEADERS : HTTP_FORWARD_DROP_HEADERS;
  const out: NodeHttp.OutgoingHttpHeaders = {};
  for (const [rawName, value] of input.headers) {
    const lower = rawName.toLowerCase();
    if (dropSet.has(lower) || STRIPPED_FORWARDED_PREFIXES.some((p) => lower.startsWith(p))) {
      continue;
    }
    appendOutgoingHeader(out, lower, value);
  }
  out.host = input.externalHost;
  out["x-forwarded-host"] = input.externalHost;
  out["x-forwarded-proto"] = input.externalProto;
  if (input.pathPrefix.length > 0) {
    out["x-forwarded-prefix"] = input.pathPrefix;
  }
  if (input.remoteAddr) {
    out["x-forwarded-for"] = input.remoteAddr;
  }
  return out;
}

export function incomingHeadersToTuples(
  headers: NodeHttp.IncomingHttpHeaders,
  options?: { readonly excludeContentLength?: boolean },
): Array<TunnelHttpHeader> {
  const tuples: Array<TunnelHttpHeader> = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      (options?.excludeContentLength === true && lower === "content-length") ||
      value === undefined
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        tuples.push([lower, item]);
      }
    } else {
      tuples.push([lower, value]);
    }
  }
  return tuples;
}
