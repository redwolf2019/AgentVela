import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_TUNNEL_INITIAL_STREAM_WINDOW_BYTES,
  DEFAULT_TUNNEL_MAX_FRAME_BYTES,
  MAX_TUNNEL_MAX_FRAME_BYTES,
  MAX_TUNNEL_STREAM_WINDOW_BYTES,
  MIN_TUNNEL_MAX_FRAME_BYTES,
  RELAY_TUNNEL_HEADER_BYTES,
  RelayEndpointKey,
  RelayTunnelFrameType,
  type TunnelCapabilities,
} from "@t3tools/contracts/agentVelaRelay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  applyWindowUpdate,
  consumeSendCredit,
  createTunnelCreditWindow,
  decodeRelayTunnelFrame,
  encodeRelayTunnelFrame,
  negotiateTunnelCapabilities,
  recordReceivedBytes,
  type RelayTunnelFrame,
} from "./relayTunnelProtocol.ts";

const makeEnvironmentId = Schema.decodeUnknownSync(EnvironmentId);
const makeEndpointKey = Schema.decodeUnknownSync(RelayEndpointKey);

const sampleCapabilities: TunnelCapabilities = {
  protocolVersion: 1,
  maxFrameBytes: DEFAULT_TUNNEL_MAX_FRAME_BYTES,
  heartbeatIntervalMs: 20_000,
  heartbeatTimeoutMs: 60_000,
  initialStreamWindowBytes: DEFAULT_TUNNEL_INITIAL_STREAM_WINDOW_BYTES,
  compression: true,
};

const roundTripCases: ReadonlyArray<readonly [string, RelayTunnelFrame]> = [
  [
    "login",
    {
      type: "login",
      streamId: 0,
      payload: {
        environmentId: makeEnvironmentId("env-1"),
        credential: "cred-secret",
        proof: "jwt-proof",
        capabilities: sampleCapabilities,
      },
    },
  ],
  [
    "login_resp ok",
    {
      type: "login_resp",
      streamId: 0,
      payload: {
        ok: true,
        runId: 7,
        negotiated: sampleCapabilities,
      },
    },
  ],
  [
    "login_resp fail",
    {
      type: "login_resp",
      streamId: 0,
      payload: {
        ok: false,
        code: "auth_invalid",
        message: "invalid credential",
      },
    },
  ],
  [
    "register_proxy",
    {
      type: "register_proxy",
      streamId: 0,
      payload: {
        environmentId: makeEnvironmentId("env-1"),
        label: "Linux Workstation",
        endpointKey: makeEndpointKey("host-alpha"),
      },
    },
  ],
  [
    "register_proxy_resp",
    {
      type: "register_proxy_resp",
      streamId: 0,
      payload: {
        ok: true,
        endpoint: {
          endpointKey: makeEndpointKey("host-alpha"),
          pathPrefix: "/e/host-alpha",
          httpBaseUrl: "https://relay.example.com/e/host-alpha",
          wsBaseUrl: "wss://relay.example.com/e/host-alpha",
        },
      },
    },
  ],
  ["ping", { type: "ping", streamId: 0, payload: { seq: 42, sentAtMs: 1_700_000_000_000 } }],
  ["pong", { type: "pong", streamId: 0, payload: { seq: 42, sentAtMs: 1_700_000_000_000 } }],
  [
    "goaway",
    {
      type: "goaway",
      streamId: 0,
      payload: { runId: 7, reason: "superseded", message: "newer tunnel connected" },
    },
  ],
  [
    "open_http",
    {
      type: "open_http",
      streamId: 1,
      payload: {
        method: "POST",
        path: "/oauth/token",
        headers: [
          ["content-type", "application/json"],
          ["x-custom", "one"],
          ["x-custom", "two"],
        ],
        hasBody: true,
        externalHost: "relay.example.com",
        externalProto: "https",
        pathPrefix: "/e/host-alpha",
        remoteAddr: "198.51.100.9",
      },
    },
  ],
  [
    "http_response",
    {
      type: "http_response",
      streamId: 1,
      payload: {
        status: 204,
        headers: [
          ["set-cookie", "s=1; HttpOnly"],
          ["set-cookie", "csrf=2"],
        ],
        hasBody: false,
      },
    },
  ],
  [
    "open_ws",
    {
      type: "open_ws",
      streamId: 2,
      payload: {
        path: "/ws",
        headers: [["origin", "https://relay.example.com"]],
        protocols: ["t3.v2"],
        externalHost: "relay.example.com",
        externalProto: "https",
        pathPrefix: "/e/host-alpha",
      },
    },
  ],
  [
    "ws_accept ok",
    {
      type: "ws_accept",
      streamId: 2,
      payload: {
        ok: true,
        protocol: "t3.v2",
        headers: [["x-accepted", "1"]],
      },
    },
  ],
  [
    "ws_accept fail",
    {
      type: "ws_accept",
      streamId: 2,
      payload: {
        ok: false,
        status: 401,
        message: "Unauthorized",
      },
    },
  ],
  [
    "data binary + compressed + endStream",
    {
      type: "data",
      streamId: 3,
      payload: new Uint8Array([1, 2, 3, 255]),
      endStream: true,
      compressed: true,
      wsText: false,
    },
  ],
  [
    "data ws text",
    {
      type: "data",
      streamId: 4,
      payload: new TextEncoder().encode('{"ok":true}'),
      endStream: false,
      compressed: false,
      wsText: true,
    },
  ],
  ["window_update", { type: "window_update", streamId: 3, creditBytes: 65_536 }],
  ["end empty", { type: "end", streamId: 1, payload: {} }],
  ["end ws close", { type: "end", streamId: 2, payload: { closeCode: 1000, closeReason: "done" } }],
  [
    "rst",
    {
      type: "rst",
      streamId: 5,
      payload: { code: "origin_unreachable", message: "connection refused" },
    },
  ],
];

