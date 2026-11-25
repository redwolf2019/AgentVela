import { useAtomValue } from "@effect/atom-react";
import { createRelayEnvironmentDiscoveryAtoms } from "@t3tools/client-runtime/state/relay";
import { createSelfHostedRelayAtoms } from "@t3tools/client-runtime/state/self-hosted-relay";

import { connectionAtomRuntime } from "../connection/runtime";

export const relayEnvironmentDiscovery: ReturnType<typeof createRelayEnvironmentDiscoveryAtoms> =
  createRelayEnvironmentDiscoveryAtoms(connectionAtomRuntime);

export const selfHostedRelay: ReturnType<typeof createSelfHostedRelayAtoms> =
  createSelfHostedRelayAtoms(connectionAtomRuntime);

export function useSelfHostedRelayUrl() {
  return useAtomValue(selfHostedRelay.relayUrlValueAtom);
}

export function useSelfHostedRelaySession() {
  return useAtomValue(selfHostedRelay.sessionValueAtom);
}

export function useSelfHostedRelayDiscovery() {
  return useAtomValue(selfHostedRelay.discoveryValueAtom);
}
