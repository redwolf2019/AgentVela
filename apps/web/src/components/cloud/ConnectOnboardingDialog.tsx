import { useAtomValue } from "@effect/atom-react";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import {
  AuthAccessWriteScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type AuthSessionState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import {
  CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
  ConnectOnboardingOptOutSchema,
  EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
} from "~/cloud/connectOnboarding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useUpdatePrimarySettings } from "~/hooks/useSettings";
import { isHostedStaticApp } from "~/hostedPairing";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { useSelfHostedRelaySession } from "~/state/relay";
import {
  environmentSession,
  readEnvironmentCanConfigureRelay,
  readEnvironmentScope,
  useEnvironmentCanConfigureRelay,
  useEnvironmentScope,
} from "~/state/session";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog } from "../ui/dialog";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { WizardSteps, WizardPopup, WizardHeader, WizardPanel, WizardFooter } from "../ui/wizard";

export function ConnectOnboardingDialog() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredConnectOnboardingDialog />;
}

type OnboardingStep = "publish" | "devices";

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

function canPublishOnEnvironment(id: EnvironmentId | null): boolean {
  return (
    id !== null &&
    readEnvironmentScope(id, AuthRelayReadScope) &&
    readEnvironmentScope(id, AuthRelayWriteScope) &&
    readEnvironmentCanConfigureRelay(id)
  );
}

