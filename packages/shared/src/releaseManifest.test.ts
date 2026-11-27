import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_RELEASE_BASE_URL,
  computeAndroidVersionCode,
  desktopInstallModeForPlatform,
  desktopInstallModeFromAssetKey,
  isNewerStableVersion,
  isSafeReleaseFileName,
  isStableReleaseVersion,
  parseReleaseManifestJson,
  resolveDesktopUpdateMechanism,
  resolveEffectiveReleaseBaseUrl,
  resolveReleaseAssetUrl,
  resolveReleaseChecksumsUrl,
  resolveReleaseManifestUrls,
  selectDesktopReleaseAssetKey,
} from "./releaseManifest.ts";

const VALID_SHA256 = "A".repeat(64);

function makeSampleManifestJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    version: "0.1.12",
    tag: "v0.1.12",
    publishedAt: "2026-11-27T00:00:00.000Z",
    notes: "## Changes\n- Self-hosted releases",
    androidVersionCode: 1012,
    desktop: {
      "darwin-arm64-dmg": {
        fileName: "AgentVela-0.1.12-arm64.dmg",
        sha256: VALID_SHA256,
        size: 123456,
      },
      "linux-x64-appimage": {
        fileName: "AgentVela-0.1.12-x86_64.AppImage",
        sha256: VALID_SHA256,
        size: 234567,
      },
    },
    cli: {
      "linux-x64": {
        fileName: "t3-0.1.12-linux-x64.tar.gz",
        sha256: VALID_SHA256,
        size: 34567,
      },
    },
    android: {
      "arm64-v8a": {
        fileName: "AgentVela-0.1.12-android-arm64-v8a.apk",
        sha256: VALID_SHA256,
        size: 456789,
      },
    },
    ...overrides,
  });
}

