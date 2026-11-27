import * as Application from "expo-application";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { msg } from "gt-react-native";
import {
  isNewerStableVersion,
  parseReleaseManifestJson,
  resolveEffectiveReleaseBaseUrl,
  resolveReleaseAssetUrl,
  resolveReleaseManifestUrls,
  type ReleaseManifestAsset,
} from "@t3tools/shared/releaseManifest";

import { m } from "../../i18n/messages";

export type AndroidReleaseUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface AndroidApkDownloadProgressEvent {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
}

export interface AndroidNativeUpdaterModule {
  readonly canRequestPackageInstalls: () => boolean;
  readonly openInstallUnknownAppsSettings: () => Promise<void>;
  readonly downloadAndVerifyApk: (
    url: string,
    fileName: string,
    expectedSha256: string,
  ) => Promise<string>;
  readonly installApk: (filePath: string) => Promise<void>;
  readonly addListener?: (
    eventName: "onApkDownloadProgress",
    listener: (payload: AndroidApkDownloadProgressEvent) => void,
  ) => { remove(): void };
}

export interface AndroidReleaseUpdateState {
  readonly supported: boolean;
  readonly status: AndroidReleaseUpdateStatus;
  readonly currentVersion: string;
  readonly currentVersionCode: number | null;
  readonly availableVersion: string | null;
  readonly releaseNotes: string | null;
  readonly asset: ReleaseManifestAsset | null;
  readonly downloadUrl: string | null;
  readonly downloadedFilePath: string | null;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly checkedAt: number | null;
  readonly errorMessage: string | null;
}

export type AndroidInstallOutcome =
  | { readonly outcome: "started" }
  | { readonly outcome: "permission-required" }
  | { readonly outcome: "failed"; readonly errorMessage: string };

export interface AndroidReleaseUpdaterDeps {
  readonly platform?: string;
  readonly currentVersion?: string;
  readonly currentVersionCode?: number | null;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly nativeModule?: AndroidNativeUpdaterModule | null;
}

const MANIFEST_TIMEOUT_MS = 15_000;

