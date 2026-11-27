import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@t3tools/contracts";
import type { ReleaseManifest } from "@t3tools/shared/releaseManifest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopReleaseClient from "./DesktopReleaseClient.ts";
import * as DesktopReleaseInstaller from "./DesktopReleaseInstaller.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

export const flushCallbacks = Effect.yieldNow;

const TEST_SHA256 = "a".repeat(64);

export function makeSampleManifest(
  version = "1.2.4",
  notes = "## What's Changed\n- Test change",
): ReleaseManifest {
  return {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    publishedAt: "2026-11-27T00:00:00.000Z",
    notes,
    androidVersionCode: 1002004,
    desktop: {
      "darwin-arm64-dmg": {
        fileName: `AgentVela-${version}-arm64.dmg`,
        sha256: TEST_SHA256,
        size: 1024,
      },
      "linux-x64-appimage": {
        fileName: `AgentVela-${version}-x86_64.AppImage`,
        sha256: TEST_SHA256,
        size: 1024,
      },
      "linux-x64-deb": {
        fileName: `AgentVela-${version}-amd64.deb`,
        sha256: TEST_SHA256,
        size: 1024,
      },
      "linux-arm64-appimage": {
        fileName: `AgentVela-${version}-arm64.AppImage`,
        sha256: TEST_SHA256,
        size: 1024,
      },
      "linux-arm64-deb": {
        fileName: `AgentVela-${version}-arm64.deb`,
        sha256: TEST_SHA256,
        size: 1024,
      },
      "win32-x64-nsis": {
        fileName: `AgentVela-${version}-setup.exe`,
        sha256: TEST_SHA256,
        size: 1024,
      },
    },
    cli: {},
    android: {},
  };
}

export interface UpdatesHarnessOptions {
  readonly fetchManifest?: (
    baseUrl: string,
  ) => Effect.Effect<
    DesktopReleaseClient.FetchedDesktopReleaseManifest,
    DesktopReleaseClient.DesktopReleaseClientError
  >;
  readonly downloadAsset?: (
    input: DesktopReleaseClient.DownloadDesktopAssetInput,
  ) => Effect.Effect<string, DesktopReleaseClient.DesktopReleaseClientError>;
  readonly verifyFileSha256?: (
    filePath: string,
    expectedSha256: string,
    expectedSize: number,
  ) => Effect.Effect<boolean>;
  readonly installAndRelaunch?: (
    input: DesktopReleaseInstaller.InstallDesktopReleaseInput,
  ) => Effect.Effect<
    DesktopReleaseInstaller.InstallDesktopReleaseResult,
    DesktopReleaseInstaller.DesktopReleaseInstallError
  >;
  readonly beforeSetMirrorUrl?: Effect.Effect<void>;
  readonly setMirrorUrlError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly stopBackend?: Effect.Effect<void>;
  readonly startBackend?: Effect.Effect<void>;
  readonly backendDesiredRunning?: boolean;
  readonly backendInstances?: ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly processArch?: string;
  readonly isPackaged?: boolean;
  readonly devServerUrl?: string;
  readonly packageType?: string | undefined;
  readonly installRecord?: string | undefined;
  readonly policy?: DesktopUpdatePolicy.UpdatePolicy;
  readonly appVersion?: string;
  readonly savedMirrorUrl?: string | null;
}

