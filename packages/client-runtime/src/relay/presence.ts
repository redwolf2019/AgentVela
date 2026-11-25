import type { EnvironmentId } from "@t3tools/contracts";
import type { AgentVelaRelayStatusResponse, RelayUserId } from "@t3tools/contracts/agentVelaRelay";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Connectivity from "../connection/connectivity.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { hasRelayRoute } from "../connection/routes.ts";
import { AgentVelaRelayClient } from "./agentVelaRelayClient.ts";
import {
  EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE,
  type RelayPresenceConnectionState,
  type SelfHostedRelayDiscoveredEnvironment,
  type SelfHostedRelayDiscoveryState,
  applyPresenceEvent,
} from "./presenceState.ts";
import {
  RelayPresenceFetch,
  type RelayPresenceStreamError,
  openRelayPresenceStream,
} from "./presenceStream.ts";
import {
  RelayApiRequestError,
  type SelfHostedRelayError,
  mapSelfHostedRelayError,
} from "./relayErrors.ts";
import { RelayAuthSession } from "./relaySession.ts";

export * from "./presenceState.ts";
export * from "./presenceStream.ts";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function jitteredBackoffDelayMs(attempt: number, randomUnit: number): number {
  const ceiling = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt, 10),
  );
  return Math.round(ceiling * (0.75 + 0.5 * randomUnit));
}

function presenceStreamErrorToAttemptError(
  error: RelayPresenceStreamError,
): ConnectionAttemptError {
  if (error._tag === "RelayPresenceUnauthorizedError") {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: "Relay rejected the presence stream token.",
      hop: "relay",
    });
  }
  return mapSelfHostedRelayError(
    new RelayApiRequestError({
      action: "presence stream",
      ...(error._tag === "RelayPresenceHttpError" ? { status: error.status } : {}),
      ...(error._tag === "RelayPresenceTransportError" ? { transportFailed: true } : {}),
      cause: error,
    }),
  );
}

function preservedEnvironmentFields(
  prev: SelfHostedRelayDiscoveryState,
  relayUrl: string,
  userId: RelayUserId,
) {
  return prev.relayUrl === relayUrl && prev.userId === userId
    ? { environments: prev.environments, listed: prev.listed, lastEventAt: prev.lastEventAt }
    : {};
}

export class SelfHostedRelayDiscovery extends Context.Service<
  SelfHostedRelayDiscovery,
  {
    readonly state: SubscriptionRef.SubscriptionRef<SelfHostedRelayDiscoveryState>;
    readonly onlineTransitions: Stream.Stream<EnvironmentId>;
    readonly refresh: Effect.Effect<void>;
    readonly checkEnvironmentStatus: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<AgentVelaRelayStatusResponse, SelfHostedRelayError>;
  }
>()("@t3tools/client-runtime/relay/presence/SelfHostedRelayDiscovery") {}

export interface SelfHostedRelayDiscoveryOptions {
  readonly heartbeatTimeoutMs?: number;
}

