// @effect-diagnostics globalDate:off globalTimers:off -- TunnelSession tracks live Node WebSocket idle timeouts, RTT timestamps, and heartbeat intervals.
import type { EnvironmentId, IsoDateTime } from "@t3tools/contracts";
import {
  DEFAULT_TUNNEL_MAX_FRAME_BYTES,
  RELAY_TUNNEL_PROTOCOL_VERSION,
  type AgentVelaRelayEndpoint,
  type RelayAdminTunnelTelemetry,
  type RelayEndpointKey,
  type RelayUserId,
  type RelayUsername,
  type TunnelGoAwayReason,
  type TunnelNegotiatedCapabilities,
  type TunnelStreamResetCode,
} from "@t3tools/contracts/agentVelaRelay";
import {
  negotiateTunnelCapabilities,
  type RelayTunnelFrame,
} from "@t3tools/shared/relayTunnelProtocol";
import type { RawData, WebSocket } from "ws";

import {
  type ActiveStreamController,
  decodeFrameSync,
  encodeFrameSync,
  rawDataToUint8Array,
  type TunnelHttpStreamResponse,
  type TunnelOpenHttpInput,
  type TunnelOpenWsInput,
  TunnelStreamError,
} from "./codec.ts";
import { sendStreamDataChunked } from "./flowControl.ts";
import { startHttpTunnelStream } from "./httpStream.ts";
import { type AcceptedWsStream, startWsTunnelStream } from "./wsStream.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_STREAMS = 256;

export interface VerifiedTunnelRegistration {
  readonly environmentId: EnvironmentId;
  readonly endpointKey: RelayEndpointKey;
  readonly endpoint: AgentVelaRelayEndpoint;
  readonly label: string;
  readonly userId: RelayUserId;
  readonly username: RelayUsername;
}

export type TunnelLoginAuthResult =
  | { readonly ok: true; readonly runId: number; readonly registration: VerifiedTunnelRegistration }
  | {
      readonly ok: false;
      readonly code: "auth_invalid" | "environment_not_linked" | "internal_error";
      readonly message: string;
    };

export interface TunnelSessionCallbacks {
  readonly serverCapabilities: TunnelNegotiatedCapabilities;
  readonly authenticateLogin: (input: {
    readonly environmentId: EnvironmentId;
    readonly credential: string;
    readonly proof: string;
  }) => Promise<TunnelLoginAuthResult>;
  readonly onRegistered: (session: TunnelSession) => Promise<void>;
  readonly onClosed: (session: TunnelSession) => void;
}

export class TunnelSession {
  readonly socket: WebSocket;
  private readonly callbacks: TunnelSessionCallbacks;
  negotiated: TunnelNegotiatedCapabilities;
  phase: "awaiting_login" | "awaiting_register" | "active" | "closed" = "awaiting_login";
  runId: number | null = null;
  registration: VerifiedTunnelRegistration | null = null;
  connectedAtIso: IsoDateTime | null = null;
  lastHeartbeatAtIso: IsoDateTime | null = null;
  lastActivityMs: number;
  rttMs: number | null = null;
  bytesIn = 0;
  bytesOut = 0;

  private nextStreamId = 1;
  private nextPingSeq = 1;
  private inboxChain = Promise.resolve();
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly streams = new Map<number, ActiveStreamController>();
  private readonly creditNotifyHooks = new Map<number, Set<() => void>>();

  static attach(socket: WebSocket, callbacks: TunnelSessionCallbacks): TunnelSession {
    return new TunnelSession(socket, callbacks);
  }