function ConfiguredConnectOnboardingDialog() {
  const navigate = useNavigate();
  const relaySession = useSelfHostedRelaySession();
  const isSignedIn = relaySession.status === "signed_in";
  const userId = relaySession.status === "signed_in" ? relaySession.user.userId : null;
  const gt = useGT();
  const m = useMessages();
  const [optOutState, setOptOutState] = useLocalStorage(
    CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
    ConnectOnboardingOptOutSchema,
  );

  const { environments, isReady: environmentsReady } = useEnvironments();
  const homeScreenAddsComputers =
    isHostedStaticApp() && environmentsReady && environments.length === 0;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primarySessionState = useAtomValue(
    primaryEnvironmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(primaryEnvironmentId),
  );
  const canConfigureRelay = useEnvironmentCanConfigureRelay(primaryEnvironmentId);
  const connectAllowed =
    managedCapabilityDenial(usePrimaryManagedPolicy(), "connect") === undefined;
  const canReadRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope);
  const canManageRelay = canReadRelay && canWriteRelay && canConfigureRelay && connectAllowed;
  const canRequireDeviceApproval = useEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope);
  const deviceApprovalRequired =
    usePrimaryEnvironment()?.serverConfig?.settings.requireConnectDeviceApproval === true;
  const updatePrimarySettings = useUpdatePrimarySettings();
  const sessionScopesKnown =
    primaryEnvironmentId === null ? environmentsReady : primarySessionState._tag !== "Initial";

  const controller = useCloudLinkController(primaryEnvironmentId);
  const showPublishStep = canManageRelay && controller.linkState.target !== null;
  const steps: ReadonlyArray<OnboardingStep> = showPublishStep
    ? ["publish", "devices"]
    : ["devices"];

  const [requestedAccount, setRequestedAccount] = useState<string | null>(null);
  const [openForAccount, setOpenForAccount] = useState<string | null>(null);
  const [step, setStep] = useState<OnboardingStep>("devices");
  const [exposeEnvironment, setExposeEnvironment] = useState(true);
  const [requireDeviceApproval, setRequireDeviceApproval] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [prefilledFromLinkState, setPrefilledFromLinkState] = useState(false);
  const [observedAccount, setObservedAccount] = useState<string | null | undefined>(undefined);

  if (step === "publish" && sessionScopesKnown && !showPublishStep && !isApplying) {
    setStep("devices");
  }

  const optOutAccounts = optOutState.optOutAccounts;
  const nextAccount = isSignedIn && userId ? userId : null;
  if (nextAccount !== observedAccount) {
    setObservedAccount(nextAccount);
    if (observedAccount !== undefined && nextAccount !== null) {
      setRequestedAccount(nextAccount);
    }
  }

  if (openForAccount !== null && (!isSignedIn || userId !== openForAccount)) {
    setOpenForAccount(null);
  }
  if (requestedAccount !== null && (!isSignedIn || userId !== requestedAccount)) {
    setRequestedAccount(null);
  }

  const publishStepDecided = !canManageRelay || controller.linkState.target !== null;

  if (requestedAccount !== null && openForAccount === null) {
    if (homeScreenAddsComputers || optOutAccounts.includes(requestedAccount)) {
      setRequestedAccount(null);
    } else if (sessionScopesKnown && publishStepDecided) {
      setRequestedAccount(null);
      setPrefilledFromLinkState(false);
      setExposeEnvironment(true);
      setRequireDeviceApproval(false);
      setDontShowAgain(false);
      setStep(canManageRelay && controller.linkState.target !== null ? "publish" : "devices");
      setOpenForAccount(requestedAccount);
    }
  }

  const linkStateData = controller.linkState.data;
  if (openForAccount !== null && !prefilledFromLinkState && linkStateData !== null) {
    setPrefilledFromLinkState(true);
    if (
      linkStateData.linked &&
      linkStateData.linkRevoked !== true &&
      linkStateData.cloudUserId === openForAccount
    ) {
      setExposeEnvironment(linkStateData.managedTunnelActive ?? linkStateData.linked);
    }
  }

  const complete = () => {
    if (isApplying) return;
    const account = openForAccount;
    setOpenForAccount(null);
    if (account !== null && dontShowAgain) {
      setOptOutState((state) =>
        state.optOutAccounts.includes(account)
          ? state
          : { optOutAccounts: [...state.optOutAccounts, account] },
      );
    }
  };

  const applyPublishSelection = async () => {
    if (isApplying) return;
    if (requireDeviceApproval && !deviceApprovalRequired) {
      setIsApplying(true);
      const saved = await new Promise<boolean>((resolve) =>
        updatePrimarySettings(
          { requireConnectDeviceApproval: true },
          { onSaved: () => resolve(true), onFailed: () => resolve(false) },
        ),
      );
      setIsApplying(false);
      if (!saved) return;
    }
    if (!canPublishOnEnvironment(primaryEnvironmentId)) {
      setStep("devices");
      return;
    }
    if (linkStateData === null || controller.linkState.error !== null) return;
    if (!exposeEnvironment) {
      setStep("devices");
      return;
    }
    setIsApplying(true);
    const ok = await controller.reconcileCloudState({
      managedTunnel: true,
      publish: false,
    });
    setIsApplying(false);
    if (!ok) return;
    toastManager.add({
      type: "success",
      title: gt("Relay linked"),
      description: gt("This environment is available through your self-hosted Relay server."),
    });
    setStep("devices");
  };

  return (
    <Dialog
      open={openForAccount !== null}
      onOpenChange={(open) => {
        if (!open && !isApplying) complete();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title={gt("Set up Relay")}
          description={
            <T>
              Connect this environment to your self-hosted Relay and access all your linked hosts in
              one place.
            </T>
          }
        >
          {steps.length > 1 ? (
            <WizardSteps
              steps={steps.map((id) => m(STEP_LABELS[id]))}
              currentStep={steps.indexOf(step)}
              isStepDisabled={() => isApplying}
              onStepChange={(index) => {
                const next = steps[index];
                if (next === "publish" && !canPublishOnEnvironment(primaryEnvironmentId)) return;
                if (next) setStep(next);
              }}
            />
          ) : null}
        </WizardHeader>
        <WizardPanel>
          {step === "publish" ? (
            <PublishStep
              exposeEnvironment={exposeEnvironment}
              requireDeviceApproval={
                canRequireDeviceApproval ? requireDeviceApproval || deviceApprovalRequired : null
              }
              requireDeviceApprovalLocked={deviceApprovalRequired}
              onRequireDeviceApprovalChange={setRequireDeviceApproval}
              disabled={isApplying || !canManageRelay || linkStateData === null}
              operationError={controller.operationError ?? controller.linkState.error}
              onOpenRelaySettings={() => {
                complete();
                void navigate({ to: "/settings/relay" });
              }}
              onExposeEnvironmentChange={(enabled) => {
                if (canPublishOnEnvironment(primaryEnvironmentId)) setExposeEnvironment(enabled);
              }}
            />
          ) : (
            <DevicesStep />
          )}
        </WizardPanel>
        <WizardFooter
          leading={
            <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-muted-foreground sm:self-center">
              <Checkbox
                checked={dontShowAgain}
                onCheckedChange={(checked) => setDontShowAgain(checked === true)}
              />
              <T>Don&apos;t show this again</T>
            </label>
          }
        >
          {step === "publish" ? (
            <>
              <Button variant="ghost" disabled={isApplying} onClick={() => setStep("devices")}>
                <T>Not now</T>
              </Button>
              <Button
                disabled={isApplying || !canManageRelay || linkStateData === null}
                onClick={() => void applyPublishSelection()}
              >
                {isApplying ? gt("Linking…") : gt("Continue")}
              </Button>
            </>
          ) : (
            <Button disabled={isApplying} onClick={complete}>
              <T>Done</T>
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

const STEP_LABELS: Record<OnboardingStep, string> = {
  publish: msg("Publish"),
  devices: msg("Connect devices"),
};

function PublishStep({
  exposeEnvironment,
  requireDeviceApproval,
  requireDeviceApprovalLocked,
  onRequireDeviceApprovalChange,
  disabled,
  operationError,
  onOpenRelaySettings,
  onExposeEnvironmentChange,
}: {
  readonly exposeEnvironment: boolean;
  readonly requireDeviceApproval: boolean | null;
  readonly requireDeviceApprovalLocked: boolean;
  readonly onRequireDeviceApprovalChange: (enabled: boolean) => void;
  readonly disabled: boolean;
  readonly operationError: string | null;
  readonly onOpenRelaySettings: () => void;
  readonly onExposeEnvironmentChange: (enabled: boolean) => void;
}) {
  const gt = useGT();
  return (
    <div className="space-y-3">
      <div className="rounded-lg border">
        <OnboardingToggleRow
          title={gt("Publish this environment")}
          description={gt(
            "Make this environment available to your other devices through your self-hosted Relay.",
          )}
          checked={exposeEnvironment}
          disabled={disabled}
          onCheckedChange={onExposeEnvironmentChange}
        />
        {requireDeviceApproval !== null ? (
          <OnboardingToggleRow
            title={gt("Require approval for new devices")}
            description={gt(
              "Devices that sign in to your Relay account wait until someone already connected here approves them.",
            )}
            checked={requireDeviceApproval}
            disabled={disabled || requireDeviceApprovalLocked}
            onCheckedChange={onRequireDeviceApprovalChange}
          />
        ) : null}
      </div>
      {operationError ? <p className="text-xs text-destructive">{operationError}</p> : null}
      <Button size="xs" variant="ghost" onClick={onOpenRelaySettings}>
        <T>Open Relay settings</T>
      </Button>
    </div>
  );
}

function OnboardingToggleRow({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/60 px-4 py-3 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function DevicesStep() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
        savedEnvironments={savedEnvironments}
        showSavedEnvironments
        empty={
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            <T>
              No other environments are linked to your Relay account yet. Link one from another
              machine and it will show up here.
            </T>
          </p>
        }
      />
    </div>
  );
}
