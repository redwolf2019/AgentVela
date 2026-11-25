import { PositiveInt } from "@t3tools/contracts";
import type {
  RelayInviteId,
  RelayInviteRecord,
  RelayUserRole,
} from "@t3tools/contracts/agentVelaRelay";
import { msg, T, useGT, useMessages } from "gt-react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { selfHostedRelay } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { toastManager } from "../ui/toast";
import { formatAtomFailure, parsePositiveIntInput } from "./relayUiHelpers";

export function AdminInvitesSection({
  invites,
  onChanged,
}: {
  readonly invites: ReadonlyArray<RelayInviteRecord>;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const createInviteCmd = useAtomCommand(selfHostedRelay.createInvite, { reportFailure: false });
  const revokeInviteCmd = useAtomCommand(selfHostedRelay.revokeInvite, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "invite code",
      unavailableMessage: msg("Clipboard API is unavailable while copying invite code."),
      failureMessage: msg("Failed to copy invite code to the clipboard."),
    },
  });

  const [role, setRole] = useState<RelayUserRole>("member");
  const [maxUses, setMaxUses] = useState("1");
  const [ttlHours, setTtlHours] = useState("72");
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const usesNum = parsePositiveIntInput(maxUses);
    const ttlNum = parsePositiveIntInput(ttlHours);
    setBusy(true);
    const res = await createInviteCmd({
      role,
      ...(usesNum !== null ? { maxUses: PositiveInt.make(usesNum) } : {}),
      ...(ttlNum !== null ? { ttlHours: PositiveInt.make(ttlNum) } : {}),
    });
    setBusy(false);
    if (res._tag === "Success") {
      setCreatedCode(res.value.code);
      onChanged();
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not create invite"),
        description: formatAtomFailure(res, gt("Invite creation failed."), resolve),
      });
    }
  };

  const handleRevoke = async (inviteId: RelayInviteId) => {
    const res = await revokeInviteCmd(inviteId);
    if (res._tag === "Success") {
      onChanged();
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not revoke invite"),
        description: formatAtomFailure(res, gt("Invite revocation failed."), resolve),
      });
    }
  };

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => void handleCreate(event)}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="w-32 space-y-1">
          <Label>
            <T>Role</T>
          </Label>
          <Select value={role} onValueChange={(value) => setRole(value as RelayUserRole)}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="member">
                <T>Member</T>
              </SelectItem>
              <SelectItem value="admin">
                <T>Admin</T>
              </SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <div className="w-24 space-y-1">
          <Label htmlFor="invite-max-uses">
            <T>Max uses</T>
          </Label>
          <Input
            id="invite-max-uses"
            size="sm"
            type="number"
            min={1}
            value={maxUses}
            onChange={(event) => setMaxUses(event.target.value)}
          />
        </div>
        <div className="w-28 space-y-1">
          <Label htmlFor="invite-ttl-hours">
            <T>TTL (hours)</T>
          </Label>
          <Input
            id="invite-ttl-hours"
            size="sm"
            type="number"
            min={1}
            value={ttlHours}
            onChange={(event) => setTtlHours(event.target.value)}
          />
        </div>
        <Button size="sm" type="submit" disabled={busy}>
          <T>Create invite</T>
        </Button>
      </form>

      {createdCode ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              <T>New invite code (shown once)</T>
            </p>
            <p className="truncate font-mono text-sm">{createdCode}</p>
          </div>
          <Button
            size="xs"
            variant="outline"
            onClick={() => copyToClipboard(createdCode, undefined)}
          >
            {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            {isCopied ? gt("Copied") : gt("Copy")}
          </Button>
        </div>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <T>Prefix</T>
            </TableHead>
            <TableHead>
              <T>Role</T>
            </TableHead>
            <TableHead>
              <T>Uses</T>
            </TableHead>
            <TableHead>
              <T>Status</T>
            </TableHead>
            <TableHead>
              <T>Actions</T>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invites.map((invite) => {
            const revoked = invite.revokedAt !== null;
            return (
              <TableRow key={invite.inviteId}>
                <TableCell>
                  <span className="font-mono">{invite.codePrefix}…</span>
                </TableCell>
                <TableCell>{invite.role}</TableCell>
                <TableCell>
                  {invite.usesCount} / {invite.maxUses}
                </TableCell>
                <TableCell>
                  <Badge variant={revoked ? "error" : "secondary"}>
                    {revoked ? gt("Revoked") : gt("Active")}
                  </Badge>
                </TableCell>
                <TableCell>
                  {!revoked ? (
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      onClick={() => void handleRevoke(invite.inviteId)}
                    >
                      <T>Revoke</T>
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
