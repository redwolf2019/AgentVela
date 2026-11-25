// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off -- Tunnel session manages a live Node ws socket, heartbeats, and handshake deadlines.
import {
  type EnvironmentId,
  type IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  DEFAULT_TUNNEL_HEARTBEAT_INTERVAL_MS,
  DEFAULT_TUNNEL_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_TUNNEL_INITIAL_STREAM_WINDOW_BYTES,
  DEFAULT_TUNNEL_MAX_FRAME_BYTES,
  RELAY_TUNNEL_CONNECT_PATH,
  RELAY_TUNNEL_PROTOCOL_VERSION,
  type AgentVelaRelayEndpoint,
  type HostRelayTunnelSnapshot,
  type RelayEndpointKey,
  type TunnelGoAwayReason,
  type TunnelNegotiatedCapabilities,
  type TunnelStreamResetCode,
} from "@t3tools/contracts/agentVelaRelay";
import type { RelayTunnelFrame } from "@t3tools/shared/relayTunnelProtocol";
import { parseRelayUrl } from "@t3tools/shared/relayUrl";
import { type RawData, WebSocket } from "ws";

import {
  type ActiveLocalStream,
  type LocalForwarderHost,
  openLocalHttpStream,
  openLocalWsStream,
} from "./localForwarder.ts";
import { decodeFrameSync, encodeFrameSync, rawDataToUint8Array } from "./tunnelCodec.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_STREAMS = 256;

const CLIENT_CAPABILITIES: TunnelNegotiatedCapabilities = {
  protocolVersion: RELAY_TUNNEL_PROTOCOL_VERSION,
  maxFrameBytes: DEFAULT_TUNNEL_MAX_FRAME_BYTES,
  heartbeatIntervalMs: DEFAULT_TUNNEL_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: DEFAULT_TUNNEL_HEARTBEAT_TIMEOUT_MS,
  initialStreamWindowBytes: DEFAULT_TUNNEL_INITIAL_STREAM_WINDOW_BYTES,
  compression: true,
};

export interface TunnelSessionCloseOutcome {
  readonly shouldReconnect: boolean;
  readonly reason: string;
  readonly terminalError?: string;
}

export interface RelayTunnelSessionOptions {
  readonly relayUrl: string;
  readonly environmentId: EnvironmentId;
  readonly environmentCredential: string;
  readonly endpointKey: RelayEndpointKey;
  readonly label: string;
  readonly localHost: string;
  readonly localPort: number;
  readonly signLoginProof: () => Promise<string>;
  readonly onSnapshot: (
    snapshot: HostRelayTunnelSnapshot,
    endpoint?: AgentVelaRelayEndpoint,
  ) => void;
  readonly onClosed: (outcome: TunnelSessionCloseOutcome) => void;
}

function isTerminalLoginCode(code: string): boolean {
  return (
    code === "auth_invalid" || code === "environment_not_linked" || code === "protocol_mismatch"
  );
}

function isTerminalRegisterCode(code: string): boolean {
  return code === "unauthorized" || code === "conflict" || code === "invalid_input";
}

function goAwayShouldReconnect(reason: TunnelGoAwayReason): boolean {
  return reason !== "kicked" && reason !== "superseded";
}

export class RelayTunnelSession {
  private readonly options: RelayTunnelSessionOptions;
  private readonly ws: WebSocket;
  private negotiated: TunnelNegotiatedCapabilities = CLIENT_CAPABILITIES;
  private phase: "connecting" | "awaiting_login" | "awaiting_register" | "active" | "closed" =
    "connecting";
  private closedNotified = false;
  private runId: typeof PositiveInt.Type | null = null;
  private rttMs: typeof NonNegativeInt.Type | null = null;
  private connectedAt: IsoDateTime | null = null;
  private lastError: string | null = null;
  private lastActivityMs: number = Date.now();
  private nextPingSeq = 1;
  private goawayOutcome: TunnelSessionCloseOutcome | null = null;
  private terminalOutcome: TunnelSessionCloseOutcome | null = null;

  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private inboxChain: Promise<void> = Promise.resolve();
  private readonly streams = new Map<number, ActiveLocalStream>();
  private readonly creditWaiters = new Map<number, Set<() => void>>();

