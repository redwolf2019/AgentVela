import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { RelayEndpointKey } from "./auth.ts";
import { AgentVelaRelayEndpoint } from "./environments.ts";

export const RELAY_TUNNEL_PROTOCOL_VERSION = 1 as const;
export const RELAY_TUNNEL_HEADER_BYTES = 11 as const;

export const DEFAULT_TUNNEL_MAX_FRAME_BYTES = 262_144;
export const MIN_TUNNEL_MAX_FRAME_BYTES = 16_384;
export const MAX_TUNNEL_MAX_FRAME_BYTES = 1_048_576;

export const DEFAULT_TUNNEL_INITIAL_STREAM_WINDOW_BYTES = 524_288;
export const MAX_TUNNEL_STREAM_WINDOW_BYTES = 4_194_304;

export const DEFAULT_TUNNEL_HEARTBEAT_INTERVAL_MS = 20_000;
export const MIN_TUNNEL_HEARTBEAT_INTERVAL_MS = 5_000;
export const MAX_TUNNEL_HEARTBEAT_INTERVAL_MS = 120_000;
export const DEFAULT_TUNNEL_HEARTBEAT_TIMEOUT_MS = 60_000;

export const RelayTunnelFrameType = {
  LOGIN: 0x01,
  LOGIN_RESP: 0x02,
  REGISTER_PROXY: 0x03,
  REGISTER_PROXY_RESP: 0x04,
  PING: 0x05,
  PONG: 0x06,
  GOAWAY: 0x07,
  OPEN_HTTP: 0x10,
  HTTP_RESPONSE: 0x11,
  OPEN_WS: 0x12,
  WS_ACCEPT: 0x13,
  DATA: 0x14,
  WINDOW_UPDATE: 0x15,
  END: 0x16,
  RST: 0x17,
} as const;
export type RelayTunnelFrameOpcode =
  (typeof RelayTunnelFrameType)[keyof typeof RelayTunnelFrameType];

export const RELAY_TUNNEL_FLAG_END_STREAM = 0x01;
export const RELAY_TUNNEL_FLAG_COMPRESSED = 0x02;
export const RELAY_TUNNEL_FLAG_WS_TEXT = 0x04;
export const RELAY_TUNNEL_KNOWN_FLAGS =
  RELAY_TUNNEL_FLAG_END_STREAM | RELAY_TUNNEL_FLAG_COMPRESSED | RELAY_TUNNEL_FLAG_WS_TEXT;

export const TunnelCapabilities = Schema.Struct({
  protocolVersion: Schema.Literal(RELAY_TUNNEL_PROTOCOL_VERSION),
  maxFrameBytes: Schema.Int.check(
    Schema.isBetween({ minimum: MIN_TUNNEL_MAX_FRAME_BYTES, maximum: MAX_TUNNEL_MAX_FRAME_BYTES }),
  ),
  heartbeatIntervalMs: Schema.Int.check(
    Schema.isBetween({
      minimum: MIN_TUNNEL_HEARTBEAT_INTERVAL_MS,
      maximum: MAX_TUNNEL_HEARTBEAT_INTERVAL_MS,
    }),
  ),
  heartbeatTimeoutMs: Schema.Int.check(
    Schema.isBetween({
      minimum: MIN_TUNNEL_HEARTBEAT_INTERVAL_MS * 2,
      maximum: MAX_TUNNEL_HEARTBEAT_INTERVAL_MS * 3,
    }),
  ),
  initialStreamWindowBytes: Schema.Int.check(
    Schema.isBetween({
      minimum: MIN_TUNNEL_MAX_FRAME_BYTES,
      maximum: MAX_TUNNEL_STREAM_WINDOW_BYTES,
    }),
  ),
  compression: Schema.Boolean,
});
export type TunnelCapabilities = typeof TunnelCapabilities.Type;

export const TunnelNegotiatedCapabilities = TunnelCapabilities;
export type TunnelNegotiatedCapabilities = typeof TunnelNegotiatedCapabilities.Type;

export const TunnelLoginPayload = Schema.Struct({
  environmentId: EnvironmentId,
  credential: TrimmedNonEmptyString,
  proof: TrimmedNonEmptyString,
  capabilities: TunnelCapabilities,
});
export type TunnelLoginPayload = typeof TunnelLoginPayload.Type;

export const TunnelLoginRespPayload = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    runId: PositiveInt,
    negotiated: TunnelNegotiatedCapabilities,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: Schema.Literals([
      "auth_invalid",
      "protocol_mismatch",
      "environment_not_linked",
      "internal_error",
    ]),
    message: Schema.String,
  }),
]);
export type TunnelLoginRespPayload = typeof TunnelLoginRespPayload.Type;

