import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  AuthRelayReadScope,
  type EnvironmentCloudLinkStateResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { HostRelayStatus } from "@t3tools/contracts/agentVelaRelay";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";
import { RelayHostControl } from "@t3tools/client-runtime/relay";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { refreshHostRelayStatus } from "./hostRelayState";

export interface CloudLinkTarget {
  readonly environmentId: EnvironmentId;
}

export function hostRelayStatusToCloudLinkState(
  status: HostRelayStatus,
): EnvironmentCloudLinkStateResult {
  const checkedAt = status.tunnel.connectedAt ?? new Date().toISOString();
  const hostname = (() => {
    if (!status.endpoint) return undefined;
    try {
      return new URL(status.endpoint.httpBaseUrl).hostname;
    } catch {
      return undefined;
    }
  })();

  return {
    linked: status.linked,
    cloudUserId: status.userId,
    relayUrl: status.relayUrl,
    relayIssuer: status.relayIssuer,
    managedTunnelActive: status.linked,
    publishAgentActivity: false,
    linkRevoked: false,
    linkableHere: true,
    ...(hostname ? { tunnelHostname: hostname } : {}),
    ...(status.linked
      ? {
          reachability:
            status.tunnel.state === "online"
              ? {
                  status: "reachable" as const,
                  checkedAt,
                  readyConnections: status.tunnel.activeStreams,
                  protocol: "t3_relay",
                }
              : {
                  status: "unreachable" as const,
                  checkedAt,
                  cause: "connector_not_ready" as const,
                  reason:
                    status.tunnel.lastError ??
                    (status.tunnel.state === "connecting"
                      ? "Relay tunnel is connecting."
                      : "Relay tunnel is disconnected."),
                  hint: null,
                  fix: "Reconnect the host relay tunnel or check network reachability.",
                },
        }
      : {}),
  };
}

const cloudLinkStateAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime.atom(RelayHostControl.readHostRelayStatus(environmentId)).pipe(
    Atom.map((result): AsyncResult.AsyncResult<EnvironmentCloudLinkStateResult | null, unknown> =>
      AsyncResult.map(result, hostRelayStatusToCloudLinkState),
    ),
    Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`cloud-link:${environmentId}`),
  ),
);

const EMPTY_CLOUD_LINK_STATE_ATOM: Atom.Atom<
  AsyncResult.AsyncResult<EnvironmentCloudLinkStateResult | null, unknown>
> = Atom.make((): AsyncResult.AsyncResult<EnvironmentCloudLinkStateResult | null, unknown> =>
  AsyncResult.success(null),
).pipe(Atom.keepAlive, Atom.withLabel("cloud-link:null"));

function refreshCloudLinkState(target: CloudLinkTarget | null): void {
  if (target && readEnvironmentScope(target.environmentId, AuthRelayReadScope)) {
    appAtomRegistry.refresh(cloudLinkStateAtom(target.environmentId));
    refreshHostRelayStatus(target.environmentId);
  }
}

export function readCachedCloudLinkState(target: CloudLinkTarget) {
  if (!readEnvironmentScope(target.environmentId, AuthRelayReadScope)) return null;
  const result = appAtomRegistry.get(cloudLinkStateAtom(target.environmentId));
  return result._tag === "Success" ? result.value : null;
}

export function useCloudLinkState(environmentId: EnvironmentId | null) {
  const gt = useGT();
  const resolve = useMessages();
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const target: CloudLinkTarget | null = environmentId === null ? null : { environmentId };
  const atom =
    environmentId !== null && canReadRelay
      ? cloudLinkStateAtom(environmentId)
      : EMPTY_CLOUD_LINK_STATE_ATOM;
  const result = useAtomValue(atom);
  const refresh = () => {
    refreshCloudLinkState(target);
  };
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error =
      (cause instanceof Error ? thrownErrorMessage(cause, resolve) : null) ??
      gt("Could not read Relay link state.");
  }

  return {
    data: result._tag === "Failure" ? null : AsyncResult.getOrElse(result, () => null),
    error,
    isPending: result.waiting,
    refresh,
    target,
  };
}

export function usePrimaryCloudLinkState() {
  return useCloudLinkState(usePrimaryEnvironmentId());
}
