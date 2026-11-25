import { RelayHostControl } from "@t3tools/client-runtime/relay";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";
import { hostRelayStatusToCloudLinkState, type CloudLinkTarget } from "./cloudLinkState";

export const checkReachability = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:check-reachability",
  execute: (input: { readonly target: CloudLinkTarget }) =>
    RelayHostControl.readHostRelayStatus(input.target.environmentId).pipe(
      Effect.map((status) => {
        const projected = hostRelayStatusToCloudLinkState(status);
        return (
          projected.reachability ?? {
            status: "unreachable" as const,
            checkedAt: new Date().toISOString(),
            cause: "not_linked" as const,
            reason: "Host is not linked to a relay server.",
            hint: null,
            fix: "Turn on Relay in Settings or link the host first.",
          }
        );
      }),
    ),
});

export const readLinkState = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:read-link-state",
  execute: (input: { readonly target: CloudLinkTarget }) =>
    RelayHostControl.readHostRelayStatus(input.target.environmentId).pipe(
      Effect.map(hostRelayStatusToCloudLinkState),
    ),
});
