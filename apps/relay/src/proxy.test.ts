// @effect-diagnostics nodeBuiltinImport:off -- Proxy tests run Node HTTP/WS clients and zlib/crypto verification.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import { RELAY_HOOK_DELIVERY_HEADER, RELAY_LINK_PROOF_TYP } from "@t3tools/shared/relayJwt";
import type { RelayTunnelFrame } from "@t3tools/shared/relayTunnelProtocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { WebSocket } from "ws";

import { generateEd25519PemKeypair } from "./auth/crypto.ts";
import { startRelayServer } from "./server.ts";
import {
  makeRelayTestConfig,
  openMockTunnel,
  rawHttp,
  rawToBytes,
  signEd25519Jwt,
} from "./testHelpers.ts";

describe("AgentVela Relay HTTP, WebSocket, and Webhook proxy", () => {
  it.live(
    "proxies streaming compressed HTTP, credit windows, WebSocket frames, live webhooks, and offline statuses",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tempDir = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-proxy-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startRelayServer(
                makeRelayTestConfig({
                  dataDir: tempDir,
                  maxFrameBytes: 32_768,
                  initialStreamWindowBytes: 65_536,
                }),
              ),
            ),
            (handle) => Effect.promise(() => handle.close()),
          );

          const loginRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: "/v1/auth/login",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: "admin", password: "e2e-relay-admin-passphrase" }),
            }),
          );
          const { accessToken } = JSON.parse(loginRes.body.toString("utf8")) as {
            readonly accessToken: string;
          };

          const chalRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: "/v1/environments/link-challenges",
              headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "application/json",
              },
              body: "{}",
            }),
          );
          const { challenge } = JSON.parse(chalRes.body.toString("utf8")) as {
            readonly challenge: string;
          };

          const envKeys = generateEd25519PemKeypair();
          const envId = "env-proxy-1";
          const nowEpoch = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
          const linkRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: "/v1/environments/link",
              headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                proof: signEd25519Jwt({
                  typ: RELAY_LINK_PROOF_TYP,
                  privateKeyPem: envKeys.privateKeyPem,
                  payload: {
                    iss: `t3-env:${envId}`,
                    aud: "http://127.0.0.1:8787",
                    sub: envId,
                    jti: NodeCrypto.randomUUID(),
                    iat: nowEpoch,
                    exp: nowEpoch + 180,
                    challenge,
                    environmentId: envId,
                    environmentPublicKey: envKeys.publicKeyPem,
                    descriptor: {
                      environmentId: envId,
                      label: "Proxy Host",
                      platform: { os: "darwin", arch: "arm64" },
                      serverVersion: "0.1.0-test",
                      capabilities: { repositoryIdentity: true },
                    },
                  },
                }),
              }),
            }),
          );
          expect(linkRes.status).toBe(200);
          const linked = JSON.parse(linkRes.body.toString("utf8")) as {
            readonly endpoint: { readonly endpointKey: string; readonly pathPrefix: string };
            readonly relayIssuer: string;
            readonly environmentCredential: string;
          };

          const randomPayload = NodeCrypto.randomBytes(40_000);
          const compressedTail = Buffer.from("compressed-payload-chunk-".repeat(40), "utf8");
          const pendingHttp = new Map<
            number,
            {
              readonly path: string;
              readonly headers: ReadonlyArray<readonly [string, string]>;
              readonly chunks: Array<Buffer>;
            }
          >();
          const wsStreams = new Set<number>();
          const windowUpdatesReceived: Array<number> = [];
          let wsStreamCloseResolve!: (code: number | undefined) => void;
          const wsStreamClosePromise = new Promise<number | undefined>((r) => {
            wsStreamCloseResolve = r;
          });

          const tunnel = yield* Effect.promise(() =>
            openMockTunnel({
              wsUrl: server.localWsUrl,
              issuer: linked.relayIssuer,
              environmentId: envId,
              credential: linked.environmentCredential,
              privateKeyPem: envKeys.privateKeyPem,
              iat: nowEpoch,
              maxFrameBytes: 32_768,
              initialStreamWindowBytes: 65_536,
              onStreamFrame: (frame: RelayTunnelFrame, send) => {
                if (frame.type === "window_update") {
                  windowUpdatesReceived.push(frame.creditBytes);
                  return;
                }
                if (frame.type === "open_http") {
                  pendingHttp.set(frame.streamId, {
                    path: frame.payload.path,
                    headers: frame.payload.headers,
                    chunks: [],
                  });
                  if (!frame.payload.hasBody) {
                    pendingHttp.delete(frame.streamId);
                    if (frame.payload.path === "/hello?x=1") {
                      send({
                        type: "http_response",
                        streamId: frame.streamId,
                        payload: { status: 200, headers: [["x-proxied", "yes"]], hasBody: true },
                      });
                      send({
                        type: "data",
                        streamId: frame.streamId,
                        payload: Buffer.from(
                          JSON.stringify({
                            path: frame.payload.path,
                            prefix: frame.payload.pathPrefix,
                            fwdPrefix: frame.payload.headers.find(
                              ([k]) => k === "x-forwarded-prefix",
                            )?.[1],
                          }),
                        ),
                        endStream: true,
                        compressed: false,
                        wsText: false,
                      });
                    } else if (frame.payload.path === "/large") {
                      send({
                        type: "http_response",
                        streamId: frame.streamId,
                        payload: {
                          status: 200,
                          headers: [["content-type", "application/octet-stream"]],
                          hasBody: true,
                        },
                      });
                      send({
                        type: "data",
                        streamId: frame.streamId,
                        payload: randomPayload.subarray(0, 20_000),
                        endStream: false,
                        compressed: false,
                        wsText: false,
                      });
                      send({
                        type: "data",
                        streamId: frame.streamId,
                        payload: randomPayload.subarray(20_000),
                        endStream: false,
                        compressed: false,
                        wsText: false,
                      });
                      send({
                        type: "data",
                        streamId: frame.streamId,
                        payload: new Uint8Array(NodeZlib.deflateRawSync(compressedTail)),
                        endStream: true,
                        compressed: true,
                        wsText: false,
                      });
                    }
                  }
                  return;
                }
                if (frame.type === "open_ws") {
                  wsStreams.add(frame.streamId);
                  send({
                    type: "ws_accept",
                    streamId: frame.streamId,
                    payload: {
                      ok: true,
                      ...(frame.payload.protocols[0]
                        ? { protocol: frame.payload.protocols[0] }
                        : {}),
                      headers: [],
                    },
                  });
                  return;
                }
                if (frame.type !== "data" && frame.type !== "end") {
                  return;
                }
                const httpReq = pendingHttp.get(frame.streamId);
                if (httpReq) {
                  if (frame.type === "data") {
                    const plain = frame.compressed
                      ? NodeZlib.inflateRawSync(frame.payload)
                      : frame.payload;
                    httpReq.chunks.push(Buffer.from(plain));
                    if (!frame.endStream) {
                      return;
                    }
                  }
                  pendingHttp.delete(frame.streamId);
                  send({
                    type: "http_response",
                    streamId: frame.streamId,
                    payload: {
                      status: 202,
                      headers: [["content-type", "application/json"]],
                      hasBody: true,
                    },
                  });
                  send({
                    type: "data",
                    streamId: frame.streamId,
                    payload: Buffer.from(
                      JSON.stringify({
                        path: httpReq.path,
                        body: Buffer.concat(httpReq.chunks).toString("utf8"),
                        hasCookie: httpReq.headers.some(([k]) => k === "cookie"),
                        hasRelaySig: httpReq.headers.some(
                          ([k]) => k === RELAY_HOOK_DELIVERY_HEADER,
                        ),
                      }),
                    ),
                    endStream: true,
                    compressed: false,
                    wsText: false,
                  });
                  return;
                }
                if (wsStreams.has(frame.streamId)) {
                  if (frame.type === "end") {
                    wsStreams.delete(frame.streamId);
                    wsStreamCloseResolve(frame.payload.closeCode);
                    return;
                  }
                  const plain = frame.compressed
                    ? NodeZlib.inflateRawSync(frame.payload)
                    : frame.payload;
                  send({
                    type: "data",
                    streamId: frame.streamId,
                    payload: plain,
                    endStream: false,
                    compressed: false,
                    wsText: frame.wsText,
                  });
                }
              },
            }),
          );

          const httpRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "GET",
              path: `${linked.endpoint.pathPrefix}/hello?x=1`,
            }),
          );
          expect(httpRes.status).toBe(200);
          expect(httpRes.headers["x-proxied"]).toBe("yes");
          expect(JSON.parse(httpRes.body.toString("utf8"))).toEqual({
            path: "/hello?x=1",
            prefix: linked.endpoint.pathPrefix,
            fwdPrefix: linked.endpoint.pathPrefix,
          });

          const largeRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "GET",
              path: `${linked.endpoint.pathPrefix}/large`,
            }),
          );
          expect(largeRes.status).toBe(200);
          expect(largeRes.body.equals(Buffer.concat([randomPayload, compressedTail]))).toBe(true);
          expect(windowUpdatesReceived.length).toBeGreaterThanOrEqual(1);

          const hookRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: `/v1/hooks/${linked.endpoint.endpointKey}/hk1/tok%201?src=gh`,
              headers: {
                cookie: "secret=1",
                "x-forwarded-for": "1.2.3.4",
                "content-type": "application/json",
              },
              body: JSON.stringify({ event: "push" }),
            }),
          );
          expect(hookRes.status).toBe(202);
          expect(hookRes.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
          expect(JSON.parse(hookRes.body.toString("utf8"))).toEqual({
            path: "/api/hooks/hk1/tok%201?src=gh",
            body: JSON.stringify({ event: "push" }),
            hasCookie: false,
            hasRelaySig: true,
          });

          const clientWs = new WebSocket(`${server.localWsUrl}${linked.endpoint.pathPrefix}/ws`, [
            "t3-rpc",
          ]);
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                clientWs.once("open", resolve);
                clientWs.once("error", reject);
              }),
          );
          expect(clientWs.protocol).toBe("t3-rpc");

          const echoedText = new Promise<string>((resolve) => {
            clientWs.once("message", (data, isBinary) => {
              expect(isBinary).toBe(false);
              resolve(Buffer.from(rawToBytes(data)).toString("utf8"));
            });
          });
          clientWs.send("ping-rpc");
          expect(yield* Effect.promise(() => echoedText)).toBe("ping-rpc");

          const echoedBin = new Promise<Buffer>((resolve) => {
            clientWs.once("message", (data, isBinary) => {
              expect(isBinary).toBe(true);
              resolve(Buffer.from(rawToBytes(data)));
            });
          });
          clientWs.send(Buffer.from([1, 2, 3, 4]), { binary: true });
          expect(Array.from(yield* Effect.promise(() => echoedBin))).toEqual([1, 2, 3, 4]);

          clientWs.close(1000, "done");
          expect(yield* Effect.promise(() => wsStreamClosePromise)).toBe(1000);

          yield* Effect.promise(() => tunnel.close());

          const offlineProxy = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "GET",
              path: `${linked.endpoint.pathPrefix}/hello?x=1`,
            }),
          );
          expect(offlineProxy.status).toBe(502);

          const offlineHook = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: `/v1/hooks/${linked.endpoint.endpointKey}/hk1/tok1`,
              body: "{}",
            }),
          );
          expect(offlineHook.status).toBe(503);
        }),
      ),
  );
});