const makeSelfHostedRelayDiscovery = Effect.fn("SelfHostedRelayDiscovery.make")(function* (
  options?: SelfHostedRelayDiscoveryOptions,
) {
  const serviceScope = yield* Scope.Scope;
  const session = yield* RelayAuthSession;
  const client = yield* AgentVelaRelayClient;
  const connectivity = yield* Connectivity.Connectivity;
  const presenceFetch = yield* RelayPresenceFetch;

  const state = yield* SubscriptionRef.make<SelfHostedRelayDiscoveryState>(
    EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE,
  );
  const onlinePubSub = yield* PubSub.unbounded<EnvironmentId>();
  const generationRef = yield* Ref.make(0);
  const streamScopeRef = yield* Ref.make<Scope.Closeable | null>(null);
  const refreshLock = yield* Semaphore.make(1);
  const syncLock = yield* Semaphore.make(1);

  const publishOnline = (ids: ReadonlyArray<EnvironmentId>) =>
    Effect.forEach(ids, (id) => PubSub.publish(onlinePubSub, id), { discard: true });

  const setConnectionState = (
    connectionState: RelayPresenceConnectionState,
    error?: ConnectionAttemptError,
  ) =>
    SubscriptionRef.update(state, (prev) => ({
      ...prev,
      connectionState,
      ...(error !== undefined ? { error: Option.some(error) } : {}),
    }));

  const refresh = refreshLock.withPermits(1)(
    Effect.gen(function* () {
      const currentSession = yield* SubscriptionRef.get(session.state);
      if (currentSession.status !== "signed_in" || (yield* connectivity.status) === "offline") {
        return;
      }
      const listedResult = yield* client.listEnvironments.pipe(Effect.result);
      if (listedResult._tag === "Failure") {
        yield* SubscriptionRef.update(state, (prev) =>
          prev.relayUrl === currentSession.relayUrl && prev.userId === currentSession.user.userId
            ? { ...prev, error: Option.some(mapSelfHostedRelayError(listedResult.failure)) }
            : prev,
        );
        return;
      }
      const newlyOnline = yield* SubscriptionRef.modify(
        state,
        (prev): readonly [ReadonlyArray<EnvironmentId>, SelfHostedRelayDiscoveryState] => {
          if (
            prev.relayUrl !== currentSession.relayUrl ||
            prev.userId !== currentSession.user.userId
          ) {
            return [[], prev] as const;
          }
          const next = new Map<EnvironmentId, SelfHostedRelayDiscoveredEnvironment>();
          const online: Array<EnvironmentId> = [];
          for (const env of listedResult.success) {
            const existing = prev.environments.get(env.environmentId);
            next.set(env.environmentId, {
              environment: env,
              availability: env.status,
              lastStatus: existing?.lastStatus ?? Option.none(),
            });
            if (env.status === "online" && existing?.availability !== "online") {
              online.push(env.environmentId);
            }
          }
          return [
            online,
            { ...prev, environments: next, listed: true, error: Option.none() },
          ] as const;
        },
      );
      yield* publishOnline(newlyOnline);
    }),
  );

  const isCurrent = (generation: number) =>
    Ref.get(generationRef).pipe(Effect.map((current) => current === generation));

  const consumeStream = (
    expectedRelayUrl: string,
    expectedUserId: RelayUserId,
    accessToken: string,
    onEvent: () => void,
  ) =>
    openRelayPresenceStream({
      relayUrl: expectedRelayUrl,
      accessToken,
      ...(options?.heartbeatTimeoutMs !== undefined
        ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs }
        : {}),
    }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          onEvent();
          const applied = yield* SubscriptionRef.modify(state, (prev) => {
            if (prev.relayUrl !== expectedRelayUrl || prev.userId !== expectedUserId) {
              return [
                { newlyOnline: [] as ReadonlyArray<EnvironmentId>, needsReconcile: false },
                prev,
              ] as const;
            }
            const next = applyPresenceEvent(prev, event);
            return [
              { newlyOnline: next.newlyOnline, needsReconcile: next.needsReconcile },
              next.state,
            ] as const;
          });
          yield* publishOnline(applied.newlyOnline);
          if (applied.needsReconcile) yield* Effect.forkIn(refresh, serviceScope);
        }),
      ),
      Effect.provideService(RelayPresenceFetch, presenceFetch),
      Effect.result,
    );

  const runPresenceLoop = Effect.fn("SelfHostedRelayDiscovery.runPresenceLoop")(function* (
    generation: number,
    expectedRelayUrl: string,
    expectedUserId: RelayUserId,
  ) {
    let attempt = 0;
    let retriedUnauthorized = false;

    while (yield* isCurrent(generation)) {
      const tokenResult = yield* session.getValidAccessToken().pipe(Effect.result);
      if (!(yield* isCurrent(generation))) return;
      if (tokenResult._tag === "Failure") {
        if (tokenResult.failure._tag === "RelaySessionUnavailableError") return;
        yield* setConnectionState("reconnecting", mapSelfHostedRelayError(tokenResult.failure));
        yield* Effect.sleep(Duration.millis(jitteredBackoffDelayMs(attempt++, yield* Random.next)));
        continue;
      }

      const token = tokenResult.success;
      if (token.relayUrl !== expectedRelayUrl || token.userId !== expectedUserId) return;
      const streamExit = yield* consumeStream(
        token.relayUrl,
        expectedUserId,
        token.accessToken,
        () => {
          attempt = 0;
          retriedUnauthorized = false;
        },
      );
      if (!(yield* isCurrent(generation))) return;

      if (streamExit._tag === "Failure") {
        if (streamExit.failure._tag === "RelayPresenceUnauthorizedError") {
          if (retriedUnauthorized) {
            yield* setConnectionState(
              "idle",
              presenceStreamErrorToAttemptError(streamExit.failure),
            );
            return;
          }
          retriedUnauthorized = true;
          const retryAuth = yield* session
            .getValidAccessToken({ forceRefresh: true })
            .pipe(Effect.result);
          if (retryAuth._tag === "Success") continue;
          yield* setConnectionState("idle", mapSelfHostedRelayError(retryAuth.failure));
          return;
        }
        yield* setConnectionState(
          "reconnecting",
          presenceStreamErrorToAttemptError(streamExit.failure),
        );
      } else {
        yield* setConnectionState("reconnecting");
      }
      yield* Effect.sleep(Duration.millis(jitteredBackoffDelayMs(attempt++, yield* Random.next)));
    }
  });

  const syncRunner = syncLock.withPermits(1)(
    Effect.gen(function* () {
      const generation = yield* Ref.updateAndGet(generationRef, (current) => current + 1);
      const prevScope = yield* Ref.getAndSet(streamScopeRef, null);
      if (prevScope !== null) yield* Scope.close(prevScope, Exit.void);

      const sessionState = yield* SubscriptionRef.get(session.state);
      const net = yield* connectivity.status;
      if (sessionState.status !== "signed_in") {
        const nextConnectionState: RelayPresenceConnectionState =
          net === "offline" ? "offline" : "idle";
        yield* SubscriptionRef.set(state, {
          ...EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE,
          relayUrl: sessionState.relayUrl,
          connectionState: nextConnectionState,
        });
        return;
      }
      const activeConnectionState: RelayPresenceConnectionState =
        net === "offline" ? "offline" : "connecting";
      yield* SubscriptionRef.update(state, (prev) => ({
        ...EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE,
        ...preservedEnvironmentFields(prev, sessionState.relayUrl, sessionState.user.userId),
        relayUrl: sessionState.relayUrl,
        userId: sessionState.user.userId,
        connectionState: activeConnectionState,
      }));
      if (net === "offline") return;

      const runnerScope = yield* Scope.fork(serviceScope);
      yield* Ref.set(streamScopeRef, runnerScope);
      yield* runPresenceLoop(generation, sessionState.relayUrl, sessionState.user.userId).pipe(
        Effect.forkIn(runnerScope, { startImmediately: true }),
      );
    }),
  );

  yield* syncRunner;

  const sessionKeyChanges = SubscriptionRef.changes(session.state).pipe(
    Stream.map((s) => `${s.status}:${s.relayUrl ?? ""}:${s.user?.userId ?? ""}`),
    Stream.changes,
    Stream.drop(1),
  );
  const networkChanges = connectivity.changes.pipe(Stream.changes, Stream.drop(1));
  yield* Stream.merge(sessionKeyChanges, networkChanges).pipe(
    Stream.runForEach(() => syncRunner),
    Effect.forkScoped({ startImmediately: true }),
  );

  const checkEnvironmentStatus = Effect.fn("SelfHostedRelayDiscovery.checkEnvironmentStatus")(
    function* (environmentId: EnvironmentId) {
      const status = yield* client.getEnvironmentStatus({ environmentId });
      const becameOnline = yield* SubscriptionRef.modify(state, (prev) => {
        const entry = prev.environments.get(environmentId);
        if (entry === undefined) return [false, prev] as const;
        const next = new Map(prev.environments);
        next.set(environmentId, {
          ...entry,
          environment: { ...entry.environment, endpoint: status.endpoint, status: status.status },
          availability: status.status,
          lastStatus: Option.some(status),
        });
        return [
          status.status === "online" && entry.availability !== "online",
          { ...prev, environments: next },
        ] as const;
      });
      if (becameOnline) yield* PubSub.publish(onlinePubSub, environmentId);
      return status;
    },
  );

  return SelfHostedRelayDiscovery.of({
    state,
    onlineTransitions: Stream.fromPubSub(onlinePubSub),
    refresh,
    checkEnvironmentStatus,
  });
});

