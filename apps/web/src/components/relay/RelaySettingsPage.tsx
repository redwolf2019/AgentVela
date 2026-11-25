import { TrimmedNonEmptyString, type EnvironmentId } from "@t3tools/contracts";
import type { RelayCreateEnrollmentTokenResponse } from "@t3tools/contracts/agentVelaRelay";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { CheckIcon, CopyIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { openRelayAuthDialog } from "../../cloud/relayAuthDialog";
import { resolveDefaultRelayUrl } from "../../cloud/publicConfig";
import { environmentCatalog } from "../../connection/catalog";
import { requestConfirmDialog } from "../../confirmDialog";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironments } from "../../state/environments";
import {
  selfHostedRelay,
  useSelfHostedRelayDiscovery,
  useSelfHostedRelaySession,
  useSelfHostedRelayUrl,
} from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { toastManager } from "../ui/toast";
import { RelayAdminPanel } from "./RelayAdminPanel";
import {
  buildEnrollmentCommand,
  formatAtomFailure,
  presenceConnectionLabel,
} from "./relayUiHelpers";

export function RelaySettingsPage() {
  return (
    <SettingsPageContainer>
      <RelayServerUrlSection />
      <RelayAccountSection />
      <RelayDiscoveredEnvironmentsSection />
      <RelayEnrollmentSection />
      <RelayAdminPanel />
    </SettingsPageContainer>
  );
}

