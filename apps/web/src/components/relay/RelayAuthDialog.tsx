import { TrimmedNonEmptyString } from "@t3tools/contracts";
import type { RelayAuthConfigResponse } from "@t3tools/contracts/agentVelaRelay";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState, type FormEvent } from "react";

import { resolveDefaultRelayUrl } from "../../cloud/publicConfig";
import { closeRelayAuthDialog, relayAuthDialogAtom } from "../../cloud/relayAuthDialog";
import {
  selfHostedRelay,
  useSelfHostedRelaySession,
  useSelfHostedRelayUrl,
} from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { formatAtomFailure, isValidRelayUsername } from "./relayUiHelpers";

export function RelayAuthDialogHost() {
  const dialogState = useAtomValue(relayAuthDialogAtom);
  if (!dialogState.open) {
    return null;
  }
  return (
    <RelayAuthDialog
      initialMode={dialogState.initialMode}
      onAuthenticated={dialogState.onAuthenticated}
    />
  );
}

function RelayAuthDialog({
  initialMode,
  onAuthenticated,
}: {
  readonly initialMode: "signin" | "register";
  readonly onAuthenticated: (() => void) | undefined;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const navigate = useNavigate();
  const urlState = useSelfHostedRelayUrl();
  const session = useSelfHostedRelaySession();
  const setRelayUrlCmd = useAtomCommand(selfHostedRelay.setRelayUrl, { reportFailure: false });
  const resetRelayUrlCmd = useAtomCommand(selfHostedRelay.resetRelayUrl, { reportFailure: false });
  const checkHealthCmd = useAtomCommand(selfHostedRelay.checkHealth, { reportFailure: false });
  const getAuthConfigCmd = useAtomCommand(selfHostedRelay.getAuthConfig, { reportFailure: false });
  const loginCmd = useAtomCommand(selfHostedRelay.login, { reportFailure: false });
  const registerCmd = useAtomCommand(selfHostedRelay.register, { reportFailure: false });
  const logoutCmd = useAtomCommand(selfHostedRelay.logout, { reportFailure: false });

  const defaultUrl = resolveDefaultRelayUrl();
  const [urlInput, setUrlInput] = useState(urlState.relayUrl ?? defaultUrl ?? "");
  const [mode, setMode] = useState<"signin" | "register">(initialMode);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [authConfig, setAuthConfig] = useState<RelayAuthConfigResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverNote, setServerNote] = useState<string | null>(null);

  const probeRelayServer = async () => {
    const healthResult = await checkHealthCmd();
    if (healthResult._tag !== "Success") {
      setError(formatAtomFailure(healthResult, gt("Could not reach the relay server."), resolve));
      return false;
    }
    const configResult = await getAuthConfigCmd();
    if (configResult._tag === "Success") {
      setAuthConfig(configResult.value);
      setServerNote(
        configResult.value.registrationOpen
          ? gt("Connected to v{version}. Registration is open.", {
              version: healthResult.value.version,
            })
          : gt("Connected to v{version}. Registration requires an invite code.", {
              version: healthResult.value.version,
            }),
      );
    } else {
      setAuthConfig(null);
      setServerNote(gt("Connected to v{version}.", { version: healthResult.value.version }));
    }
    return true;
  };

  const handleSaveUrl = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setServerNote(null);
    setBusy(true);
    const saved = await setRelayUrlCmd(urlInput.trim() || null);
    if (saved._tag !== "Success") {
      setBusy(false);
      setError(formatAtomFailure(saved, gt("Invalid relay server URL."), resolve));
      return;
    }
    if (saved.value.relayUrl !== null) {
      await probeRelayServer();
    }
    setBusy(false);
  };

  const handleResetUrl = async () => {
    setError(null);
    setServerNote(null);
    setBusy(true);
    const reset = await resetRelayUrlCmd();
    if (reset._tag === "Success") {
      setUrlInput(reset.value.relayUrl ?? "");
      if (reset.value.relayUrl) {
        await probeRelayServer();
      }
    }
    setBusy(false);
  };

  const handleAuthSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmedUser = username.trim();
    const trimmedPass = password.trim();
    if (!isValidRelayUsername(trimmedUser)) {
      setError(gt("Username must start with a letter or digit and be 2-64 characters."));
      return;
    }
    if (trimmedPass.length === 0) {
      setError(gt("Enter a password."));
      return;
    }
    setBusy(true);
    const activeUrl = urlState.relayUrl;
    if (urlInput.trim() && urlInput.trim() !== activeUrl) {
      const saved = await setRelayUrlCmd(urlInput.trim());
      if (saved._tag !== "Success") {
        setBusy(false);
        setError(formatAtomFailure(saved, gt("Invalid relay server URL."), resolve));
        return;
      }
    }

    const result =
      mode === "signin"
        ? await loginCmd({
            username: TrimmedNonEmptyString.make(trimmedUser),
            password: TrimmedNonEmptyString.make(trimmedPass),
          })
        : await registerCmd({
            username: TrimmedNonEmptyString.make(trimmedUser),
            password: TrimmedNonEmptyString.make(trimmedPass),
            ...(inviteCode.trim().length > 0
              ? { inviteCode: TrimmedNonEmptyString.make(inviteCode.trim()) }
              : {}),
          });
    setBusy(false);

    if (result._tag !== "Success") {
      setError(
        formatAtomFailure(
          result,
          mode === "signin" ? gt("Sign-in failed.") : gt("Registration failed."),
          resolve,
        ),
      );
      return;
    }

    toastManager.add({
      type: "success",
      title: mode === "signin" ? gt("Signed in to Relay") : gt("Relay account created"),
      description: gt("Signed in as {username}.", { username: result.value.username }),
    });
    closeRelayAuthDialog();
    onAuthenticated?.();
  };

  const handleLogout = async () => {
    setBusy(true);
    await logoutCmd();
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeRelayAuthDialog())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Self-Hosted Relay</T>
          </DialogTitle>
          <DialogDescription>
            <T>Connect to your own agent-vela-relay server to access environments remotely.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            <form onSubmit={(event) => void handleSaveUrl(event)} className="space-y-2">
              <Label htmlFor="relay-dialog-url">
                <T>Relay server URL</T>
              </Label>
              <div className="flex flex-wrap gap-2">
                <div className="min-w-48 flex-1">
                  <Input
                    id="relay-dialog-url"
                    type="url"
                    value={urlInput}
                    placeholder={gt("https://relay.example.com")}
                    disabled={busy}
                    onChange={(event) => setUrlInput(event.target.value)}
                  />
                </div>
                <Button type="submit" size="sm" variant="outline" disabled={busy}>
                  {busy ? gt("Connecting…") : gt("Save & test")}
                </Button>
                {defaultUrl !== null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void handleResetUrl()}
                  >
                    <T>Reset</T>
                  </Button>
                ) : null}
              </div>
              {serverNote ? <p className="text-xs text-muted-foreground">{serverNote}</p> : null}
            </form>

            {session.status === "signed_in" ? (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{session.user.username}</p>
                    <p className="text-xs text-muted-foreground">{session.relayUrl}</p>
                  </div>
                  <Badge variant={session.user.role === "admin" ? "info" : "secondary"}>
                    {session.user.role === "admin" ? gt("Admin") : gt("Member")}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      closeRelayAuthDialog();
                      void navigate({ to: "/settings/relay" });
                    }}
                  >
                    <T>Open Relay settings</T>
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() => void handleLogout()}
                  >
                    <T>Sign out</T>
                  </Button>
                </div>
              </div>
            ) : urlState.relayUrl !== null ? (
              <form onSubmit={(event) => void handleAuthSubmit(event)} className="space-y-3">
                <ToggleGroup
                  value={[mode]}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (next === "signin" || next === "register") {
                      setMode(next);
                      setError(null);
                    }
                  }}
                >
                  <Toggle value="signin">
                    <T>Sign in</T>
                  </Toggle>
                  <Toggle value="register">
                    <T>Create account</T>
                  </Toggle>
                </ToggleGroup>

                <div className="space-y-1.5">
                  <Label htmlFor="relay-dialog-username">
                    <T>Username</T>
                  </Label>
                  <Input
                    id="relay-dialog-username"
                    autoComplete="username"
                    value={username}
                    placeholder={gt("username")}
                    disabled={busy}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="relay-dialog-password">
                    <T>Password</T>
                  </Label>
                  <Input
                    id="relay-dialog-password"
                    type="password"
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>

                {mode === "register" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="relay-dialog-invite">
                      {authConfig && !authConfig.registrationOpen ? (
                        <T>Invite code (required)</T>
                      ) : (
                        <T>Invite code (optional)</T>
                      )}
                    </Label>
                    <Input
                      id="relay-dialog-invite"
                      value={inviteCode}
                      placeholder={gt("Invite code")}
                      disabled={busy}
                      onChange={(event) => setInviteCode(event.target.value)}
                    />
                  </div>
                ) : null}

                <div className="pt-1">
                  <Button type="submit" size="sm" disabled={busy}>
                    {busy
                      ? gt("Working…")
                      : mode === "signin"
                        ? gt("Sign in")
                        : gt("Create account")}
                  </Button>
                </div>
              </form>
            ) : (
              <p className="text-xs text-muted-foreground">
                <T>
                  Save a relay URL first (https:// for public servers, or http:// on LAN/Tailscale).
                </T>
              </p>
            )}

            {error ? (
              <Alert variant="error">
                <AlertTitle>
                  <T>Relay error</T>
                </AlertTitle>
                <AlertDescription>
                  <Var>{error}</Var>
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" size="sm" onClick={closeRelayAuthDialog}>
            <T>Close</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
