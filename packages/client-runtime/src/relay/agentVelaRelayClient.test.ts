import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  AgentVelaRelayConnectScope,
  AgentVelaRelayStatusScope,
  RelayEndpointKey,
  RelayInviteId,
  RelayUserId,
  RelayUsername,
} from "@t3tools/contracts/agentVelaRelay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { BearerConnectionProfile, ConnectionCredential } from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "../connection/model.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as ConnectionResolver from "../connection/resolver.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";
import { AgentVelaRelayClient, layerAgentVelaRelayClient } from "./agentVelaRelayClient.ts";
import { ManagedRelayDpopSigner } from "./managedRelay.ts";
import { layerManagedRelayBridge } from "./managedRelayBridge.ts";
import {
  RelayUrlConfig,
  layerInMemoryRelayConfigStorage,
  layerRelayUrlConfig,
} from "./relayConfig.ts";
import {
  RelayAuthSession,
  type StoredRelaySession,
  layerCloudSessionFromRelayAuth,
  layerInMemoryRelaySessionStore,
  layerRelayAuthSession,
} from "./relaySession.ts";

const RELAY_URL = "https://relay.example.com";
const OTHER_RELAY_URL = "https://relay-two.example.com";
const ENV_1 = EnvironmentId.make("env-client-1");
const ENDPOINT_KEY_1 = RelayEndpointKey.make("env-1234567890abcdef");
const PATH_PREFIX_1 = `/e/${ENDPOINT_KEY_1}`;
const RELAY_ENV_HTTP = `${RELAY_URL}${PATH_PREFIX_1}`;
const RELAY_ENV_WS = `wss://relay.example.com${PATH_PREFIX_1}`;
const LAN_HTTP = "https://lan-host.local:3773";
const LAN_WS = "wss://lan-host.local:3773";

const USER_1 = RelayUserId.make("user-1");
const USER_2 = RelayUserId.make("user-2");
const INVITE_1 = RelayInviteId.make("invite-1");

const ALICE = {
  userId: USER_1,
  username: RelayUsername.make("alice"),
  role: "admin" as const,
  disabled: false,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

const ENDPOINT_1 = {
  endpointKey: ENDPOINT_KEY_1,
  pathPrefix: TrimmedNonEmptyString.make(PATH_PREFIX_1),
  httpBaseUrl: TrimmedNonEmptyString.make(RELAY_ENV_HTTP),
  wsBaseUrl: TrimmedNonEmptyString.make(RELAY_ENV_WS),
};

const ENV_RECORD_1 = {
  environmentId: ENV_1,
  label: TrimmedNonEmptyString.make("Workstation"),
  endpoint: ENDPOINT_1,
  status: "online" as const,
  linkedAt: "1970-01-01T00:00:00.000Z",
  lastSeenAt: "1970-01-01T00:00:05.000Z",
};

const DESCRIPTOR = {
  environmentId: ENV_1,
  label: "Workstation",
  platform: { os: "linux" as const, arch: "x64" as const },
  serverVersion: "0.0.0-test",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true },
};

const INITIAL_SESSION: StoredRelaySession = {
  relayUrl: RELAY_URL,
  user: ALICE,
  accessToken: "bearer-1",
  accessTokenExpiresAt: "1970-01-01T01:00:00.000Z",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: "1970-01-02T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedFetch {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly dpop: string | null;
  readonly rawBody: string;
  readonly body: unknown;
}

async function readFetchRecord(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<RecordedFetch> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const rawBody =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : input instanceof Request && method !== "GET" && method !== "HEAD"
          ? await input.clone().text()
          : "";
  let parsedBody: unknown;
  if (rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }
  return {
    url,
    method,
    authorization: headers.get("authorization"),
    dpop: headers.get("dpop"),
    rawBody,
    body: parsedBody,
  };
}

function makeRelayClientStack(
  fetchFn: typeof globalThis.fetch,
  proofLog: Array<{ readonly method: string; readonly url: string; readonly accessToken?: string }>,
) {
  const configLayer = layerRelayUrlConfig({ defaultRelayUrl: RELAY_URL }).pipe(
    Layer.provide(layerInMemoryRelayConfigStorage()),
  );
  const storeLayer = layerInMemoryRelaySessionStore(INITIAL_SESSION);
  const httpLayer = RpcHttp.layerRemoteHttpClient(fetchFn);
  const sessionLayer = layerRelayAuthSession.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(httpLayer),
  );
  const signerLayer = Layer.succeed(
    ManagedRelayDpopSigner,
    ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("thumbprint-client-1"),
      createProof: (input) =>
        Effect.sync(() => {
          proofLog.push(input);
          return `proof:${input.method}:${input.url}:${input.accessToken ?? "no-ath"}`;
        }),
    }),
  );
  const clientLayer = layerAgentVelaRelayClient({ clientSurface: "web" }).pipe(
    Layer.provideMerge(sessionLayer),
    Layer.provideMerge(signerLayer),
    Layer.provideMerge(httpLayer),
  );
  return Layer.mergeAll(sessionLayer, signerLayer, clientLayer);
}

