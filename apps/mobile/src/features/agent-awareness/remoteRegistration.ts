import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { Preferences } from "../../persistence/mobile-preferences";

export type AgentAwarenessRegistrationStatus = "unknown" | "pending" | "registered" | "failed";

/**
 * Self-hosted `agent-vela-relay` mode does not register APNs/FCM push tokens or
 * remote Live Activities. This module keeps the extension seam for local UI and
 * preference flows until an opt-in push transport is added.
 */
export function getAgentAwarenessRegistrationStatus(): AgentAwarenessRegistrationStatus {
  return "unknown";
}

export function agentAwarenessNotificationsReady(): boolean {
  return false;
}

export function subscribeAgentAwarenessRegistrationStatus(_listener: () => void): () => void {
  return () => {};
}

export function armAgentAwarenessLiveActivityForLocalWork(_input: {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {}

export function refreshAgentAwarenessRegistration(): Effect.Effect<void> {
  return Effect.void;
}

export function updateAgentAwarenessRegistrationPreferences(
  _preferencesOverride: Partial<Preferences>,
): Effect.Effect<void> {
  return Effect.void;
}