  private constructor(socket: WebSocket, callbacks: TunnelSessionCallbacks) {
    this.socket = socket;
    this.callbacks = callbacks;
    this.negotiated = callbacks.serverCapabilities;
    this.lastActivityMs = Date.now();
    this.handshakeTimer = setTimeout(() => {
      if (this.phase !== "active") {
        this.closeWithReason(1008, "Handshake timed out");
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on("message", (raw: RawData) => {
      const bytes = rawDataToUint8Array(raw);
      this.bytesIn += bytes.byteLength;
      this.inboxChain = this.inboxChain
        .then(() => this.handleIncomingBytes(bytes))
        .catch(() => this.closeWithGoAway("protocol_error", "Malformed tunnel frame"));
    });
    socket.on("close", () => this.terminate());
    socket.on("error", () => this.terminate());
  }

  private get transport() {
    return {
      negotiated: this.negotiated,
      sendFrame: (frame: RelayTunnelFrame) => this.sendFrame(frame),
      sendDataChunked: (
        stream: ActiveStreamController,
        data: Uint8Array,
        endStream: boolean,
        wsText: boolean,
        signal?: AbortSignal,
      ) =>
        sendStreamDataChunked(
          {
            isStreamOpen: (id) => this.phase === "active" && this.streams.has(id),
            negotiated: this.negotiated,
            sendFrame: (frame) => this.sendFrame(frame),
            creditNotifyHooks: this.creditNotifyHooks,
          },
          stream,
          data,
          endStream,
          wsText,
          signal,
        ),
      resetStream: (streamId: number, code: "cancelled" | "protocol_error", message?: string) =>
        this.resetStream(streamId, code, message),
      deleteStream: (streamId: number) => {
        this.streams.delete(streamId);
        this.creditNotifyHooks.delete(streamId);
      },
    };
  }

  sendFrame(frame: RelayTunnelFrame): void {
    if (this.phase === "closed" || this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    const maxBytes =
      this.phase === "awaiting_login"
        ? DEFAULT_TUNNEL_MAX_FRAME_BYTES
        : this.negotiated.maxFrameBytes;
    const encoded = encodeFrameSync(frame, maxBytes);
    this.bytesOut += encoded.byteLength;
    this.socket.send(encoded);
  }

  private resetStream(streamId: number, code: TunnelStreamResetCode, message?: string): void {
    if (this.streams.has(streamId)) {
      this.sendFrame({
        type: "rst",
        streamId,
        payload: { code, ...(message ? { message } : {}) },
      });
    }
    this.streams.delete(streamId);
    this.creditNotifyHooks.delete(streamId);
  }

  private async handleIncomingBytes(bytes: Uint8Array): Promise<void> {
    if (this.phase === "closed") {
      return;
    }
    this.lastActivityMs = Date.now();
    const maxBytes =
      this.phase === "awaiting_login"
        ? DEFAULT_TUNNEL_MAX_FRAME_BYTES
        : this.negotiated.maxFrameBytes;
    const frame = decodeFrameSync(bytes, maxBytes);

    if (frame.streamId === 0) {
      await this.handleControlFrame(frame);
      return;
    }
    if (this.phase !== "active") {
      this.closeWithGoAway("protocol_error", "Stream frame before handshake completion");
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      return;
    }
    stream.onFrame(frame);
    if (frame.type === "window_update") {
      for (const wake of this.creditNotifyHooks.get(frame.streamId) ?? []) {
        wake();
      }
    }
  }

  private async handleLoginFrame(
    frame: Extract<RelayTunnelFrame, { readonly type: "login" }>,
  ): Promise<void> {
    if (frame.payload.capabilities.protocolVersion !== RELAY_TUNNEL_PROTOCOL_VERSION) {
      this.sendFrame({
        type: "login_resp",
        streamId: 0,
        payload: { ok: false, code: "protocol_mismatch", message: "Incompatible protocol version" },
      });
      this.closeWithReason(1008, "Incompatible protocol version");
      return;
    }
    const negotiated = negotiateTunnelCapabilities(
      frame.payload.capabilities,
      this.callbacks.serverCapabilities,
    );
    const auth = await this.callbacks.authenticateLogin({
      environmentId: frame.payload.environmentId,
      credential: frame.payload.credential,
      proof: frame.payload.proof,
    });
    if (!auth.ok) {
      this.sendFrame({
        type: "login_resp",
        streamId: 0,
        payload: { ok: false, code: auth.code, message: auth.message },
      });
      this.closeWithReason(1008, auth.message);
      return;
    }
    this.negotiated = negotiated;
    this.runId = auth.runId;
    this.registration = auth.registration;
    this.phase = "awaiting_register";
    this.sendFrame({
      type: "login_resp",
      streamId: 0,
      payload: { ok: true, runId: auth.runId, negotiated },
    });
  }

  private async handleRegisterProxyFrame(
    frame: Extract<RelayTunnelFrame, { readonly type: "register_proxy" }>,
  ): Promise<void> {
    if (!this.registration) {
      return;
    }
    if (
      frame.payload.environmentId !== this.registration.environmentId ||
      (frame.payload.endpointKey !== undefined &&
        frame.payload.endpointKey !== this.registration.endpointKey)
    ) {
      this.sendFrame({
        type: "register_proxy_resp",
        streamId: 0,
        payload: { ok: false, code: "conflict", message: "Environment identity mismatch" },
      });
      this.closeWithReason(1008, "Environment identity mismatch");
      return;
    }
    this.phase = "active";
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    const nowIso = new Date().toISOString() as IsoDateTime;
    this.connectedAtIso = nowIso;
    this.lastHeartbeatAtIso = nowIso;
    this.registration = { ...this.registration, label: frame.payload.label };
    await this.callbacks.onRegistered(this);
    this.sendFrame({
      type: "register_proxy_resp",
      streamId: 0,
      payload: { ok: true, endpoint: this.registration.endpoint },
    });
    this.startHeartbeatLoop();
  }

  private async handleControlFrame(frame: RelayTunnelFrame): Promise<void> {
    if (frame.type === "login" && this.phase === "awaiting_login") {
      await this.handleLoginFrame(frame);
      return;
    }
    if (frame.type === "register_proxy" && this.phase === "awaiting_register") {
      await this.handleRegisterProxyFrame(frame);
      return;
    }
    if (frame.type === "ping" && this.phase === "active") {
      this.lastHeartbeatAtIso = new Date().toISOString() as IsoDateTime;
      this.sendFrame({
        type: "pong",
        streamId: 0,
        payload: { seq: frame.payload.seq, sentAtMs: frame.payload.sentAtMs },
      });
      return;
    }
    if (frame.type === "pong" && this.phase === "active") {
      const nowMs = Date.now();
      this.lastHeartbeatAtIso = new Date(nowMs).toISOString() as IsoDateTime;
      this.rttMs = Math.max(0, nowMs - frame.payload.sentAtMs);
      return;
    }
    if (frame.type === "goaway") {
      this.terminate();
      return;
    }
    this.closeWithGoAway(
      "protocol_error",
      `Unexpected control frame '${frame.type}' in ${this.phase}`,
    );
  }

  private startHeartbeatLoop(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.phase !== "active") {
        return;
      }
      const nowMs = Date.now();
      if (nowMs - this.lastActivityMs > this.negotiated.heartbeatTimeoutMs) {
        this.closeWithGoAway("heartbeat_timeout", "Tunnel heartbeat timed out");
        return;
      }
      this.sendFrame({
        type: "ping",
        streamId: 0,
        payload: { seq: this.nextPingSeq++, sentAtMs: nowMs },
      });
    }, this.negotiated.heartbeatIntervalMs);
  }

  openHttp(input: TunnelOpenHttpInput): Promise<TunnelHttpStreamResponse> {
    if (this.phase !== "active") {
      return Promise.reject(
        new TunnelStreamError({ reason: "offline", message: "Tunnel is offline" }),
      );
    }
    if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
      return Promise.reject(
        new TunnelStreamError({
          reason: "stream_limit",
          message: "Tunnel concurrent stream limit reached",
        }),
      );
    }
    const streamId = this.nextStreamId;
    this.nextStreamId += 2;
    return startHttpTunnelStream(this.transport, streamId, input, (controller) => {
      this.streams.set(streamId, controller);
    });
  }

