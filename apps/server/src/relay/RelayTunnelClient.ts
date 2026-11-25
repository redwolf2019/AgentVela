// @effect-diagnostics nodeBuiltinImport:off -- Tunnel client derives randomized reconnect jitter via node:crypto.
import * as NodeCrypto from "node:crypto";

import { NonNegativeInt, type EnvironmentId } from "@t3tools/contracts";
import type {
  AgentVelaRelayEndpoint,
  HostRelayTunnelSnapshot,
} from "@t3tools/contracts/agentVelaRelay";
import { normalizeRelayIssuer, RELAY_TUNNEL_LOGIN_TYP } from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { StoredSelfHostedRelayLink } from "./RelayState.ts";
import { RelayTunnelSession, type TunnelSessionCloseOutcome } from "./RelayTunnelSession.ts";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const JITTER_FACTOR = 0.2;
const ZERO = NonNegativeInt.make(0);

export function computeTunnelReconnectDelayMs(attempt: number, randomUnit: number): number {
  const clampedAttempt = Math.max(0, Math.floor(attempt));
  const clampedRand = Math.max(0, Math.min(1, randomUnit));
  const baseDelay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** clampedAttempt);
  const jitterOffset = (clampedRand * 2 - 1) * JITTER_FACTOR * baseDelay;
  return Math.max(200, Math.round(baseDelay + jitterOffset));
}

const DISCONNECTED_SNAPSHOT: HostRelayTunnelSnapshot = {
  state: "disconnected",
  runId: null,
  rttMs: null,
  activeStreams: ZERO,
  connectedAt: null,
  lastError: null,
  compression: false,
};

export interface LocalServerOrigin {
  readonly host: string;
  readonly port: number;
}

export class RelayTunnelClient extends Context.Service<
  RelayTunnelClient,
  {
    readonly setLocalOrigin: (origin: LocalServerOrigin) => Effect.Effect<void>;
    readonly configure: (config: StoredSelfHostedRelayLink | null) => Effect.Effect<void>;
    readonly reconnect: () => Effect.Effect<void>;
    readonly getSnapshot: () => Effect.Effect<HostRelayTunnelSnapshot>;
    readonly snapshotChanges: Stream.Stream<HostRelayTunnelSnapshot>;
    readonly getActiveEndpoint: () => Effect.Effect<AgentVelaRelayEndpoint | null>;
  }
>()("t3/relay/RelayTunnelClient") {}

interface SupervisorState {
  readonly config: StoredSelfHostedRelayLink | null;
  readonly localOrigin: LocalServerOrigin | null;
  readonly fiber: Fiber.Fiber<void, never> | null;
  readonly activeSession: RelayTunnelSession | null;
}