  static connect(options: RelayTunnelSessionOptions): RelayTunnelSession {
    return new RelayTunnelSession(options);
  }

  private constructor(options: RelayTunnelSessionOptions) {
    this.options = options;
    const parsed = parseRelayUrl(options.relayUrl);
    if (!parsed) {
      throw new Error(`Invalid relay URL for tunnel session: ${options.relayUrl}`);
    }
    const targetUrl = `${parsed.wsOrigin}${RELAY_TUNNEL_CONNECT_PATH}`;
    this.ws = new WebSocket(targetUrl, {
      perMessageDeflate: false,
      handshakeTimeout: WS_CONNECT_TIMEOUT_MS,
    });
    this.emitSnapshot("connecting");

    this.handshakeTimer = setTimeout(() => {
      if (this.phase !== "active" && this.phase !== "closed") {
        this.lastError = "Relay tunnel handshake timed out";
        this.ws.terminate();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    this.ws.on("open", () => {
      this.inboxChain = this.inboxChain
        .then(() => this.sendLoginFrame())
        .catch((err) => {
          this.terminalOutcome = {
            shouldReconnect: false,
            reason: "login_proof_failed",
            terminalError: err instanceof Error ? err.message : String(err),
          };
          this.closeSocket(1008, "Failed to sign tunnel login proof");
        });
    });

    this.ws.on("message", (raw: RawData) => {
      const bytes = rawDataToUint8Array(raw);
      this.inboxChain = this.inboxChain
        .then(() => this.handleIncomingBytes(bytes))
        .catch(() => {
          this.lastError = "Malformed tunnel frame from relay";
          this.closeSocket(1002, "Malformed tunnel frame");
        });
    });

    this.ws.on("error", (err) => {
      this.lastError = err.message;
    });

    this.ws.on("close", (_code, reasonBuf) => {
      this.handleClosed(reasonBuf.toString("utf8"));
    });
  }

  private get forwarderHost(): LocalForwarderHost {
    return {
      localHost: this.options.localHost,
      localPort: this.options.localPort,
      negotiated: this.negotiated,
      isStreamActive: (id) => this.phase === "active" && this.streams.has(id),
      sendFrame: (frame) => this.sendFrame(frame),
      sendReset: (streamId, code, message) => this.sendReset(streamId, code, message),
      unregisterStream: (streamId) => {
        this.streams.delete(streamId);
        this.creditWaiters.delete(streamId);
        if (this.phase === "active") this.emitSnapshot("online");
      },
      addCreditWaiter: (streamId, wake) => {
        let set = this.creditWaiters.get(streamId);
        if (!set) {
          set = new Set();
          this.creditWaiters.set(streamId, set);
        }
        set.add(wake);
        return () => set.delete(wake);
      },
    };
  }

  snapshot(state: HostRelayTunnelSnapshot["state"] = "connecting"): HostRelayTunnelSnapshot {
    return {
      state,
      runId: this.runId,
      rttMs: this.rttMs,
      activeStreams: NonNegativeInt.make(this.streams.size),
      connectedAt: this.connectedAt,
      lastError: this.lastError,
      compression: this.negotiated.compression,
    };
  }

  closeGracefully(reason = "Client disconnecting"): void {
    if (this.phase === "closed") return;
    if (this.ws.readyState === this.ws.OPEN && this.runId !== null) {
      this.sendFrame({
        type: "goaway",
        streamId: 0,
        payload: { runId: this.runId, reason: "server_shutdown" },
      });
    }
    this.phase = "closed";
    this.terminalOutcome = { shouldReconnect: false, reason };
    this.cleanupResources();
    this.closeSocket(1000, reason);
  }

  private emitSnapshot(
    state: HostRelayTunnelSnapshot["state"],
    endpoint?: AgentVelaRelayEndpoint,
  ): void {
    if (this.phase === "closed") return;
    this.options.onSnapshot(this.snapshot(state), endpoint);
  }

  private sendFrame(frame: RelayTunnelFrame): void {
    if (this.phase === "closed" || this.ws.readyState !== this.ws.OPEN) return;
    const maxBytes =
      this.phase === "awaiting_login" || this.phase === "connecting"
        ? DEFAULT_TUNNEL_MAX_FRAME_BYTES
        : this.negotiated.maxFrameBytes;
    const encoded = encodeFrameSync(frame, maxBytes);
    this.ws.send(encoded);
  }

  private sendReset(streamId: number, code: TunnelStreamResetCode, message?: string): void {
    this.sendFrame({
      type: "rst",
      streamId,
      payload: { code, ...(message ? { message } : {}) },
    });
  }

  private async sendLoginFrame(): Promise<void> {
    if (this.phase !== "connecting") return;
    const proof = await this.options.signLoginProof();
    if (this.phase !== "connecting") return;
    this.phase = "awaiting_login";
    this.sendFrame({
      type: "login",
      streamId: 0,
      payload: {
        environmentId: this.options.environmentId,
        credential: TrimmedNonEmptyString.make(this.options.environmentCredential),
        proof: TrimmedNonEmptyString.make(proof),
        capabilities: CLIENT_CAPABILITIES,
      },
    });
  }

  private handleIncomingBytes(bytes: Uint8Array): void {
    if (this.phase === "closed") return;
    this.lastActivityMs = Date.now();
    const maxBytes =
      this.phase === "awaiting_login" || this.phase === "connecting"
        ? DEFAULT_TUNNEL_MAX_FRAME_BYTES
        : this.negotiated.maxFrameBytes;
    const frame = decodeFrameSync(bytes, maxBytes);
    if (frame.streamId === 0) {
      this.handleControlFrame(frame);
      return;
    }
    if (this.phase !== "active") {
      this.closeSocket(1002, "Stream frame received before active tunnel state");
      return;
    }
    if (frame.type === "open_http") {
      this.handleOpenHttp(frame.streamId, frame.payload);
      return;
    }
    if (frame.type === "open_ws") {
      this.handleOpenWs(frame.streamId, frame.payload);
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    stream.onFrame(frame);
    if (frame.type === "window_update") {
      for (const wake of this.creditWaiters.get(frame.streamId) ?? []) {
        wake();
      }
    }
  }

  private handleControlFrame(frame: RelayTunnelFrame): void {
    if (frame.type === "login_resp" && this.phase === "awaiting_login") {
      this.handleLoginResp(frame.payload);
      return;
    }
    if (frame.type === "register_proxy_resp" && this.phase === "awaiting_register") {
      this.handleRegisterResp(frame.payload);
      return;
    }
    if (frame.type === "ping" && this.phase === "active") {
      this.sendFrame({
        type: "pong",
        streamId: 0,
        payload: { seq: frame.payload.seq, sentAtMs: frame.payload.sentAtMs },
      });
      return;
    }
    if (frame.type === "pong" && this.phase === "active") {
      this.rttMs = NonNegativeInt.make(Math.max(0, Date.now() - frame.payload.sentAtMs));
      this.emitSnapshot("online");
      return;
    }
    if (frame.type === "goaway") {
      const shouldReconnect = goAwayShouldReconnect(frame.payload.reason);
      const detail = frame.payload.message ?? frame.payload.reason;
      this.lastError = detail;
      this.goawayOutcome = {
        shouldReconnect,
        reason: frame.payload.reason,
        ...(shouldReconnect ? {} : { terminalError: detail }),
      };
      this.closeSocket(1001, detail);
      return;
    }
    this.closeSocket(1002, `Unexpected control frame '${frame.type}' in ${this.phase}`);
  }

  private handleLoginResp(
    payload: Extract<RelayTunnelFrame, { readonly type: "login_resp" }>["payload"],
  ): void {
    if (!payload.ok) {
      this.lastError = payload.message;
      if (isTerminalLoginCode(payload.code)) {
        this.terminalOutcome = {
          shouldReconnect: false,
          reason: payload.code,
          terminalError: payload.message,
        };
      }
      this.closeSocket(1008, payload.message);
      return;
    }
    this.negotiated = payload.negotiated;
    this.runId = PositiveInt.make(payload.runId);
    this.phase = "awaiting_register";
    this.sendFrame({
      type: "register_proxy",
      streamId: 0,
      payload: {
        environmentId: this.options.environmentId,
        label: TrimmedNonEmptyString.make(this.options.label.trim() || this.options.environmentId),
        endpointKey: this.options.endpointKey,
      },
    });
  }

  private handleRegisterResp(
    payload: Extract<RelayTunnelFrame, { readonly type: "register_proxy_resp" }>["payload"],
  ): void {
    if (!payload.ok) {
      this.lastError = payload.message;
      if (isTerminalRegisterCode(payload.code)) {
        this.terminalOutcome = {
          shouldReconnect: false,
          reason: payload.code,
          terminalError: payload.message,
        };
      }
      this.closeSocket(1008, payload.message);
      return;
    }
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.phase = "active";
    this.lastError = null;
    this.connectedAt = new Date().toISOString() as IsoDateTime;
    this.startHeartbeatLoop();
    this.emitSnapshot("online", payload.endpoint);
  }

  private startHeartbeatLoop(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.phase !== "active") return;
      const nowMs = Date.now();
      if (nowMs - this.lastActivityMs > this.negotiated.heartbeatTimeoutMs) {
        this.lastError = "Relay tunnel heartbeat timed out";
        this.closeSocket(1001, "Heartbeat timed out");
        return;
      }
      this.sendFrame({
        type: "ping",
        streamId: 0,
        payload: { seq: this.nextPingSeq++, sentAtMs: nowMs },
      });
    }, this.negotiated.heartbeatIntervalMs);
  }

  private handleOpenHttp(
    streamId: number,
    payload: Extract<RelayTunnelFrame, { readonly type: "open_http" }>["payload"],
  ): void {
    if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
      this.sendReset(streamId, "stream_limit", "Concurrent stream limit reached");
      return;
    }
    const stream = openLocalHttpStream(this.forwarderHost, streamId, payload);
    if (stream) {
      this.streams.set(streamId, stream);
      this.emitSnapshot("online");
    }
  }