  openWs(input: TunnelOpenWsInput): Promise<AcceptedWsStream> {
    if (this.phase !== "active") {
      return Promise.reject(
        new TunnelStreamError({ reason: "offline", message: "Tunnel is offline" }),
      );
    }
    if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
      return Promise.reject(
        new TunnelStreamError({
          reason: "stream_limit",
          message: "Tunnel concurrent stream limit reached",
        }),
      );
    }
    const streamId = this.nextStreamId;
    this.nextStreamId += 2;
    return startWsTunnelStream(this.transport, streamId, input, (controller) => {
      this.streams.set(streamId, controller);
    });
  }

  closeWithGoAway(reason: TunnelGoAwayReason, message?: string): void {
    if (this.phase === "closed") {
      return;
    }
    if (this.runId !== null) {
      this.sendFrame({
        type: "goaway",
        streamId: 0,
        payload: { runId: this.runId, reason, ...(message ? { message } : {}) },
      });
    }
    this.closeWithReason(1001, message ?? reason);
  }

  private closeWithReason(code: number, reason: string): void {
    this.terminate();
    if (
      this.socket.readyState === this.socket.OPEN ||
      this.socket.readyState === this.socket.CONNECTING
    ) {
      this.socket.close(code, reason.slice(0, 120));
    }
  }

  private terminate(): void {
    if (this.phase === "closed") {
      return;
    }
    const wasActive = this.phase === "active";
    this.phase = "closed";
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const offlineErr = new TunnelStreamError({ reason: "offline", message: "Tunnel disconnected" });
    for (const controller of Array.from(this.streams.values())) {
      controller.onForceClose(offlineErr);
    }
    this.streams.clear();
    for (const hooks of this.creditNotifyHooks.values()) {
      for (const wake of hooks) {
        wake();
      }
    }
    this.creditNotifyHooks.clear();
    if (wasActive) {
      this.callbacks.onClosed(this);
    }
  }

  toTelemetry(): RelayAdminTunnelTelemetry | null {
    if (!this.registration || !this.runId || !this.connectedAtIso || !this.lastHeartbeatAtIso) {
      return null;
    }
    return {
      environmentId: this.registration.environmentId,
      endpointKey: this.registration.endpointKey,
      label: this.registration.label,
      userId: this.registration.userId,
      username: this.registration.username,
      runId: this.runId,
      connectedAt: this.connectedAtIso,
      lastHeartbeatAt: this.lastHeartbeatAtIso,
      rttMs: this.rttMs,
      activeStreams: this.streams.size,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      compression: this.negotiated.compression,
    };
  }
}
