import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  type HostRelayStatus,
  RelayEndpointKey,
  RelayUserId,
  RelayUsername,
} from "@t3tools/contracts/agentVelaRelay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as Connectivity from "../connection/connectivity.ts";
import {
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcHttp from "../rpc/http.ts";
import { createSelfHostedRelayAtoms } from "../state/selfHostedRelay.ts";
import { layerAgentVelaRelayClient } from "./agentVelaRelayClient.ts";
import {
  linkHostToRelay,
  readHostRelayStatus,
  reconnectHostRelay,
  unlinkHostFromRelay,
} from "./hostControl.ts";
import { ManagedRelayDpopSigner } from "./managedRelay.ts";
import { RelayPresenceFetch, layerSelfHostedRelayDiscovery } from "./presence.ts";
import { layerInMemoryRelayConfigStorage, layerRelayUrlConfig } from "./relayConfig.ts";
import {
  RelayAuthSession,
  type StoredRelaySession,
  layerInMemoryRelaySessionStore,
  layerRelayAuthSession,
} from "./relaySession.ts";

const RELAY_URL = "https://relay.example.com";
const HOST_HTTP = "https://host.local:3773";
const HOST_WS = "wss://host.local:3773";
const ENV_1 = EnvironmentId.make("env-host-1");
const ENDPOINT_KEY_1 = RelayEndpointKey.make("env-hostkey-123456");
const USER_1 = RelayUserId.make("user-1");

const ALICE = {
  userId: USER_1,
  username: RelayUsername.make("alice"),
  role: "admin" as const,
  disabled: false,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

const SIGNED_IN_SESSION: StoredRelaySession = {
  relayUrl: RELAY_URL,
  user: ALICE,
  accessToken: "bearer-1",
  accessTokenExpiresAt: "1970-01-01T01:00:00.000Z",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: "1970-01-02T00:00:00.000Z",
};

const ENDPOINT_1 = {
  endpointKey: ENDPOINT_KEY_1,
  pathPrefix: TrimmedNonEmptyString.make(`/e/${ENDPOINT_KEY_1}`),
  httpBaseUrl: TrimmedNonEmptyString.make(`${RELAY_URL}/e/${ENDPOINT_KEY_1}`),
  wsBaseUrl: TrimmedNonEmptyString.make(`wss://relay.example.com/e/${ENDPOINT_KEY_1}`),
};

const DESCRIPTOR = {
  environmentId: ENV_1,
  label: "Host Machine",
  platform: { os: "linux" as const, arch: "x64" as const },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

const DISCONNECTED_STATUS: HostRelayStatus = {
  linked: false,
  relayUrl: null,
  relayIssuer: null,
  userId: null,
  endpoint: null,
  tunnel: {
    state: "disconnected",
    runId: null,
    rttMs: null,
    activeStreams: 0,
    connectedAt: null,
    lastError: null,
    compression: true,
  },
};

const LINKED_ONLINE_STATUS: HostRelayStatus = {
  linked: true,
  relayUrl: TrimmedNonEmptyString.make(RELAY_URL),
  relayIssuer: TrimmedNonEmptyString.make(RELAY_URL),
  userId: USER_1,
  endpoint: ENDPOINT_1,
  tunnel: {
    state: "online",
    runId: 3,
    rttMs: 14,
    activeStreams: 2,
    connectedAt: "1970-01-01T00:00:00.000Z" as HostRelayStatus["tunnel"]["connectedAt"],
    lastError: null,
    compression: true,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFullStack(
  fetchFn: typeof globalThis.fetch,
  options?: { readonly initialSession?: StoredRelaySession | null },
) {
  const configLayer = layerRelayUrlConfig({ defaultRelayUrl: RELAY_URL }).pipe(
    Layer.provide(layerInMemoryRelayConfigStorage()),
  );
  const storeLayer = layerInMemoryRelaySessionStore(
    options?.initialSession === undefined ? SIGNED_IN_SESSION : options.initialSession,
  );
  const httpLayer = RpcHttp.layerRemoteHttpClient(fetchFn);
  const sessionLayer = layerRelayAuthSession.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(httpLayer),
  );
  const signerLayer = Layer.succeed(
    ManagedRelayDpopSigner,
    ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("jkt-host-ctrl"),
      createProof: ({ url }) => Effect.succeed(`proof:${url}`),
    }),
  );
  const clientLayer = layerAgentVelaRelayClient({ clientSurface: "web" }).pipe(
    Layer.provideMerge(sessionLayer),
    Layer.provideMerge(signerLayer),
    Layer.provideMerge(httpLayer),
  );
  const connectivityLayer = Layer.effect(
    Connectivity.Connectivity,
    SubscriptionRef.make<NetworkStatus>("online").pipe(
      Effect.map((ref) =>
        Connectivity.Connectivity.of({
          status: SubscriptionRef.get(ref),
          changes: SubscriptionRef.changes(ref),
        }),
      ),
    ),
  );
  const sseStream = new ReadableStream<Uint8Array>({ start() {} });
  const discoveryLayer = layerSelfHostedRelayDiscovery().pipe(
    Layer.provideMerge(sessionLayer),
    Layer.provideMerge(clientLayer),
    Layer.provideMerge(connectivityLayer),
    Layer.provide(
      Layer.succeed(RelayPresenceFetch, async () => {
        return new Response(sseStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    ),
  );
  const registryLayer = Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: ENV_1,
        label: "Host Machine",
        httpBaseUrl: HOST_HTTP,
        wsBaseUrl: HOST_WS,
      });
      const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
        Option.some({
          environmentId: ENV_1,
          label: "Host Machine",
          httpBaseUrl: HOST_HTTP,
          socketUrl: `${HOST_WS}/ws`,
          httpAuthorization: null,
          target,
          descriptor: DESCRIPTOR,
        }),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        prepared,
      } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
        _environmentId,
        effect,
      ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      return EnvironmentRegistry.EnvironmentRegistry.of({
        run,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    }),
  );

  return Layer.mergeAll(
    configLayer,
    sessionLayer,
    clientLayer,
    discoveryLayer,
    registryLayer,
    httpLayer,
  );
}

function awaitAtomValue<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  predicate: (value: A) => boolean,
): Effect.Effect<A> {
  return Effect.callback((resume) => {
    const current = registry.get(atom);
    if (predicate(current)) {
      resume(Effect.succeed(current));
      return;
    }
    const unsubscribe = registry.subscribe(atom, (next) => {
      if (predicate(next)) {
        unsubscribe();
        resume(Effect.succeed(next));
      }
    });
    return Effect.sync(() => {
      unsubscribe();
    });
  });
}