  private handleOpenWs(
    streamId: number,
    payload: Extract<RelayTunnelFrame, { readonly type: "open_ws" }>["payload"],
  ): void {
    if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
      this.sendReset(streamId, "stream_limit", "Concurrent stream limit reached");
      return;
    }
    const stream = openLocalWsStream(this.forwarderHost, streamId, payload);
    if (stream) {
      this.streams.set(streamId, stream);
      this.emitSnapshot("online");
    }
  }

  private closeSocket(code: number, reason: string): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.close(code, reason.slice(0, 120));
    } else if (this.ws.readyState === this.ws.CONNECTING) {
      this.ws.terminate();
    }
  }

  private cleanupResources(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const stream of Array.from(this.streams.values())) {
      stream.destroy();
    }
    this.streams.clear();
    for (const waiters of this.creditWaiters.values()) {
      for (const wake of waiters) {
        wake();
      }
    }
    this.creditWaiters.clear();
  }

  private handleClosed(closeReason: string): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.phase = "closed";
    this.cleanupResources();
    const outcome: TunnelSessionCloseOutcome = this.terminalOutcome ??
      this.goawayOutcome ?? {
        shouldReconnect: true,
        reason: closeReason || this.lastError || "Tunnel connection closed",
      };
    this.options.onClosed(outcome);
  }
}
