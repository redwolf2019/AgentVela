// @effect-diagnostics nodeBuiltinImport:off -- Server e2e tests use Node temp directories, zlib, and crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import { IsoDateTime } from "@t3tools/contracts";
import {
  AgentVelaRelayConnectScope,
  AgentVelaRelayStatusScope,
} from "@t3tools/contracts/agentVelaRelay";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@t3tools/shared/dpop";
import {
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_LINK_PROOF_TYP,
  RELAY_MINT_RESPONSE_TYP,
} from "@t3tools/shared/relayJwt";
import type { RelayTunnelFrame } from "@t3tools/shared/relayTunnelProtocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { generateEd25519PemKeypair } from "./auth/crypto.ts";
import { RELAY_SERVICE_VERSION } from "./config.ts";
import { startRelayServer } from "./server.ts";
import {
  connectSseEvents,
  decodeJwtPayloadNoVerify,
  makeRelayTestConfig,
  openMockTunnel,
  rawHttp,
  signDpop,
  signEd25519Jwt,
} from "./testHelpers.ts";

describe("AgentVela Relay control plane & lifecycle", () => {
  it.live(
    "runs control-plane, enrollment, SSE, DPoP broker, static UI, fencing, and admin kick",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tempDir = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-srv-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          const webDir = NodePath.join(tempDir, "web-dist");
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(webDir, "assets"), { recursive: true }),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(webDir, "index.html"), "<!doctype html><h1>Relay</h1>"),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(webDir, "assets", "app.js"), "console.log('ok');"),
          );

          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startRelayServer(makeRelayTestConfig({ dataDir: tempDir, webUiDir: webDir })),
            ),
            (handle) => Effect.promise(() => handle.close()),
          );

          const health = yield* Effect.promise(() =>
            rawHttp({ baseUrl: server.localHttpUrl, method: "GET", path: "/health" }),
          );
          expect(health.status).toBe(200);
          expect(JSON.parse(health.body.toString("utf8"))).toEqual({
            ok: true,
            service: "agent-vela-relay",
            version: RELAY_SERVICE_VERSION,
          });

          const uiIndex = yield* Effect.promise(() =>
            rawHttp({ baseUrl: server.localHttpUrl, method: "GET", path: "/" }),
          );
          expect(uiIndex.status).toBe(200);
          const html = uiIndex.body.toString("utf8");
          expect(html).toContain("Relay");
          expect(html).toContain('<meta name="agent-vela-relay-hosted" content="1" />');

          const apiProbe = yield* Effect.promise(() =>
            rawHttp({ baseUrl: server.localHttpUrl, method: "GET", path: "/api/auth/session" }),
          );
          expect(apiProbe.headers["content-type"] ?? "").not.toContain("text/html");

          const uiAsset = yield* Effect.promise(() =>
            rawHttp({ baseUrl: server.localHttpUrl, method: "GET", path: "/assets/app.js" }),
          );
          expect(uiAsset.status).toBe(200);
          expect(uiAsset.headers["cache-control"]).toContain("immutable");

          const traversal = yield* Effect.promise(() =>
            rawHttp({ baseUrl: server.localHttpUrl, method: "GET", path: "/../../etc/passwd" }),
          );
          expect(traversal.status).toBe(400);

          const loginRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: "/v1/auth/login",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: "admin", password: "e2e-relay-admin-passphrase" }),
            }),
          );
          expect(loginRes.status).toBe(200);
          const session = JSON.parse(loginRes.body.toString("utf8")) as {
            readonly accessToken: string;
          };

          const tokenRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: "/v1/environments/enrollment-tokens",
              headers: {
                authorization: `Bearer ${session.accessToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ labelHint: "Enrolled Linux Box" }),
            }),
          );
          expect(tokenRes.status).toBe(200);
          const { enrollmentToken } = JSON.parse(tokenRes.body.toString("utf8")) as {
            readonly enrollmentToken: string;
          };

          const chalRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: "/v1/environments/enroll/challenge",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enrollmentToken }),
            }),
          );
          expect(chalRes.status).toBe(200);
          const { challenge } = JSON.parse(chalRes.body.toString("utf8")) as {
            readonly challenge: string;
          };

          const envKeys = generateEd25519PemKeypair();
          const envId = "env-test-host-1";
          const now = yield* DateTime.now;
          const nowEpoch = Math.floor(now.epochMilliseconds / 1_000);
          const descriptor = {
            environmentId: envId,
            label: "Workstation",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.1.0-test",
            capabilities: { repositoryIdentity: true },
          };

          const enrollRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: "/v1/environments/enroll",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                enrollmentToken,
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
                    descriptor,
                  },
                }),
              }),
            }),
          );
          expect(enrollRes.status).toBe(200);
          const enrolled = JSON.parse(enrollRes.body.toString("utf8")) as {
            readonly relayIssuer: string;
            readonly environmentCredential: string;
          };

          const reuseEnrollRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: "/v1/environments/enroll/challenge",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enrollmentToken }),
            }),
          );
          expect(reuseEnrollRes.status).toBe(401);

          const sse = yield* Effect.acquireRelease(
            Effect.sync(() => connectSseEvents(server.localHttpUrl, session.accessToken)),
            (client) => Effect.sync(() => client.close()),
          );
          expect((yield* Effect.promise(() => sse.nextEvent())).type).toBe("snapshot");

          const pendingHttp = new Map<number, { path: string; chunks: Array<Buffer> }>();
          const mock1 = yield* Effect.promise(() =>
            openMockTunnel({
              wsUrl: server.localWsUrl,
              issuer: enrolled.relayIssuer,
              environmentId: envId,
              credential: enrolled.environmentCredential,
              privateKeyPem: envKeys.privateKeyPem,
              iat: nowEpoch,
              onStreamFrame: (frame: RelayTunnelFrame, send) => {
                if (frame.type === "open_http") {
                  pendingHttp.set(frame.streamId, { path: frame.payload.path, chunks: [] });
                  return;
                }
                if (frame.type !== "data" && frame.type !== "end") {
                  return;
                }
                const entry = pendingHttp.get(frame.streamId);
                if (!entry) {
                  return;
                }
                if (frame.type === "data") {
                  const plain = frame.compressed
                    ? NodeZlib.inflateRawSync(frame.payload)
                    : frame.payload;
                  entry.chunks.push(Buffer.from(plain));
                  if (!frame.endStream) {
                    return;
                  }
                }
                pendingHttp.delete(frame.streamId);
                const reqClaims = decodeJwtPayloadNoVerify(
                  (
                    JSON.parse(Buffer.concat(entry.chunks).toString("utf8")) as {
                      readonly proof: string;
                    }
                  ).proof,
                );
                const requestNonce = String(reqClaims.nonce);
                const exp = nowEpoch + 300;
                if (entry.path === "/api/t3-connect/health") {
                  const checkedAt = IsoDateTime.make(DateTime.formatIso(now));
                  const proof = signEd25519Jwt({
                    typ: RELAY_HEALTH_RESPONSE_TYP,
                    privateKeyPem: envKeys.privateKeyPem,
                    payload: {
                      iss: `t3-env:${envId}`,
                      aud: enrolled.relayIssuer,
                      sub: envId,
                      jti: NodeCrypto.randomUUID(),
                      iat: nowEpoch,
                      exp,
                      environmentId: envId,
                      requestNonce,
                      status: "online",
                      descriptor,
                      checkedAt,
                    },
                  });
                  send({
                    type: "http_response",
                    streamId: frame.streamId,
                    payload: {
                      status: 200,
                      headers: [["content-type", "application/json"]],
                      hasBody: true,
                    },
                  });
                  send({
                    type: "data",
                    streamId: frame.streamId,
                    payload: Buffer.from(
                      JSON.stringify({
                        environmentId: envId,
                        status: "online",
                        descriptor,
                        checkedAt,
                        proof,
                      }),
                    ),
                    endStream: true,
                    compressed: false,
                    wsText: false,
                  });
                } else if (entry.path === "/api/t3-connect/mint-credential") {
                  const thumbprint = String(reqClaims.clientProofKeyThumbprint);
                  const expiresAt = DateTime.formatIso(
                    DateTime.add(now, { seconds: exp - nowEpoch }),
                  );
                  const credential = "host-boot-cred-1";
                  const proof = signEd25519Jwt({
                    typ: RELAY_MINT_RESPONSE_TYP,
                    privateKeyPem: envKeys.privateKeyPem,
                    payload: {
                      iss: `t3-env:${envId}`,
                      aud: enrolled.relayIssuer,
                      sub: envId,
                      jti: NodeCrypto.randomUUID(),
                      iat: nowEpoch,
                      exp,
                      environmentId: envId,
                      clientProofKeyThumbprint: thumbprint,
                      requestNonce,
                      credential,
                    },
                  });
                  send({
                    type: "http_response",
                    streamId: frame.streamId,
                    payload: {
                      status: 200,
                      headers: [["content-type", "application/json"]],
                      hasBody: true,
                    },
                  });
                  send({
                    type: "data",
                    streamId: frame.streamId,
                    payload: Buffer.from(JSON.stringify({ credential, expiresAt, proof })),
                    endStream: true,
                    compressed: false,
                    wsText: false,
                  });
                }
              },
            }),
          );
          expect(mock1.runId).toBe(1);
          expect((yield* Effect.promise(() => sse.nextEvent())).type).toBe("environment.online");

          const { privateKey: clientDpopPriv, publicKey: clientDpopPub } =
            NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
          const clientJwk = clientDpopPub.export({ format: "jwk" }) as DpopPublicJwk;
          const thumbprint = computeDpopJwkThumbprint(clientJwk);

          const exchRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: "/v1/auth/dpop-token",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${session.accessToken}`,
                dpop: signDpop({
                  method: "POST",
                  url: `${server.localHttpUrl}/v1/auth/dpop-token`,
                  jti: "dpop-ex-1",
                  iat: nowEpoch,
                  privateKey: clientDpopPriv,
                  publicJwk: clientJwk,
                }),
              },
              body: JSON.stringify({
                scopes: [AgentVelaRelayConnectScope, AgentVelaRelayStatusScope],
                clientSurface: "web",
              }),
            }),
          );
          expect(exchRes.status).toBe(200);
          const { accessToken: dpopToken } = JSON.parse(exchRes.body.toString("utf8")) as {
            readonly accessToken: string;
          };

          const statusRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: `/v1/environments/${envId}/status`,
              headers: {
                "content-type": "application/json",
                authorization: `DPoP ${dpopToken}`,
                dpop: signDpop({
                  method: "POST",
                  url: `${server.localHttpUrl}/v1/environments/${envId}/status`,
                  jti: "dpop-st-1",
                  iat: nowEpoch,
                  privateKey: clientDpopPriv,
                  publicJwk: clientJwk,
                  accessToken: dpopToken,
                }),
              },
              body: "{}",
            }),
          );
          expect(statusRes.status).toBe(200);
          expect(
            (JSON.parse(statusRes.body.toString("utf8")) as { readonly status: string }).status,
          ).toBe("online");

          const connectMismatch = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: `/v1/environments/${envId}/connect`,
              headers: {
                "content-type": "application/json",
                authorization: `DPoP ${dpopToken}`,
                dpop: signDpop({
                  method: "POST",
                  url: `${server.localHttpUrl}/v1/environments/${envId}/connect`,
                  jti: "dpop-cn-bad",
                  iat: nowEpoch,
                  privateKey: clientDpopPriv,
                  publicJwk: clientJwk,
                  accessToken: dpopToken,
                }),
              },
              body: JSON.stringify({ clientProofKeyThumbprint: "attacker-thumbprint" }),
            }),
          );
          expect(connectMismatch.status).toBe(401);

          const connectRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: `/v1/environments/${envId}/connect`,
              headers: {
                "content-type": "application/json",
                authorization: `DPoP ${dpopToken}`,
                dpop: signDpop({
                  method: "POST",
                  url: `${server.localHttpUrl}/v1/environments/${envId}/connect`,
                  jti: "dpop-cn-ok",
                  iat: nowEpoch,
                  privateKey: clientDpopPriv,
                  publicJwk: clientJwk,
                  accessToken: dpopToken,
                }),
              },
              body: JSON.stringify({ clientProofKeyThumbprint: thumbprint }),
            }),
          );
          expect(connectRes.status).toBe(200);
          expect(
            (JSON.parse(connectRes.body.toString("utf8")) as { readonly credential: string })
              .credential,
          ).toBe("host-boot-cred-1");

          const mock2 = yield* Effect.promise(() =>
            openMockTunnel({
              wsUrl: server.localWsUrl,
              issuer: enrolled.relayIssuer,
              environmentId: envId,
              credential: enrolled.environmentCredential,
              privateKeyPem: envKeys.privateKeyPem,
              iat: nowEpoch,
            }),
          );
          expect(mock2.runId).toBe(2);
          expect((yield* Effect.promise(() => mock1.goAwayPromise)).payload.reason).toBe(
            "superseded",
          );
          yield* Effect.promise(() => mock1.close());

          const tunnelsRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "GET",
              path: "/v1/admin/tunnels",
              headers: { authorization: `Bearer ${session.accessToken}` },
            }),
          );
          expect(tunnelsRes.status).toBe(200);
          expect(
            (
              JSON.parse(tunnelsRes.body.toString("utf8")) as {
                readonly tunnels: ReadonlyArray<{ readonly runId: number }>;
              }
            ).tunnels[0]?.runId,
          ).toBe(2);

          const kickRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl: server.localHttpUrl,
              method: "POST",
              path: `/v1/admin/tunnels/${envId}/kick`,
              headers: {
                authorization: `Bearer ${session.accessToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ reason: "maintenance" }),
            }),
          );
          expect(kickRes.status).toBe(200);
          expect((yield* Effect.promise(() => mock2.goAwayPromise)).payload.reason).toBe("kicked");

          expect((yield* Effect.promise(() => sse.nextEvent())).type).toBe("environment.online");
          expect((yield* Effect.promise(() => sse.nextEvent())).type).toBe("environment.offline");
        }),
      ),
  );
});
