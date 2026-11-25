// @effect-diagnostics nodeBuiltinImport:off -- Exercises RelayTunnelClient over real localhost WebSocket and HTTP sockets.
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  DEFAULT_TUNNEL_MAX_FRAME_BYTES,
  MIN_TUNNEL_MAX_FRAME_BYTES,
  RelayEndpointKey,
  RelayUserId,
  type TunnelNegotiatedCapabilities,
} from "@t3tools/contracts/agentVelaRelay";
import { assert, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type RawData, WebSocket, WebSocketServer } from "ws";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentKeys from "../cloud/environmentKeys.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RelayTunnelClient from "./RelayTunnelClient.ts";
import type { StoredSelfHostedRelayLink } from "./RelayState.ts";
import { decodeFrameSync, encodeFrameSync, rawDataToUint8Array } from "./tunnelCodec.ts";

const makeTestLayer = () => {
  const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-tunnel-client-test-" });
  const layerSecrets = ServerSecretStore.layer;
  const layerEnv = ServerEnvironment.layer.pipe(
    Layer.provide(layerSecrets),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(ManagedPolicy.layerTest()),
  );
  const layerKeys = EnvironmentKeys.layer.pipe(Layer.provide(layerSecrets));
  return RelayTunnelClient.layer.pipe(
    Layer.provideMerge(layerEnv),
    Layer.provideMerge(layerKeys),
    Layer.provideMerge(layerSecrets),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

function makeConfig(
  port: number,
  linkedAt = IsoDateTime.make("2026-01-01T00:00:00.000Z"),
): StoredSelfHostedRelayLink {
  const base = `http://127.0.0.1:${port}`;
  const key = RelayEndpointKey.make("0123456789abcdef");
  return {
    relayUrl: TrimmedNonEmptyString.make(base),
    relayIssuer: TrimmedNonEmptyString.make(base),
    userId: RelayUserId.make("user_1"),
    endpoint: {
      endpointKey: key,
      pathPrefix: TrimmedNonEmptyString.make(`/e/${key}`),
      httpBaseUrl: TrimmedNonEmptyString.make(`${base}/e/${key}`),
      wsBaseUrl: TrimmedNonEmptyString.make(`ws://127.0.0.1:${port}/e/${key}`),
    },
    environmentCredential: TrimmedNonEmptyString.make("avr_env_test_secret"),
    relayMintPublicKey: TrimmedNonEmptyString.make("unused"),
    linkedAt,
  };
}

const smallCaps: TunnelNegotiatedCapabilities = {
  protocolVersion: 1,
  maxFrameBytes: 32_768,
  heartbeatIntervalMs: 60_000,
  heartbeatTimeoutMs: 120_000,
  initialStreamWindowBytes: MIN_TUNNEL_MAX_FRAME_BYTES,
  compression: true,
};

function listenHttpEcho() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const wsClosed = Promise.withResolvers<{ readonly code: number; readonly reason: string }>();
      const server = NodeHttp.createServer((req, res) => {
        if (req.url === "/large") {
          const payload = Buffer.from("hello-agent-vela-stream-".repeat(1_200));
          res.writeHead(200, {
            "content-type": "text/plain",
            "x-seen-prefix": String(req.headers["x-forwarded-prefix"] ?? ""),
          });
          res.end(payload);
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("message", (raw: RawData, isBinary: boolean) => {
            if (!isBinary) {
              ws.send(`echo:${raw.toString()}`, { binary: false });
            } else {
              ws.send(rawDataToUint8Array(raw), { binary: true });
            }
          });
          ws.on("close", (code, reason) => {
            wsClosed.resolve({ code, reason: reason.toString("utf8") });
          });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      return { server, wss, port: address.port, wsClosed: wsClosed.promise };
    }),
    ({ server, wss }) =>
      Effect.promise(async () => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );
}

function listenMockRelayWss() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer();
      const wss = new WebSocketServer({ server, path: "/v1/tunnel/connect" });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      return { server, wss, port: address.port };
    }),
    ({ server, wss }) =>
      Effect.promise(async () => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );
}

it("computes bounded exponential reconnect backoff with deterministic jitter", () => {
  assert.strictEqual(RelayTunnelClient.computeTunnelReconnectDelayMs(0, 0.5), 1_000);
  assert.strictEqual(RelayTunnelClient.computeTunnelReconnectDelayMs(0, 0), 800);
  assert.strictEqual(RelayTunnelClient.computeTunnelReconnectDelayMs(0, 1), 1_200);
  assert.strictEqual(RelayTunnelClient.computeTunnelReconnectDelayMs(3, 0.5), 8_000);
  assert.strictEqual(RelayTunnelClient.computeTunnelReconnectDelayMs(10, 0.5), 30_000);
  assert.strictEqual(RelayTunnelClient.computeTunnelReconnectDelayMs(10, 1), 36_000);
});

