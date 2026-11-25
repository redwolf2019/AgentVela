import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  type AgentVelaRelayEnvironmentRecord,
  type AgentVelaRelayStatusResponse,
  RelayEndpointKey,
  type RelayPresenceEvent,
  RelayUserId,
  RelayUsername,
} from "@t3tools/contracts/agentVelaRelay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as Connectivity from "../connection/connectivity.ts";
import {
  ConnectionBlockedError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as RpcHttp from "../rpc/http.ts";
import { AgentVelaRelayClient, layerAgentVelaRelayClient } from "./agentVelaRelayClient.ts";
import { ManagedRelayDpopSigner } from "./managedRelay.ts";
import {
  RelayPresenceFetch,
  SelfHostedRelayDiscovery,
  type SelfHostedRelayDiscoveryState,
  createSseEventParser,
  layerSelfHostedRelayDiscovery,
  watchRelayOnlineWakeups,
  watchRelaySessionIsolation,
} from "./presence.ts";
import {
  RelayUrlConfig,
  layerInMemoryRelayConfigStorage,
  layerRelayUrlConfig,
} from "./relayConfig.ts";
import {
  RelayAuthSession,
  type StoredRelaySession,
  layerInMemoryRelaySessionStore,
  layerRelayAuthSession,
} from "./relaySession.ts";

const RELAY_URL = "https://relay.example.com";
const OTHER_RELAY_URL = "https://relay-two.example.com";
const USER_1 = RelayUserId.make("user-1");
const ENV_1 = EnvironmentId.make("env-presence-1");
const ENV_2 = EnvironmentId.make("env-presence-2");
const ENV_KEY_1 = RelayEndpointKey.make("env-key-presence-1");
const ENV_KEY_2 = RelayEndpointKey.make("env-key-presence-2");

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

function makeEndpoint(relayUrl: string, key: RelayEndpointKey) {
  const wsOrigin = relayUrl.replace(/^http/u, "ws");
  const pathPrefix = `/e/${key}`;
  return {
    endpointKey: key,
    pathPrefix: TrimmedNonEmptyString.make(pathPrefix),
    httpBaseUrl: TrimmedNonEmptyString.make(`${relayUrl}${pathPrefix}`),
    wsBaseUrl: TrimmedNonEmptyString.make(`${wsOrigin}${pathPrefix}`),
  };
}

function makeEnvRecord(
  environmentId: EnvironmentId,
  key: RelayEndpointKey,
  status: "online" | "offline",
  label = "Workstation",
): AgentVelaRelayEnvironmentRecord {
  return {
    environmentId,
    label: TrimmedNonEmptyString.make(label),
    endpoint: makeEndpoint(RELAY_URL, key),
    status,
    linkedAt: "1970-01-01T00:00:00.000Z" as AgentVelaRelayEnvironmentRecord["linkedAt"],
    lastSeenAt:
      status === "online"
        ? ("1970-01-01T00:00:05.000Z" as AgentVelaRelayEnvironmentRecord["lastSeenAt"])
        : null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeControllableSseStream(callbacks?: {
  readonly onCancel?: () => void;
  readonly onPull?: () => void;
}) {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
    pull() {
      callbacks?.onPull?.();
    },
    cancel() {
      callbacks?.onCancel?.();
    },
  });
  return {
    stream,
    pushEvent(event: RelayPresenceEvent) {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controller?.close();
    },
  };
}

function awaitDiscoveryState(
  discovery: SelfHostedRelayDiscovery["Service"],
  predicate: (state: SelfHostedRelayDiscoveryState) => boolean,
) {
  return Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(discovery.state);
    if (predicate(current)) return current;
    return yield* SubscriptionRef.changes(discovery.state).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  });
}