export const TunnelRegisterProxyPayload = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  endpointKey: Schema.optionalKey(RelayEndpointKey),
});
export type TunnelRegisterProxyPayload = typeof TunnelRegisterProxyPayload.Type;

export const TunnelRegisterProxyRespPayload = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    endpoint: AgentVelaRelayEndpoint,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: Schema.Literals(["unauthorized", "conflict", "invalid_input", "internal_error"]),
    message: Schema.String,
  }),
]);
export type TunnelRegisterProxyRespPayload = typeof TunnelRegisterProxyRespPayload.Type;

export const TunnelPingPayload = Schema.Struct({
  seq: NonNegativeInt,
  sentAtMs: NonNegativeInt,
});
export type TunnelPingPayload = typeof TunnelPingPayload.Type;

export const TunnelPongPayload = Schema.Struct({
  seq: NonNegativeInt,
  sentAtMs: NonNegativeInt,
});
export type TunnelPongPayload = typeof TunnelPongPayload.Type;

export const TunnelGoAwayReason = Schema.Literals([
  "superseded",
  "kicked",
  "server_shutdown",
  "heartbeat_timeout",
  "protocol_error",
]);
export type TunnelGoAwayReason = typeof TunnelGoAwayReason.Type;

export const TunnelGoAwayPayload = Schema.Struct({
  runId: PositiveInt,
  reason: TunnelGoAwayReason,
  message: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TunnelGoAwayPayload = typeof TunnelGoAwayPayload.Type;

// Tuple list preserves duplicate header names such as multiple Set-Cookie headers.
export const TunnelHttpHeader = Schema.Tuple([Schema.String, Schema.String]);
export type TunnelHttpHeader = typeof TunnelHttpHeader.Type;

export const TunnelHttpMethod = Schema.Literals([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
export type TunnelHttpMethod = typeof TunnelHttpMethod.Type;

export const TunnelExternalProto = Schema.Literals(["http", "https"]);
export type TunnelExternalProto = typeof TunnelExternalProto.Type;

export const TunnelOpenHttpPayload = Schema.Struct({
  method: TunnelHttpMethod,
  path: Schema.String.check(Schema.isMinLength(1)),
  headers: Schema.Array(TunnelHttpHeader),
  hasBody: Schema.Boolean,
  externalHost: TrimmedNonEmptyString,
  externalProto: TunnelExternalProto,
  pathPrefix: TrimmedNonEmptyString,
  remoteAddr: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TunnelOpenHttpPayload = typeof TunnelOpenHttpPayload.Type;

export const TunnelHttpResponsePayload = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  headers: Schema.Array(TunnelHttpHeader),
  hasBody: Schema.Boolean,
});
export type TunnelHttpResponsePayload = typeof TunnelHttpResponsePayload.Type;

export const TunnelOpenWsPayload = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
  headers: Schema.Array(TunnelHttpHeader),
  protocols: Schema.Array(Schema.String),
  externalHost: TrimmedNonEmptyString,
  externalProto: TunnelExternalProto,
  pathPrefix: TrimmedNonEmptyString,
  remoteAddr: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TunnelOpenWsPayload = typeof TunnelOpenWsPayload.Type;

export const TunnelWsAcceptPayload = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    protocol: Schema.optionalKey(Schema.String),
    headers: Schema.Array(TunnelHttpHeader),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
    message: Schema.optionalKey(Schema.String),
  }),
]);
export type TunnelWsAcceptPayload = typeof TunnelWsAcceptPayload.Type;

export const TunnelStreamEndPayload = Schema.Struct({
  closeCode: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 4999 })),
  ),
  closeReason: Schema.optionalKey(Schema.String),
});
export type TunnelStreamEndPayload = typeof TunnelStreamEndPayload.Type;

export const TunnelStreamResetCode = Schema.Literals([
  "cancelled",
  "flow_control_error",
  "frame_size_error",
  "origin_unreachable",
  "origin_timeout",
  "protocol_error",
  "stream_limit",
  "internal_error",
]);
export type TunnelStreamResetCode = typeof TunnelStreamResetCode.Type;

export const TunnelStreamResetPayload = Schema.Struct({
  code: TunnelStreamResetCode,
  message: Schema.optionalKey(Schema.String),
});
export type TunnelStreamResetPayload = typeof TunnelStreamResetPayload.Type;
