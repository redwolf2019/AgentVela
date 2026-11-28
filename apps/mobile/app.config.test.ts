import * as NodeModule from "node:module";

import { computeAndroidVersionCode } from "@t3tools/shared/releaseManifest";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";
import mobilePackageJson from "./package.json" with { type: "json" };

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () =>
    Object.fromEntries(
      [
        "APP_VARIANT",
        "T3CODE_HOSTED_APP_URL",
        "EXPO_PUBLIC_HOSTED_APP_URL",
        "T3CODE_MOBILE_VERSION",
      ]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "io.github.redwolf2019.agentvela"],
  ["development", "io.github.redwolf2019.agentvela.dev"],
  ["preview", "io.github.redwolf2019.agentvela.preview"],
  ["production", "io.github.redwolf2019.agentvela"],
])(
  "keeps identifiers, syncs version and Android versionCode, registers APK plugins, and disables Expo OTA for APP_VARIANT=%j",
  async (value, identifier) => {
    const config = await loadConfig(value);
    expect(config.version).toBe(mobilePackageJson.version);
    expect(config.ios?.bundleIdentifier).toBe(identifier);
    expect(config.android?.package).toBe(identifier);
    expect(config.android?.versionCode).toBe(computeAndroidVersionCode(mobilePackageJson.version));
    expect(config.updates).toEqual({
      enabled: false,
      checkAutomatically: "NEVER",
      fallbackToCacheTimeout: 0,
    });
    expect(config.plugins).toContain("./plugins/withAndroidInstallPackagesPermission.cjs");
    expect(config.plugins).toContain("./plugins/withAndroidReleaseSigning.cjs");
    expect(config.owner).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
    expect(config.extra?.hostedAppUrl).toBeNull();
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
    expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
      `${config.ios?.appleTeamId}.${identifier}`,
    );
    expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
  },
);

it("derives android.versionCode from T3CODE_MOBILE_VERSION overrides", async () => {
  vi.stubEnv("T3CODE_MOBILE_VERSION", "1.2.3");
  const config = await loadConfig("production");
  expect(config.version).toBe("1.2.3");
  expect(config.android?.versionCode).toBe(1_002_003);
});

it("enables universal/app links only when T3CODE_HOSTED_APP_URL is configured", async () => {
  vi.stubEnv("T3CODE_HOSTED_APP_URL", DEFAULT_HOSTED_APP_URL);
  const config = await loadConfig("production");
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.extra?.hostedAppUrl).toBe(DEFAULT_HOSTED_APP_URL);
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
});

it("resolves @t3tools/shared/releaseManifest through Node CommonJS require for Expo", () => {
  const require = NodeModule.createRequire(import.meta.url);
  const releaseManifest =
    require("@t3tools/shared/releaseManifest") as typeof import("@t3tools/shared/releaseManifest");
  expect(releaseManifest.isStableReleaseVersion("0.1.13")).toBe(true);
  expect(releaseManifest.computeAndroidVersionCode("0.1.13")).toBe(1_013);
});
