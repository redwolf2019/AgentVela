import * as RelayContracts from "@t3tools/contracts/agentVelaRelay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const RelayTunnelProtocolErrorCode = Schema.Literals([
  "frame_too_short",
  "unsupported_version",
  "unknown_type",
  "invalid_flags",
  "invalid_stream_id",
  "payload_length_mismatch",
  "frame_too_large",
  "invalid_payload",
  "window_overflow",
]);
export type RelayTunnelProtocolErrorCode = typeof RelayTunnelProtocolErrorCode.Type;

export class RelayTunnelProtocolError extends Schema.TaggedError<RelayTunnelProtocolError>()(
  "RelayTunnelProtocolError",
  {
    code: RelayTunnelProtocolErrorCode,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Relay tunnel protocol error (${this.code}): ${this.detail}`;
  }
}

type JsonControlPayloadMap = {
  readonly login: RelayContracts.TunnelLoginPayload;
  readonly login_resp: RelayContracts.TunnelLoginRespPayload;
  readonly register_proxy: RelayContracts.TunnelRegisterProxyPayload;
  readonly register_proxy_resp: RelayContracts.TunnelRegisterProxyRespPayload;
  readonly ping: RelayContracts.TunnelPingPayload;
  readonly pong: RelayContracts.TunnelPongPayload;
  readonly goaway: RelayContracts.TunnelGoAwayPayload;
};

type JsonStreamPayloadMap = {
  readonly open_http: RelayContracts.TunnelOpenHttpPayload;
  readonly http_response: RelayContracts.TunnelHttpResponsePayload;
  readonly open_ws: RelayContracts.TunnelOpenWsPayload;
  readonly ws_accept: RelayContracts.TunnelWsAcceptPayload;
  readonly end: RelayContracts.TunnelStreamEndPayload;
  readonly rst: RelayContracts.TunnelStreamResetPayload;
};

export type RelayTunnelFrame =
  | {
      readonly [K in keyof JsonControlPayloadMap]: {
        readonly type: K;
        readonly streamId: 0;
        readonly payload: JsonControlPayloadMap[K];
      };
    }[keyof JsonControlPayloadMap]
  | {
      readonly [K in keyof JsonStreamPayloadMap]: {
        readonly type: K;
        readonly streamId: number;
        readonly payload: JsonStreamPayloadMap[K];
      };
    }[keyof JsonStreamPayloadMap]
  | {
      readonly type: "data";
      readonly streamId: number;
      readonly payload: Uint8Array;
      readonly endStream: boolean;
      readonly compressed: boolean;
      readonly wsText: boolean;
    }
  | { readonly type: "window_update"; readonly streamId: number; readonly creditBytes: number };

export interface TunnelCreditWindow {
  readonly initialWindowBytes: number;
  readonly sendAvailableBytes: number;
  readonly receiveConsumedSinceUpdateBytes: number;
  readonly receiveWindowRemainingBytes: number;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface JsonCodec {
  readonly decode: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly encode: (input: unknown) => Effect.Effect<string, Schema.SchemaError>;
}

function makeJsonCodec<
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(schema: S): JsonCodec {
  const jsonSchema = Schema.fromJsonString(schema);
  return {
    decode: Schema.decodeUnknownEffect(jsonSchema),
    encode: Schema.encodeUnknownEffect(jsonSchema),
  };
}

const CODECS = {
  login: makeJsonCodec(RelayContracts.TunnelLoginPayload),
  login_resp: makeJsonCodec(RelayContracts.TunnelLoginRespPayload),
  register_proxy: makeJsonCodec(RelayContracts.TunnelRegisterProxyPayload),
  register_proxy_resp: makeJsonCodec(RelayContracts.TunnelRegisterProxyRespPayload),
  ping: makeJsonCodec(RelayContracts.TunnelPingPayload),
  pong: makeJsonCodec(RelayContracts.TunnelPongPayload),
  goaway: makeJsonCodec(RelayContracts.TunnelGoAwayPayload),
  open_http: makeJsonCodec(RelayContracts.TunnelOpenHttpPayload),
  http_response: makeJsonCodec(RelayContracts.TunnelHttpResponsePayload),
  open_ws: makeJsonCodec(RelayContracts.TunnelOpenWsPayload),
  ws_accept: makeJsonCodec(RelayContracts.TunnelWsAcceptPayload),
  end: makeJsonCodec(RelayContracts.TunnelStreamEndPayload),
  rst: makeJsonCodec(RelayContracts.TunnelStreamResetPayload),
} as const;

type JsonFrameType = keyof typeof CODECS;

const FRAME_OPCODE_BY_TYPE: Readonly<
  Record<RelayTunnelFrame["type"], RelayContracts.RelayTunnelFrameOpcode>
> = {
  login: RelayContracts.RelayTunnelFrameType.LOGIN,
  login_resp: RelayContracts.RelayTunnelFrameType.LOGIN_RESP,
  register_proxy: RelayContracts.RelayTunnelFrameType.REGISTER_PROXY,
  register_proxy_resp: RelayContracts.RelayTunnelFrameType.REGISTER_PROXY_RESP,
  ping: RelayContracts.RelayTunnelFrameType.PING,
  pong: RelayContracts.RelayTunnelFrameType.PONG,
  goaway: RelayContracts.RelayTunnelFrameType.GOAWAY,
  open_http: RelayContracts.RelayTunnelFrameType.OPEN_HTTP,
  http_response: RelayContracts.RelayTunnelFrameType.HTTP_RESPONSE,
  open_ws: RelayContracts.RelayTunnelFrameType.OPEN_WS,
  ws_accept: RelayContracts.RelayTunnelFrameType.WS_ACCEPT,
  data: RelayContracts.RelayTunnelFrameType.DATA,
  window_update: RelayContracts.RelayTunnelFrameType.WINDOW_UPDATE,
  end: RelayContracts.RelayTunnelFrameType.END,
  rst: RelayContracts.RelayTunnelFrameType.RST,
};

const FRAME_TYPE_BY_OPCODE = new Map<number, RelayTunnelFrame["type"]>(
  Object.entries(FRAME_OPCODE_BY_TYPE).map(([type, opcode]) => [
    opcode,
    type as RelayTunnelFrame["type"],
  ]),
);

const CONTROL_FRAME_TYPES = new Set<RelayTunnelFrame["type"]>([
  "login",
  "login_resp",
  "register_proxy",
  "register_proxy_resp",
  "ping",
  "pong",
  "goaway",
]);

function makeError(code: RelayTunnelProtocolErrorCode, detail: string) {
  return new RelayTunnelProtocolError({ code, detail });
}

function failProtocol(code: RelayTunnelProtocolErrorCode, detail: string) {
  return Effect.fail(makeError(code, detail));
}

function clampBetween(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function resolveMaxFrameBytes(maxFrameBytes: number | undefined): number {
  return clampBetween(
    maxFrameBytes ?? RelayContracts.DEFAULT_TUNNEL_MAX_FRAME_BYTES,
    RelayContracts.MIN_TUNNEL_MAX_FRAME_BYTES,
    RelayContracts.MAX_TUNNEL_MAX_FRAME_BYTES,
  );
}

function isValidStreamIdForType(type: RelayTunnelFrame["type"], streamId: number): boolean {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffff_ffff) return false;
  return CONTROL_FRAME_TYPES.has(type) ? streamId === 0 : streamId >= 1;
}

function validateWindowIncrement(creditBytes: number) {
  if (
    !Number.isInteger(creditBytes) ||
    creditBytes < 1 ||
    creditBytes > RelayContracts.MAX_TUNNEL_STREAM_WINDOW_BYTES
  ) {
    return failProtocol("window_overflow", `Invalid window increment ${creditBytes}.`);
  }
  return Effect.succeed(creditBytes);
}

function encodeJsonPayload(
  type: JsonFrameType,
  payload: unknown,
): Effect.Effect<Uint8Array, RelayTunnelProtocolError> {
  return CODECS[type].encode(payload).pipe(
    Effect.map((text) => utf8Encoder.encode(text)),
    Effect.mapError((error) => makeError("invalid_payload", String(error))),
  );
}

function decodeJsonPayload(
  type: JsonFrameType,
  payloadBytes: Uint8Array,
): Effect.Effect<unknown, RelayTunnelProtocolError> {
  return Effect.try({
    try: () => utf8Decoder.decode(payloadBytes),
    catch: () => makeError("invalid_payload", `Malformed UTF-8 in ${type} frame.`),
  }).pipe(
    Effect.flatMap((text) =>
      CODECS[type]
        .decode(text)
        .pipe(Effect.mapError((error) => makeError("invalid_payload", String(error)))),
    ),
  );
}

function assembleFrame(
  opcode: RelayContracts.RelayTunnelFrameOpcode,
  flags: number,
  streamId: number,
  payloadBytes: Uint8Array,
  maxFrameBytes: number,
): Effect.Effect<Uint8Array, RelayTunnelProtocolError> {
  if (payloadBytes.byteLength > maxFrameBytes) {
    return failProtocol(
      "frame_too_large",
      `Frame payload ${payloadBytes.byteLength} exceeds max ${maxFrameBytes} bytes.`,
    );
  }
  const buffer = new Uint8Array(RelayContracts.RELAY_TUNNEL_HEADER_BYTES + payloadBytes.byteLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setUint8(0, RelayContracts.RELAY_TUNNEL_PROTOCOL_VERSION);
  view.setUint8(1, opcode);
  view.setUint8(2, flags);
  view.setUint32(3, streamId, false);
  view.setUint32(7, payloadBytes.byteLength, false);
  buffer.set(payloadBytes, RelayContracts.RELAY_TUNNEL_HEADER_BYTES);
  return Effect.succeed(buffer);
}

function encodeDataFlags(frame: Extract<RelayTunnelFrame, { readonly type: "data" }>): number {
  return (
    (frame.endStream ? RelayContracts.RELAY_TUNNEL_FLAG_END_STREAM : 0) |
    (frame.compressed ? RelayContracts.RELAY_TUNNEL_FLAG_COMPRESSED : 0) |
    (frame.wsText ? RelayContracts.RELAY_TUNNEL_FLAG_WS_TEXT : 0)
  );
}

export const encodeRelayTunnelFrame = Effect.fn("relayTunnelProtocol.encode")(function* (
  frame: RelayTunnelFrame,
  options?: { readonly maxFrameBytes?: number },
): Effect.fn.Return<Uint8Array, RelayTunnelProtocolError> {
  if (!isValidStreamIdForType(frame.type, frame.streamId)) {
    return yield* failProtocol(
      "invalid_stream_id",
      `Invalid streamId ${frame.streamId} for frame ${frame.type}.`,
    );
  }
  const maxFrameBytes = resolveMaxFrameBytes(options?.maxFrameBytes);
  const opcode = FRAME_OPCODE_BY_TYPE[frame.type];

  if (frame.type === "data") {
    return yield* assembleFrame(
      opcode,
      encodeDataFlags(frame),
      frame.streamId,
      frame.payload,
      maxFrameBytes,
    );
  }
  if (frame.type === "window_update") {
    const creditBytes = yield* validateWindowIncrement(frame.creditBytes);
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, creditBytes, false);
    return yield* assembleFrame(opcode, 0, frame.streamId, payload, maxFrameBytes);
  }
  if (
    frame.type === "end" &&
    frame.payload.closeCode === undefined &&
    frame.payload.closeReason === undefined
  ) {
    return yield* assembleFrame(opcode, 0, frame.streamId, new Uint8Array(0), maxFrameBytes);
  }
  const payload = yield* encodeJsonPayload(frame.type, frame.payload);
  return yield* assembleFrame(opcode, 0, frame.streamId, payload, maxFrameBytes);
});

function validateHeaderFields(
  view: DataView,
  actualLength: number,
  maxFrameBytes: number,
): Effect.Effect<
  { readonly type: RelayTunnelFrame["type"]; readonly flags: number; readonly streamId: number },
  RelayTunnelProtocolError
> {
  const version = view.getUint8(0);
  if (version !== RelayContracts.RELAY_TUNNEL_PROTOCOL_VERSION) {
    return failProtocol("unsupported_version", `Unsupported version ${version}.`);
  }
  const opcode = view.getUint8(1);
  const type = FRAME_TYPE_BY_OPCODE.get(opcode);
  if (type === undefined) {
    return failProtocol("unknown_type", `Unknown frame opcode 0x${opcode.toString(16)}.`);
  }
  const flags = view.getUint8(2);
  if (
    (flags & ~RelayContracts.RELAY_TUNNEL_KNOWN_FLAGS) !== 0 ||
    (type !== "data" && flags !== 0)
  ) {
    return failProtocol("invalid_flags", `Invalid flags 0x${flags.toString(16)} for ${type}.`);
  }
  const streamId = view.getUint32(3, false);
  if (!isValidStreamIdForType(type, streamId)) {
    return failProtocol("invalid_stream_id", `Invalid streamId ${streamId} for ${type}.`);
  }
  const payloadLength = view.getUint32(7, false);
  if (payloadLength > maxFrameBytes) {
    return failProtocol(
      "frame_too_large",
      `Frame payload ${payloadLength} exceeds max ${maxFrameBytes} bytes.`,
    );
  }
  if (payloadLength !== actualLength) {
    return failProtocol(
      "payload_length_mismatch",
      `Header length ${payloadLength} != actual ${actualLength}.`,
    );
  }
  return Effect.succeed({ type, flags, streamId });
}

export const decodeRelayTunnelFrame = Effect.fn("relayTunnelProtocol.decode")(function* (
  bytes: Uint8Array,
  options?: { readonly maxFrameBytes?: number },
): Effect.fn.Return<RelayTunnelFrame, RelayTunnelProtocolError> {
  if (bytes.byteLength < RelayContracts.RELAY_TUNNEL_HEADER_BYTES) {
    return yield* failProtocol(
      "frame_too_short",
      `Expected at least ${RelayContracts.RELAY_TUNNEL_HEADER_BYTES} bytes, got ${bytes.byteLength}.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { type, flags, streamId } = yield* validateHeaderFields(
    view,
    bytes.byteLength - RelayContracts.RELAY_TUNNEL_HEADER_BYTES,
    resolveMaxFrameBytes(options?.maxFrameBytes),
  );
  const payloadBytes = bytes.slice(RelayContracts.RELAY_TUNNEL_HEADER_BYTES);

  if (type === "data") {
    return {
      type: "data",
      streamId,
      payload: payloadBytes,
      endStream: (flags & RelayContracts.RELAY_TUNNEL_FLAG_END_STREAM) !== 0,
      compressed: (flags & RelayContracts.RELAY_TUNNEL_FLAG_COMPRESSED) !== 0,
      wsText: (flags & RelayContracts.RELAY_TUNNEL_FLAG_WS_TEXT) !== 0,
    };
  }
  if (type === "window_update") {
    if (payloadBytes.byteLength !== 4) {
      return yield* failProtocol(
        "invalid_payload",
        `Expected 4-byte WINDOW_UPDATE payload, got ${payloadBytes.byteLength}.`,
      );
    }
    const creditBytes = yield* validateWindowIncrement(
      new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength).getUint32(
        0,
        false,
      ),
    );
    return { type: "window_update", streamId, creditBytes };
  }
  if (type === "end" && payloadBytes.byteLength === 0) {
    return { type: "end", streamId, payload: {} };
  }
  const payload = yield* decodeJsonPayload(type, payloadBytes);
  return { type, streamId, payload } as RelayTunnelFrame;
});

