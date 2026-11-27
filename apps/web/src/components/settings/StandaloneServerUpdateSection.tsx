import { useAtomValue } from "@effect/atom-react";
import { managedUpdatesDenial } from "@t3tools/client-runtime/contract-labels";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, sessionGrantsScope } from "@t3tools/contracts";
import { CLI_RELEASES_PAGE_URL } from "@t3tools/shared/cliRelease";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerConfigAtom, serverEnvironment } from "~/state/server";
import { environmentSession } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { ServerUpdateAction } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AboutVersionTitle } from "./AboutVersionTitle";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { UpdateMirrorSettingsRow } from "./UpdateMirrorSettingsRow";

export function StandaloneServerUpdateSection() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const messages = useMessages();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = usePrimaryEnvironment();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const primaryPolicy = usePrimaryManagedPolicy();
  const checkForUpdate = useAtomCommand(serverEnvironment.checkForServerUpdate, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [isChecking, setIsChecking] = useState(false);

  const sessionState = useAtomValue(
    environmentSession.sessionStateAtom(primaryEnvironmentId ?? ("unconnected" as never)),
  );
  const canWriteSettings =
    primaryEnvironmentId !== null &&
    sessionState._tag === "Success" &&
    sessionState.value.authenticated &&
    sessionGrantsScope(sessionState.value, AuthSettingsWriteScope);

  const updatesDenial = managedUpdatesDenial(primaryPolicy, messages);
  const updateState = serverConfig?.updateState;
  const checkSupported = serverConfig?.environment.capabilities.releaseUpdateCheck === true;
  const latestVersion = updateState?.latestVersion ?? null;
  const isAvailable = updateState?.status === "available" && latestVersion !== null;
  const releaseUrl = updateState?.releaseUrl ?? CLI_RELEASES_PAGE_URL;
  const savedMirrorUrl = serverConfig?.settings.updateMirrorUrl ?? null;

  const handleCheck = async () => {
    if (primaryEnvironmentId === null || isChecking) return;
    setIsChecking(true);
    try {
      const result = await checkForUpdate({
        environmentId: primaryEnvironmentId,
        input: { force: true },
      });
      setIsChecking(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const message = thrownErrorMessage(squashAtomCommandFailure(result), messages);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not check for updates"),
            description: message ?? gt("Release check failed."),
          }),
        );
      }
    } catch (error) {
      setIsChecking(false);
      throw error;
    }
  };

  const handleSaveMirror = async (nextMirrorUrl: string | null) => {
    if (primaryEnvironmentId === null) return;
    const result = await updateSettings({
      environmentId: primaryEnvironmentId,
      input: { patch: { updateMirrorUrl: nextMirrorUrl } },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const message = thrownErrorMessage(squashAtomCommandFailure(result), messages);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not save update mirror"),
          description: message ?? gt("Update mirror settings failed."),
        }),
      );
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: nextMirrorUrl ? gt("Update mirror saved") : gt("Update mirror reset"),
      }),
    );
  };

  const versionDescription = (() => {
    if (updatesDenial !== undefined) return updatesDenial;
    if (updateState?.status === "error" && updateState.errorMessage) {
      return updateState.errorMessage;
    }
    if (isAvailable) {
      return gt("AgentVela {version} is available.", { version: latestVersion });
    }
    if (updateState?.status === "up-to-date") {
      return gt("Up to date with the latest release.");
    }
    return gt("Current version of the application.");
  })();

  const control =
    primaryEnvironmentId !== null && checkSupported ? (
      <div className="flex flex-wrap items-center gap-2">
        {isAvailable ? (
          <>
            <ServerUpdateAction
              environmentId={primaryEnvironmentId}
              serverLabel={primaryEnvironment?.label ?? gt("Server")}
              selfUpdate={serverConfig.environment.capabilities.serverSelfUpdate ?? null}
              installation={serverConfig.environment.capabilities.serverInstallation}
              desktopAppUpdate={serverConfig.environment.capabilities.desktopAppUpdate ?? false}
              targetVersion={latestVersion}
              size="sm"
              label={gt("Update to {version}", { version: latestVersion })}
            />
            <Button
              size="sm"
              variant="ghost"
              render={<a href={releaseUrl} target="_blank" rel="noreferrer noopener" />}
            >
              <T>Release page</T>
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={
              isChecking || updateState?.status === "checking" || updatesDenial !== undefined
            }
            onClick={() => void handleCheck()}
          >
            {isChecking || updateState?.status === "checking" ? (
              <T>Checking…</T>
            ) : (
              <T>Check for Updates</T>
            )}
          </Button>
        )}
      </div>
    ) : null;

  return (
    <>
      <SettingsRow
        id={setting("app-version").id}
        title={<AboutVersionTitle />}
        description={versionDescription}
        managed={updatesDenial}
        control={control}
      >
        {isAvailable && updateState.releaseNotes ? (
          <p className="whitespace-pre-line text-xs text-muted-foreground">
            {updateState.releaseNotes}
          </p>
        ) : null}
      </SettingsRow>
      {primaryEnvironmentId !== null && checkSupported ? (
        <UpdateMirrorSettingsRow
          id={setting("update-mirror").id}
          savedMirrorUrl={savedMirrorUrl}
          managedReason={updatesDenial}
          disabled={!canWriteSettings}
          settingKeys={["updateMirrorUrl"]}
          onSave={handleSaveMirror}
        />
      ) : null}
    </>
  );
}