function RelayServerUrlSection() {
  const gt = useGT();
  const resolve = useMessages();
  const urlState = useSelfHostedRelayUrl();
  const discovery = useSelfHostedRelayDiscovery();
  const defaultUrl = resolveDefaultRelayUrl();
  const setRelayUrlCmd = useAtomCommand(selfHostedRelay.setRelayUrl, { reportFailure: false });
  const resetRelayUrlCmd = useAtomCommand(selfHostedRelay.resetRelayUrl, { reportFailure: false });
  const checkHealthCmd = useAtomCommand(selfHostedRelay.checkHealth, { reportFailure: false });

  const [urlInput, setUrlInput] = useState(urlState.relayUrl ?? defaultUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setBusy(true);
    const saved = await setRelayUrlCmd(urlInput.trim() || null);
    if (saved._tag !== "Success") {
      setBusy(false);
      setErrorMessage(formatAtomFailure(saved, gt("Invalid relay server URL."), resolve));
      return;
    }
    if (saved.value.relayUrl) {
      const health = await checkHealthCmd();
      setBusy(false);
      if (health._tag === "Success") {
        setStatusMessage(gt("Healthy (v{version}).", { version: health.value.version }));
      } else {
        setErrorMessage(formatAtomFailure(health, gt("Health check failed."), resolve));
      }
    } else {
      setBusy(false);
      setStatusMessage(gt("Relay URL cleared."));
    }
  };

  const handleReset = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    setBusy(true);
    const reset = await resetRelayUrlCmd();
    if (reset._tag === "Success") {
      setUrlInput(reset.value.relayUrl ?? "");
    }
    setBusy(false);
  };

  return (
    <SettingsSection
      id="relay-server"
      title={gt("Relay server")}
      headerAction={
        <Badge
          variant={
            discovery.connectionState === "connected"
              ? "success"
              : discovery.connectionState === "offline" ||
                  discovery.connectionState === "reconnecting"
                ? "warning"
                : "secondary"
          }
        >
          {presenceConnectionLabel(discovery.connectionState, resolve)}
        </Badge>
      }
    >
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">
          <T>
            Enter the base URL of your self-hosted agent-vela-relay server. Public addresses require
            https://; loopback, LAN, and Tailscale support http://.
          </T>
        </p>
        <form onSubmit={(event) => void handleSave(event)} className="flex flex-wrap gap-2">
          <div className="min-w-56 flex-1">
            <Input
              aria-label={gt("Relay server URL")}
              type="url"
              value={urlInput}
              placeholder={gt("https://relay.example.com")}
              disabled={busy}
              onChange={(event) => setUrlInput(event.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? gt("Testing…") : gt("Save & test")}
          </Button>
          {defaultUrl !== null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void handleReset()}
            >
              <T>Use default</T>
            </Button>
          ) : null}
        </form>
        {statusMessage ? <p className="text-xs text-muted-foreground">{statusMessage}</p> : null}
        {errorMessage ? (
          <p className="text-xs text-destructive-foreground">{errorMessage}</p>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function RelayAccountSection() {
  const gt = useGT();
  const session = useSelfHostedRelaySession();
  const urlState = useSelfHostedRelayUrl();
  const getMeCmd = useAtomCommand(selfHostedRelay.getMe, { reportFailure: false });
  const logoutCmd = useAtomCommand(selfHostedRelay.logout, { reportFailure: false });

  return (
    <SettingsSection id="relay-account" title={gt("Relay account")}>
      {session.status === "signed_in" ? (
        <SettingsRow
          title={session.user.username}
          description={gt("Signed in to {relayUrl}", { relayUrl: session.relayUrl })}
          status={
            <div className="flex items-center gap-2 pt-1">
              <Badge variant={session.user.role === "admin" ? "info" : "secondary"}>
                {session.user.role === "admin" ? gt("Admin") : gt("Member")}
              </Badge>
            </div>
          }
          control={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void getMeCmd()}>
                <T>Refresh profile</T>
              </Button>
              <Button size="sm" variant="destructive-outline" onClick={() => void logoutCmd()}>
                <T>Sign out</T>
              </Button>
            </div>
          }
        />
      ) : (
        <SettingsRow
          title={gt("Not signed in")}
          description={
            urlState.relayUrl
              ? gt("Sign in or create an account on {relayUrl}.", { relayUrl: urlState.relayUrl })
              : gt("Configure a relay server URL above, then sign in.")
          }
          control={
            <Button size="sm" onClick={() => openRelayAuthDialog()}>
              <T>Sign in / Register</T>
            </Button>
          }
        />
      )}
    </SettingsSection>
  );
}

function RelayDiscoveredEnvironmentsSection() {
  const gt = useGT();
  const resolve = useMessages();
  const session = useSelfHostedRelaySession();
  const discovery = useSelfHostedRelayDiscovery();
  const { environments: localEnvironments } = useEnvironments();
  const registerEnvCmd = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const refreshCmd = useAtomCommand(selfHostedRelay.refreshDiscovery, { reportFailure: false });
  const unlinkEnvCmd = useAtomCommand(selfHostedRelay.unlinkEnvironment, { reportFailure: false });
  const [busyId, setBusyId] = useState<EnvironmentId | null>(null);

  if (session.status !== "signed_in") {
    return null;
  }

  const localById = new Set(localEnvironments.map((env) => env.environmentId));
  const discovered = [...discovery.environments.values()];

  const handleConnect = async (environmentId: EnvironmentId) => {
    const entry = discovery.environments.get(environmentId);
    if (!entry) return;
    setBusyId(environmentId);
    const res = await registerEnvCmd(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: entry.environment.environmentId,
          label: entry.environment.label,
        }),
      }),
    );
    setBusyId(null);
    if (res._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: gt("Could not add environment"),
        description: formatAtomFailure(res, gt("Connection failed."), resolve),
      });
    }
  };

  const handleUnlink = async (environmentId: EnvironmentId, label: string) => {
    const confirmed = await requestConfirmDialog(
      gt("Unlink {label} from your Relay account?", { label }),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusyId(environmentId);
    const res = await unlinkEnvCmd(environmentId);
    if (res._tag === "Success") {
      await refreshCmd();
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not unlink environment"),
        description: formatAtomFailure(res, gt("Unlink failed."), resolve),
      });
    }
    setBusyId(null);
  };

  return (
    <SettingsSection
      id="relay-environments"
      title={gt("Linked environments")}
      headerAction={
        <Button size="sm" variant="outline" onClick={() => void refreshCmd()}>
          <RefreshCwIcon className="size-3.5" />
          <T>Refresh</T>
        </Button>
      }
    >
      {discovered.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">
          <T>
            No environments are linked to this Relay account yet. Link a running host from Sharing &
            access, or enroll a headless server below.
          </T>
        </div>
      ) : (
        discovered.map((entry) => {
          const added = localById.has(entry.environment.environmentId);
          return (
            <SettingsRow
              key={entry.environment.environmentId}
              title={
                <span className="flex items-center gap-2">
                  <span>{entry.environment.label}</span>
                  <Badge variant={entry.availability === "online" ? "success" : "secondary"}>
                    {entry.availability === "online" ? gt("Online") : gt("Offline")}
                  </Badge>
                </span>
              }
              description={entry.environment.endpoint.httpBaseUrl}
              control={
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={added ? "outline" : "default"}
                    disabled={added || busyId === entry.environment.environmentId}
                    onClick={() => void handleConnect(entry.environment.environmentId)}
                  >
                    {added ? gt("Added") : gt("Connect")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={busyId === entry.environment.environmentId}
                    onClick={() =>
                      void handleUnlink(entry.environment.environmentId, entry.environment.label)
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                    <T>Unlink</T>
                  </Button>
                </div>
              }
            />
          );
        })
      )}
    </SettingsSection>
  );
}