export function negotiateTunnelCapabilities(
  client: RelayContracts.TunnelCapabilities,
  server: RelayContracts.TunnelCapabilities,
): RelayContracts.TunnelNegotiatedCapabilities {
  const maxFrameBytes = clampBetween(
    Math.min(client.maxFrameBytes, server.maxFrameBytes),
    RelayContracts.MIN_TUNNEL_MAX_FRAME_BYTES,
    RelayContracts.MAX_TUNNEL_MAX_FRAME_BYTES,
  );
  const heartbeatIntervalMs = clampBetween(
    Math.max(client.heartbeatIntervalMs, server.heartbeatIntervalMs),
    RelayContracts.MIN_TUNNEL_HEARTBEAT_INTERVAL_MS,
    RelayContracts.MAX_TUNNEL_HEARTBEAT_INTERVAL_MS,
  );
  const heartbeatTimeoutMs = clampBetween(
    Math.min(client.heartbeatTimeoutMs, server.heartbeatTimeoutMs),
    heartbeatIntervalMs * 2,
    RelayContracts.MAX_TUNNEL_HEARTBEAT_INTERVAL_MS * 3,
  );
  const initialStreamWindowBytes = clampBetween(
    Math.min(client.initialStreamWindowBytes, server.initialStreamWindowBytes),
    RelayContracts.MIN_TUNNEL_MAX_FRAME_BYTES,
    RelayContracts.MAX_TUNNEL_STREAM_WINDOW_BYTES,
  );
  return {
    protocolVersion: RelayContracts.RELAY_TUNNEL_PROTOCOL_VERSION,
    maxFrameBytes,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    initialStreamWindowBytes,
    compression: client.compression && server.compression,
  };
}

