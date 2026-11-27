import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { computeAndroidVersionCode, type ReleaseManifest } from "@t3tools/shared/releaseManifest";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-application", () => ({ nativeBuildVersion: "100" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.11" } } }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

import {
  createAndroidReleaseUpdater,
  type AndroidNativeUpdaterModule,
} from "./android-release-updater";

function makeManifest(version = "0.2.0"): ReleaseManifest {
  return {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    publishedAt: "2026-11-27T00:00:00.000Z",
    notes: "Bug fixes and performance improvements.",
    androidVersionCode: computeAndroidVersionCode(version),
    desktop: {},
    cli: {},
    android: {
      "arm64-v8a": {
        fileName: `AgentVela-${version}-android-arm64-v8a.apk`,
        sha256: "a".repeat(64),
        size: 42_000_000,
      },
    },
  };
}

function makeNativeModule(
  overrides: Partial<AndroidNativeUpdaterModule> = {},
): AndroidNativeUpdaterModule {
  return {
    canRequestPackageInstalls: vi.fn(() => true),
    openInstallUnknownAppsSettings: vi.fn(async () => {}),
    downloadAndVerifyApk: vi.fn(async (_url, fileName) => `/data/cache/updates/${fileName}`),
    installApk: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("android-release-updater", () => {
  it("stays inert on iOS", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const updater = createAndroidReleaseUpdater({
      platform: "ios",
      currentVersion: "0.1.11",
      fetchImpl,
      nativeModule: null,
    });
    const next = await updater.checkForUpdate();
    expect(next.supported).toBe(false);
    expect(next.status).toBe("idle");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks release-manifest.json, downloads verified APK, and handles install permission", async () => {
    const manifest = makeManifest("0.2.0");
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      expect(url).toBe("https://mirror.example.com/releases/latest/download/release-manifest.json");
      return new Response(JSON.stringify(manifest), { status: 200 });
    });
    const native = makeNativeModule({
      canRequestPackageInstalls: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
    });
    const updater = createAndroidReleaseUpdater({
      platform: "android",
      currentVersion: "0.1.11",
      currentVersionCode: computeAndroidVersionCode("0.1.11"),
      fetchImpl,
      nativeModule: native,
      now: () => 12345,
    });

    const checked = await updater.checkForUpdate({
      userMirrorUrl: "https://mirror.example.com/releases",
    });
    expect(checked.status).toBe("available");
    expect(checked.availableVersion).toBe("0.2.0");
    expect(checked.downloadUrl).toBe(
      "https://mirror.example.com/releases/download/v0.2.0/AgentVela-0.2.0-android-arm64-v8a.apk",
    );

    const downloaded = await updater.downloadUpdate();
    expect(downloaded.status).toBe("downloaded");
    expect(native.downloadAndVerifyApk).toHaveBeenCalledWith(
      "https://mirror.example.com/releases/download/v0.2.0/AgentVela-0.2.0-android-arm64-v8a.apk",
      "AgentVela-0.2.0-android-arm64-v8a.apk",
      "a".repeat(64),
    );

    const denied = await updater.installDownloadedUpdate();
    expect(denied).toEqual({ outcome: "permission-required" });
    expect(native.installApk).not.toHaveBeenCalled();

    const started = await updater.installDownloadedUpdate();
    expect(started).toEqual({ outcome: "started" });
    expect(native.installApk).toHaveBeenCalledWith(
      "/data/cache/updates/AgentVela-0.2.0-android-arm64-v8a.apk",
    );
  });

  it("reports up-to-date when currentVersion matches or exceeds manifest versionCode", async () => {
    const manifest = makeManifest("0.1.11");
    const updater = createAndroidReleaseUpdater({
      platform: "android",
      currentVersion: "0.1.11",
      currentVersionCode: computeAndroidVersionCode("0.1.11"),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })),
      nativeModule: makeNativeModule(),
    });
    const checked = await updater.checkForUpdate();
    expect(checked.status).toBe("up-to-date");
    expect(checked.availableVersion).toBeNull();
  });

  it("fails closed on invalid mirror URLs without fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const updater = createAndroidReleaseUpdater({
      platform: "android",
      currentVersion: "0.1.11",
      fetchImpl,
      nativeModule: makeNativeModule(),
    });
    const checked = await updater.checkForUpdate({ userMirrorUrl: "ftp://bad.example.com" });
    expect(checked.status).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