function rawFrame(
  version: number,
  opcode: number,
  flags: number,
  streamId: number,
  payload: Uint8Array,
  declaredLen?: number,
) {
  const bytes = new Uint8Array(RELAY_TUNNEL_HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, version);
  view.setUint8(1, opcode);
  view.setUint8(2, flags);
  view.setUint32(3, streamId, false);
  view.setUint32(7, declaredLen ?? payload.byteLength, false);
  bytes.set(payload, RELAY_TUNNEL_HEADER_BYTES);
  return bytes;
}

describe("relayTunnelProtocol framing", () => {
  it.effect.each(roundTripCases)("round-trips %s frame", ([, frame]) =>
    Effect.gen(function* () {
      const encoded = yield* encodeRelayTunnelFrame(frame);
      const decoded = yield* decodeRelayTunnelFrame(encoded);
      expect(decoded).toEqual(frame);
    }),
  );

  it.effect("encodes empty END frame as header-only 11 bytes", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeRelayTunnelFrame({ type: "end", streamId: 9, payload: {} });
      expect(encoded.byteLength).toBe(RELAY_TUNNEL_HEADER_BYTES);
    }),
  );

  it.effect("rejects malformed, mismatched, and oversized frames", () =>
    Effect.gen(function* () {
      const shortErr = yield* Effect.flip(decodeRelayTunnelFrame(new Uint8Array(10)));
      expect(shortErr.code).toBe("frame_too_short");

      const versionErr = yield* Effect.flip(
        decodeRelayTunnelFrame(rawFrame(2, RelayTunnelFrameType.PING, 0, 0, new Uint8Array(0))),
      );
      expect(versionErr.code).toBe("unsupported_version");

      const opcodeErr = yield* Effect.flip(
        decodeRelayTunnelFrame(rawFrame(1, 0x7f, 0, 0, new Uint8Array(0))),
      );
      expect(opcodeErr.code).toBe("unknown_type");

      const unknownFlagErr = yield* Effect.flip(
        decodeRelayTunnelFrame(rawFrame(1, RelayTunnelFrameType.DATA, 0x80, 1, new Uint8Array(1))),
      );
      expect(unknownFlagErr.code).toBe("invalid_flags");

      const nonDataFlagErr = yield* Effect.flip(
        decodeRelayTunnelFrame(rawFrame(1, RelayTunnelFrameType.END, 0x01, 1, new Uint8Array(0))),
      );
      expect(nonDataFlagErr.code).toBe("invalid_flags");

      const controlStreamErr = yield* Effect.flip(
        decodeRelayTunnelFrame(rawFrame(1, RelayTunnelFrameType.PING, 0, 1, new Uint8Array(0))),
      );
      expect(controlStreamErr.code).toBe("invalid_stream_id");

      const dataStreamErr = yield* Effect.flip(
        decodeRelayTunnelFrame(rawFrame(1, RelayTunnelFrameType.DATA, 0, 0, new Uint8Array(0))),
      );
      expect(dataStreamErr.code).toBe("invalid_stream_id");

      const lenMismatchErr = yield* Effect.flip(
        decodeRelayTunnelFrame(rawFrame(1, RelayTunnelFrameType.DATA, 0, 1, new Uint8Array(3), 5)),
      );
      expect(lenMismatchErr.code).toBe("payload_length_mismatch");

      const oversizedPayload = new Uint8Array(MIN_TUNNEL_MAX_FRAME_BYTES + 1);
      const encodeBigErr = yield* Effect.flip(
        encodeRelayTunnelFrame(
          {
            type: "data",
            streamId: 1,
            payload: oversizedPayload,
            endStream: false,
            compressed: false,
            wsText: false,
          },
          { maxFrameBytes: MIN_TUNNEL_MAX_FRAME_BYTES },
        ),
      );
      expect(encodeBigErr.code).toBe("frame_too_large");

      const decodeBigErr = yield* Effect.flip(
        decodeRelayTunnelFrame(rawFrame(1, RelayTunnelFrameType.DATA, 0, 1, oversizedPayload), {
          maxFrameBytes: MIN_TUNNEL_MAX_FRAME_BYTES,
        }),
      );
      expect(decodeBigErr.code).toBe("frame_too_large");

      const badJsonErr = yield* Effect.flip(
        decodeRelayTunnelFrame(
          rawFrame(1, RelayTunnelFrameType.PING, 0, 0, new TextEncoder().encode("{bad")),
        ),
      );
      expect(badJsonErr.code).toBe("invalid_payload");

      const badUtf8Err = yield* Effect.flip(
        decodeRelayTunnelFrame(
          rawFrame(1, RelayTunnelFrameType.PING, 0, 0, new Uint8Array([0xff, 0xfe])),
        ),
      );
      expect(badUtf8Err.code).toBe("invalid_payload");

      const badWindowLenErr = yield* Effect.flip(
        decodeRelayTunnelFrame(
          rawFrame(1, RelayTunnelFrameType.WINDOW_UPDATE, 0, 1, new Uint8Array([0, 1])),
        ),
      );
      expect(badWindowLenErr.code).toBe("invalid_payload");

      const zeroWindowErr = yield* Effect.flip(
        encodeRelayTunnelFrame({ type: "window_update", streamId: 1, creditBytes: 0 }),
      );
      expect(zeroWindowErr.code).toBe("window_overflow");
    }),
  );
});