describe("agentVelaRelayClient", () => {
  it.effect(
    "exchanges and caches DPoP tokens, retries once on 401, checks scopes, and validates environmentId",
    () =>
      Effect.gen(function* () {
        const requests: Array<RecordedFetch> = [];
        const proofLog: Array<{
          readonly method: string;
          readonly url: string;
          readonly accessToken?: string;
        }> = [];
        let dpopExchangeCount = 0;
        let connectAttempt = 0;
        let grantFullScopes = true;
        let mismatchConnectEnvId = false;

        const fetchFn: typeof globalThis.fetch = async (input, init) => {
          const req = await readFetchRecord(input, init);
          requests.push(req);
          const path = new URL(req.url).pathname;

          if (path === "/v1/auth/dpop-token") {
            dpopExchangeCount += 1;
            const payload = req.body as { readonly scopes: ReadonlyArray<string> };
            return jsonResponse({
              accessToken: `dpop-tok-${dpopExchangeCount}`,
              tokenType: "DPoP",
              expiresIn: 300,
              scopes: grantFullScopes ? payload.scopes : [],
            });
          }
          if (path === `/v1/environments/${ENV_1}/connect`) {
            connectAttempt += 1;
            if (connectAttempt === 3) {
              return jsonResponse(
                {
                  _tag: "RelayAuthError",
                  code: "auth_invalid",
                  reason: "token_expired",
                  traceId: "trace-dpop-expired",
                },
                401,
              );
            }
            return jsonResponse({
              environmentId: mismatchConnectEnvId ? "env-wrong" : ENV_1,
              endpoint: ENDPOINT_1,
              credential: "minted-env-cred",
              expiresAt: "1970-01-01T00:10:00.000Z",
            });
          }
          if (path === `/v1/environments/${ENV_1}/status`) {
            return jsonResponse({
              environmentId: ENV_1,
              endpoint: ENDPOINT_1,
              status: "online",
              checkedAt: "1970-01-01T00:00:10.000Z",
            });
          }
          return jsonResponse({}, 404);
        };

        yield* Effect.gen(function* () {
          const client = yield* AgentVelaRelayClient;

          const firstConnect = yield* client.connectEnvironment({
            environmentId: ENV_1,
            deviceId: "device-1",
          });
          expect(firstConnect.credential).toBe("minted-env-cred");

          // Second connect reuses cached DPoP token (no second /v1/auth/dpop-token call)
          yield* client.connectEnvironment({ environmentId: ENV_1 });
          expect(dpopExchangeCount).toBe(1);

          // First proof has NO accessToken (dpop-token exchange); connect proofs include ath
          expect(proofLog[0]?.url).toBe(`${RELAY_URL}/v1/auth/dpop-token`);
          expect(proofLog[0]?.accessToken).toBeUndefined();
          expect(proofLog[1]?.url).toBe(`${RELAY_URL}/v1/environments/${ENV_1}/connect`);
          expect(proofLog[1]?.accessToken).toBe("dpop-tok-1");

          // Third attempt simulates 401 expired DPoP token -> evicts cache, exchanges dpop-tok-2, retries once
          const retried = yield* client.connectEnvironment({ environmentId: ENV_1 });
          expect(retried.environmentId).toBe(ENV_1);
          expect(dpopExchangeCount).toBe(2);
          expect(connectAttempt).toBe(4);

          // Missing requested DPoP scopes fails with RelayDpopScopeError
          grantFullScopes = false;
          const scopeError = yield* client
            .getEnvironmentStatus({ environmentId: ENV_1 })
            .pipe(Effect.flip);
          expect(scopeError._tag).toBe("RelayDpopScopeError");
          if (scopeError._tag === "RelayDpopScopeError") {
            expect(scopeError.requestedScopes).toEqual([AgentVelaRelayStatusScope]);
            expect(scopeError.grantedScopes).toEqual([]);
          }

          // Different scope requests get a distinct cached token when granted
          grantFullScopes = true;
          const statusRes = yield* client.getEnvironmentStatus({ environmentId: ENV_1 });
          expect(statusRes.status).toBe("online");

          // Reject mismatched environmentId from relay response
          mismatchConnectEnvId = true;
          const mismatchErr = yield* client
            .connectEnvironment({ environmentId: ENV_1 })
            .pipe(Effect.flip);
          expect(mismatchErr._tag).toBe("RelayApiRequestError");
        }).pipe(Effect.provide(makeRelayClientStack(fetchFn, proofLog)));

        const dpopExchangeBody = requests.find(
          (r) => new URL(r.url).pathname === "/v1/auth/dpop-token",
        )?.body as { readonly scopes: ReadonlyArray<string>; readonly clientSurface: string };
        expect(dpopExchangeBody.scopes).toEqual([AgentVelaRelayConnectScope]);
        expect(dpopExchangeBody.clientSurface).toBe("web");

        const connectReq = requests.find(
          (r) => new URL(r.url).pathname === `/v1/environments/${ENV_1}/connect`,
        );
        expect(connectReq?.authorization).toBe("DPoP dpop-tok-1");
        expect(connectReq?.body).toEqual({
          clientProofKeyThumbprint: "thumbprint-client-1",
          deviceId: "device-1",
        });
      }),
  );

  it.effect(
    "executes environment CRUD, all 8 admin APIs, and retargets when relay URL changes",
    () =>
      Effect.gen(function* () {
        const seenOrigins: Array<string> = [];
        const seenPaths: Array<string> = [];
        const proofLog: Array<{
          readonly method: string;
          readonly url: string;
          readonly accessToken?: string;
        }> = [];

        const fetchFn: typeof globalThis.fetch = async (input, init) => {
          const req = await readFetchRecord(input, init);
          const parsed = new URL(req.url);
          seenOrigins.push(parsed.origin);
          seenPaths.push(`${req.method} ${parsed.pathname}`);

          if (parsed.pathname === "/v1/environments" && req.method === "GET") {
            return jsonResponse({ environments: [ENV_RECORD_1] });
          }
          if (parsed.pathname === "/v1/environments/link-challenges") {
            return jsonResponse({
              challenge: "chal-123",
              expiresAt: "1970-01-01T00:05:00.000Z",
            });
          }
          if (parsed.pathname === "/v1/environments/link") {
            return jsonResponse({
              ok: true,
              userId: USER_1,
              environmentId: ENV_1,
              endpoint: ENDPOINT_1,
              relayIssuer: parsed.origin,
              environmentCredential: "env-cred",
              relayMintPublicKey: "ed25519:mint",
            });
          }
          if (parsed.pathname === `/v1/environments/${ENV_1}` && req.method === "DELETE") {
            return jsonResponse({ ok: true });
          }
          if (parsed.pathname === "/v1/environments/enrollment-tokens") {
            return jsonResponse({
              tokenId: "enroll-id-1",
              enrollmentToken: "enroll-secret-1",
              expiresAt: "1970-01-01T00:15:00.000Z",
            });
          }
          if (parsed.pathname === "/v1/admin/users" && req.method === "GET") {
            return jsonResponse({ users: [ALICE] });
          }
          if (parsed.pathname === "/v1/admin/users" && req.method === "POST") {
            return jsonResponse({ ...ALICE, userId: USER_2, username: "bob", role: "member" });
          }
          if (parsed.pathname === `/v1/admin/users/${USER_2}` && req.method === "PATCH") {
            return jsonResponse({
              ...ALICE,
              userId: USER_2,
              username: "bob",
              role: "admin",
              disabled: true,
            });
          }
          if (parsed.pathname === "/v1/admin/invites" && req.method === "GET") {
            return jsonResponse({ invites: [] });
          }
          if (parsed.pathname === "/v1/admin/invites" && req.method === "POST") {
            return jsonResponse({
              invite: {
                inviteId: INVITE_1,
                codePrefix: "INV1",
                role: "member",
                maxUses: 3,
                usesCount: 0,
                expiresAt: null,
                revokedAt: null,
                createdByUserId: USER_1,
                createdAt: "1970-01-01T00:00:00.000Z",
              },
              code: "INV1-SECRET",
            });
          }
          if (parsed.pathname === `/v1/admin/invites/${INVITE_1}` && req.method === "DELETE") {
            return jsonResponse({ ok: true });
          }
          if (parsed.pathname === "/v1/admin/tunnels" && req.method === "GET") {
            return jsonResponse({
              tunnels: [
                {
                  environmentId: ENV_1,
                  endpointKey: ENDPOINT_KEY_1,
                  label: "Workstation",
                  userId: USER_1,
                  username: "alice",
                  runId: 1,
                  connectedAt: "1970-01-01T00:00:00.000Z",
                  lastHeartbeatAt: "1970-01-01T00:00:02.000Z",
                  rttMs: 12,
                  activeStreams: 1,
                  bytesIn: 100,
                  bytesOut: 200,
                  compression: true,
                },
              ],
            });
          }
          if (parsed.pathname === `/v1/admin/tunnels/${ENV_1}/kick` && req.method === "POST") {
            return jsonResponse({ ok: true });
          }
          return jsonResponse({}, 404);
        };

        yield* Effect.gen(function* () {
          const client = yield* AgentVelaRelayClient;
          const config = yield* RelayUrlConfig;
          const session = yield* RelayAuthSession;

          expect(yield* client.listEnvironments).toHaveLength(1);
          expect((yield* client.createLinkChallenge).challenge).toBe("chal-123");
          expect(
            (yield* client.linkEnvironment({ proof: TrimmedNonEmptyString.make("host-proof") })).ok,
          ).toBe(true);
          expect((yield* client.unlinkEnvironment(ENV_1)).ok).toBe(true);
          expect(
            (yield* client.createEnrollmentToken({
              labelHint: TrimmedNonEmptyString.make("Build Box"),
              ttlMinutes: 15,
            })).enrollmentToken,
          ).toBe("enroll-secret-1");

          expect(yield* client.listUsers).toHaveLength(1);
          const createdUser = yield* client.createUser({
            username: RelayUsername.make("bob"),
            password: TrimmedNonEmptyString.make("very-strong-password"),
            role: "member",
          });
          expect(createdUser.userId).toBe(USER_2);
          const updatedUser = yield* client.updateUser(USER_2, { disabled: true, role: "admin" });
          expect(updatedUser.disabled).toBe(true);

          expect(yield* client.listInvites).toEqual([]);
          const invite = yield* client.createInvite({ role: "member", maxUses: 3 });
          expect(invite.code).toBe("INV1-SECRET");
          expect((yield* client.revokeInvite(INVITE_1)).ok).toBe(true);
          expect(yield* client.listTunnels).toHaveLength(1);
          expect((yield* client.kickTunnel(ENV_1, "rotate")).ok).toBe(true);

          // Retarget relay URL at runtime and adopt new session
          yield* config.setRelayUrl(OTHER_RELAY_URL);
          yield* session.adoptSession({
            user: ALICE,
            accessToken: TrimmedNonEmptyString.make("bearer-other"),
            accessTokenExpiresAt:
              "1970-01-01T01:00:00.000Z" as StoredRelaySession["accessTokenExpiresAt"],
            refreshToken: TrimmedNonEmptyString.make("refresh-other"),
            refreshTokenExpiresAt:
              "1970-01-02T00:00:00.000Z" as StoredRelaySession["refreshTokenExpiresAt"],
          });
          expect(yield* client.listEnvironments).toHaveLength(1);
        }).pipe(Effect.provide(makeRelayClientStack(fetchFn, proofLog)));

        expect(seenPaths).toEqual([
          "GET /v1/environments",
          "POST /v1/environments/link-challenges",
          "POST /v1/environments/link",
          `DELETE /v1/environments/${ENV_1}`,
          "POST /v1/environments/enrollment-tokens",
          "GET /v1/admin/users",
          "POST /v1/admin/users",
          `PATCH /v1/admin/users/${USER_2}`,
          "GET /v1/admin/invites",
          "POST /v1/admin/invites",
          `DELETE /v1/admin/invites/${INVITE_1}`,
          "GET /v1/admin/tunnels",
          `POST /v1/admin/tunnels/${ENV_1}/kick`,
          "GET /v1/environments",
        ]);
        expect(seenOrigins[0]).toBe(RELAY_URL);
        expect(seenOrigins[seenOrigins.length - 1]).toBe(OTHER_RELAY_URL);
      }),
  );

  it.effect(
    "integrates RelayAuthSession + AgentVelaRelayClient + ManagedRelayBridge + RemoteEnvironmentAuthorization over /e/:endpointKey and reuses host DPoP token on direct LAN failover",
    () =>
      Effect.gen(function* () {
        const requestedUrls: Array<string> = [];
        let relayConnectCalls = 0;
        let hostDpopExchangeCalls = 0;
        const tokens = yield* Ref.make(new Map<EnvironmentId, TokenStore.RemoteDpopAccessToken>());
        const unused = () => Effect.die("Unexpected store call");

        const fetchFn: typeof globalThis.fetch = async (input, init) => {
          const req = await readFetchRecord(input, init);
          requestedUrls.push(req.url);
          const parsed = new URL(req.url);

          if (parsed.origin === RELAY_URL && parsed.pathname === "/v1/auth/dpop-token") {
            return jsonResponse({
              accessToken: "relay-dpop-access",
              tokenType: "DPoP",
              expiresIn: 300,
              scopes: ["environment:connect"],
            });
          }
          if (
            parsed.origin === RELAY_URL &&
            parsed.pathname === `/v1/environments/${ENV_1}/connect`
          ) {
            relayConnectCalls += 1;
            return jsonResponse({
              environmentId: ENV_1,
              endpoint: ENDPOINT_1,
              credential: "minted-bootstrap-jwt",
              expiresAt: "1970-01-01T00:30:00.000Z",
            });
          }
          if (req.url === `${RELAY_ENV_HTTP}/.well-known/t3/environment`) {
            return jsonResponse(DESCRIPTOR);
          }
          if (req.url === `${RELAY_ENV_HTTP}/oauth/token`) {
            hostDpopExchangeCalls += 1;
            expect(req.dpop).toContain("proof:POST:");
            const form = new URLSearchParams(req.rawBody);
            expect(form.get("subject_token")).toBe("minted-bootstrap-jwt");
            return jsonResponse({
              access_token: "host-dpop-token-1",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "DPoP",
              expires_in: 3_600,
              scope: AuthStandardClientScopes.join(" "),
            });
          }
          if (req.url === `${RELAY_ENV_HTTP}/api/auth/websocket-ticket`) {
            expect(req.authorization).toBe("DPoP host-dpop-token-1");
            return jsonResponse({
              ticket: "ws-ticket-relay",
              expiresAt: "1970-01-01T01:00:00.000Z",
            });
          }
          if (req.url === `${LAN_HTTP}/.well-known/t3/environment`) {
            return jsonResponse(DESCRIPTOR);
          }
          if (req.url === `${LAN_HTTP}/api/auth/websocket-ticket`) {
            expect(req.authorization).toBe("DPoP host-dpop-token-1");
            return jsonResponse({
              ticket: "ws-ticket-lan",
              expiresAt: "1970-01-01T01:00:00.000Z",
            });
          }
          return jsonResponse({ message: `unexpected ${req.url}` }, 404);
        };

        const configLayer = layerRelayUrlConfig({ defaultRelayUrl: RELAY_URL }).pipe(
          Layer.provide(layerInMemoryRelayConfigStorage()),
        );
        const storeLayer = layerInMemoryRelaySessionStore(INITIAL_SESSION);
        const httpLayer = RpcHttp.layerRemoteHttpClient(fetchFn);
        const sessionLayer = layerRelayAuthSession.pipe(
          Layer.provideMerge(configLayer),
          Layer.provideMerge(storeLayer),
          Layer.provideMerge(httpLayer),
        );
        const cloudSessionLayer = layerCloudSessionFromRelayAuth.pipe(
          Layer.provideMerge(sessionLayer),
        );
        const signerLayer = Layer.succeed(
          ManagedRelayDpopSigner,
          ManagedRelayDpopSigner.of({
            thumbprint: Effect.succeed("thumbprint-e2e"),
            createProof: ({ method, url, accessToken }) =>
              Effect.succeed(`proof:${method}:${url}:${accessToken ?? "no-ath"}`),
          }),
        );
        const clientLayer = layerAgentVelaRelayClient({ clientSurface: "web" }).pipe(
          Layer.provideMerge(sessionLayer),
          Layer.provideMerge(signerLayer),
          Layer.provideMerge(httpLayer),
        );
        const bridgeLayer = layerManagedRelayBridge.pipe(
          Layer.provideMerge(clientLayer),
          Layer.provideMerge(configLayer),
        );
        const tokenStoreLayer = Layer.succeed(
          TokenStore.RemoteDpopAccessTokenStore,
          TokenStore.RemoteDpopAccessTokenStore.of({
            get: (environmentId) =>
              Ref.get(tokens).pipe(Effect.map((m) => Option.fromUndefinedOr(m.get(environmentId)))),
            put: (token) =>
              Ref.update(tokens, (m) => {
                const next = new Map(m);
                next.set(token.environmentId, token);
                return next;
              }),
            remove: (environmentId) =>
              Ref.update(tokens, (m) => {
                const next = new Map(m);
                next.delete(environmentId);
                return next;
              }),
          }),
        );
        const authLayer = RemoteEnvironmentAuthorization.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              httpLayer,
              signerLayer,
              bridgeLayer,
              cloudSessionLayer,
              tokenStoreLayer,
              ConnectionCredentialStore.layerMemory(
                [] as ReadonlyArray<readonly [string, ConnectionCredential]>,
              ),
              Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
                deviceId: Effect.succeedSome("device-e2e"),
              }),
              Layer.succeed(ClientCapabilities.ClientPresentation, {
                metadata: { label: "E2E Web", deviceType: "desktop", os: "macos" },
              }),
            ),
          ),
        );
        const resolverLayer = ConnectionResolver.layer.pipe(
          Layer.provideMerge(authLayer),
          Layer.provideMerge(
            Layer.mergeAll(
              tokenStoreLayer,
              Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
                get: unused,
                put: unused,
                remove: unused,
              }),
              ConnectionCredentialStore.layerMemory([]),
              Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
                bearerToken: Effect.succeedNone,
              }),
              Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
                provision: unused,
                prepare: unused,
                disconnect: unused,
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const resolver = yield* ConnectionResolver.ConnectionResolver;

          // 1. Connect via self-hosted relay path-prefixed /e/:endpointKey route
          const preparedRelay = yield* resolver.prepare({
            target: new RelayConnectionTarget({ environmentId: ENV_1, label: "Workstation" }),
            profile: Option.none(),
            enabled: true,
          });
          expect(preparedRelay.httpBaseUrl).toBe(RELAY_ENV_HTTP);
          const parsedRelaySocket = new URL(preparedRelay.socketUrl);
          expect(parsedRelaySocket.origin).toBe("wss://relay.example.com");
          expect(parsedRelaySocket.pathname).toBe(`${PATH_PREFIX_1}/ws`);
          expect(parsedRelaySocket.searchParams.get("wsTicket")).toBe("ws-ticket-relay");
          expect(parsedRelaySocket.searchParams.get("dpop")).toBe(
            `proof:GET:${RELAY_ENV_HTTP}/ws:ws-ticket-relay`,
          );
          expect(relayConnectCalls).toBe(1);
          expect(hostDpopExchangeCalls).toBe(1);

          // 2. Subsequent learned direct LAN route reuses cached host DPoP credential without calling relay again
          const preparedLan = yield* resolver.prepare({
            target: new BearerConnectionTarget({
              environmentId: ENV_1,
              label: "Workstation LAN",
              connectionId: "lan-learned",
            }),
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId: "lan-learned",
                environmentId: ENV_1,
                label: "Workstation LAN",
                httpBaseUrl: LAN_HTTP,
                wsBaseUrl: LAN_WS,
                learned: true,
                authorization: "t3-connect",
              }),
            ),
            enabled: true,
          });
          expect(preparedLan.httpBaseUrl).toBe(LAN_HTTP);
          const parsedLanSocket = new URL(preparedLan.socketUrl);
          expect(parsedLanSocket.origin).toBe(LAN_WS);
          expect(parsedLanSocket.pathname).toBe("/ws");
          expect(parsedLanSocket.searchParams.get("wsTicket")).toBe("ws-ticket-lan");
          expect(parsedLanSocket.searchParams.get("dpop")).toBe(
            `proof:GET:${LAN_HTTP}/ws:ws-ticket-lan`,
          );
          expect(relayConnectCalls).toBe(1);
          expect(hostDpopExchangeCalls).toBe(1);
        }).pipe(Effect.provide(resolverLayer));

        expect(requestedUrls.slice(0, 2)).toEqual([
          `${RELAY_URL}/v1/auth/dpop-token`,
          `${RELAY_URL}/v1/environments/${ENV_1}/connect`,
        ]);
        expect(requestedUrls).toContain(`${RELAY_ENV_HTTP}/oauth/token`);
        expect(requestedUrls).toContain(`${RELAY_ENV_HTTP}/.well-known/t3/environment`);
        expect(requestedUrls).toContain(`${RELAY_ENV_HTTP}/api/auth/websocket-ticket`);
        expect(requestedUrls).toContain(`${LAN_HTTP}/api/auth/websocket-ticket`);
        expect(requestedUrls).not.toContain(`${LAN_HTTP}/oauth/token`);
      }),
  );
});