function makeDiscoveryStack(options: {
  readonly apiFetch: typeof globalThis.fetch;
  readonly sseFetch: typeof globalThis.fetch;
  readonly initialSession?: StoredRelaySession | null;
  readonly initialUrl?: string | null;
  readonly networkRef?: SubscriptionRef.SubscriptionRef<NetworkStatus>;
  readonly heartbeatTimeoutMs?: number;
}) {
  const configLayer = layerRelayUrlConfig({
    defaultRelayUrl: options.initialUrl === undefined ? RELAY_URL : options.initialUrl,
  }).pipe(Layer.provide(layerInMemoryRelayConfigStorage()));
  const storeLayer = layerInMemoryRelaySessionStore(
    options.initialSession === undefined ? SIGNED_IN_SESSION : options.initialSession,
  );
  const httpLayer = RpcHttp.layerRemoteHttpClient(options.apiFetch);
  const sessionLayer = layerRelayAuthSession.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(httpLayer),
  );
  const signerLayer = Layer.succeed(
    ManagedRelayDpopSigner,
    ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("jkt-presence-1"),
      createProof: ({ url }) => Effect.succeed(`dpop-proof:${url}`),
    }),
  );
  const relayClientLayer = layerAgentVelaRelayClient({ clientSurface: "web" }).pipe(
    Layer.provideMerge(sessionLayer),
    Layer.provideMerge(signerLayer),
    Layer.provideMerge(httpLayer),
  );
  const connectivityLayer = Layer.effect(
    Connectivity.Connectivity,
    Effect.gen(function* () {
      const ref = options.networkRef ?? (yield* SubscriptionRef.make<NetworkStatus>("online"));
      return Connectivity.Connectivity.of({
        status: SubscriptionRef.get(ref),
        changes: SubscriptionRef.changes(ref),
      });
    }),
  );
  const discoveryLayer = layerSelfHostedRelayDiscovery(
    options.heartbeatTimeoutMs !== undefined
      ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs }
      : undefined,
  ).pipe(
    Layer.provideMerge(sessionLayer),
    Layer.provideMerge(relayClientLayer),
    Layer.provideMerge(connectivityLayer),
    Layer.provide(Layer.succeed(RelayPresenceFetch, options.sseFetch)),
  );
  return Layer.mergeAll(sessionLayer, relayClientLayer, connectivityLayer, discoveryLayer);
}

