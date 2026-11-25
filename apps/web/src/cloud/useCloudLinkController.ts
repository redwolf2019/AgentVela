import { findErrorTraceId, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { AuthRelayReadScope, AuthRelayWriteScope, type EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { msg } from "gt-react";

import { stackedThreadToast } from "../components/ui/toastHelpers";
import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { selfHostedRelay, useSelfHostedRelaySession } from "../state/relay";
import {
  readEnvironmentCanConfigureRelay,
  readEnvironmentScope,
  useEnvironmentCanConfigureRelay,
} from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useCloudLinkState } from "./cloudLinkState";
import { refreshHostRelayStatus } from "./hostRelayState";

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
  readonly holdWebhooksWhileOffline?: boolean;
}

export function useCloudLinkController(environmentId: EnvironmentId | null) {
  const session = useSelfHostedRelaySession();
  const isSignedIn = session.status === "signed_in";
  const refreshRelayEnvironments = useAtomCommand(selfHostedRelay.refreshDiscovery, {
    reportFailure: false,
  });
  const linkHost = useAtomCommand(selfHostedRelay.linkHost, { reportFailure: false });
  const unlinkHost = useAtomCommand(selfHostedRelay.unlinkHost, { reportFailure: false });
  const cloudLinkState = useCloudLinkState(environmentId);
  const [operationError, setOperationError] = useState<string | null>(null);

  const reportUpdateFailure = (cause: unknown, reason?: string) => {
    const message = thrownErrorMessage(cause, m) ?? m(msg("Could not update Relay access."));
    const traceId = findErrorTraceId(cause);
    console.error("[relay] Could not update Relay access", { message, traceId, cause });
    setOperationError(
      traceId ? m(msg("{message} Trace ID: {traceId}", { message, traceId })) : message,
    );
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Could not update Relay access")),
        description: reason ?? message,
        ...(traceId
          ? {
              actionProps: {
                children: m(msg("Copy trace ID")),
                onClick: () => void navigator.clipboard?.writeText(traceId),
              },
              actionVariant: "outline",
            }
          : {}),
        data: { hideCopyButton: true },
      }),
    );
  };

  const linkData = cloudLinkState.data;
  const managedTunnelActive = linkData ? Boolean(linkData.linked && !linkData.linkRevoked) : false;
  const linked = managedTunnelActive;
  const canConfigureRelay = useEnvironmentCanConfigureRelay(environmentId);
  const needsRelayConfiguration = (desired: CloudLinkDesiredState) =>
    !canConfigureRelay && desired.managedTunnel && !linked;

  const reconcileCloudState = async (desired: CloudLinkDesiredState): Promise<boolean> => {
    setOperationError(null);
    if (!environmentId) {
      reportUpdateFailure(new Error(m(msg("Choose an environment first."))));
      return false;
    }
    if (
      !readEnvironmentScope(environmentId, AuthRelayReadScope) ||
      !readEnvironmentScope(environmentId, AuthRelayWriteScope)
    ) {
      reportUpdateFailure(
        new Error(m(msg("This connection needs permission to view and manage Relay settings."))),
      );
      return false;
    }

    if (!desired.managedTunnel) {
      const result = await unlinkHost(environmentId);
      cloudLinkState.refresh();
      refreshHostRelayStatus(environmentId);
      await refreshRelayEnvironments();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportUpdateFailure(squashAtomCommandFailure(result));
        }
        return false;
      }
      return true;
    }

    if (!isSignedIn) {
      reportUpdateFailure(new Error(m(msg("Sign in to your Relay server before linking."))));
      return false;
    }

    if (!readEnvironmentCanConfigureRelay(environmentId)) {
      reportUpdateFailure(
        new Error(m(msg("This connection needs permission to configure Relay access."))),
      );
      return false;
    }

    const linkResult = await linkHost(environmentId);
    cloudLinkState.refresh();
    refreshHostRelayStatus(environmentId);
    await refreshRelayEnvironments();
    if (linkResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(linkResult)) {
        reportUpdateFailure(squashAtomCommandFailure(linkResult));
      }
      return false;
    }
    return true;
  };

  return {
    isSignedIn,
    linkState: cloudLinkState,
    linked,
    linkRevoked: false,
    managedTunnelActive,
    managedTunnelOutOfSync: false,
    publishAgentActivity: false,
    holdWebhooksWhileOffline: false,
    operationError,
    tunnelLimit: null,
    needsRelayConfiguration,
    reconcileCloudState,
  };
}