describe("releaseManifest", () => {
  it("parses valid manifests and normalizes sha256 digests to lowercase", () => {
    const parsed = parseReleaseManifestJson(makeSampleManifestJson());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.version).toBe("0.1.12");
    expect(parsed.manifest.androidVersionCode).toBe(1012);
    expect(parsed.manifest.desktop["darwin-arm64-dmg"]?.sha256).toBe("a".repeat(64));
    expect(parsed.manifest.android["arm64-v8a"]?.fileName).toBe(
      "AgentVela-0.1.12-android-arm64-v8a.apk",
    );
  });

  it("rejects manifests with path traversal filenames, prerelease versions, or bad sha256", () => {
    expect(
      parseReleaseManifestJson(makeSampleManifestJson({ version: "0.1.12-nightly.1" })).ok,
    ).toBe(false);

    expect(
      parseReleaseManifestJson(
        makeSampleManifestJson({
          android: {
            "arm64-v8a": {
              fileName: "../evil.apk",
              sha256: "b".repeat(64),
              size: 10,
            },
          },
        }),
      ).ok,
    ).toBe(false);

    expect(
      parseReleaseManifestJson(
        makeSampleManifestJson({
          cli: {
            "linux-x64": {
              fileName: "t3-0.1.12-linux-x64.tar.gz",
              sha256: "not-hex",
              size: 10,
            },
          },
        }),
      ).ok,
    ).toBe(false);
  });

  it("computes monotonic Android versionCodes from stable semver versions", () => {
    expect(computeAndroidVersionCode("0.1.11")).toBe(1011);
    expect(computeAndroidVersionCode("0.1.12")).toBe(1012);
    expect(computeAndroidVersionCode("1.2.3")).toBe(1_002_003);
    expect(() => computeAndroidVersionCode("0.1.12-nightly.1")).toThrow();
    expect(() => computeAndroidVersionCode("0.1000.0")).toThrow();
  });

  it("compares stable release versions safely", () => {
    expect(isStableReleaseVersion("0.1.12")).toBe(true);
    expect(isStableReleaseVersion("0.1")).toBe(false);
    expect(isStableReleaseVersion("0.1.12-nightly.1")).toBe(false);
    expect(isNewerStableVersion("0.1.12", "0.1.11")).toBe(true);
    expect(isNewerStableVersion("0.1.11", "0.1.11")).toBe(false);
    expect(isNewerStableVersion("0.1.10", "0.1.11")).toBe(false);
    expect(isNewerStableVersion("0.1.11", "0.1.11-nightly.20261101.1")).toBe(true);
    expect(isNewerStableVersion("0.1.12-nightly.1", "0.1.11")).toBe(false);
    expect(isSafeReleaseFileName("AgentVela-0.1.12-arm64.dmg")).toBe(true);
    expect(isSafeReleaseFileName("foo/bar.dmg")).toBe(false);
    expect(isSafeReleaseFileName("..")).toBe(false);
  });

  it("enforces release base URL precedence and fails closed on invalid overrides", () => {
    expect(resolveEffectiveReleaseBaseUrl()).toEqual({
      ok: true,
      url: DEFAULT_RELEASE_BASE_URL,
      source: "default",
    });

    expect(
      resolveEffectiveReleaseBaseUrl({
        managedFeedUrl: "https://policy.example.com/releases/",
        envReleaseBaseUrl: "https://env.example.com/releases",
        userMirrorUrl: "https://user.example.com/releases",
      }),
    ).toEqual({
      ok: true,
      url: "https://policy.example.com/releases",
      source: "policy",
    });

    expect(
      resolveEffectiveReleaseBaseUrl({
        envReleaseBaseUrl: "https://env.example.com/releases",
        userMirrorUrl: "https://user.example.com/releases",
      }),
    ).toEqual({
      ok: true,
      url: "https://env.example.com/releases",
      source: "env",
    });

    expect(
      resolveEffectiveReleaseBaseUrl({
        envReleaseBaseUrl: "http://insecure.example.com/releases",
        userMirrorUrl: "https://user.example.com/releases",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      source: "env",
      value: "http://insecure.example.com/releases",
    });

    expect(
      resolveEffectiveReleaseBaseUrl({
        userMirrorUrl: "http://127.0.0.1:8787",
      }),
    ).toEqual({
      ok: true,
      url: "http://127.0.0.1:8787",
      source: "user",
    });

    expect(
      resolveEffectiveReleaseBaseUrl({
        envReleaseBaseUrl: "off",
      }),
    ).toEqual({
      ok: false,
      reason: "disabled",
      source: "env",
    });
  });

  it("resolves manifest and asset URLs for GitHub, proxies, and flat mirrors", () => {
    expect(resolveReleaseManifestUrls(DEFAULT_RELEASE_BASE_URL)).toEqual([
      "https://github.com/redwolf2019/AgentVela/releases/latest/download/release-manifest.json",
    ]);
    expect(
      resolveReleaseAssetUrl(DEFAULT_RELEASE_BASE_URL, "0.1.12", "AgentVela-0.1.12-arm64.dmg"),
    ).toBe(
      "https://github.com/redwolf2019/AgentVela/releases/download/v0.1.12/AgentVela-0.1.12-arm64.dmg",
    );
    expect(
      resolveReleaseChecksumsUrl(
        "https://ghproxy.example.com/https://github.com/redwolf2019/AgentVela/releases",
        "0.1.12",
      ),
    ).toBe(
      "https://ghproxy.example.com/https://github.com/redwolf2019/AgentVela/releases/download/v0.1.12/SHA256SUMS",
    );

    expect(resolveReleaseManifestUrls("http://127.0.0.1:8787")).toEqual([
      "http://127.0.0.1:8787/latest/download/release-manifest.json",
      "http://127.0.0.1:8787/release-manifest.json",
    ]);
    expect(
      resolveReleaseAssetUrl(
        "http://127.0.0.1:8787",
        "0.1.12",
        "AgentVela-0.1.12-android-arm64-v8a.apk",
        "http://127.0.0.1:8787/release-manifest.json",
      ),
    ).toBe("http://127.0.0.1:8787/v0.1.12/AgentVela-0.1.12-android-arm64-v8a.apk");
    expect(
      resolveReleaseAssetUrl(
        "http://127.0.0.1:8787",
        "0.1.12",
        "AgentVela-0.1.12-android-arm64-v8a.apk",
        "http://127.0.0.1:8787/latest/download/release-manifest.json",
      ),
    ).toBe("http://127.0.0.1:8787/download/v0.1.12/AgentVela-0.1.12-android-arm64-v8a.apk");
  });

  it("maps platform/package formats to desktop asset keys and update mechanisms", () => {
    expect(selectDesktopReleaseAssetKey({ platform: "darwin", arch: "arm64" })).toBe(
      "darwin-arm64-dmg",
    );
    expect(selectDesktopReleaseAssetKey({ platform: "darwin", arch: "x64" })).toBeNull();
    expect(selectDesktopReleaseAssetKey({ platform: "win32", arch: "x64" })).toBe("win32-x64-nsis");
    expect(
      selectDesktopReleaseAssetKey({
        platform: "linux",
        arch: "x64",
        isAppImage: true,
      }),
    ).toBe("linux-x64-appimage");
    expect(
      selectDesktopReleaseAssetKey({
        platform: "linux",
        arch: "arm64",
        linuxPackageFormat: "deb",
      }),
    ).toBe("linux-arm64-deb");

    expect(isSafeReleaseFileName(".")).toBe(false);
    expect(desktopInstallModeFromAssetKey("darwin-arm64-dmg")).toBe("dmg");
    expect(resolveDesktopUpdateMechanism("darwin-arm64-dmg")).toBe("manual-installer");
    expect(resolveDesktopUpdateMechanism("linux-x64-appimage")).toBe("self-update");
    expect(desktopInstallModeForPlatform({ platform: "win32", arch: "x64" })).toBe("nsis");
  });
});