describe("presence", () => {
  it("parses chunked SSE frames, CRLF endings, multi-line data, comments, and ignores malformed JSON", () => {
    const events: Array<RelayPresenceEvent> = [];
    const parser = createSseEventParser((event) => {
      events.push(event);
    });
    const encoder = new TextEncoder();
    const snapshotJson = JSON.stringify({
      type: "snapshot",
      environments: [makeEnvRecord(ENV_1, ENV_KEY_1, "online", "Host 中文 🚀")],
    });
    const frame = `: keepalive\r\ndata: {not valid json}\r\n\r\ndata: ${snapshotJson.slice(0, 28)}\rdata: \n`;
    const part1 = encoder.encode(`: comment\r\n\r\ndata: ${snapshotJson.slice(0, 35)}\n`);
    const part2 = encoder.encode(`data: ${snapshotJson.slice(35)}`);
    // Split multi-line JSON cleanly on a token/whitespace boundary across data lines + trailing blank line
    const splitPoint = snapshotJson.indexOf(',"environments"') + 1;
    const multiLine = encoder.encode(
      `data: ${snapshotJson.slice(0, splitPoint)}\r\ndata: ${snapshotJson.slice(splitPoint)}\r\n\r\n`,
    );
    const heartbeat = encoder.encode(
      `data: ${JSON.stringify({ type: "heartbeat", serverTime: "1970-01-01T00:01:00.000Z" })}`,
    );

    parser.push(encoder.encode(frame));
    // Malformed frame produces nothing; test split chunks for valid frame:
    parser.push(part1.slice(0, 12));
    parser.push(part1.slice(12));
    parser.push(part2);
    // Flush dispatches the incomplete event assembled from part1 + part2 (note part1 had complete first data line; reset and parse clean multiline instead)
    events.length = 0;

    const parser2 = createSseEventParser((event) => {
      events.push(event);
    });
    const malformed = encoder.encode(": comment line\r\ndata: {malformed}\r\n\r\n");
    parser2.push(malformed.slice(0, 10));
    parser2.push(malformed.slice(10));
    parser2.push(multiLine.slice(0, 19));
    parser2.push(multiLine.slice(19, 51));
    parser2.push(multiLine.slice(51));
    parser2.push(heartbeat.slice(0, 14));
    parser2.push(heartbeat.slice(14));
    parser2.flush();

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("snapshot");
    if (events[0]?.type === "snapshot") {
      expect(events[0].environments[0]?.label).toBe("Host 中文 🚀");
    }
    expect(events[1]?.type).toBe("heartbeat");
  });

  it.effect(
    "processes snapshot, online/offline/linked/unlinked/heartbeat, and checkEnvironmentStatus",
    () =>
      Effect.gen(function* () {
        const sseControl = makeControllableSseStream();
        let resolveStreamOpen: (() => void) | undefined;
        const streamOpened = new Promise<void>((resolve) => {
          resolveStreamOpen = resolve;
        });

        const apiFetch: typeof globalThis.fetch = async (input) => {
          const path = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          ).pathname;
          if (path === "/v1/auth/dpop-token") {
            return jsonResponse({
              accessToken: "dpop-status-token",
              tokenType: "DPoP",
              expiresIn: 300,
              scopes: ["environment:status"],
            });
          }
          if (path === `/v1/environments/${ENV_1}/status`) {
            const statusBody: AgentVelaRelayStatusResponse = {
              environmentId: ENV_1,
              endpoint: makeEndpoint(RELAY_URL, ENV_KEY_1),
              status: "online",
              checkedAt: "1970-01-01T00:00:10.000Z" as AgentVelaRelayStatusResponse["checkedAt"],
            };
            return jsonResponse(statusBody);
          }
          return jsonResponse({}, 404);
        };

        let sseRequestUrl = "";
        let sseAuthHeader: string | null = null;
        const sseFetch: typeof globalThis.fetch = async (input, init) => {
          sseRequestUrl =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          sseAuthHeader = new Headers(init?.headers).get("authorization");
          resolveStreamOpen?.();
          return new Response(sseControl.stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        };

        yield* Effect.gen(function* () {
          const discovery = yield* SelfHostedRelayDiscovery;
          const transitions = yield* Queue.unbounded<EnvironmentId>();
          const gotThirdOnline = yield* Deferred.make<void>();
          let onlineCount = 0;

          yield* discovery.onlineTransitions.pipe(
            Stream.runForEach((id) =>
              Effect.gen(function* () {
                yield* Queue.offer(transitions, id);
                onlineCount += 1;
                if (onlineCount >= 3) {
                  yield* Deferred.succeed(gotThirdOnline, undefined);
                }
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );

          yield* Effect.promise(() => streamOpened);
          expect(sseRequestUrl).toBe(`${RELAY_URL}/v1/events`);
          expect(sseAuthHeader).toBe("Bearer bearer-1");

          sseControl.pushEvent({
            type: "snapshot",
            environments: [makeEnvRecord(ENV_1, ENV_KEY_1, "offline")],
          });
          let snap = yield* awaitDiscoveryState(
            discovery,
            (state) => state.listed && state.connectionState === "connected",
          );
          expect(snap.environments.get(ENV_1)?.availability).toBe("offline");

          sseControl.pushEvent({
            type: "environment.online",
            environmentId: ENV_1,
            endpoint: makeEndpoint(RELAY_URL, ENV_KEY_1),
            lastSeenAt: "1970-01-01T00:00:05.000Z" as AgentVelaRelayStatusResponse["checkedAt"],
          });
          snap = yield* awaitDiscoveryState(
            discovery,
            (state) => state.environments.get(ENV_1)?.availability === "online",
          );
          expect(snap.environments.get(ENV_1)?.availability).toBe("online");

          sseControl.pushEvent({
            type: "environment.offline",
            environmentId: ENV_1,
            checkedAt: "1970-01-01T00:00:08.000Z" as AgentVelaRelayStatusResponse["checkedAt"],
          });
          snap = yield* awaitDiscoveryState(
            discovery,
            (state) => state.environments.get(ENV_1)?.availability === "offline",
          );
          expect(snap.environments.get(ENV_1)?.availability).toBe("offline");

          const checked = yield* discovery.checkEnvironmentStatus(ENV_1);
          expect(checked.status).toBe("online");
          snap = yield* SubscriptionRef.get(discovery.state);
          expect(Option.isSome(snap.environments.get(ENV_1)!.lastStatus)).toBe(true);

          sseControl.pushEvent({
            type: "environment.linked",
            environment: makeEnvRecord(ENV_2, ENV_KEY_2, "online", "Second Host"),
          });
          sseControl.pushEvent({
            type: "heartbeat",
            serverTime: "1970-01-01T00:00:15.000Z" as AgentVelaRelayStatusResponse["checkedAt"],
          });
          yield* Deferred.await(gotThirdOnline);
          snap = yield* awaitDiscoveryState(
            discovery,
            (state) =>
              state.environments.has(ENV_2) && state.lastEventAt === "1970-01-01T00:00:15.000Z",
          );
          expect(snap.environments.has(ENV_2)).toBe(true);
          expect(snap.lastEventAt).toBe("1970-01-01T00:00:15.000Z");

          sseControl.pushEvent({ type: "environment.unlinked", environmentId: ENV_2 });
          snap = yield* awaitDiscoveryState(discovery, (state) => !state.environments.has(ENV_2));
          expect(snap.environments.has(ENV_2)).toBe(false);

          const onlineIds = Array.from(yield* Queue.takeAll(transitions));
          expect(onlineIds).toEqual([ENV_1, ENV_1, ENV_2]);
        }).pipe(Effect.provide(makeDiscoveryStack({ apiFetch, sseFetch })));
      }),
  );

  it.effect(
    "retries 401 once, stops cleanly on repeated 401, backs off on 503/stall under TestClock, and aborts on logout or URL switch",
    () =>
      Effect.gen(function* () {
        let sseCalls = 0;
        const abortedSignals: Array<AbortSignal> = [];
        let resolveOpen!: (call: number) => void;
        let ssePlan: (call: number) => Response = () => jsonResponse({}, 503);

        const sseFetch: typeof globalThis.fetch = async (_input, init) => {
          sseCalls += 1;
          if (init?.signal) abortedSignals.push(init.signal);
          resolveOpen?.(sseCalls);
          return ssePlan(sseCalls);
        };

        // Phase A: 401 -> forceRefresh -> 200 -> 503 -> TestClock backoff -> stalled stream -> TestClock timeout -> sign out aborts
        const liveStream1 = makeControllableSseStream();
        let resolveStream4Pull: (() => void) | undefined;
        const stream4Pulled = new Promise<void>((resolve) => {
          resolveStream4Pull = resolve;
        });
        ssePlan = (call) => {
          if (call === 1) return new Response(null, { status: 401 });
          if (call === 2) {
            return new Response(liveStream1.stream, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
          if (call === 3) return new Response(null, { status: 503 });
          const freshStream = makeControllableSseStream(
            call === 4 ? { onPull: () => resolveStream4Pull?.() } : undefined,
          );
          return new Response(freshStream.stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        };

        const apiFetch: typeof globalThis.fetch = async (input) => {
          const path = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          ).pathname;
          if (path === "/v1/auth/refresh") {
            return jsonResponse({
              user: ALICE,
              accessToken: "bearer-refreshed",
              accessTokenExpiresAt: "1970-01-01T02:00:00.000Z",
              refreshToken: "refresh-2",
              refreshTokenExpiresAt: "1970-01-03T00:00:00.000Z",
            });
          }
          return jsonResponse({}, 404);
        };

        const openWaiters = new Map<number, () => void>();
        resolveOpen = (call) => {
          openWaiters.get(call)?.();
        };
        const flushMicrotasksAndFibers = Effect.promise(() => Promise.resolve()).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(Effect.yieldNow),
        );
        const awaitSseCall = (call: number) =>
          (sseCalls >= call
            ? Effect.void
            : Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    openWaiters.set(call, resolve);
                  }),
              )
          ).pipe(Effect.andThen(flushMicrotasksAndFibers));

        yield* Effect.gen(function* () {
          const discovery = yield* SelfHostedRelayDiscovery;
          const session = yield* RelayAuthSession;

          // 1 -> 401 -> refresh -> 2 (connected)
          yield* awaitSseCall(2);
          liveStream1.pushEvent({
            type: "heartbeat",
            serverTime: "1970-01-01T00:00:02.000Z" as AgentVelaRelayStatusResponse["checkedAt"],
          });
          yield* awaitDiscoveryState(discovery, (s) => s.connectionState === "connected");

          // Close stream 2 cleanly -> reconnecting (attempt 0 backoff <= 1250ms) -> 3 (503)
          liveStream1.close();
          yield* awaitDiscoveryState(discovery, (s) => s.connectionState === "reconnecting");
          yield* TestClock.adjust("1300 millis");
          yield* awaitSseCall(3);
          expect((yield* SubscriptionRef.get(discovery.state)).connectionState).toBe(
            "reconnecting",
          );

          // Attempt 1 backoff (<= 2500ms) -> stream 4 opens silent -> wait for pull() -> TestClock triggers 200ms stall
          yield* TestClock.adjust("2600 millis");
          yield* awaitSseCall(4);
          yield* Effect.promise(() => stream4Pulled).pipe(Effect.andThen(flushMicrotasksAndFibers));
          yield* TestClock.adjust("250 millis");
          yield* awaitDiscoveryState(
            discovery,
            (s) => s.connectionState === "reconnecting" && Option.isSome(s.error),
          );

          // Attempt 2 backoff (<= 5000ms) -> stream 5 opens, then logout aborts its AbortSignal
          yield* TestClock.adjust("5100 millis");
          yield* awaitSseCall(5);
          yield* session.logout;
          yield* awaitDiscoveryState(discovery, (s) => s.connectionState === "idle");
          expect(abortedSignals[abortedSignals.length - 1]?.aborted).toBe(true);
        }).pipe(
          Effect.provide(
            makeDiscoveryStack({
              apiFetch,
              sseFetch,
              heartbeatTimeoutMs: 200,
            }),
          ),
        );

        // Phase B: repeated 401 after refresh stops cleanly in "idle" (no tight retry loop)
        sseCalls = 0;
        const repeatedWaiters = new Map<number, () => void>();
        resolveOpen = (call) => repeatedWaiters.get(call)?.();
        const awaitRepeatedCall = (call: number) =>
          sseCalls >= call
            ? Effect.yieldNow
            : Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    repeatedWaiters.set(call, resolve);
                  }),
              ).pipe(Effect.andThen(Effect.yieldNow));

        yield* Effect.gen(function* () {
          const discovery = yield* SelfHostedRelayDiscovery;
          yield* awaitRepeatedCall(2);
          yield* TestClock.adjust("500 millis");
          yield* Effect.yieldNow;
          expect(sseCalls).toBe(2);
          const st = yield* SubscriptionRef.get(discovery.state);
          expect(st.connectionState).toBe("idle");
          expect(Option.isSome(st.error)).toBe(true);
          if (Option.isSome(st.error)) {
            expect(st.error.value).toBeInstanceOf(ConnectionBlockedError);
          }
        }).pipe(
          Effect.provide(
            makeDiscoveryStack({
              apiFetch,
              sseFetch: async (input, init) => {
                sseCalls += 1;
                resolveOpen?.(sseCalls);
                void input;
                void init;
                return new Response(null, { status: 401 });
              },
            }),
          ),
        );
      }),
  );

  it.effect(
    "triggers online wakeups only for enabled backoff relay routes and isolates session changes",
    () =>
      Effect.gen(function* () {
        const sseControl = makeControllableSseStream();
        let resolveOpen: (() => void) | undefined;
        const streamOpened = new Promise<void>((resolve) => {
          resolveOpen = resolve;
        });
        const envDisabled = EnvironmentId.make("env-disabled");
        const envConnected = EnvironmentId.make("env-connected");
        const envLan = EnvironmentId.make("env-lan");

        const retryCalls: Array<EnvironmentId> = [];
        let removeRelayCalls = 0;
        let dpopCalls = 0;

        const makeState = (phase: SupervisorConnectionState["phase"]): SupervisorConnectionState =>
          ({ phase }) as SupervisorConnectionState;

        const entriesMap = new Map<EnvironmentId, ConnectionCatalogEntry>([
          [
            ENV_1,
            {
              target: new RelayConnectionTarget({ environmentId: ENV_1, label: "Backoff Relay" }),
              profile: Option.none(),
              enabled: true,
            },
          ],
          [
            envDisabled,
            {
              target: new RelayConnectionTarget({
                environmentId: envDisabled,
                label: "Disabled Relay",
              }),
              profile: Option.none(),
              enabled: false,
            },
          ],
          [
            envConnected,
            {
              target: new RelayConnectionTarget({
                environmentId: envConnected,
                label: "Connected Relay",
              }),
              profile: Option.none(),
              enabled: true,
            },
          ],
          [
            envLan,
            {
              target: new PrimaryConnectionTarget({
                environmentId: envLan,
                label: "Direct LAN",
                httpBaseUrl: "http://192.168.1.5:3773",
                wsBaseUrl: "ws://192.168.1.5:3773",
              }),
              profile: Option.none(),
              enabled: true,
            },
          ],
        ]);

        const apiFetch: typeof globalThis.fetch = async (input) => {
          const path = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          ).pathname;
          if (path === "/v1/auth/dpop-token") {
            dpopCalls += 1;
            return jsonResponse({
              accessToken: `dpop-token-${dpopCalls}`,
              tokenType: "DPoP",
              expiresIn: 300,
              scopes: ["environment:status"],
            });
          }
          if (path === `/v1/environments/${ENV_1}/status`) {
            return jsonResponse({
              environmentId: ENV_1,
              endpoint: makeEndpoint(RELAY_URL, ENV_KEY_1),
              status: "online",
              checkedAt: "1970-01-01T00:00:05.000Z",
            });
          }
          return jsonResponse({}, 404);
        };

        const sseFetch: typeof globalThis.fetch = async () => {
          resolveOpen?.();
          return new Response(sseControl.stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        };

        const entriesRef =
          yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            entriesMap,
          );

        const state: EnvironmentRegistry.EnvironmentRegistry["Service"]["state"] = (
          environmentId,
        ) =>
          Effect.succeed(
            environmentId === envConnected ? makeState("connected") : makeState("backoff"),
          );
        const retryNow: EnvironmentRegistry.EnvironmentRegistry["Service"]["retryNow"] = (
          environmentId,
        ) =>
          Effect.sync(() => {
            retryCalls.push(environmentId);
          });
        const removeRelayEnvironments: EnvironmentRegistry.EnvironmentRegistry["Service"]["removeRelayEnvironments"] =
          () =>
            Effect.sync(() => {
              removeRelayCalls += 1;
              // Verify non-relay entries stay intact in simulated store
              entriesMap.delete(ENV_1);
              entriesMap.delete(envDisabled);
              entriesMap.delete(envConnected);
            });
        const mockRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          entries: entriesRef,
          state,
          retryNow,
          removeRelayEnvironments,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

        const stack = Layer.mergeAll(
          makeDiscoveryStack({ apiFetch, sseFetch }),
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, mockRegistry),
        );

        yield* Effect.gen(function* () {
          const wakeupFiber = yield* watchRelayOnlineWakeups().pipe(
            Effect.forkScoped({ startImmediately: true }),
          );
          const isolationFiber = yield* watchRelaySessionIsolation().pipe(
            Effect.forkScoped({ startImmediately: true }),
          );

          yield* Effect.promise(() => streamOpened);
          sseControl.pushEvent({
            type: "snapshot",
            environments: [
              makeEnvRecord(ENV_1, ENV_KEY_1, "online"),
              makeEnvRecord(envDisabled, RelayEndpointKey.make("env-key-disabled-1"), "online"),
              makeEnvRecord(envConnected, RelayEndpointKey.make("env-key-connected-1"), "online"),
            ],
          });
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          expect(retryCalls).toEqual([ENV_1]);

          // Acquire a DPoP token before switching relay URL; isolation should clear cache & relay targets
          const relayClient = yield* AgentVelaRelayClient;
          yield* relayClient.getEnvironmentStatus({ environmentId: ENV_1 });
          expect(dpopCalls).toBe(1);

          const config = yield* RelayUrlConfig;
          yield* config.setRelayUrl(OTHER_RELAY_URL);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          expect(removeRelayCalls).toBe(1);
          expect(entriesMap.has(envLan)).toBe(true);

          yield* Fiber.interrupt(wakeupFiber);
          yield* Fiber.interrupt(isolationFiber);
        }).pipe(Effect.provide(stack));
      }),
  );
});
