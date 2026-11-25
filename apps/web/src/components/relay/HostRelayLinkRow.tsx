import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useHostRelayStatus } from "../../cloud/hostRelayState";
import { openRelayAuthDialog } from "../../cloud/relayAuthDialog";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  selfHostedRelay,
  useSelfHostedRelaySession,
  useSelfHostedRelayUrl,
} from "../../state/relay";
import { useEnvironmentCanConfigureRelay } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { formatAtomFailure } from "./relayUiHelpers";

export interface HostDeviceApprovalControl {
  readonly required: boolean;
  readonly canManage: boolean;
}

export function HostRelayLinkRow({
  environmentId,
  canReadRelay,
  canManageRelay,
  connectDeviceApproval,
}: {
  readonly environmentId: EnvironmentId;
  readonly canReadRelay: boolean;
  readonly canManageRelay: boolean;
  readonly connectDeviceApproval: HostDeviceApprovalControl | null;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const session = useSelfHostedRelaySession();
  const urlState = useSelfHostedRelayUrl();
  const canConfigureRelay = useEnvironmentCanConfigureRelay(environmentId);
  const hostStatus = useHostRelayStatus(environmentId);
  const updateEnvironmentSettings = useUpdateEnvironmentSettings(environmentId);

  const linkHostCmd = useAtomCommand(selfHostedRelay.linkHost, { reportFailure: false });
  const reconnectHostCmd = useAtomCommand(selfHostedRelay.reconnectHost, { reportFailure: false });
  const unlinkHostCmd = useAtomCommand(selfHostedRelay.unlinkHost, { reportFailure: false });
  const refreshDiscoveryCmd = useAtomCommand(selfHostedRelay.refreshDiscovery, {
    reportFailure: false,
  });

  const [busy, setBusy] = useState(false);

  if (!canReadRelay) {
    return (
      <SettingsRow
        title={gt("Self-hosted Relay")}
        description={gt(
          "To edit these settings, pair this connection with both View relay and Manage relay permissions.",
        )}
      />
    );
  }

  const statusData = hostStatus.data;
  const linked = statusData?.linked === true;
  const isSignedIn = session.status === "signed_in";
  const canToggleLink = linked ? canManageRelay : canManageRelay && canConfigureRelay;

  const handleToggleLink = async (enabled: boolean) => {
    setBusy(true);
    const res = enabled ? await linkHostCmd(environmentId) : await unlinkHostCmd(environmentId);
    hostStatus.refresh();
    await refreshDiscoveryCmd();
    setBusy(false);
    if (res._tag === "Success") {
      toastManager.add({
        type: "success",
        title: enabled ? gt("Host linked to Relay") : gt("Host unlinked from Relay"),
      });
    } else {
      toastManager.add({
        type: "error",
        title: enabled ? gt("Could not link host") : gt("Could not unlink host"),
        description: formatAtomFailure(res, gt("Relay update failed."), resolve),
      });
    }
  };

  const handleReconnect = async () => {
    setBusy(true);
    const res = await reconnectHostCmd(environmentId);
    hostStatus.refresh();
    setBusy(false);
    if (res._tag === "Success") {
      toastManager.add({ type: "success", title: gt("Relay tunnel reconnecting") });
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not reconnect tunnel"),
        description: formatAtomFailure(res, gt("Reconnect failed."), resolve),
      });
    }
  };

  const tunnel = statusData?.tunnel;
  const tunnelStatusLine =
    linked && tunnel ? (
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Badge
          variant={
            tunnel.state === "online"
              ? "success"
              : tunnel.state === "connecting"
                ? "warning"
                : "secondary"
          }
        >
          {tunnel.state === "online"
            ? gt("Online")
            : tunnel.state === "connecting"
              ? gt("Connecting")
              : tunnel.state === "error"
                ? gt("Error")
                : gt("Disconnected")}
        </Badge>
        {tunnel.rttMs !== null ? (
          <span className="text-xs text-muted-foreground">{tunnel.rttMs} ms</span>
        ) : null}
        {statusData.endpoint?.httpBaseUrl ? (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {statusData.endpoint.httpBaseUrl}
          </span>
        ) : null}
        {tunnel.lastError ? (
          <span className="text-xs text-destructive-foreground">{tunnel.lastError}</span>
        ) : null}
      </div>
    ) : (
      hostStatus.error
    );

  return (
    <>
      <SettingsRow
        id="t3-connect"
        title={gt("Self-hosted Relay")}
        description={
          !urlState.relayUrl
            ? gt("Configure a relay URL and sign in to expose this environment.")
            : !isSignedIn && !linked
              ? gt("Sign in to your Relay server to link this environment.")
              : linked
                ? gt("Outbound tunnel from this host to your Relay server.")
                : gt("Link this host to accept remote Web, Desktop, and Mobile connections.")
        }
        status={tunnelStatusLine}
        control={
          !isSignedIn && !linked ? (
            <Button size="sm" variant="outline" onClick={() => openRelayAuthDialog()}>
              <T>Sign in</T>
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              {linked ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleReconnect()}
                >
                  <RefreshCwIcon className="size-3.5" />
                  <T>Reconnect</T>
                </Button>
              ) : null}
              <Switch
                aria-label={gt("Enable self-hosted Relay")}
                checked={linked}
                disabled={busy || !canToggleLink || hostStatus.isPending}
                onCheckedChange={(checked) => void handleToggleLink(Boolean(checked))}
              />
            </div>
          )
        }
      />
      {linked && connectDeviceApproval ? (
        <SettingsRow
          id="connect-device-approval"
          title={gt("Require approval for new devices")}
          description={gt(
            "Devices that sign in to your Relay account wait until someone already connected here approves them.",
          )}
          control={
            <Switch
              aria-label={gt("Require approval for new devices")}
              checked={connectDeviceApproval.required}
              disabled={!connectDeviceApproval.canManage}
              onCheckedChange={(enabled) =>
                updateEnvironmentSettings({ requireConnectDeviceApproval: Boolean(enabled) })
              }
            />
          }
        />
      ) : null}
    </>
  );
}
