// @effect-diagnostics globalTimers:off -- HTTP mux streams enforce per-stream response header timeouts over Node WebSocket callbacks.
import type { TunnelNegotiatedCapabilities } from "@t3tools/contracts/agentVelaRelay";
import {
  applyWindowUpdate,
  createTunnelCreditWindow,
  recordReceivedBytes,
  type RelayTunnelFrame,
} from "@t3tools/shared/relayTunnelProtocol";
import * as Effect from "effect/Effect";

import {
  type ActiveStreamController,
  decompressTunnelPayload,
  resetCodeToStreamError,
  type TunnelHttpStreamResponse,
  type TunnelOpenHttpInput,
  TunnelStreamError,
} from "./codec.ts";

export interface HttpStreamTransport {
  readonly negotiated: TunnelNegotiatedCapabilities;
  readonly sendFrame: (frame: RelayTunnelFrame) => void;
  readonly sendDataChunked: (
    stream: ActiveStreamController,
    data: Uint8Array,
    endStream: boolean,
    wsText: boolean,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly resetStream: (
    streamId: number,
    code: "cancelled" | "protocol_error",
    message?: string,
  ) => void;
  readonly deleteStream: (streamId: number) => void;
}

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  private readonly chunks: Array<Uint8Array> = [];
  private ended = false;
  private failure: Error | null = null;
  private waiter: (() => void) | null = null;

  push(chunk: Uint8Array): void {
    if (this.ended || this.failure) {
      return;
    }
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk);
    }
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  fail(error: Error): void {
    this.failure = error;
    this.wake();
  }

  private wake(): void {
    const current = this.waiter;
    this.waiter = null;
    current?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      if (this.chunks.length > 0) {
        yield this.chunks.shift()!;
        continue;
      }
      if (this.failure) {
        throw this.failure;
      }
      if (this.ended) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

async function pumpRequestBody(
  transport: HttpStreamTransport,
  stream: ActiveStreamController,
  body: TunnelOpenHttpInput["body"],
  signal?: AbortSignal,
): Promise<void> {
  if (!body) {
    return;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > 0) {
      await transport.sendDataChunked(stream, body, true, false, signal);
    } else {
      transport.sendFrame({ type: "end", streamId: stream.streamId, payload: {} });
    }
    return;
  }
  for await (const chunk of body) {
    if (signal?.aborted) {
      transport.resetStream(stream.streamId, "cancelled");
      return;
    }
    if (chunk.byteLength > 0) {
      await transport.sendDataChunked(stream, chunk, false, false, signal);
    }
  }
  transport.sendFrame({ type: "end", streamId: stream.streamId, payload: {} });
}

function dispatchHttpDataFrame(
  transport: HttpStreamTransport,
  controller: ActiveStreamController,
  frame: Extract<RelayTunnelFrame, { readonly type: "data" }>,
  bodyQueue: AsyncByteQueue,
  onEnd: () => void,
): void {
  try {
    const recv = Effect.runSync(
      recordReceivedBytes(controller.recvWindow, frame.payload.byteLength),
    );
    controller.recvWindow = recv.window;
    const plain = decompressTunnelPayload(
      frame.payload,
      frame.compressed,
      transport.negotiated.maxFrameBytes,
    );
    bodyQueue.push(plain);
    if (recv.creditToSend > 0) {
      transport.sendFrame({
        type: "window_update",
        streamId: controller.streamId,
        creditBytes: recv.creditToSend,
      });
    }
    if (frame.endStream) {
      onEnd();
    }
  } catch (cause) {
    const err = new TunnelStreamError({
      reason: "protocol_error",
      message: `Invalid tunnel HTTP data: ${String(cause)}`,
    });
    transport.resetStream(controller.streamId, "protocol_error", err.message);
    controller.onForceClose(err);
  }
}

