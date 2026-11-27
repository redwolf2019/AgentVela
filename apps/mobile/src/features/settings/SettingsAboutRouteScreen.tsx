import { useAtomValue } from "@effect/atom-react";
import { CLI_RELEASES_PAGE_URL } from "@t3tools/shared/cliRelease";
import { resolveMirrorUrlOverride } from "@t3tools/shared/url";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { AsyncResult } from "effect/reactivity";
import { T, useGT } from "gt-react-native";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  defaultAndroidReleaseUpdater,
  useAndroidReleaseUpdateState,
  type AndroidReleaseUpdateState,
} from "../updates/android-release-updater";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsAboutRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title={gt("About")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppSettingsSection />
        {Platform.OS === "android" ? <AndroidUpdatesSection /> : null}
      </ScrollView>
    </SettingsScreen>
  );
}

function AppSettingsSection() {
  const gt = useGT();
  const version = Constants.expoConfig?.version ?? "0.0.0";
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const build = Application.nativeBuildVersion;
  const versionWithBuild = build ? `${version} (${build})` : version;
  const versionLabel = variantLabel ? `${versionWithBuild} · ${variantLabel}` : versionWithBuild;

  return (
    <SettingsSection title={gt("App", { $context: "settings section about this mobile app" })}>
      <SettingsRow
        icon="internaldrive"
        label={gt("Client Storage")}
        target="SettingsClientStorage"
      />
      <SettingsRow icon="stethoscope" label={gt("Diagnostics")} target="SettingsDiagnostics" />
      <SettingsRow
        icon="doc.on.doc"
        label={gt("Open source licenses")}
        target="SettingsOpenSourceLicenses"
      />
      <SettingsRow icon="doc.text" label={gt("Legal")} fullScreenTarget="SettingsLegal" />
      <View className="flex-row items-center gap-4 p-4">
        <SymbolView
          name="info.circle"
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <Text className="flex-1 text-lg text-foreground">
          <T>Version</T>
        </Text>
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
      </View>
    </SettingsSection>
  );
}

function formatAndroidStatusText(
  updateState: AndroidReleaseUpdateState,
  gt: ReturnType<typeof useGT>,
): string {
  switch (updateState.status) {
    case "checking":
      return gt("Checking for updates…");
    case "downloading": {
      const total = updateState.totalBytes ?? 0;
      const percent =
        total > 0 ? Math.min(100, Math.round((updateState.downloadedBytes / total) * 100)) : null;
      return percent !== null
        ? gt("Downloading APK ({percent}%)…", { percent })
        : gt("Downloading APK…");
    }
    case "downloaded":
      return updateState.availableVersion
        ? gt("AgentVela {version} is ready to install.", { version: updateState.availableVersion })
        : gt("Update is ready to install.");
    case "installing":
      return gt("Opening Android installer…");
    case "available":
      return updateState.availableVersion
        ? gt("AgentVela {version} is available.", { version: updateState.availableVersion })
        : gt("Update available.");
    case "up-to-date":
      return gt("You are up to date.");
    case "error":
      return updateState.errorMessage ?? gt("Could not check for updates.");
    case "idle":
      return gt("Check for Android APK updates from releases.");
  }
}

function AndroidUpdatesSection() {
  const gt = useGT();
  const updateState = useAndroidReleaseUpdateState();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const savedMirrorUrl = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.updateMirrorUrl ?? null)
    : null;
  const busy =
    updateState.status === "checking" ||
    updateState.status === "downloading" ||
    updateState.status === "installing";

  async function handleAction() {
    if (busy) return;
    if (updateState.status === "downloaded") {
      const result = await defaultAndroidReleaseUpdater.installDownloadedUpdate();
      if (result.outcome === "permission-required") {
        Dialog.alert(
          gt("Allow installing updates"),
          gt("Android needs permission for AgentVela to install downloaded update APKs."),
          [
            { text: gt("Cancel"), style: "cancel" },
            {
              text: gt("Open Settings"),
              onPress: () => void defaultAndroidReleaseUpdater.openInstallUnknownAppsSettings(),
            },
          ],
        );
      }
      return;
    }
    if (updateState.status === "available") {
      await defaultAndroidReleaseUpdater.downloadUpdate();
      return;
    }
    await defaultAndroidReleaseUpdater.checkForUpdate({
      userMirrorUrl: savedMirrorUrl,
      force: true,
    });
  }

  function handleEditMirror() {
    Dialog.prompt({
      title: gt("Update mirror URL"),
      message: gt("Leave empty to use the default GitHub Releases feed."),
      placeholder: CLI_RELEASES_PAGE_URL,
      initialValue: savedMirrorUrl ?? "",
      cancelText: gt("Cancel"),
      confirmText: gt("Save"),
      onConfirm: (rawValue) => {
        const trimmed = rawValue.trim();
        if (trimmed.length === 0) {
          defaultAndroidReleaseUpdater.invalidateCache();
          void savePreferences({ updateMirrorUrl: null });
          return;
        }
        const resolved = resolveMirrorUrlOverride(trimmed);
        if (resolved._tag !== "url") {
          Dialog.alert(
            gt("Invalid update mirror"),
            gt("Mirror URL must be a valid https:// URL (or http://localhost)."),
          );
          return;
        }
        defaultAndroidReleaseUpdater.invalidateCache();
        void savePreferences({ updateMirrorUrl: resolved.url });
      },
    });
  }

  const actionLabel =
    updateState.status === "downloaded"
      ? gt("Install update")
      : updateState.status === "available"
        ? gt("Download APK")
        : gt("Check for updates");

  const statusText = formatAndroidStatusText(updateState, gt);

  return (
    <SettingsSection title={gt("Updates")}>
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{statusText}</Text>
        {updateState.releaseNotes ? (
          <Text className="text-sm text-foreground-muted">{updateState.releaseNotes}</Text>
        ) : null}
        {updateState.errorMessage && updateState.status !== "error" ? (
          <Text selectable className="text-sm text-danger-foreground">
            {updateState.errorMessage}
          </Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon="arrow.clockwise"
        label={actionLabel}
        disabled={busy}
        loading={busy}
        onPress={() => void handleAction()}
      />
      <SettingsRow
        icon="link"
        label={gt("Update mirror")}
        value={savedMirrorUrl ?? gt("Default (GitHub Releases)")}
        onPress={handleEditMirror}
      />
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
