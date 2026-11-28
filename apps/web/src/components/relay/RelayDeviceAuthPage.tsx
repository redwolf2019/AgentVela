import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState, type FormEvent } from "react";

import { openRelayAuthDialog } from "../../cloud/relayAuthDialog";
import {
  selfHostedRelay,
  useSelfHostedRelaySession,
  useSelfHostedRelayUrl,
} from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { formatAtomFailure } from "./relayUiHelpers";

function initialUserCodeFromLocation(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return new URL(window.location.href).searchParams.get("code")?.trim().toUpperCase() ?? "";
}

export function RelayDeviceAuthPage() {
  const gt = useGT();
  const resolve = useMessages();
  const urlState = useSelfHostedRelayUrl();
  const session = useSelfHostedRelaySession();
  const approveCmd = useAtomCommand(selfHostedRelay.approveDeviceAuth, { reportFailure: false });

  const [userCode, setUserCode] = useState(initialUserCodeFromLocation);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmed = userCode.trim().toUpperCase();
    if (trimmed.length === 0) {
      setError(gt("Enter the device code printed by your terminal."));
      return;
    }
    setBusy(true);
    const res = await approveCmd({ userCode: TrimmedNonEmptyString.make(trimmed) });
    setBusy(false);
    if (res._tag === "Success") {
      setApproved(true);
    } else {
      setError(formatAtomFailure(res, gt("Could not approve the device code."), resolve));
    }
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        context={gt("CLI device login")}
        title={gt("Authorize terminal access")}
        description={
          session.status === "signed_in"
            ? gt("Signed in as {username} on {relayUrl}.", {
                username: session.user.username,
                relayUrl: session.relayUrl,
              })
            : gt("Sign in to your Relay account to approve `agentvela relay login`.")
        }
      />

      <div className="mt-6 space-y-4">
        {session.status !== "signed_in" || urlState.relayUrl === null ? (
          <Button type="button" onClick={() => openRelayAuthDialog()}>
            <T>Sign in / Configure Relay</T>
          </Button>
        ) : approved ? (
          <Alert variant="success">
            <AlertTitle>
              <T>Device authorized</T>
            </AlertTitle>
            <AlertDescription>
              <T>You can return to your terminal now.</T>
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={(event) => void handleApprove(event)} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="device-auth-user-code">
                <T>Verification code</T>
              </Label>
              <Input
                id="device-auth-user-code"
                font="mono"
                value={userCode}
                placeholder={gt("ABCD-EFGH")}
                disabled={busy}
                onChange={(event) => setUserCode(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? gt("Approving…") : gt("Approve device")}
            </Button>
          </form>
        )}

        {error ? (
          <Alert variant="error">
            <AlertTitle>
              <T>Authorization failed</T>
            </AlertTitle>
            <AlertDescription>
              <Var>{error}</Var>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </StandalonePage>
  );
}
