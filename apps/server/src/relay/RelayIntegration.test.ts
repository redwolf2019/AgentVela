// @effect-diagnostics nodeBuiltinImport:off -- End-to-end integration test exercises live relay process against real host Effect HTTP/WS server.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  AgentVelaRelayConnectScope,
  AgentVelaRelayStatusScope,
} from "@t3tools/contracts/agentVelaRelay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import type * as RelayTunnelClient from "./RelayTunnelClient.ts";
import {
  acquireHostHttpServer,
  buildHostWebApp,
  connectRelaySse,
  exerciseWsEcho,
  httpJson,
  makeDpopSigner,
  makeHostServiceLayer,
  RELAY_ADMIN_PASS,
  reserveFreePort,
  spawnRealRelay,
  type WebRequestFn,
} from "./relayIntegration.testkit.ts";

async function verifyBrokerHealthAndConnect(input: {
  readonly relayUrl: string;
  readonly adminToken: string;
  readonly envId: EnvironmentId;
  readonly iat: number;
}) {
  const dpop = makeDpopSigner(input.iat);
  const exchRes = await httpJson<{ readonly accessToken: string }>({
    baseUrl: input.relayUrl,
    method: "POST",
    path: "/v1/auth/dpop-token",
    headers: {
      authorization: `Bearer ${input.adminToken}`,
      dpop: dpop.sign("POST", `${input.relayUrl}/v1/auth/dpop-token`),
    },
    body: { scopes: [AgentVelaRelayConnectScope, AgentVelaRelayStatusScope], clientSurface: "web" },
  });
  expect(exchRes.status).toBe(200);
  const dpopToken = exchRes.data.accessToken;

  const statusRes = await httpJson<{
    readonly status: string;
    readonly descriptor?: { readonly environmentId: string };
  }>({
    baseUrl: input.relayUrl,
    method: "POST",
    path: `/v1/environments/${input.envId}/status`,
    headers: {
      authorization: `DPoP ${dpopToken}`,
      dpop: dpop.sign("POST", `${input.relayUrl}/v1/environments/${input.envId}/status`, dpopToken),
    },
    body: {},
  });
  expect(statusRes.status).toBe(200);
  expect(statusRes.data.status).toBe("online");
  expect(statusRes.data.descriptor?.environmentId).toBe(input.envId);

  const connectRes = await httpJson<{ readonly credential: string }>({
    baseUrl: input.relayUrl,
    method: "POST",
    path: `/v1/environments/${input.envId}/connect`,
    headers: {
      authorization: `DPoP ${dpopToken}`,
      dpop: dpop.sign(
        "POST",
        `${input.relayUrl}/v1/environments/${input.envId}/connect`,
        dpopToken,
      ),
    },
    body: { clientProofKeyThumbprint: dpop.thumbprint },
  });
  expect(connectRes.status).toBe(200);
  return { dpop, credential: connectRes.data.credential };
}

async function exchangeOAuthAndVerifyStatus(input: {
  readonly relayUrl: string;
  readonly endpointKey: string;
  readonly credential: string;
  readonly dpop: ReturnType<typeof makeDpopSigner>;
}) {
  const oauthUrl = `${input.relayUrl}/e/${input.endpointKey}/oauth/token`;
  const oauthRes = await httpJson<{ readonly access_token: string; readonly token_type: string }>({
    baseUrl: input.relayUrl,
    method: "POST",
    path: `/e/${input.endpointKey}/oauth/token`,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      dpop: input.dpop.sign("POST", oauthUrl),
    },
    rawBody: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: input.credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
    }).toString(),
  });
  expect(oauthRes.status).toBe(200);
  expect(oauthRes.data.token_type).toBe("DPoP");

  const statusUrl = `${input.relayUrl}/e/${input.endpointKey}/api/relay/status`;
  const proxied = await httpJson<{
    readonly linked: boolean;
    readonly tunnel: { readonly state: string };
  }>({
    baseUrl: input.relayUrl,
    method: "GET",
    path: `/e/${input.endpointKey}/api/relay/status`,
    headers: {
      authorization: `DPoP ${oauthRes.data.access_token}`,
      dpop: input.dpop.sign("GET", statusUrl, oauthRes.data.access_token),
    },
  });
  expect(proxied.status).toBe(200);
  expect(proxied.data.linked).toBe(true);
  expect(proxied.data.tunnel.state).toBe("online");
}

const loginEnrollAndWaitOnline = Effect.fn("RelayIntegration.loginEnroll")(function* (input: {
  readonly relayUrl: string;
  readonly hostPort: number;
  readonly setHandler: (fn: WebRequestFn) => void;
}) {
  const host = yield* buildHostWebApp();
  input.setHandler(host.handler);
  yield* host.tunnelClient.setLocalOrigin({ host: "127.0.0.1", port: input.hostPort });

  const loginRes = yield* Effect.promise(() =>
    httpJson<{ readonly accessToken: string }>({
      baseUrl: input.relayUrl,
      method: "POST",
      path: "/v1/auth/login",
      body: { username: "admin", password: RELAY_ADMIN_PASS },
    }),
  );
  expect(loginRes.status).toBe(200);
  const sse = yield* Effect.acquireRelease(
    Effect.sync(() => connectRelaySse(input.relayUrl, loginRes.data.accessToken)),
    (stream) => Effect.sync(() => stream.close()),
  );
  yield* Effect.promise(() => sse.nextOfType("snapshot"));

  const tokenRes = yield* Effect.promise(() =>
    httpJson<{ readonly enrollmentToken: string }>({
      baseUrl: input.relayUrl,
      method: "POST",
      path: "/v1/environments/enrollment-tokens",
      headers: { authorization: `Bearer ${loginRes.data.accessToken}` },
      body: { labelHint: "Integration Host" },
    }),
  );
  expect(tokenRes.status).toBe(200);
  const enrolled = yield* host.relayLinks.enrollWithToken({
    relayUrl: input.relayUrl,
    enrollmentToken: tokenRes.data.enrollmentToken,
  });
  expect(enrolled.linked).toBe(true);
  yield* Effect.promise(() => sse.nextOfType("environment.online"));
  const onlineSnap = yield* host.tunnelClient.snapshotChanges.pipe(
    Stream.filter((s) => s.state === "online"),
    Stream.runHead,
  );
  expect(Option.isSome(onlineSnap) && onlineSnap.value.runId !== null).toBe(true);
  return {
    host,
    sse,
    adminToken: loginRes.data.accessToken,
    endpointKey: enrolled.endpoint!.endpointKey,
  };
});