describe("hostControl and selfHostedRelay atoms", () => {
  it.effect(
    "reads status, links host via 4-step challenge/proof/link/config flow, reconnects, and unlinks",
    () =>
      Effect.gen(function* () {
        const seenCalls: Array<string> = [];
        let hostProofEnvId = ENV_1;
        let relayLinkEnvId = ENV_1;
        let unlinkRelayStatus = 200;

        const fetchFn: typeof globalThis.fetch = async (input, init) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          const parsed = new URL(url);
          const method = (init?.method ?? "GET").toUpperCase();
          seenCalls.push(`${method} ${parsed.origin}${parsed.pathname}`);

          if (parsed.origin === HOST_HTTP && parsed.pathname === "/api/relay/status") {
            return jsonResponse(DISCONNECTED_STATUS);
          }
          if (
            parsed.origin === RELAY_URL &&
            parsed.pathname === "/v1/environments/link-challenges"
          ) {
            return jsonResponse({
              challenge: "challenge-xyz",
              expiresAt: "1970-01-01T00:05:00.000Z",
            });
          }
          if (parsed.origin === HOST_HTTP && parsed.pathname === "/api/relay/link-proof") {
            return jsonResponse({
              environmentId: hostProofEnvId,
              environmentPublicKey: "ed25519:host-pub",
              descriptor: DESCRIPTOR,
              proof: "host-signed-jwt",
            });
          }
          if (parsed.origin === RELAY_URL && parsed.pathname === "/v1/environments/link") {
            return jsonResponse({
              ok: true,
              userId: USER_1,
              environmentId: relayLinkEnvId,
              endpoint: ENDPOINT_1,
              relayIssuer: RELAY_URL,
              environmentCredential: "env-cred-jwt",
              relayMintPublicKey: "ed25519:mint-pub",
            });
          }
          if (parsed.origin === HOST_HTTP && parsed.pathname === "/api/relay/config") {
            return jsonResponse(LINKED_ONLINE_STATUS);
          }
          if (parsed.origin === HOST_HTTP && parsed.pathname === "/api/relay/reconnect") {
            return jsonResponse(LINKED_ONLINE_STATUS);
          }
          if (parsed.origin === HOST_HTTP && parsed.pathname === "/api/relay/unlink") {
            return jsonResponse({ ok: true });
          }
          if (
            parsed.origin === RELAY_URL &&
            parsed.pathname === `/v1/environments/${ENV_1}` &&
            method === "DELETE"
          ) {
            if (unlinkRelayStatus === 404) {
              return jsonResponse(
                {
                  _tag: "RelayNotFoundError",
                  code: "not_found",
                  resource: "environment",
                  traceId: "trace-404",
                },
                404,
              );
            }
            return jsonResponse({ ok: true });
          }
          return jsonResponse({}, 500);
        };

        yield* Effect.gen(function* () {
          const status = yield* readHostRelayStatus(ENV_1);
          expect(status.linked).toBe(false);

          const linkedStatus = yield* linkHostToRelay(ENV_1);
          expect(linkedStatus.linked).toBe(true);
          expect(linkedStatus.tunnel.state).toBe("online");

          const reconnected = yield* reconnectHostRelay(ENV_1);
          expect(reconnected.tunnel.runId).toBe(3);

          // Idempotent unlink when relay reports 404 RelayNotFoundError
          unlinkRelayStatus = 404;
          yield* unlinkHostFromRelay(ENV_1);

          // Rejects mismatched environmentId from host link-proof
          hostProofEnvId = EnvironmentId.make("env-other-host");
          const hostMismatch = yield* linkHostToRelay(ENV_1).pipe(Effect.flip);
          expect(hostMismatch._tag).toBe("HostRelayControlError");
          hostProofEnvId = ENV_1;

          // Rejects mismatched environmentId from relay link response
          relayLinkEnvId = EnvironmentId.make("env-other-relay");
          const relayMismatch = yield* linkHostToRelay(ENV_1).pipe(Effect.flip);
          expect(relayMismatch._tag).toBe("HostRelayControlError");
          relayLinkEnvId = ENV_1;

          // When signed out, unlinkHostFromRelay unlinks locally and skips relay DELETE
          const session = yield* RelayAuthSession;
          yield* session.logout;
          seenCalls.length = 0;
          yield* unlinkHostFromRelay(ENV_1);
          expect(seenCalls).toEqual([`POST ${HOST_HTTP}/api/relay/unlink`]);
        }).pipe(Effect.provide(makeFullStack(fetchFn)));

        expect(seenCalls).toContain(`POST ${HOST_HTTP}/api/relay/unlink`);
      }),
  );

  it.effect("drives reactive state atoms and commands via createSelfHostedRelayAtoms", () =>
    Effect.gen(function* () {
      const fetchFn: typeof globalThis.fetch = async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const parsed = new URL(url);
        const method = (init?.method ?? "GET").toUpperCase();

        if (parsed.pathname === "/v1/auth/login") {
          return jsonResponse({
            user: ALICE,
            accessToken: "atom-access-1",
            accessTokenExpiresAt: "1970-01-01T01:00:00.000Z",
            refreshToken: "atom-refresh-1",
            refreshTokenExpiresAt: "1970-01-02T00:00:00.000Z",
          });
        }
        if (parsed.pathname === "/v1/admin/users" && method === "GET") {
          return jsonResponse({ users: [ALICE] });
        }
        if (parsed.origin === HOST_HTTP && parsed.pathname === "/api/relay/status") {
          return jsonResponse(LINKED_ONLINE_STATUS);
        }
        if (parsed.pathname === "/v1/environments" && method === "GET") {
          return jsonResponse({
            environments: [
              {
                environmentId: ENV_1,
                label: "Host Machine",
                endpoint: ENDPOINT_1,
                status: "online",
                linkedAt: "1970-01-01T00:00:00.000Z",
                lastSeenAt: "1970-01-01T00:00:05.000Z",
              },
            ],
          });
        }
        return jsonResponse({}, 404);
      };

      const runtime = Atom.runtime(makeFullStack(fetchFn, { initialSession: null }));
      const atoms = createSelfHostedRelayAtoms(runtime);
      const registry = AtomRegistry.make();
      const unmounts = [
        registry.mount(atoms.relayUrlValueAtom),
        registry.mount(atoms.sessionValueAtom),
        registry.mount(atoms.discoveryValueAtom),
      ];
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const unmount of unmounts) unmount();
          registry.dispose();
        }),
      );

      yield* awaitAtomValue(
        registry,
        atoms.relayUrlValueAtom,
        (value) => value.relayUrl === RELAY_URL,
      );
      expect(registry.get(atoms.relayUrlValueAtom).relayUrl).toBe(RELAY_URL);
      expect(registry.get(atoms.sessionValueAtom).status).toBe("signed_out");

      const updatedUrl = yield* atoms.setRelayUrl.run(
        registry,
        "https://relay-updated.example.com",
      );
      expect(updatedUrl.relayUrl).toBe("https://relay-updated.example.com");
      const updatedAtomState = yield* awaitAtomValue(
        registry,
        atoms.relayUrlValueAtom,
        (value) => value.relayUrl === "https://relay-updated.example.com",
      );
      expect(updatedAtomState.relayUrl).toBe("https://relay-updated.example.com");

      const user = yield* atoms.login.run(registry, {
        username: RelayUsername.make("alice"),
        password: TrimmedNonEmptyString.make("correct-horse-battery"),
      });
      expect(user.username).toBe("alice");
      const signedInState = yield* awaitAtomValue(
        registry,
        atoms.sessionValueAtom,
        (value) => value.status === "signed_in",
      );
      expect(signedInState.status).toBe("signed_in");

      const users = yield* atoms.listUsers.run(registry, undefined);
      expect(users).toHaveLength(1);

      const hostStatus = yield* atoms.readHostStatus.run(registry, ENV_1);
      expect(hostStatus.linked).toBe(true);

      yield* atoms.refreshDiscovery.run(registry, undefined);
      const discoveryState = yield* awaitAtomValue(
        registry,
        atoms.discoveryValueAtom,
        (value) => value.listed && value.environments.has(ENV_1),
      );
      expect(discoveryState.environments.get(ENV_1)?.availability).toBe("online");
    }),
  );
});
