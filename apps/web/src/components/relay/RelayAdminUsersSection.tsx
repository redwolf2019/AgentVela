import { TrimmedNonEmptyString } from "@t3tools/contracts";
import type {
  RelayUserId,
  RelayUserRecord,
  RelayUserRole,
} from "@t3tools/contracts/agentVelaRelay";
import { T, useGT, useMessages } from "gt-react";
import { useState, type FormEvent } from "react";

import { selfHostedRelay } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { toastManager } from "../ui/toast";
import { formatAtomFailure, isValidRelayUsername } from "./relayUiHelpers";

export function AdminUsersSection({
  users,
  currentUserId,
  onChanged,
}: {
  readonly users: ReadonlyArray<RelayUserRecord>;
  readonly currentUserId: RelayUserId;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const createUserCmd = useAtomCommand(selfHostedRelay.createUser, { reportFailure: false });
  const updateUserCmd = useAtomCommand(selfHostedRelay.updateUser, { reportFailure: false });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<RelayUserRole>("member");
  const [busy, setBusy] = useState(false);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!isValidRelayUsername(username) || password.trim().length === 0) {
      toastManager.add({
        type: "error",
        title: gt("Enter a valid username and password."),
      });
      return;
    }
    setBusy(true);
    const res = await createUserCmd({
      username: TrimmedNonEmptyString.make(username.trim()),
      password: TrimmedNonEmptyString.make(password.trim()),
      role,
    });
    setBusy(false);
    if (res._tag === "Success") {
      setUsername("");
      setPassword("");
      toastManager.add({ type: "success", title: gt("User created") });
      onChanged();
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not create user"),
        description: formatAtomFailure(res, gt("Create user failed."), resolve),
      });
    }
  };

  const handleUpdate = async (
    user: RelayUserRecord,
    patch: { readonly role?: RelayUserRole; readonly disabled?: boolean },
  ) => {
    const res = await updateUserCmd({ userId: user.userId, patch });
    if (res._tag === "Success") {
      onChanged();
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not update user"),
        description: formatAtomFailure(res, gt("Update user failed."), resolve),
      });
    }
  };

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => void handleCreate(event)}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="min-w-36 space-y-1">
          <Label htmlFor="admin-create-username">
            <T>Username</T>
          </Label>
          <Input
            id="admin-create-username"
            size="sm"
            value={username}
            placeholder={gt("username")}
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
        <div className="min-w-40 space-y-1">
          <Label htmlFor="admin-create-password">
            <T>Password</T>
          </Label>
          <Input
            id="admin-create-password"
            size="sm"
            type="password"
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
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
        <Button size="sm" type="submit" disabled={busy}>
          <T>Create user</T>
        </Button>
      </form>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <T>Username</T>
            </TableHead>
            <TableHead>
              <T>Role</T>
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
          {users.map((user) => {
            const isSelf = user.userId === currentUserId;
            return (
              <TableRow key={user.userId}>
                <TableCell>{user.username}</TableCell>
                <TableCell>
                  <Badge variant={user.role === "admin" ? "info" : "secondary"}>
                    {user.role === "admin" ? gt("Admin") : gt("Member")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={user.disabled ? "error" : "success"}>
                    {user.disabled ? gt("Disabled") : gt("Active")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={isSelf}
                      onClick={() =>
                        void handleUpdate(user, {
                          role: user.role === "admin" ? "member" : "admin",
                        })
                      }
                    >
                      {user.role === "admin" ? gt("Make member") : gt("Make admin")}
                    </Button>
                    <Button
                      size="xs"
                      variant={user.disabled ? "outline" : "destructive-outline"}
                      disabled={isSelf}
                      onClick={() => void handleUpdate(user, { disabled: !user.disabled })}
                    >
                      {user.disabled ? gt("Enable") : gt("Disable")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