describe("negotiateTunnelCapabilities & TunnelCreditWindow", () => {
  it("negotiates conservative capabilities within protocol limits", () => {
    const client: TunnelCapabilities = {
      protocolVersion: 1,
      maxFrameBytes: MAX_TUNNEL_MAX_FRAME_BYTES,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      initialStreamWindowBytes: MAX_TUNNEL_STREAM_WINDOW_BYTES,
      compression: true,
    };
    const server: TunnelCapabilities = {
      protocolVersion: 1,
      maxFrameBytes: 65_536,
      heartbeatIntervalMs: 25_000,
      heartbeatTimeoutMs: 40_000,
      initialStreamWindowBytes: 262_144,
      compression: false,
    };

    expect(negotiateTunnelCapabilities(client, server)).toEqual({
      protocolVersion: 1,
      maxFrameBytes: 65_536,
      heartbeatIntervalMs: 25_000,
      heartbeatTimeoutMs: 50_000,
      initialStreamWindowBytes: 262_144,
      compression: false,
    });
  });

  it.effect(
    "tracks send credit, blocks exhaustion, refills at >=50%, and prevents window overflow",
    () =>
      Effect.gen(function* () {
        const initial = createTunnelCreditWindow(MIN_TUNNEL_MAX_FRAME_BYTES);
        const afterSend = consumeSendCredit(initial, 10_000);
        expect(afterSend?.sendAvailableBytes).toBe(MIN_TUNNEL_MAX_FRAME_BYTES - 10_000);
        expect(consumeSendCredit(afterSend!, 10_000)).toBeNull();

        const replenished = yield* applyWindowUpdate(afterSend!, 10_000);
        expect(replenished.sendAvailableBytes).toBe(MIN_TUNNEL_MAX_FRAME_BYTES);

        const overflowErr = yield* Effect.flip(
          applyWindowUpdate(replenished, MAX_TUNNEL_STREAM_WINDOW_BYTES),
        );
        expect(overflowErr.code).toBe("window_overflow");

        const recv1 = yield* recordReceivedBytes(initial, 4_000);
        expect(recv1.creditToSend).toBe(0);
        expect(recv1.window.receiveWindowRemainingBytes).toBe(MIN_TUNNEL_MAX_FRAME_BYTES - 4_000);

        const recv2 = yield* recordReceivedBytes(recv1.window, 5_000);
        expect(recv2.creditToSend).toBe(9_000);
        expect(recv2.window.receiveConsumedSinceUpdateBytes).toBe(0);
        expect(recv2.window.receiveWindowRemainingBytes).toBe(MIN_TUNNEL_MAX_FRAME_BYTES);

        const recvViolation = yield* Effect.flip(
          recordReceivedBytes(recv2.window, MIN_TUNNEL_MAX_FRAME_BYTES + 1),
        );
        expect(recvViolation.code).toBe("window_overflow");
      }),
  );
});