export function createTunnelCreditWindow(initialWindowBytes: number): TunnelCreditWindow {
  const clamped = clampBetween(
    Math.trunc(initialWindowBytes),
    RelayContracts.MIN_TUNNEL_MAX_FRAME_BYTES,
    RelayContracts.MAX_TUNNEL_STREAM_WINDOW_BYTES,
  );
  return {
    initialWindowBytes: clamped,
    sendAvailableBytes: clamped,
    receiveConsumedSinceUpdateBytes: 0,
    receiveWindowRemainingBytes: clamped,
  };
}

export function consumeSendCredit(
  window: TunnelCreditWindow,
  bytes: number,
): TunnelCreditWindow | null {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > window.sendAvailableBytes) return null;
  return { ...window, sendAvailableBytes: window.sendAvailableBytes - bytes };
}

export const applyWindowUpdate = Effect.fn("relayTunnelProtocol.applyWindowUpdate")(function* (
  window: TunnelCreditWindow,
  creditBytes: number,
): Effect.fn.Return<TunnelCreditWindow, RelayTunnelProtocolError> {
  const validIncrement = yield* validateWindowIncrement(creditBytes);
  if (window.sendAvailableBytes + validIncrement > RelayContracts.MAX_TUNNEL_STREAM_WINDOW_BYTES) {
    return yield* failProtocol(
      "window_overflow",
      `Window update ${validIncrement} exceeds max ${RelayContracts.MAX_TUNNEL_STREAM_WINDOW_BYTES}.`,
    );
  }
  return { ...window, sendAvailableBytes: window.sendAvailableBytes + validIncrement };
});

