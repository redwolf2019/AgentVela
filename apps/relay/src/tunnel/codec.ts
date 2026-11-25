// @effect-diagnostics nodeBuiltinImport:off -- Tunnel codec compresses frames via node:zlib and accepts ws RawData buffers.
import * as NodeZlib from "node:zlib";

import type {
  TunnelHttpHeader,
  TunnelHttpMethod,
  TunnelHttpResponsePayload,
  TunnelStreamResetCode,
} from "@t3tools/contracts/agentVelaRelay";
import {
  decodeRelayTunnelFrame,
  encodeRelayTunnelFrame,
  type RelayTunnelFrame,
  type TunnelCreditWindow,
} from "@t3tools/shared/relayTunnelProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RawData } from "ws";

export class TunnelStreamError extends Schema.TaggedError<
  TunnelStreamError,
  { readonly brand: unique symbol }
>()("TunnelStreamError", {
  reason: Schema.Literals(["offline", "timed_out", "reset", "protocol_error", "stream_limit"]),
  message: Schema.String,
  resetCode: Schema.optionalKey(Schema.String),
  httpStatus: Schema.optionalKey(Schema.Number),
}) {
  override get name(): string {
    return "TunnelStreamError";
  }
}

export interface TunnelOpenHttpInput {
  readonly method: TunnelHttpMethod;
  readonly path: string;
  readonly headers: ReadonlyArray<TunnelHttpHeader>;
  readonly body?: AsyncIterable<Uint8Array> | Uint8Array | null;
  readonly externalHost: string;
  readonly externalProto: "http" | "https";
  readonly pathPrefix: string;
  readonly remoteAddr?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface TunnelHttpStreamResponse {
  readonly status: number;
  readonly headers: ReadonlyArray<TunnelHttpHeader>;
  readonly hasBody: boolean;
  readonly body: AsyncIterable<Uint8Array>;
  readonly abort: () => void;
}

export interface TunnelOpenWsInput {
  readonly path: string;
  readonly headers: ReadonlyArray<TunnelHttpHeader>;
  readonly protocols: ReadonlyArray<string>;
  readonly externalHost: string;
  readonly externalProto: "http" | "https";
  readonly pathPrefix: string;
  readonly remoteAddr?: string;
  readonly timeoutMs?: number;
}

export interface ActiveStreamController {
  readonly streamId: number;
  readonly kind: "http" | "ws";
  sendWindow: TunnelCreditWindow;
  recvWindow: TunnelCreditWindow;
  readonly notifyCredit: () => void;
  readonly onFrame: (frame: RelayTunnelFrame) => void;
  readonly onForceClose: (error: TunnelStreamError) => void;
}

export function rawDataToUint8Array(raw: RawData): Uint8Array {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
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
  if (!compressed) {
    return payload;
  }
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

export function resetCodeToStreamError(
  code: TunnelStreamResetCode,
  message?: string,
): TunnelStreamError {
  if (code === "origin_timeout") {
    return new TunnelStreamError({
      reason: "timed_out",
      resetCode: code,
      message: message ?? "Tunnel origin timed out",
    });
  }
  if (code === "origin_unreachable") {
    return new TunnelStreamError({
      reason: "offline",
      resetCode: code,
      message: message ?? "Tunnel origin unreachable",
    });
  }
  return new TunnelStreamError({
    reason: "reset",
    resetCode: code,
    message: message ?? `Tunnel stream reset: ${code}`,
  });
}

export function toHttpResponseMeta(payload: TunnelHttpResponsePayload) {
  return {
    status: payload.status,
    headers: payload.headers,
    hasBody: payload.hasBody,
  };
}
