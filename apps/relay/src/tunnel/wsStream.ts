// @effect-diagnostics globalTimers:off -- WebSocket mux streams enforce handshake timeouts and pause/resume socket flow control.
import {
  applyWindowUpdate,
  createTunnelCreditWindow,
  recordReceivedBytes,
  type RelayTunnelFrame,
} from "@t3tools/shared/relayTunnelProtocol";
import * as Effect from "effect/Effect";
import type { RawData, WebSocket } from "ws";

import {
  type ActiveStreamController,
  decompressTunnelPayload,
  rawDataToUint8Array,
  resetCodeToStreamError,
  sanitizeWsCloseCode,
  type TunnelOpenWsInput,
  TunnelStreamError,
} from "./codec.ts";
import type { HttpStreamTransport } from "./httpStream.ts";

export interface AcceptedWsStream {
  readonly protocol?: string;
  readonly attachClientSocket: (clientWs: WebSocket) => void;
  readonly abortBeforeAttach: () => void;
}

function attachWsClientSocketEvents(input: {
  readonly transport: HttpStreamTransport;
  readonly controller: ActiveStreamController;
  readonly socket: WebSocket;
  readonly setClientSocket: (ws: WebSocket | null) => void;
  readonly cleanup: () => void;
}): void {
  const { transport, controller, socket, setClientSocket, cleanup } = input;
  let sendChain = Promise.resolve();
  setClientSocket(socket);

  socket.on("message", (raw: RawData, isBinary: boolean) => {
    const bytes = rawDataToUint8Array(raw);
    if (controller.sendWindow.sendAvailableBytes < bytes.byteLength) {
      socket.pause();
    }
    sendChain = sendChain
      .then(async () => {
        await transport.sendDataChunked(controller, bytes, false, !isBinary);
        if (controller.sendWindow.sendAvailableBytes > 0) {
          socket.resume();
        }
      })
      .catch((cause) => {
        transport.resetStream(controller.streamId, "protocol_error", String(cause));
        controller.onForceClose(new TunnelStreamError({ reason: "reset", message: String(cause) }));
      });
  });

  socket.on("close", (code, reasonBuf) => {
    transport.sendFrame({
      type: "end",
      streamId: controller.streamId,
      payload: {
        closeCode: sanitizeWsCloseCode(code),
        closeReason: reasonBuf.toString("utf8"),
      },
    });
    setClientSocket(null);
    cleanup();
  });

  socket.on("error", () => {
    transport.resetStream(controller.streamId, "cancelled");
    setClientSocket(null);
    cleanup();
  });
}

function forwardTunnelWsDataFrame(
  transport: HttpStreamTransport,
  controller: ActiveStreamController,
  frame: Extract<RelayTunnelFrame, { readonly type: "data" }>,
  clientWs: WebSocket | null,
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
    if (clientWs && clientWs.readyState === clientWs.OPEN) {
      clientWs.send(plain, { binary: !frame.wsText });
    }
    if (recv.creditToSend > 0) {
      transport.sendFrame({
        type: "window_update",
        streamId: controller.streamId,
        creditBytes: recv.creditToSend,
      });
    }
  } catch (cause) {
    transport.resetStream(controller.streamId, "protocol_error", String(cause));
    controller.onForceClose(
      new TunnelStreamError({ reason: "protocol_error", message: String(cause) }),
    );
  }
}

export async function startWsTunnelStream(
  transport: HttpStreamTransport,
  streamId: number,
  input: TunnelOpenWsInput,
  registerController: (controller: ActiveStreamController) => void,
): Promise<AcceptedWsStream> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const initialWindow = transport.negotiated.initialStreamWindowBytes;

  let settled = false;
  let clientWs: WebSocket | null = null;
  let resolveAccept!: (accepted: AcceptedWsStream) => void;
  let rejectAccept!: (err: TunnelStreamError) => void;
  const acceptPromise = new Promise<AcceptedWsStream>((resolve, reject) => {
    resolveAccept = resolve;
    rejectAccept = reject;
  });

  const timer = setTimeout(() => {
    const err = new TunnelStreamError({
      reason: "timed_out",
      message: "Timed out waiting for tunnel WebSocket accept",
    });
    transport.resetStream(streamId, "cancelled", err.message);
    controller.onForceClose(err);
  }, timeoutMs);

  const cleanup = () => {
    clearTimeout(timer);
    transport.deleteStream(streamId);
  };

  const closeClientSocket = (code?: number, reason?: string) => {
    if (!clientWs) {
      return;
    }
    const target = clientWs;
    clientWs = null;
    if (target.readyState === target.OPEN || target.readyState === target.CONNECTING) {
      target.close(sanitizeWsCloseCode(code), reason?.slice(0, 120) ?? "");
    }
  };

  const controller: ActiveStreamController = {
    streamId,
    kind: "ws",
    sendWindow: createTunnelCreditWindow(initialWindow),
    recvWindow: createTunnelCreditWindow(initialWindow),
    notifyCredit: () => {
      if (clientWs && controller.sendWindow.sendAvailableBytes > 0) {
        clientWs.resume();
      }
    },
    onForceClose: (error) => {
      cleanup();
      closeClientSocket(1011, error.message);
      if (!settled) {
        settled = true;
        rejectAccept(error);
      }
    },
    onFrame: (frame) => {
      if (frame.type === "window_update") {
        controller.sendWindow = Effect.runSync(
          applyWindowUpdate(controller.sendWindow, frame.creditBytes),
        );
        controller.notifyCredit();
        return;
      }
      if (frame.type === "rst") {
        controller.onForceClose(resetCodeToStreamError(frame.payload.code, frame.payload.message));
        return;
      }
      if (frame.type === "ws_accept") {
        clearTimeout(timer);
        if (!frame.payload.ok) {
          cleanup();
          if (!settled) {
            settled = true;
            rejectAccept(
              new TunnelStreamError({
                reason: "reset",
                httpStatus: frame.payload.status,
                message: frame.payload.message ?? `Upstream rejected WS (${frame.payload.status})`,
              }),
            );
          }
          return;
        }
        if (!settled) {
          settled = true;
          resolveAccept({
            ...(frame.payload.protocol ? { protocol: frame.payload.protocol } : {}),
            abortBeforeAttach: () => {
              transport.resetStream(
                streamId,
                "cancelled",
                "Client WebSocket aborted before attach",
              );
              cleanup();
            },
            attachClientSocket: (socket) =>
              attachWsClientSocketEvents({
                transport,
                controller,
                socket,
                setClientSocket: (ws) => {
                  clientWs = ws;
                },
                cleanup,
              }),
          });
        }
        return;
      }
      if (frame.type === "data") {
        forwardTunnelWsDataFrame(transport, controller, frame, clientWs);
        return;
      }
      if (frame.type === "end") {
        cleanup();
        closeClientSocket(frame.payload.closeCode, frame.payload.closeReason);
      }
    },
  };

  registerController(controller);

  transport.sendFrame({
    type: "open_ws",
    streamId,
    payload: {
      path: input.path,
      headers: [...input.headers],
      protocols: [...input.protocols],
      externalHost: input.externalHost,
      externalProto: input.externalProto,
      pathPrefix: input.pathPrefix,
      ...(input.remoteAddr ? { remoteAddr: input.remoteAddr } : {}),
    },
  });

  return await acceptPromise;
}