function readNativeVersionCode(): number | null {
  const raw = Application.nativeBuildVersion?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function defaultNativeModule(): AndroidNativeUpdaterModule | null {
  if (Platform.OS !== "android") return null;
  const mod = requireOptionalNativeModule<AndroidNativeUpdaterModule>("T3NativeControls");
  if (!mod || typeof mod.downloadAndVerifyApk !== "function") return null;
  return mod;
}

function toFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

async function fetchManifestWithTimeout(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

export function createAndroidReleaseUpdater(deps: AndroidReleaseUpdaterDeps = {}) {
  const platform = deps.platform ?? Platform.OS;
  const currentVersion = deps.currentVersion ?? Constants.expoConfig?.version ?? "0.0.0";
  const currentVersionCode =
    deps.currentVersionCode !== undefined ? deps.currentVersionCode : readNativeVersionCode();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const getNative = () =>
    deps.nativeModule !== undefined ? deps.nativeModule : defaultNativeModule();
  const supported = platform === "android";

  let state: AndroidReleaseUpdateState = {
    supported,
    status: "idle",
    currentVersion,
    currentVersionCode,
    availableVersion: null,
    releaseNotes: null,
    asset: null,
    downloadUrl: null,
    downloadedFilePath: null,
    downloadedBytes: 0,
    totalBytes: null,
    checkedAt: null,
    errorMessage: null,
  };
  let checkInFlight: Promise<AndroidReleaseUpdateState> | null = null;
  let downloadInFlight: Promise<AndroidReleaseUpdateState> | null = null;
  const listeners = new Set<() => void>();

  const setState = (patch: Partial<AndroidReleaseUpdateState>): AndroidReleaseUpdateState => {
    state = { ...state, ...patch };
    for (const listener of Array.from(listeners)) listener();
    return state;
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const checkForUpdate = async (options?: {
    readonly userMirrorUrl?: string | null;
    readonly force?: boolean;
  }): Promise<AndroidReleaseUpdateState> => {
    if (!supported) return state;
    if (checkInFlight) return checkInFlight;
    if (state.status === "downloading" || state.status === "installing") return state;

    const run = async (): Promise<AndroidReleaseUpdateState> => {
      const resolvedBase = resolveEffectiveReleaseBaseUrl({
        userMirrorUrl: options?.userMirrorUrl ?? null,
      });
      if (!resolvedBase.ok) {
        return setState({
          status: "error",
          errorMessage:
            resolvedBase.reason === "disabled"
              ? m(msg("Updates are disabled by update mirror configuration."))
              : m(msg("Update mirror URL is invalid.")),
        });
      }

      setState({ status: "checking", errorMessage: null });
      const manifestUrls = resolveReleaseManifestUrls(resolvedBase.url);
      let matchedUrl: string | undefined;
      let parsedManifest: ReturnType<typeof parseReleaseManifestJson> | null = null;
      let lastError: unknown;

      for (const candidateUrl of manifestUrls) {
        try {
          const response = await fetchManifestWithTimeout(candidateUrl, fetchImpl);
          if (!response.ok) {
            lastError = new Error(
              m(
                msg("Could not check releases ({status}). Try again.", { status: response.status }),
              ),
            );
            continue;
          }
          const parsed = parseReleaseManifestJson(await response.text());
          if (!parsed.ok) {
            lastError = new Error(m(msg("Release manifest is invalid.")));
            continue;
          }
          matchedUrl = candidateUrl;
          parsedManifest = parsed;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!parsedManifest || !parsedManifest.ok) {
        return setState({
          status: "error",
          checkedAt: now(),
          errorMessage: toFailureMessage(lastError, m(msg("Could not check for updates."))),
        });
      }

      const manifest = parsedManifest.manifest;
      const asset = manifest.android["arm64-v8a"];
      const newerSemver = isNewerStableVersion(manifest.version, currentVersion);
      const newerCode =
        currentVersionCode === null || manifest.androidVersionCode > currentVersionCode;

      if (!asset || !newerSemver || !newerCode) {
        return setState({
          status: "up-to-date",
          availableVersion: null,
          releaseNotes: null,
          asset: null,
          downloadUrl: null,
          downloadedFilePath: null,
          downloadedBytes: 0,
          totalBytes: null,
          checkedAt: now(),
          errorMessage: null,
        });
      }

      const nextDownloadUrl = resolveReleaseAssetUrl(
        resolvedBase.url,
        manifest.tag,
        asset.fileName,
        matchedUrl,
      );
      const keepDownloadedPath =
        state.downloadedFilePath !== null &&
        state.availableVersion === manifest.version &&
        state.asset?.sha256 === asset.sha256 &&
        state.downloadUrl === nextDownloadUrl
          ? state.downloadedFilePath
          : null;

      return setState({
        status: keepDownloadedPath ? "downloaded" : "available",
        availableVersion: manifest.version,
        releaseNotes: manifest.notes ?? null,
        asset,
        downloadUrl: nextDownloadUrl,
        downloadedFilePath: keepDownloadedPath,
        downloadedBytes: keepDownloadedPath ? asset.size : 0,
        totalBytes: asset.size,
        checkedAt: now(),
        errorMessage: null,
      });
    };

    checkInFlight = run().finally(() => {
      checkInFlight = null;
    });
    return checkInFlight;
  };

  const downloadUpdate = async (): Promise<AndroidReleaseUpdateState> => {
    if (!supported) return state;
    if (downloadInFlight) return downloadInFlight;
    const asset = state.asset;
    const downloadUrl = state.downloadUrl;
    if (!asset || !downloadUrl) return state;

    const native = getNative();
    if (!native) {
      return setState({
        status: "error",
        errorMessage: m(msg("Android installer module is unavailable in this build.")),
      });
    }

    const run = async (): Promise<AndroidReleaseUpdateState> => {
      setState({
        status: "downloading",
        downloadedBytes: 0,
        totalBytes: asset.size,
        errorMessage: null,
      });
      const subscription = native.addListener?.("onApkDownloadProgress", (payload) => {
        if (state.status !== "downloading") return;
        setState({
          downloadedBytes: payload.downloadedBytes,
          totalBytes: payload.totalBytes ?? asset.size,
        });
      });
      try {
        const filePath = await native.downloadAndVerifyApk(
          downloadUrl,
          asset.fileName,
          asset.sha256,
        );
        return setState({
          status: "downloaded",
          downloadedFilePath: filePath,
          downloadedBytes: asset.size,
          totalBytes: asset.size,
          errorMessage: null,
        });
      } catch (error) {
        return setState({
          status: state.availableVersion ? "available" : "error",
          downloadedBytes: 0,
          errorMessage: toFailureMessage(error, m(msg("Could not download the update APK."))),
        });
      } finally {
        subscription?.remove();
      }
    };

    downloadInFlight = run().finally(() => {
      downloadInFlight = null;
    });
    return downloadInFlight;
  };

  const installDownloadedUpdate = async (): Promise<AndroidInstallOutcome> => {
    if (!supported || !state.downloadedFilePath) {
      return { outcome: "failed", errorMessage: m(msg("No downloaded APK is ready to install.")) };
    }
    const native = getNative();
    if (!native) {
      const errorMessage = m(msg("Android installer module is unavailable in this build."));
      setState({ status: "error", errorMessage });
      return { outcome: "failed", errorMessage };
    }
    if (!native.canRequestPackageInstalls()) {
      return { outcome: "permission-required" };
    }
    setState({ status: "installing", errorMessage: null });
    try {
      await native.installApk(state.downloadedFilePath);
      setState({ status: "downloaded", errorMessage: null });
      return { outcome: "started" };
    } catch (error) {
      const errorMessage = toFailureMessage(error, m(msg("Could not launch the APK installer.")));
      setState({ status: "downloaded", errorMessage });
      return { outcome: "failed", errorMessage };
    }
  };

  const openInstallUnknownAppsSettings = async (): Promise<void> => {
    const native = getNative();
    if (!native) return;
    await native.openInstallUnknownAppsSettings();
  };

  const invalidateCache = () => {
    if (state.status === "downloading" || state.status === "installing") return;
    setState({
      status: "idle",
      availableVersion: null,
      releaseNotes: null,
      asset: null,
      downloadUrl: null,
      downloadedFilePath: null,
      downloadedBytes: 0,
      totalBytes: null,
      checkedAt: null,
      errorMessage: null,
    });
  };

  return {
    getState: () => state,
    subscribe,
    checkForUpdate,
    downloadUpdate,
    installDownloadedUpdate,
    openInstallUnknownAppsSettings,
    invalidateCache,
  };
}

export const defaultAndroidReleaseUpdater = createAndroidReleaseUpdater();

export function useAndroidReleaseUpdateState(): AndroidReleaseUpdateState {
  return useSyncExternalStore(
    defaultAndroidReleaseUpdater.subscribe,
    defaultAndroidReleaseUpdater.getState,
    defaultAndroidReleaseUpdater.getState,
  );
}
