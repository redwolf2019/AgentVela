// @effect-diagnostics globalTimers:off -- Tunnel flow control uses bounded Promise wait deadlines keyed to WebSocket WINDOW_UPDATE frames.
import type { TunnelNegotiatedCapabilities } from "@t3tools/contracts/agentVelaRelay";
import {
  consumeSendCredit,
  type RelayTunnelFrame,
  type TunnelCreditWindow,
} from "@t3tools/shared/relayTunnelProtocol";
import * as Schema from "effect/Schema";

import { compressDataIfSmaller } from "./tunnelCodec.ts";

const FRAME_HEADER_ALLOWANCE = 64;
const CREDIT_WAIT_TIMEOUT_MS = 30_000;

export class LocalStreamAbortedError extends Schema.TaggedError<
  LocalStreamAbortedError,
  { readonly brand: unique symbol }
>()("LocalStreamAbortedError", {
  code: Schema.Literals(["offline", "timed_out", "reset", "protocol_error"]),
  message: Schema.String,
}) {}

export interface LocalStreamFlowState {
  readonly streamId: number;
  readonly kind: "http" | "ws";
  sendWindow: TunnelCreditWindow;
  recvWindow: TunnelCreditWindow;
}

export interface LocalFlowControlHost {
  readonly negotiated: TunnelNegotiatedCapabilities;
  readonly isStreamActive: (streamId: number) => boolean;
  readonly sendFrame: (frame: RelayTunnelFrame) => void;
  readonly addCreditWaiter: (streamId: number, wake: () => void) => () => void;
}

function waitForSendCredit(
  host: LocalFlowControlHost,
  stream: LocalStreamFlowState,
  signal?: AbortSignal,
): Promise<void> {
  if (stream.sendWindow.sendAvailableBytes > 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let removeWaiter = (): void => undefined;
    const cleanup = () => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      removeWaiter();
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(
        new LocalStreamAbortedError({
          code: "timed_out",
          message: "Local stream send window stalled",
        }),
      );
    }, CREDIT_WAIT_TIMEOUT_MS);
    const onAbort = () => {
      cleanup();
      reject(
        new LocalStreamAbortedError({
          code: "reset",
          message: "Stream aborted while waiting for credit",
        }),
      );
    };
    const wake = () => {
      cleanup();
      resolve();
    };
    removeWaiter = host.addCreditWaiter(stream.streamId, wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function sendSingleWsChunk(
  host: LocalFlowControlHost,
  stream: LocalStreamFlowState,
  data: Uint8Array,
  endStream: boolean,
  wsText: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const maxChunkPayload = Math.max(1024, host.negotiated.maxFrameBytes - FRAME_HEADER_ALLOWANCE);
  const prepared = compressDataIfSmaller(data, host.negotiated.compression);
  if (prepared.bytes.byteLength > maxChunkPayload) {
    throw new LocalStreamAbortedError({
      code: "protocol_error",
      message: `WebSocket payload (${prepared.bytes.byteLength}) exceeds maxFrameBytes`,
    });
  }
  while (stream.sendWindow.sendAvailableBytes < prepared.bytes.byteLength) {
    await waitForSendCredit(host, stream, signal);
    if (!host.isStreamActive(stream.streamId)) {
      throw new LocalStreamAbortedError({ code: "offline", message: "Stream closed" });
    }
  }
  const nextWin = consumeSendCredit(stream.sendWindow, prepared.bytes.byteLength);
  if (!nextWin) {
    throw new LocalStreamAbortedError({
      code: "protocol_error",
      message: "Send credit window depleted",
    });
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

export async function sendLocalDataChunked(
  host: LocalFlowControlHost,
  stream: LocalStreamFlowState,
  data: Uint8Array,
  endStream: boolean,
  wsText: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (stream.kind === "ws") {
    await sendSingleWsChunk(host, stream, data, endStream, wsText, signal);
    return;
  }
  const maxChunkPayload = Math.max(1024, host.negotiated.maxFrameBytes - FRAME_HEADER_ALLOWANCE);
  let offset = 0;
  while (offset < data.byteLength) {
    await waitForSendCredit(host, stream, signal);
    if (!host.isStreamActive(stream.streamId)) {
      throw new LocalStreamAbortedError({ code: "offline", message: "Stream closed" });
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
      throw new LocalStreamAbortedError({
        code: "protocol_error",
        message: "Send credit window depleted",
      });
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
