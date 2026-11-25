import type { EnvironmentId } from "@t3tools/contracts";
import type {
  AgentVelaRelayEnvironmentRecord,
  AgentVelaRelayStatusResponse,
  RelayPresenceEvent,
  RelayUserId,
} from "@t3tools/contracts/agentVelaRelay";
import * as Option from "effect/Option";

import type { ConnectionAttemptError } from "../connection/model.ts";

export interface SelfHostedRelayDiscoveredEnvironment {
  readonly environment: AgentVelaRelayEnvironmentRecord;
  readonly availability: "online" | "offline";
  readonly lastStatus: Option.Option<AgentVelaRelayStatusResponse>;
}

export type RelayPresenceConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

export interface SelfHostedRelayDiscoveryState {
  readonly relayUrl: string | null;
  readonly userId: RelayUserId | null;
  readonly connectionState: RelayPresenceConnectionState;
  readonly environments: ReadonlyMap<EnvironmentId, SelfHostedRelayDiscoveredEnvironment>;
  readonly listed: boolean;
  readonly lastEventAt: string | null;
  readonly error: Option.Option<ConnectionAttemptError>;
}

export const EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE: SelfHostedRelayDiscoveryState = Object.freeze(
  {
    relayUrl: null,
    userId: null,
    connectionState: "idle",
    environments: new Map(),
    listed: false,
    lastEventAt: null,
    error: Option.none(),
  },
);

export interface AppliedPresenceTransition {
  readonly state: SelfHostedRelayDiscoveryState;
  readonly newlyOnline: ReadonlyArray<EnvironmentId>;
  readonly needsReconcile: boolean;
}

function applySnapshotEvent(
  state: SelfHostedRelayDiscoveryState,
  environments: ReadonlyArray<AgentVelaRelayEnvironmentRecord>,
): AppliedPresenceTransition {
  const next = new Map<EnvironmentId, SelfHostedRelayDiscoveredEnvironment>();
  const newlyOnline: Array<EnvironmentId> = [];
  for (const env of environments) {
    const prev = state.environments.get(env.environmentId);
    next.set(env.environmentId, {
      environment: env,
      availability: env.status,
      lastStatus: prev?.lastStatus ?? Option.none(),
    });
    if (env.status === "online" && prev?.availability !== "online") {
      newlyOnline.push(env.environmentId);
    }
  }
  return {
    state: {
      ...state,
      environments: next,
      listed: true,
      connectionState: "connected",
      error: Option.none(),
    },
    newlyOnline,
    needsReconcile: false,
  };
}

function applyOnlineEvent(
  state: SelfHostedRelayDiscoveryState,
  event: Extract<RelayPresenceEvent, { readonly type: "environment.online" }>,
): AppliedPresenceTransition {
  const prev = state.environments.get(event.environmentId);
  if (prev === undefined) {
    return {
      state: { ...state, connectionState: "connected", error: Option.none() },
      newlyOnline: [event.environmentId],
      needsReconcile: true,
    };
  }
  const next = new Map(state.environments);
  next.set(event.environmentId, {
    ...prev,
    environment: {
      ...prev.environment,
      endpoint: event.endpoint,
      status: "online",
      lastSeenAt: event.lastSeenAt,
    },
    availability: "online",
  });
  return {
    state: { ...state, environments: next, connectionState: "connected", error: Option.none() },
    newlyOnline: prev.availability === "online" ? [] : [event.environmentId],
    needsReconcile: false,
  };
}

export function applyPresenceEvent(
  state: SelfHostedRelayDiscoveryState,
  event: RelayPresenceEvent,
): AppliedPresenceTransition {
  switch (event.type) {
    case "snapshot":
      return applySnapshotEvent(state, event.environments);
    case "environment.online":
      return applyOnlineEvent(state, event);
    case "environment.offline": {
      const prev = state.environments.get(event.environmentId);
      if (prev === undefined) return { state, newlyOnline: [], needsReconcile: false };
      const next = new Map(state.environments);
      next.set(event.environmentId, {
        ...prev,
        environment: { ...prev.environment, status: "offline" },
        availability: "offline",
        lastStatus: Option.none(),
      });
      return {
        state: { ...state, environments: next, lastEventAt: event.checkedAt },
        newlyOnline: [],
        needsReconcile: false,
      };
    }
    case "environment.linked": {
      const prev = state.environments.get(event.environment.environmentId);
      const next = new Map(state.environments);
      next.set(event.environment.environmentId, {
        environment: event.environment,
        availability: event.environment.status,
        lastStatus: prev?.lastStatus ?? Option.none(),
      });
      const becameOnline = event.environment.status === "online" && prev?.availability !== "online";
      return {
        state: { ...state, environments: next, connectionState: "connected", error: Option.none() },
        newlyOnline: becameOnline ? [event.environment.environmentId] : [],
        needsReconcile: false,
      };
    }
    case "environment.unlinked": {
      if (!state.environments.has(event.environmentId)) {
        return { state, newlyOnline: [], needsReconcile: false };
      }
      const next = new Map(state.environments);
      next.delete(event.environmentId);
      return { state: { ...state, environments: next }, newlyOnline: [], needsReconcile: false };
    }
    case "heartbeat":
      return {
        state: {
          ...state,
          lastEventAt: event.serverTime,
          connectionState: "connected",
          error: Option.none(),
        },
        newlyOnline: [],
        needsReconcile: false,
      };
  }
}