export async function startHttpTunnelStream(
  transport: HttpStreamTransport,
  streamId: number,
  input: TunnelOpenHttpInput,
  registerController: (controller: ActiveStreamController) => void,
): Promise<TunnelHttpStreamResponse> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const bodyQueue = new AsyncByteQueue();
  const initialWindow = transport.negotiated.initialStreamWindowBytes;

  let settled = false;
  let responseEnded = false;
  let resolveHeaders!: (res: TunnelHttpStreamResponse) => void;
  let rejectHeaders!: (err: TunnelStreamError) => void;
  const headersPromise = new Promise<TunnelHttpStreamResponse>((resolve, reject) => {
    resolveHeaders = resolve;
    rejectHeaders = reject;
  });

  const timer = setTimeout(() => {
    const err = new TunnelStreamError({
      reason: "timed_out",
      message: "Timed out waiting for tunnel HTTP response",
    });
    transport.resetStream(streamId, "cancelled", err.message);
    controller.onForceClose(err);
  }, timeoutMs);

  const onAbort = () => {
    transport.resetStream(streamId, "cancelled", "Client aborted request");
    controller.onForceClose(
      new TunnelStreamError({ reason: "reset", message: "Client aborted request" }),
    );
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const cleanup = () => {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    transport.deleteStream(streamId);
  };

  const endStreamCleanly = () => {
    responseEnded = true;
    bodyQueue.end();
    cleanup();
  };

  const controller: ActiveStreamController = {
    streamId,
    kind: "http",
    sendWindow: createTunnelCreditWindow(initialWindow),
    recvWindow: createTunnelCreditWindow(initialWindow),
    notifyCredit: () => undefined,
    onForceClose: (error) => {
      cleanup();
      bodyQueue.fail(error);
      if (!settled) {
        settled = true;
        rejectHeaders(error);
      }
    },
    onFrame: (frame) => {
      if (frame.type === "window_update") {
        controller.sendWindow = Effect.runSync(
          applyWindowUpdate(controller.sendWindow, frame.creditBytes),
        );
        return;
      }
      if (frame.type === "rst") {
        controller.onForceClose(resetCodeToStreamError(frame.payload.code, frame.payload.message));
        return;
      }
      if (frame.type === "http_response") {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          if (!frame.payload.hasBody || responseEnded) {
            bodyQueue.end();
            cleanup();
          }
          resolveHeaders({
            status: frame.payload.status,
            headers: frame.payload.headers,
            hasBody: frame.payload.hasBody,
            body: bodyQueue,
            abort: () => {
              transport.resetStream(streamId, "cancelled", "Response consumer aborted");
              controller.onForceClose(
                new TunnelStreamError({ reason: "reset", message: "Response consumer aborted" }),
              );
            },
          });
        }
        return;
      }
      if (frame.type === "data") {
        dispatchHttpDataFrame(transport, controller, frame, bodyQueue, endStreamCleanly);
        return;
      }
      if (frame.type === "end") {
        endStreamCleanly();
      }
    },
  };

  registerController(controller);

  const hasBody = input.body instanceof Uint8Array ? input.body.byteLength > 0 : input.body != null;
  transport.sendFrame({
    type: "open_http",
    streamId,
    payload: {
      method: input.method,
      path: input.path,
      headers: [...input.headers],
      hasBody,
      externalHost: input.externalHost,
      externalProto: input.externalProto,
      pathPrefix: input.pathPrefix,
      ...(input.remoteAddr ? { remoteAddr: input.remoteAddr } : {}),
    },
  });

  if (hasBody) {
    void pumpRequestBody(transport, controller, input.body, input.signal).catch((cause) => {
      controller.onForceClose(
        new TunnelStreamError({
          reason: "reset",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    });
  }

  return await headersPromise;
}

export async function collectHttpResponseBytes(
  response: TunnelHttpStreamResponse,
  maxBytes = 2 * 1024 * 1024,
): Promise<Uint8Array> {
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.abort();
      throw new TunnelStreamError({
        reason: "protocol_error",
        message: "Response body exceeds maximum allowed size",
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