it.live(
  "handshakes, measures PING RTT, and forwards HTTP (compressed + WINDOW_UPDATE) and WS",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const local = yield* listenHttpEcho();
      const relay = yield* listenMockRelayWss();
      const config = makeConfig(relay.port, IsoDateTime.make(DateTime.formatIso(now)));

      const httpDone = Promise.withResolvers<string>();
      const wsDone = Promise.withResolvers<string>();
      const activeSocket = Promise.withResolvers<WebSocket>();
      const httpChunks: Array<Uint8Array> = [];
      let seenPrefix = "";
      const wsReceived: Array<{
        readonly text: boolean;
        readonly textData?: string;
        readonly binLen?: number;
      }> = [];

      relay.wss.on("connection", (ws) => {
        ws.on("message", (raw: RawData) => {
          const frame = decodeFrameSync(rawDataToUint8Array(raw), DEFAULT_TUNNEL_MAX_FRAME_BYTES);
          if (frame.type === "login") {
            ws.send(
              encodeFrameSync(
                {
                  type: "login_resp",
                  streamId: 0,
                  payload: { ok: true, runId: 7, negotiated: smallCaps },
                },
                smallCaps.maxFrameBytes,
              ),
            );
            return;
          }
          if (frame.type === "register_proxy") {
            ws.send(
              encodeFrameSync(
                {
                  type: "register_proxy_resp",
                  streamId: 0,
                  payload: { ok: true, endpoint: config.endpoint },
                },
                smallCaps.maxFrameBytes,
              ),
            );
            activeSocket.resolve(ws);
            return;
          }
          if (frame.type === "ping") {
            ws.send(
              encodeFrameSync(
                { type: "pong", streamId: 0, payload: frame.payload },
                smallCaps.maxFrameBytes,
              ),
            );
            return;
          }
          if (frame.streamId === 1) {
            if (frame.type === "http_response") {
              seenPrefix = frame.payload.headers.find(([k]) => k === "x-seen-prefix")?.[1] ?? "";
            } else if (frame.type === "data") {
              const plain = frame.compressed
                ? NodeZlib.inflateRawSync(frame.payload, {
                    maxOutputLength: smallCaps.maxFrameBytes * 4,
                  })
                : frame.payload;
              httpChunks.push(plain);
              ws.send(
                encodeFrameSync(
                  { type: "window_update", streamId: 1, creditBytes: frame.payload.byteLength },
                  smallCaps.maxFrameBytes,
                ),
              );
            } else if (frame.type === "end") {
              httpDone.resolve(
                `${seenPrefix}|${Buffer.concat(httpChunks).toString("utf8").length}`,
              );
            }
          }
          if (frame.streamId === 3) {
            if (frame.type === "ws_accept" && frame.payload.ok) {
              ws.send(
                encodeFrameSync(
                  {
                    type: "data",
                    streamId: 3,
                    payload: new TextEncoder().encode("ping"),
                    endStream: false,
                    compressed: false,
                    wsText: true,
                  },
                  smallCaps.maxFrameBytes,
                ),
              );
            } else if (frame.type === "data") {
              if (frame.wsText) {
                wsReceived.push({
                  text: true,
                  textData: Buffer.from(frame.payload).toString("utf8"),
                });
                ws.send(
                  encodeFrameSync(
                    {
                      type: "data",
                      streamId: 3,
                      payload: new Uint8Array([1, 2, 3, 4]),
                      endStream: false,
                      compressed: false,
                      wsText: false,
                    },
                    smallCaps.maxFrameBytes,
                  ),
                );
              } else {
                wsReceived.push({ text: false, binLen: frame.payload.byteLength });
                ws.send(
                  encodeFrameSync(
                    { type: "end", streamId: 3, payload: { closeCode: 1000, closeReason: "done" } },
                    smallCaps.maxFrameBytes,
                  ),
                );
                wsDone.resolve(JSON.stringify(wsReceived));
              }
            }
          }
        });
      });

      const client = yield* RelayTunnelClient.RelayTunnelClient;
      yield* client.setLocalOrigin({ host: "127.0.0.1", port: local.port });
      yield* client.configure(config);

      const ws = yield* Effect.promise(() => activeSocket.promise);

      ws.send(
        encodeFrameSync(
          {
            type: "open_http",
            streamId: 1,
            payload: {
              method: "GET",
              path: "/large",
              headers: [],
              hasBody: false,
              externalHost: "relay.example.com",
              externalProto: "https",
              pathPrefix: config.endpoint.pathPrefix,
            },
          },
          smallCaps.maxFrameBytes,
        ),
      );
      const httpResult = yield* Effect.promise(() => httpDone.promise);
      assert.strictEqual(
        httpResult,
        `${config.endpoint.pathPrefix}|${"hello-agent-vela-stream-".length * 1200}`,
      );

      const snap = yield* client.getSnapshot();
      assert.strictEqual(snap.state, "online");
      assert.strictEqual(snap.runId, 7);

      ws.send(
        encodeFrameSync(
          {
            type: "open_ws",
            streamId: 3,
            payload: {
              path: "/ws",
              headers: [],
              protocols: [],
              externalHost: "relay.example.com",
              externalProto: "https",
              pathPrefix: config.endpoint.pathPrefix,
            },
          },
          smallCaps.maxFrameBytes,
        ),
      );
      const [wsResult, wsClosed] = yield* Effect.promise(() =>
        Promise.all([wsDone.promise, local.wsClosed]),
      );
      assert.strictEqual(
        wsResult,
        JSON.stringify([
          { text: true, textData: "echo:ping" },
          { text: false, binLen: 4 },
        ]),
      );
      assert.deepStrictEqual(wsClosed, { code: 1000, reason: "done" });
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
);

