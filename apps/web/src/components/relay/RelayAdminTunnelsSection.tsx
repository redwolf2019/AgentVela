import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayAdminTunnelTelemetry } from "@t3tools/contracts/agentVelaRelay";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { selfHostedRelay } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { toastManager } from "../ui/toast";
import { formatAtomFailure, formatRelayBytes, formatRelayDuration } from "./relayUiHelpers";

export function AdminTunnelsSection({
  tunnels,
  onChanged,
}: {
  readonly tunnels: ReadonlyArray<RelayAdminTunnelTelemetry>;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const kickTunnelCmd = useAtomCommand(selfHostedRelay.kickTunnel, { reportFailure: false });
  const [kickingId, setKickingId] = useState<EnvironmentId | null>(null);

  const handleKick = async (tunnel: RelayAdminTunnelTelemetry) => {
    const confirmed = await requestConfirmDialog(
      gt("Disconnect active tunnel for {label} ({user})?", {
        label: tunnel.label,
        user: tunnel.username,
      }),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setKickingId(tunnel.environmentId);
    const result = await kickTunnelCmd({
      environmentId: tunnel.environmentId,
      reason: "kicked_by_admin",
    });
    setKickingId(null);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: gt("Tunnel disconnected") });
      onChanged();
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not disconnect tunnel"),
        description: formatAtomFailure(result, gt("Tunnel kick failed."), resolve),
      });
    }
  };

  if (tunnels.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <T>No active host tunnels are connected right now.</T>
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <T>Environment</T>
          </TableHead>
          <TableHead>
            <T>Owner</T>
          </TableHead>
          <TableHead>
            <T>Run</T>
          </TableHead>
          <TableHead>
            <T>Uptime</T>
          </TableHead>
          <TableHead>
            <T>RTT</T>
          </TableHead>
          <TableHead>
            <T>Streams</T>
          </TableHead>
          <TableHead>
            <T>Traffic</T>
          </TableHead>
          <TableHead>
            <T>Actions</T>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tunnels.map((tunnel) => (
          <TableRow key={`${tunnel.environmentId}:${tunnel.runId}`}>
            <TableCell>
              <div className="font-medium">{tunnel.label}</div>
              <div className="font-mono text-2xs text-muted-foreground">{tunnel.endpointKey}</div>
            </TableCell>
            <TableCell>{tunnel.username}</TableCell>
            <TableCell>#{tunnel.runId}</TableCell>
            <TableCell>{formatRelayDuration(tunnel.connectedAt, resolve)}</TableCell>
            <TableCell>
              {tunnel.rttMs !== null ? `${tunnel.rttMs} ms` : gt("-")}
              {tunnel.compression ? ` · ${gt("gzip")}` : ""}
            </TableCell>
            <TableCell>{tunnel.activeStreams}</TableCell>
            <TableCell>
              {formatRelayBytes(tunnel.bytesIn)} / {formatRelayBytes(tunnel.bytesOut)}
            </TableCell>
            <TableCell>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={kickingId === tunnel.environmentId}
                onClick={() => void handleKick(tunnel)}
              >
                <T>Kick</T>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