export const layer = Layer.effect(
  RelayTunnelClient,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const identity = yield* ServerEnvironment.ServerEnvironment;
    const signingKey = yield* EnvironmentSigningKey;
    const random = yield* SecureRandom.SecureRandom;
    const runtime = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtime);
    const runSync = Effect.runSyncWith(runtime);

    const snapshotRef = yield* Ref.make<HostRelayTunnelSnapshot>(DISCONNECTED_SNAPSHOT);
    const snapshotPubSub = yield* PubSub.unbounded<HostRelayTunnelSnapshot>();
    const publishSnapshot = (snapshot: HostRelayTunnelSnapshot) =>
      Ref.set(snapshotRef, snapshot).pipe(
        Effect.andThen(PubSub.publish(snapshotPubSub, snapshot)),
        Effect.asVoid,
      );
    const endpointRef = yield* Ref.make<AgentVelaRelayEndpoint | null>(null);
    const stateRef = yield* Ref.make<SupervisorState>({
      config: null,
      localOrigin: null,
      fiber: null,
      activeSession: null,
    });

    const signLoginProof = Effect.fn("RelayTunnelClient.signLoginProof")(function* (
      config: StoredSelfHostedRelayLink,
      environmentId: EnvironmentId,
    ) {
      const now = yield* DateTime.now;
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      return yield* signingKey.sign({
        typ: RELAY_TUNNEL_LOGIN_TYP,
        payload: {
          iss: `t3-env:${environmentId}`,
          aud: normalizeRelayIssuer(config.relayIssuer),
          sub: environmentId,
          jti: yield* random.uuidV4(),
          iat: nowSeconds,
          exp: nowSeconds + 120,
          environmentId,
          endpointKey: config.endpoint.endpointKey,
          nonce: yield* random.uuidV4(),
        },
      });
    });

    const stopSupervisor = Effect.gen(function* () {
      const prev = yield* Ref.getAndUpdate(stateRef, (s) => ({
        ...s,
        fiber: null,
        activeSession: null,
      }));
      if (prev.activeSession) {
        prev.activeSession.closeGracefully("Reconfiguring relay tunnel");
      }
      if (prev.fiber) {
        yield* Fiber.interrupt(prev.fiber);
      }
      yield* Ref.set(endpointRef, null);
    });

    const runSessionOnce = Effect.fn("RelayTunnelClient.runSessionOnce")(function* (
      config: StoredSelfHostedRelayLink,
      localOrigin: LocalServerOrigin,
    ) {
      const environmentId = yield* identity.getEnvironmentId;
      const descriptor = yield* identity.getDescriptor;
      let reachedOnline = false;

      const outcome = yield* Effect.callback<TunnelSessionCloseOutcome>((resume) => {
        const session = RelayTunnelSession.connect({
          relayUrl: config.relayUrl,
          environmentId,
          environmentCredential: config.environmentCredential,
          endpointKey: config.endpoint.endpointKey,
          label: descriptor.label,
          localHost: localOrigin.host,
          localPort: localOrigin.port,
          signLoginProof: () => runPromise(signLoginProof(config, environmentId)),
          onSnapshot: (snap, endpoint) => {
            if (snap.state === "online") reachedOnline = true;
            runSync(publishSnapshot(snap));
            if (endpoint) runSync(Ref.set(endpointRef, endpoint));
          },
          onClosed: (closedOutcome) => resume(Effect.succeed(closedOutcome)),
        });
        runSync(Ref.update(stateRef, (s) => ({ ...s, activeSession: session })));
        return Effect.sync(() => {
          session.closeGracefully("Tunnel supervisor interrupted");
        });
      });

      yield* Ref.update(stateRef, (s) => ({ ...s, activeSession: null }));
      if (outcome.terminalError || !outcome.shouldReconnect) {
        yield* Ref.set(endpointRef, null);
      }
      return { outcome, reachedOnline };
    });

    const supervisorLoop = Effect.fn("RelayTunnelClient.supervisorLoop")(function* (
      config: StoredSelfHostedRelayLink,
      localOrigin: LocalServerOrigin,
    ) {
      let attempt = 0;
      while (true) {
        const { outcome, reachedOnline } = yield* runSessionOnce(config, localOrigin);
        if (!outcome.shouldReconnect) {
          yield* publishSnapshot({
            state: outcome.terminalError ? "error" : "disconnected",
            runId: null,
            rttMs: null,
            activeStreams: ZERO,
            connectedAt: null,
            lastError: outcome.terminalError ?? outcome.reason,
            compression: false,
          });
          return;
        }
        attempt = reachedOnline ? 0 : attempt + 1;
        const randomUnit = NodeCrypto.randomInt(0, 10_000) / 10_000;
        const delayMs = computeTunnelReconnectDelayMs(attempt, randomUnit);
        yield* publishSnapshot({
          state: "connecting",
          runId: null,
          rttMs: null,
          activeStreams: ZERO,
          connectedAt: null,
          lastError: outcome.reason,
          compression: false,
        });
        yield* Effect.sleep(Duration.millis(delayMs));
      }
    });

    const launchSupervisorIfReady = Effect.gen(function* () {
      yield* stopSupervisor;
      const state = yield* Ref.get(stateRef);
      if (!state.config || !state.localOrigin) {
        yield* publishSnapshot(DISCONNECTED_SNAPSHOT);
        return;
      }
      const fiber = yield* supervisorLoop(state.config, state.localOrigin).pipe(
        Effect.forkIn(scope),
      );
      yield* Ref.update(stateRef, (s) => ({ ...s, fiber }));
    });

    const snapshotChanges: Stream.Stream<HostRelayTunnelSnapshot> = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(snapshotPubSub);
        const current = yield* Ref.get(snapshotRef);
        return Stream.concat(Stream.make(current), Stream.fromSubscription(subscription));
      }),
    );

    yield* Effect.addFinalizer(() => stopSupervisor);

    return RelayTunnelClient.of({
      setLocalOrigin: Effect.fn("RelayTunnelClient.setLocalOrigin")(function* (origin) {
        yield* Ref.update(stateRef, (s) => ({ ...s, localOrigin: origin }));
        yield* launchSupervisorIfReady;
      }),
      configure: Effect.fn("RelayTunnelClient.configure")(function* (config) {
        yield* Ref.update(stateRef, (s) => ({ ...s, config }));
        yield* launchSupervisorIfReady;
      }),
      reconnect: Effect.fn("RelayTunnelClient.reconnect")(function* () {
        yield* launchSupervisorIfReady;
      }),
      getSnapshot: Effect.fn("RelayTunnelClient.getSnapshot")(() => Ref.get(snapshotRef)),
      snapshotChanges,
      getActiveEndpoint: Effect.fn("RelayTunnelClient.getActiveEndpoint")(() =>
        Ref.get(endpointRef),
      ),
    });
  }),
);
