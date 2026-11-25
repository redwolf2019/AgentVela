import { useAtomValue } from "@effect/atom-react";
import { AgentVelaRelay, ManagedRelayBridge } from "@t3tools/client-runtime/relay";
import { findErrorTraceId, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { useGT, useMessages } from "gt-react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { selfHostedRelay, useSelfHostedRelaySession } from "../../state/relay";

const relayEnvironmentsAtom = connectionAtomRuntime.atom(
  AgentVelaRelay.AgentVelaRelayClient.pipe(Effect.flatMap((client) => client.listEnvironments)),
);

const managedRelayMutationScheduler = createAtomCommandScheduler();

export const deregisterManagedRelayEnvironmentCommand = createRuntimeCommand(
  connectionAtomRuntime,
  {
    label: "mobile:managed-relay:deregister-environment",
    scheduler: managedRelayMutationScheduler,
    concurrency: {
      mode: "serial",
      key: (input: { readonly accountId?: string; readonly environmentId: EnvironmentId }) =>
        input.accountId ?? "relay",
    },
    execute: (input) =>
      AgentVelaRelay.AgentVelaRelayClient.pipe(
        Effect.flatMap((client) => client.unlinkEnvironment(input.environmentId)),
      ),
  },
);

export function useManagedRelayEnvironments() {
  const gt = useGT();
  const resolve = useMessages();
  const session = useSelfHostedRelaySession();
  const accountId = session.status === "signed_in" ? session.user.userId : null;
  const result = useAtomValue(relayEnvironmentsAtom);

  const data =
    accountId !== null && result._tag === "Success"
      ? result.value.map(ManagedRelayBridge.toLegacyEnvironmentRecord)
      : null;

  let error: string | null = null;
  let errorTraceId: string | null = null;
  if (accountId !== null && result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error =
      (cause instanceof Error ? thrownErrorMessage(cause, resolve) : null) ??
      gt("Could not load Relay environments.");
    errorTraceId = findErrorTraceId(cause);
  }

  return {
    data,
    isPending: result.waiting,
    error,
    errorTraceId,
    accountId,
    refresh: () => {
      refreshManagedRelayEnvironments();
    },
  };
}

export function refreshManagedRelayEnvironments(): void {
  const session = appAtomRegistry.get(selfHostedRelay.sessionValueAtom);
  if (session.status === "signed_in") {
    appAtomRegistry.refresh(relayEnvironmentsAtom);
  }
}
