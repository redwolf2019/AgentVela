import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { RelayHostControl } from "@t3tools/client-runtime/relay";
import { AuthRelayReadScope, type EnvironmentId } from "@t3tools/contracts";
import type { HostRelayStatus } from "@t3tools/contracts/agentVelaRelay";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";

const hostRelayStatusAtomFamily = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime.atom(RelayHostControl.readHostRelayStatus(environmentId)).pipe(
    Atom.map((result): AsyncResult.AsyncResult<HostRelayStatus | null, unknown> => result),
    Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`host-relay-status:${environmentId}`),
  ),
);

const EMPTY_HOST_RELAY_STATUS_ATOM: Atom.Atom<
  AsyncResult.AsyncResult<HostRelayStatus | null, unknown>
> = Atom.make((): AsyncResult.AsyncResult<HostRelayStatus | null, unknown> =>
  AsyncResult.success(null),
).pipe(Atom.keepAlive, Atom.withLabel("host-relay-status:null"));

export function refreshHostRelayStatus(environmentId: EnvironmentId | null): void {
  if (environmentId !== null && readEnvironmentScope(environmentId, AuthRelayReadScope)) {
    appAtomRegistry.refresh(hostRelayStatusAtomFamily(environmentId));
  }
}

export function readCachedHostRelayStatus(environmentId: EnvironmentId): HostRelayStatus | null {
  if (!readEnvironmentScope(environmentId, AuthRelayReadScope)) {
    return null;
  }
  const result = appAtomRegistry.get(hostRelayStatusAtomFamily(environmentId));
  return result._tag === "Success" ? result.value : null;
}

export function useHostRelayStatus(environmentId: EnvironmentId | null) {
  const gt = useGT();
  const resolve = useMessages();
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const atom =
    environmentId !== null && canReadRelay
      ? hostRelayStatusAtomFamily(environmentId)
      : EMPTY_HOST_RELAY_STATUS_ATOM;
  const result = useAtomValue(atom);

  const refresh = () => {
    refreshHostRelayStatus(environmentId);
  };

  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error =
      (cause instanceof Error ? thrownErrorMessage(cause, resolve) : null) ??
      gt("Could not read host relay status.");
  }

  return {
    data: result._tag === "Failure" ? null : AsyncResult.getOrElse(result, () => null),
    error,
    isPending: result.waiting,
    refresh,
  };
}

export function usePrimaryHostRelayStatus() {
  return useHostRelayStatus(usePrimaryEnvironmentId());
}