export const layerSelfHostedRelayDiscovery = (options?: SelfHostedRelayDiscoveryOptions) =>
  Layer.effect(SelfHostedRelayDiscovery, makeSelfHostedRelayDiscovery(options));

export const watchRelayOnlineWakeups = Effect.fn("clientRuntime.relay.watchOnlineWakeups")(
  function* () {
    const discovery = yield* SelfHostedRelayDiscovery;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* discovery.onlineTransitions.pipe(
      Stream.runForEach((environmentId) =>
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
          if (entry === undefined || !hasRelayRoute(entry) || !entry.enabled) return;
          const current = yield* registry.state(environmentId);
          if (current.phase === "backoff") yield* registry.retryNow(environmentId);
        }).pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void })),
      ),
    );
  },
);

export const watchRelaySessionIsolation = Effect.fn("clientRuntime.relay.watchSessionIsolation")(
  function* () {
    const session = yield* RelayAuthSession;
    const client = yield* AgentVelaRelayClient;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* session.accountChanges.pipe(
      Stream.runForEach(() =>
        client.resetDpopTokenCache.pipe(
          Effect.andThen(registry.removeRelayEnvironments()),
          Effect.catch((error) =>
            Effect.logWarning("Could not clear relay environments after relay session change.", {
              error,
            }),
          ),
        ),
      ),
    );
  },
);