export const recordReceivedBytes = Effect.fn("relayTunnelProtocol.recordReceivedBytes")(function* (
  window: TunnelCreditWindow,
  bytes: number,
): Effect.fn.Return<
  { readonly window: TunnelCreditWindow; readonly creditToSend: number },
  RelayTunnelProtocolError
> {
  if (!Number.isInteger(bytes) || bytes < 0) {
    return yield* failProtocol("invalid_payload", `Invalid received byte count ${bytes}.`);
  }
  if (bytes > window.receiveWindowRemainingBytes) {
    return yield* failProtocol(
      "window_overflow",
      `Received ${bytes} bytes exceeding remaining window ${window.receiveWindowRemainingBytes}.`,
    );
  }
  const remaining = window.receiveWindowRemainingBytes - bytes;
  const consumed = window.receiveConsumedSinceUpdateBytes + bytes;
  if (consumed >= Math.floor(window.initialWindowBytes / 2)) {
    return {
      window: {
        ...window,
        receiveConsumedSinceUpdateBytes: 0,
        receiveWindowRemainingBytes: remaining + consumed,
      },
      creditToSend: consumed,
    };
  }
  return {
    window: {
      ...window,
      receiveConsumedSinceUpdateBytes: consumed,
      receiveWindowRemainingBytes: remaining,
    },
    creditToSend: 0,
  };
});