it.live(
  "reconnects on GOAWAY server_shutdown but stops permanently on GOAWAY kicked and auth_invalid",
  () =>
    Effect.gen(function* () {
      const relay = yield* listenMockRelayWss();
      const config = makeConfig(relay.port);
      const conn1 = Promise.withResolvers<void>();
      const conn2 = Promise.withResolvers<void>();
      const conn3 = Promise.withResolvers<void>();
      const conn3Closed = yield* Deferred.make<void>();
      let count = 0;
      let mode: "shutdown_then_kick" | "reject_auth" = "shutdown_then_kick";

      relay.wss.on("connection", (ws) => {
        const idx = ++count;
        ws.on("close", () => {
          if (idx === 3) {
            ws.removeAllListeners();
          }
        });
        ws.on("message", (raw: RawData) => {
          const frame = decodeFrameSync(rawDataToUint8Array(raw), DEFAULT_TUNNEL_MAX_FRAME_BYTES);
          if (frame.type === "login") {
            if (mode === "reject_auth") {
              ws.send(
                encodeFrameSync(
                  {
                    type: "login_resp",
                    streamId: 0,
                    payload: { ok: false, code: "auth_invalid", message: "Bad credential" },
                  },
                  DEFAULT_TUNNEL_MAX_FRAME_BYTES,
                ),
              );
              ws.close(1008, "Bad credential");
              conn3.resolve();
              return;
            }
            ws.send(
              encodeFrameSync(
                {
                  type: "login_resp",
                  streamId: 0,
                  payload: { ok: true, runId: idx, negotiated: smallCaps },
                },
                smallCaps.maxFrameBytes,
              ),
            );
            return;
          }
          if (frame.type === "register_proxy") {
            ws.send(
              encodeFrameSync(
                {
                  type: "register_proxy_resp",
                  streamId: 0,
                  payload: { ok: true, endpoint: config.endpoint },
                },
                smallCaps.maxFrameBytes,
              ),
            );
            if (idx === 1) conn1.resolve();
            if (idx === 2) conn2.resolve();
            ws.send(
              encodeFrameSync(
                {
                  type: "goaway",
                  streamId: 0,
                  payload:
                    idx === 1
                      ? { runId: idx, reason: "server_shutdown", message: "Restarting" }
                      : { runId: idx, reason: "kicked", message: "Admin kicked" },
                },
                smallCaps.maxFrameBytes,
              ),
            );
          }
        });
      });

      const client = yield* RelayTunnelClient.RelayTunnelClient;
      yield* client.setLocalOrigin({ host: "127.0.0.1", port: 9 });
      yield* client.configure(config);

      yield* Effect.promise(() => conn1.promise);
      yield* Effect.promise(() => conn2.promise);
      expect(count).toBe(2);

      mode = "reject_auth";
      yield* client.reconnect();
      yield* Effect.promise(() => conn3.promise);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(conn3Closed, undefined);
      yield* Deferred.await(conn3Closed);
      const snap = yield* client.getSnapshot();
      expect(["error", "connecting", "disconnected"]).toContain(snap.state);
      expect(count).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
);
