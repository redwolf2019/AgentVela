import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () =>
    Object.fromEntries(
      [
        "APP_VARIANT",
        "T3CODE_HOSTED_APP_URL",
        "EXPO_PUBLIC_HOSTED_APP_URL",
        "T3CODE_MOBILE_UPDATES_ENABLED",
        "T3CODE_MOBILE_EAS_PROJECT_ID",
        "T3CODE_MOBILE_UPDATES_URL",
        "T3CODE_MOBILE_EAS_OWNER",
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
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])(
  "keeps the iOS and Android identifiers and disables upstream OTA/links by default for APP_VARIANT=%j",
  async (value, identifier) => {
    const config = await loadConfig(value);
    expect(config.ios?.bundleIdentifier).toBe(identifier);
    expect(config.android?.package).toBe(identifier);
    expect(config.updates).toEqual({
      enabled: false,
      checkAutomatically: "NEVER",
      fallbackToCacheTimeout: 0,
    });
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

it("enables OTA updates only when explicitly opted in with an update project/URL", async () => {
  vi.stubEnv("T3CODE_MOBILE_UPDATES_ENABLED", "1");
  vi.stubEnv("T3CODE_MOBILE_EAS_PROJECT_ID", "11111111-2222-3333-4444-555555555555");
  vi.stubEnv("T3CODE_MOBILE_EAS_OWNER", "self-hosted-org");
  const config = await loadConfig("production");
  expect(config.updates).toEqual({
    enabled: true,
    url: "https://u.expo.dev/11111111-2222-3333-4444-555555555555",
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  });
  expect(config.extra?.eas).toEqual({
    projectId: "11111111-2222-3333-4444-555555555555",
  });
  expect(config.owner).toBe("self-hosted-org");
});
