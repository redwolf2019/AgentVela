// @effect-diagnostics globalTimers:off -- Tunnel flow control uses bounded Promise wait deadlines keyed to WebSocket WINDOW_UPDATE frames.
import type { TunnelNegotiatedCapabilities } from "@t3tools/contracts/agentVelaRelay";
import { consumeSendCredit, type RelayTunnelFrame } from "@t3tools/shared/relayTunnelProtocol";

import { type ActiveStreamController, compressDataIfSmaller, TunnelStreamError } from "./codec.ts";

const FRAME_HEADER_ALLOWANCE = 64;

export interface FlowControlHost {
  readonly isStreamOpen: (streamId: number) => boolean;
  readonly negotiated: TunnelNegotiatedCapabilities;
  readonly sendFrame: (frame: RelayTunnelFrame) => void;
  readonly creditNotifyHooks: Map<number, Set<() => void>>;
}

export function waitForSendCredit(
  host: FlowControlHost,
  stream: ActiveStreamController,
  signal?: AbortSignal,
): Promise<void> {
  if (stream.sendWindow.sendAvailableBytes > 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let existingSet = host.creditNotifyHooks.get(stream.streamId);
    if (!existingSet) {
      existingSet = new Set();
      host.creditNotifyHooks.set(stream.streamId, existingSet);
    }
    const hookSet = existingSet;
    const cleanup = () => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      hookSet.delete(wake);
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new TunnelStreamError({ reason: "timed_out", message: "Stream flow control stall" }));
    }, 30_000);
    const onAbort = () => {
      cleanup();
      reject(new TunnelStreamError({ reason: "reset", message: "Request aborted while queued" }));
    };
    const wake = () => {
      cleanup();
      resolve();
    };
    hookSet.add(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function sendSingleWsPayload(
  host: FlowControlHost,
  stream: ActiveStreamController,
  data: Uint8Array,
  endStream: boolean,
  wsText: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const maxChunkPayload = Math.max(1024, host.negotiated.maxFrameBytes - FRAME_HEADER_ALLOWANCE);
  const prepared = compressDataIfSmaller(data, host.negotiated.compression);
  if (prepared.bytes.byteLength > maxChunkPayload) {
    throw new TunnelStreamError({
      reason: "protocol_error",
      message: `WebSocket payload (${prepared.bytes.byteLength}) exceeds maxFrameBytes`,
    });
  }
  while (stream.sendWindow.sendAvailableBytes < prepared.bytes.byteLength) {
    await waitForSendCredit(host, stream, signal);
    if (!host.isStreamOpen(stream.streamId)) {
      throw new TunnelStreamError({ reason: "offline", message: "Tunnel closed" });
    }
  }
  const nextWin = consumeSendCredit(stream.sendWindow, prepared.bytes.byteLength);
  if (!nextWin) {
    throw new TunnelStreamError({ reason: "protocol_error", message: "Credit window depleted" });
  }
  stream.sendWindow = nextWin;
  host.sendFrame({
    type: "data",
    streamId: stream.streamId,
    payload: prepared.bytes,
    endStream,
    compressed: prepared.compressed,
    wsText,
  });
}

export async function sendStreamDataChunked(
  host: FlowControlHost,
  stream: ActiveStreamController,
  data: Uint8Array,
  endStream: boolean,
  wsText: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (stream.kind === "ws") {
    await sendSingleWsPayload(host, stream, data, endStream, wsText, signal);
    return;
  }
  const maxChunkPayload = Math.max(1024, host.negotiated.maxFrameBytes - FRAME_HEADER_ALLOWANCE);
  let offset = 0;
  while (offset < data.byteLength) {
    await waitForSendCredit(host, stream, signal);
    if (!host.isStreamOpen(stream.streamId)) {
      throw new TunnelStreamError({ reason: "offline", message: "Tunnel closed" });
    }
    const sliceLen = Math.min(
      maxChunkPayload,
      stream.sendWindow.sendAvailableBytes,
      data.byteLength - offset,
    );
    const slice = data.subarray(offset, offset + sliceLen);
    offset += sliceLen;
    const prepared = compressDataIfSmaller(slice, host.negotiated.compression);
    const nextWin = consumeSendCredit(stream.sendWindow, prepared.bytes.byteLength);
    if (!nextWin) {
      throw new TunnelStreamError({ reason: "protocol_error", message: "Credit window depleted" });
    }
    stream.sendWindow = nextWin;
    host.sendFrame({
      type: "data",
      streamId: stream.streamId,
      payload: prepared.bytes,
      endStream: endStream && offset >= data.byteLength,
      compressed: prepared.compressed,
      wsText: false,
    });
  }
}