function RelayEnrollmentSection() {
  const gt = useGT();
  const resolve = useMessages();
  const session = useSelfHostedRelaySession();
  const createTokenCmd = useAtomCommand(selfHostedRelay.createEnrollmentToken, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "enrollment command",
      unavailableMessage: msg("Clipboard API is unavailable while copying enrollment command."),
      failureMessage: msg("Failed to copy enrollment command to the clipboard."),
    },
  });

  const [labelHint, setLabelHint] = useState("");
  const [issued, setIssued] = useState<RelayCreateEnrollmentTokenResponse | null>(null);
  const [busy, setBusy] = useState(false);

  if (session.status !== "signed_in") {
    return null;
  }

  const handleGenerate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const trimmedLabel = labelHint.trim();
    const res = await createTokenCmd(
      trimmedLabel.length > 0 ? { labelHint: TrimmedNonEmptyString.make(trimmedLabel) } : {},
    );
    setBusy(false);
    if (res._tag === "Success") {
      setIssued(res.value);
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not generate enrollment token"),
        description: formatAtomFailure(res, gt("Enrollment token request failed."), resolve),
      });
    }
  };

  const command = issued ? buildEnrollmentCommand(session.relayUrl, issued.enrollmentToken) : null;

  return (
    <SettingsSection id="relay-enrollment" title={gt("Headless host enrollment")}>
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">
          <T>
            Generate a single-use enrollment token to link a headless Linux host directly from the
            terminal.
          </T>
        </p>
        <form
          onSubmit={(event) => void handleGenerate(event)}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="relay-enroll-label">
              <T>Host label hint (optional)</T>
            </Label>
            <Input
              id="relay-enroll-label"
              size="sm"
              value={labelHint}
              placeholder={gt("Build Server")}
              disabled={busy}
              onChange={(event) => setLabelHint(event.target.value)}
            />
          </div>
          <Button size="sm" type="submit" disabled={busy}>
            <T>Generate enrollment token</T>
          </Button>
        </form>
        {command ? (
          <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                <T>
                  Expires <Var>{new Date(issued!.expiresAt).toLocaleString()}</Var>
                </T>
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => copyToClipboard(command, undefined)}
              >
                {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                {isCopied ? gt("Copied") : gt("Copy command")}
              </Button>
            </div>
            <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all">
              {command}
            </pre>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