export function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let downloadCount = 0;
  let installCount = 0;
  const fetchedBaseUrls: string[] = [];
  const downloadedUrls: string[] = [];
  const sentStates: DesktopUpdateState[] = [];
  const installSteps: string[] = [];
  const deletedFiles = new Set<string>();

  const releaseClientLayer = DesktopReleaseClient.layerTest({
    fetchLatestManifest: (baseUrl) => {
      checkCount += 1;
      fetchedBaseUrls.push(baseUrl);
      if (options.fetchManifest) {
        return options.fetchManifest(baseUrl);
      }
      return Effect.succeed({
        manifest: makeSampleManifest(),
        matchedManifestUrl: `${baseUrl}/latest/download/release-manifest.json`,
      });
    },
    downloadAsset: (input) => {
      downloadCount += 1;
      downloadedUrls.push(input.url);
      if (options.downloadAsset) {
        return options.downloadAsset(input);
      }
      return Effect.gen(function* () {
        if (input.onProgress) yield* input.onProgress(50);
        if (input.onProgress) yield* input.onProgress(100);
        return `${input.targetDir}/${input.asset.fileName}`;
      });
    },
    verifyFileSha256: (filePath, expectedSha256, expectedSize) =>
      options.verifyFileSha256
        ? options.verifyFileSha256(filePath, expectedSha256, expectedSize)
        : Effect.succeed(!deletedFiles.has(filePath)),
  });

  const releaseInstallerLayer = DesktopReleaseInstaller.layerTest({
    installAndRelaunch: (input) => {
      installCount += 1;
      installSteps.push(`install:${input.mode}`);
      if (options.installAndRelaunch) {
        return options.installAndRelaunch(input);
      }
      return Effect.succeed({
        mechanism: input.mode === "dmg" ? "manual-installer" : "self-update",
      });
    },
  });

  const layerWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeedNone,
    currentMainOrFirst: Effect.succeedNone,
    focusedMainOrFirst: Effect.succeedNone,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.sync(() => {
      installSteps.push("destroyAll");
    }),
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const layerSshEnvironment = Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {
    closeAllTunnels: Effect.sync(() => {
      installSteps.push("closeSshTunnels");
    }),
  });

  let backendDesiredRunning = options.backendDesiredRunning ?? true;
  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Primary"),
    start: Effect.sync(() => {
      backendDesiredRunning = true;
      installSteps.push("startBackend");
    }).pipe(Effect.andThen(options.startBackend ?? Effect.void)),
    stop: () =>
      Effect.sync(() => {
        backendDesiredRunning = false;
        installSteps.push("stopBackend");
      }).pipe(Effect.andThen(options.stopBackend ?? Effect.void)),
    currentConfig: Effect.succeedNone,
    snapshot: Effect.sync(() => ({
      desiredRunning: backendDesiredRunning,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    })),
    waitForReady: () => Effect.succeed(true),
  };
  const layerBackend = DesktopBackendPool.layerTest(
    options.backendInstances ?? [stubBackendInstance],
  );

  const envMap: Record<string, string | undefined> = {
    T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
    ...(options.devServerUrl ? { VITE_DEV_SERVER_URL: options.devServerUrl } : {}),
    ...options.env,
  };

  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-desktop-updates-home-${process.pid}`,
    platform: options.platform ?? "linux",
    processArch: options.processArch ?? "x64",
    appVersion: options.appVersion ?? "1.2.3",
    appPath: "/repo",
    isPackaged: options.isPackaged ?? true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(envMap))));

  let testSettings: DesktopAppSettings.DesktopSettings = {
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
    ...(options.savedMirrorUrl === undefined ? {} : { updateMirrorUrl: options.savedMirrorUrl }),
  };
  const setMirrorUrlError = options.setMirrorUrlError;
  const layerSettings = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(() => testSettings),
    load: Effect.sync(() => testSettings),
    setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
    setServerExposureMode: () => Effect.die("unexpected server exposure update"),
    setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
    setUpdateMirrorUrl: (mirrorUrl) =>
      setMirrorUrlError
        ? Effect.fail(setMirrorUrlError)
        : (options.beforeSetMirrorUrl ?? Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                const normalized = mirrorUrl?.trim() || null;
                const changed = testSettings.updateMirrorUrl !== normalized;
                testSettings = { ...testSettings, updateMirrorUrl: normalized };
                return { settings: testSettings, changed };
              }),
            ),
          ),
    setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
    setWslDistro: () => Effect.die("unexpected WSL distro change"),
    setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
    setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
    applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
    applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
  } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

  const updateRestartMarkers = new Set<string>();
  const updateMarkerContents = new Map<string, string>();
  const installRecords = new Map<string, string>();
  let previousInstallRecord = options.installRecord;
  const isInstallRecord = (path: string) =>
    path.endsWith(DesktopUpdates.DESKTOP_UPDATE_INSTALL_RECORD_FILE);
  const layerFileSystem = FileSystem.layerNoop({
    readFileString: (path) => {
      const installRecord = isInstallRecord(path)
        ? (installRecords.get(path) ?? previousInstallRecord)
        : undefined;
      if (installRecord !== undefined) return Effect.succeed(installRecord);
      return path === "/missing/resources/package-type" && options.packageType !== undefined
        ? Effect.succeed(options.packageType)
        : Effect.fail(
            PlatformError.systemError({
              module: "FileSystem",
              method: "readFileString",
              _tag: "NotFound",
              pathOrDescriptor: path,
            }),
          );
    },
    exists: (path) => Effect.succeed(!deletedFiles.has(path)),
    makeDirectory: () => Effect.void,
    writeFileString: (path, data) =>
      Effect.sync(() => {
        if (isInstallRecord(path)) installRecords.set(path, data);
        else {
          if (path.endsWith("/desktop-update-restart")) updateRestartMarkers.add(path);
          updateMarkerContents.set(path, data);
        }
      }),
    rename: (from, to) =>
      Effect.sync(() => {
        const contents = updateMarkerContents.get(from);
        if (contents !== undefined) updateMarkerContents.set(to, contents);
        updateMarkerContents.delete(from);
      }),
    remove: (path) =>
      Effect.sync(() => {
        updateRestartMarkers.delete(path);
        updateMarkerContents.delete(path);
        installRecords.delete(path);
        if (isInstallRecord(path)) previousInstallRecord = undefined;
      }),
  });

  const layer = DesktopUpdates.layer.pipe(
    Layer.provide(layerFileSystem),
    Layer.provide(DesktopUpdatePolicy.layerTest(options.policy)),
    Layer.provideMerge(releaseClientLayer),
    Layer.provideMerge(releaseInstallerLayer),
    Layer.provideMerge(layerWindow),
    Layer.provideMerge(layerBackend),
    Layer.provideMerge(layerSshEnvironment),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(DesktopConfig.layerTest(envMap)),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

  return {
    layer,
    checkCount: () => checkCount,
    downloadCount: () => downloadCount,
    installCount: () => installCount,
    fetchedBaseUrls: () => fetchedBaseUrls,
    downloadedUrls: () => downloadedUrls,
    installSteps,
    updateRestartMarkers,
    updateInProgressMarker: () =>
      [...updateMarkerContents].find(([path]) => path.endsWith("/desktop-update-in-progress"))?.[1],
    installRecords,
    deletedFiles,
    previousInstallRecord: () => previousInstallRecord,
    sentStates,
    savedSettings: () => testSettings,
  };
}