const verifyWebhookAndAdminKick = Effect.fn("RelayIntegration.verifyWebhookKick")(
  function* (input: {
    readonly relayUrl: string;
    readonly envId: EnvironmentId;
    readonly endpointKey: string;
    readonly adminToken: string;
    readonly tunnelClient: RelayTunnelClient.RelayTunnelClient["Service"];
    readonly sse: ReturnType<typeof connectRelaySse>;
    readonly webhookCalls: ReadonlyArray<ScheduledTaskService.WebhookTriggerRequest>;
  }) {
    const hookRes = yield* Effect.promise(() =>
      httpJson<{ readonly deliveryId: string }>({
        baseUrl: input.relayUrl,
        method: "POST",
        path: `/v1/hooks/${input.endpointKey}/hook-1/secret-tok`,
        body: { event: "push" },
      }),
    );
    expect(hookRes.status).toBe(202);
    expect(input.webhookCalls).toHaveLength(1);
    expect(input.webhookCalls[0]?.hookId).toBe("hook-1");
    expect(input.webhookCalls[0]?.token).toBe("secret-tok");
    expect(input.webhookCalls[0]?.relayDeliveryId).toBeTruthy();

    const kickRes = yield* Effect.promise(() =>
      httpJson<{ readonly ok: boolean }>({
        baseUrl: input.relayUrl,
        method: "POST",
        path: `/v1/admin/tunnels/${input.envId}/kick`,
        headers: { authorization: `Bearer ${input.adminToken}` },
        body: { reason: "integration_kick" },
      }),
    );
    expect(kickRes.status).toBe(200);
    yield* Effect.promise(() => input.sse.nextOfType("environment.offline"));
    const kickedSnap = yield* input.tunnelClient.snapshotChanges.pipe(
      Stream.filter((s) => s.state === "error"),
      Stream.runHead,
    );
    expect(Option.isSome(kickedSnap)).toBe(true);
    expect(Option.getOrThrow(kickedSnap).lastError).toContain("integration_kick");
    const tunnelsRes = yield* Effect.promise(() =>
      httpJson<{ readonly tunnels: ReadonlyArray<unknown> }>({
        baseUrl: input.relayUrl,
        method: "GET",
        path: "/v1/admin/tunnels",
        headers: { authorization: `Bearer ${input.adminToken}` },
      }),
    );
    expect(tunnelsRes.status).toBe(200);
    expect(tunnelsRes.data.tunnels).toEqual([]);
  },
);

describe("RelayIntegration (real relay process + host HTTP/WS server)", () => {
  it.live(
    "enrolls, connects tunnel, serves DPoP connect/status, HTTP/WS proxy, webhooks, and admin kick",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tempDir = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-relay-e2e-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          const relayPort = yield* Effect.promise(() => reserveFreePort());
          const relay = yield* spawnRealRelay(relayPort, tempDir);
          const hostServer = yield* acquireHostHttpServer();
          const webhookCalls: Array<ScheduledTaskService.WebhookTriggerRequest> = [];
          const now = yield* DateTime.now;
          const iat = Math.floor(DateTime.toEpochMillis(now) / 1_000);

          yield* Effect.gen(function* () {
            const started = yield* loginEnrollAndWaitOnline({
              relayUrl: relay.baseUrl,
              hostPort: hostServer.port,
              setHandler: hostServer.setHandler,
            });
            const envId = yield* started.host.identity.getEnvironmentId;
            const minted = yield* Effect.promise(() =>
              verifyBrokerHealthAndConnect({
                relayUrl: relay.baseUrl,
                adminToken: started.adminToken,
                envId,
                iat,
              }),
            );
            yield* Effect.promise(() =>
              exchangeOAuthAndVerifyStatus({
                relayUrl: relay.baseUrl,
                endpointKey: started.endpointKey,
                credential: minted.credential,
                dpop: minted.dpop,
              }),
            );
            expect(
              yield* Effect.promise(() =>
                exerciseWsEcho(`ws://127.0.0.1:${relayPort}/e/${started.endpointKey}/ws-echo`),
              ),
            ).toBe(1000);
            yield* verifyWebhookAndAdminKick({
              relayUrl: relay.baseUrl,
              envId,
              endpointKey: started.endpointKey,
              adminToken: started.adminToken,
              tunnelClient: started.host.tunnelClient,
              sse: started.sse,
              webhookCalls,
            });
          }).pipe(
            Effect.scoped,
            Effect.provide(makeHostServiceLayer(tempDir, hostServer.port, webhookCalls)),
          );
        }),
      ),
  );
});
