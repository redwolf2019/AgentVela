import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_CHECKSUMS_FILE,
  CLI_RELEASES_PAGE_URL,
  releaseAssetUrl,
} from "./cliRelease.ts";
import { compareSemverVersions, parseSemver } from "./semver.ts";
import { resolveMirrorUrlOverride } from "./url.ts";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
const RELEASE_MANIFEST_FILE = "release-manifest.json";
export const RELEASE_BASE_URL_ENV = CLI_RELEASE_BASE_URL_ENV;
export const DEFAULT_RELEASE_BASE_URL = CLI_RELEASES_PAGE_URL;

const DESKTOP_RELEASE_ASSET_KEYS = [
  "darwin-arm64-dmg",
  "linux-x64-appimage",
  "linux-x64-deb",
  "linux-arm64-appimage",
  "linux-arm64-deb",
  "win32-x64-nsis",
] as const;

export const DesktopReleaseAssetKeySchema = Schema.Literals(DESKTOP_RELEASE_ASSET_KEYS);
export type DesktopReleaseAssetKey = typeof DesktopReleaseAssetKeySchema.Type;

const CLI_RELEASE_ASSET_KEYS = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"] as const;

export const CliReleaseAssetKeySchema = Schema.Literals(CLI_RELEASE_ASSET_KEYS);
export type CliReleaseAssetKey = typeof CliReleaseAssetKeySchema.Type;

const ANDROID_RELEASE_ASSET_KEYS = ["arm64-v8a"] as const;

export const AndroidReleaseAssetKeySchema = Schema.Literals(ANDROID_RELEASE_ASSET_KEYS);
export type AndroidReleaseAssetKey = typeof AndroidReleaseAssetKeySchema.Type;

export type DesktopInstallMode = "appimage" | "deb" | "nsis" | "dmg";
export type DesktopUpdateMechanism = "self-update" | "manual-installer";

const RELEASE_VERSION_TAG_PREFIX = /^v/i;

export function isSafeReleaseFileName(fileName: string): boolean {
  const trimmed = fileName.trim();
  if (trimmed.length === 0 || trimmed !== fileName) {
    return false;
  }
  if (
    trimmed === "." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..")
  ) {
    return false;
  }
  return !/[\0-\x1f\x7f]/.test(trimmed);
}

const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export function isStableReleaseVersion(version: string): boolean {
  const normalized = version.trim().replace(RELEASE_VERSION_TAG_PREFIX, "");
  if (!STABLE_SEMVER_PATTERN.test(normalized)) {
    return false;
  }
  const parsed = parseSemver(normalized);
  return parsed !== null && parsed.prerelease.length === 0;
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  if (!isStableReleaseVersion(candidate)) {
    return false;
  }
  const normalizedCandidate = candidate.trim().replace(RELEASE_VERSION_TAG_PREFIX, "");
  const normalizedCurrent = current.trim().replace(RELEASE_VERSION_TAG_PREFIX, "");
  if (parseSemver(normalizedCurrent) === null) {
    return false;
  }
  return compareSemverVersions(normalizedCandidate, normalizedCurrent) > 0;
}

export function computeAndroidVersionCode(version: string): number {
  const normalized = version.trim().replace(RELEASE_VERSION_TAG_PREFIX, "");
  const parsed = parseSemver(normalized);
  if (!parsed || !isStableReleaseVersion(normalized)) {
    throw new Error(`Invalid stable release version for Android versionCode: "${version}"`);
  }
  if (parsed.minor >= 1_000 || parsed.patch >= 1_000) {
    throw new Error(
      `Release version "${version}" exceeds Android versionCode component limit (< 1000).`,
    );
  }
  const versionCode = parsed.major * 1_000_000 + parsed.minor * 1_000 + parsed.patch;
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    throw new Error(`Release version "${version}" produced invalid Android versionCode.`);
  }
  return versionCode;
}

const NonBlankStringSchema = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0, {
    expected: "a non-blank string",
  }),
);

const SafeFileNameSchema = Schema.String.check(
  Schema.makeFilter((value: string) => isSafeReleaseFileName(value), {
    expected: "a safe release asset file name",
  }),
);

const Sha256HexSchema = Schema.String.check(
  Schema.makeFilter((value: string) => /^[0-9a-f]{64}$/i.test(value), {
    expected: "a 64-character hexadecimal SHA-256 digest",
  }),
);

const StableSemverSchema = Schema.String.check(
  Schema.makeFilter((value: string) => isStableReleaseVersion(value) && !value.startsWith("v"), {
    expected: "a canonical stable semver version (X.Y.Z)",
  }),
);

const NonNegativeSafeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveSafeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const ReleaseManifestAssetSchema = Schema.Struct({
  fileName: SafeFileNameSchema,
  sha256: Sha256HexSchema,
  size: NonNegativeSafeIntSchema,
});
export type ReleaseManifestAsset = typeof ReleaseManifestAssetSchema.Type;

export const DesktopReleaseManifestAssetsSchema = Schema.Struct({
  "darwin-arm64-dmg": Schema.optionalKey(ReleaseManifestAssetSchema),
  "linux-x64-appimage": Schema.optionalKey(ReleaseManifestAssetSchema),
  "linux-x64-deb": Schema.optionalKey(ReleaseManifestAssetSchema),
  "linux-arm64-appimage": Schema.optionalKey(ReleaseManifestAssetSchema),
  "linux-arm64-deb": Schema.optionalKey(ReleaseManifestAssetSchema),
  "win32-x64-nsis": Schema.optionalKey(ReleaseManifestAssetSchema),
});
export type DesktopReleaseManifestAssets = typeof DesktopReleaseManifestAssetsSchema.Type;

export const CliReleaseManifestAssetsSchema = Schema.Struct({
  "darwin-arm64": Schema.optionalKey(ReleaseManifestAssetSchema),
  "linux-arm64": Schema.optionalKey(ReleaseManifestAssetSchema),
  "linux-x64": Schema.optionalKey(ReleaseManifestAssetSchema),
  "win32-x64": Schema.optionalKey(ReleaseManifestAssetSchema),
});
export type CliReleaseManifestAssets = typeof CliReleaseManifestAssetsSchema.Type;

export const AndroidReleaseManifestAssetsSchema = Schema.Struct({
  "arm64-v8a": Schema.optionalKey(ReleaseManifestAssetSchema),
});
export type AndroidReleaseManifestAssets = typeof AndroidReleaseManifestAssetsSchema.Type;

export const ReleaseManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(RELEASE_MANIFEST_SCHEMA_VERSION),
  version: StableSemverSchema,
  tag: NonBlankStringSchema,
  publishedAt: NonBlankStringSchema,
  notes: Schema.optionalKey(Schema.String),
  androidVersionCode: PositiveSafeIntSchema,
  desktop: DesktopReleaseManifestAssetsSchema,
  cli: CliReleaseManifestAssetsSchema,
  android: AndroidReleaseManifestAssetsSchema,
});
export type ReleaseManifest = typeof ReleaseManifestSchema.Type;

const decodeReleaseManifestUnknownExit = Schema.decodeUnknownExit(ReleaseManifestSchema);
const decodeReleaseManifestJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(ReleaseManifestSchema),
);

export type ParseReleaseManifestResult =
  | { readonly ok: true; readonly manifest: ReleaseManifest }
  | { readonly ok: false; readonly error: string };

function normalizeReleaseAssetDigests<T extends Record<string, ReleaseManifestAsset | undefined>>(
  assets: T,
): T {
  const normalized: Record<string, ReleaseManifestAsset | undefined> = {};
  for (const [key, asset] of Object.entries(assets)) {
    if (asset !== undefined) {
      normalized[key] = { ...asset, sha256: asset.sha256.toLowerCase() };
    }
  }
  return normalized as T;
}

function finalizeDecodedManifest(
  exit: Exit.Exit<ReleaseManifest, unknown>,
): ParseReleaseManifestResult {
  if (Exit.isFailure(exit)) {
    return { ok: false, error: Cause.pretty(exit.cause) };
  }
  const manifest = exit.value;
  return {
    ok: true,
    manifest: {
      ...manifest,
      desktop: normalizeReleaseAssetDigests(manifest.desktop),
      cli: normalizeReleaseAssetDigests(manifest.cli),
      android: normalizeReleaseAssetDigests(manifest.android),
    },
  };
}

export function parseReleaseManifest(input: unknown): ParseReleaseManifestResult {
  return finalizeDecodedManifest(decodeReleaseManifestUnknownExit(input));
}

export function parseReleaseManifestJson(rawJson: string): ParseReleaseManifestResult {
  return finalizeDecodedManifest(decodeReleaseManifestJsonExit(rawJson));
}

export type ReleaseBaseUrlSource = "policy" | "env" | "user" | "default";

export interface ReleaseBaseUrlOptions {
  readonly managedFeedUrl?: string | null | undefined;
  readonly envReleaseBaseUrl?: string | null | undefined;
  readonly userMirrorUrl?: string | null | undefined;
  readonly defaultBaseUrl?: string | undefined;
}

export type ResolvedReleaseBaseUrl =
  | { readonly ok: true; readonly url: string; readonly source: ReleaseBaseUrlSource }
  | {
      readonly ok: false;
      readonly reason: "disabled" | "invalid";
      readonly source: Exclude<ReleaseBaseUrlSource, "default">;
      readonly value?: string;
    };

function normalizeResolvedUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/+$/, "");
}

export function resolveEffectiveReleaseBaseUrl(
  options: ReleaseBaseUrlOptions = {},
): ResolvedReleaseBaseUrl {
  const layers: ReadonlyArray<
    readonly [Exclude<ReleaseBaseUrlSource, "default">, string | null | undefined]
  > = [
    ["policy", options.managedFeedUrl],
    ["env", options.envReleaseBaseUrl],
    ["user", options.userMirrorUrl],
  ];

  for (const [source, rawValue] of layers) {
    const candidate = rawValue?.trim();
    if (!candidate) {
      continue;
    }
    const resolved = resolveMirrorUrlOverride(candidate);
    if (resolved._tag === "url") {
      return { ok: true, url: normalizeResolvedUrl(resolved.url), source };
    }
    if (resolved._tag === "off") {
      return { ok: false, reason: "disabled", source };
    }
    if (resolved._tag === "invalid") {
      return { ok: false, reason: "invalid", source, value: resolved.value };
    }
  }

  return {
    ok: true,
    url: normalizeResolvedUrl(options.defaultBaseUrl ?? DEFAULT_RELEASE_BASE_URL),
    source: "default",
  };
}

function isGitHubHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "github.com" || normalized.endsWith(".github.com");
}

function normalizedPathname(url: URL): string {
  return url.pathname.replace(/\/+$/, "");
}

export function resolveReleaseManifestUrls(baseUrl: string): ReadonlyArray<string> {
  const parsed = new URL(baseUrl);
  const path = normalizedPathname(parsed);
  const urls: string[] = [];

  if (path.endsWith("/releases")) {
    urls.push(releaseAssetUrl(baseUrl, "latest", "download", RELEASE_MANIFEST_FILE));
    if (!isGitHubHost(parsed.hostname)) {
      urls.push(releaseAssetUrl(baseUrl, RELEASE_MANIFEST_FILE));
    }
    return urls;
  }

  if (path.endsWith("/releases/download")) {
    const releasesUrl = new URL(parsed.toString());
    releasesUrl.pathname = path.slice(0, -"/download".length);
    urls.push(releaseAssetUrl(releasesUrl.toString(), "latest", "download", RELEASE_MANIFEST_FILE));
    if (!isGitHubHost(parsed.hostname)) {
      urls.push(releaseAssetUrl(baseUrl, RELEASE_MANIFEST_FILE));
    }
    return urls;
  }

  urls.push(releaseAssetUrl(baseUrl, "latest", "download", RELEASE_MANIFEST_FILE));
  urls.push(releaseAssetUrl(baseUrl, RELEASE_MANIFEST_FILE));
  return urls;
}

const LATEST_DOWNLOAD_MANIFEST_SUFFIX = `/latest/download/${RELEASE_MANIFEST_FILE}`;

function resolveReleaseAssetBaseUrl(baseUrl: string, matchedManifestUrl?: string): string {
  if (matchedManifestUrl) {
    const matched = new URL(matchedManifestUrl);
    const matchedPath = normalizedPathname(matched);
    if (matchedPath.endsWith(LATEST_DOWNLOAD_MANIFEST_SUFFIX)) {
      const rootUrl = new URL(matched.toString());
      rootUrl.pathname = matchedPath.slice(0, -LATEST_DOWNLOAD_MANIFEST_SUFFIX.length);
      return releaseAssetUrl(rootUrl.toString(), "download");
    }
    if (matchedPath.endsWith(`/${RELEASE_MANIFEST_FILE}`)) {
      const rootUrl = new URL(matched.toString());
      rootUrl.pathname = matchedPath.slice(0, -`/${RELEASE_MANIFEST_FILE}`.length);
      return rootUrl.toString().replace(/\/+$/, "");
    }
  }

  const parsed = new URL(baseUrl);
  const path = normalizedPathname(parsed);
  if (path.endsWith("/releases")) {
    return releaseAssetUrl(baseUrl, "download");
  }
  return baseUrl.replace(/\/+$/, "");
}

export function resolveReleaseAssetUrl(
  baseUrl: string,
  versionOrTag: string,
  fileName: string,
  matchedManifestUrl?: string,
): string {
  const tag = versionOrTag.startsWith("v") ? versionOrTag : `v${versionOrTag}`;
  const assetBase = resolveReleaseAssetBaseUrl(baseUrl, matchedManifestUrl);
  return releaseAssetUrl(assetBase, tag, fileName);
}

export function resolveReleaseChecksumsUrl(
  baseUrl: string,
  versionOrTag: string,
  matchedManifestUrl?: string,
): string {
  return resolveReleaseAssetUrl(
    baseUrl,
    versionOrTag,
    CLI_RELEASE_CHECKSUMS_FILE,
    matchedManifestUrl,
  );
}

export function selectDesktopReleaseAssetKey(input: {
  readonly platform: NodeJS.Platform | string;
  readonly arch: string;
  readonly isAppImage?: boolean;
  readonly linuxPackageFormat?: "appimage" | "deb" | undefined;
}): DesktopReleaseAssetKey | null {
  if (input.platform === "darwin" && input.arch === "arm64") {
    return "darwin-arm64-dmg";
  }
  if (input.platform === "win32" && input.arch === "x64") {
    return "win32-x64-nsis";
  }
  if (input.platform === "linux" && (input.arch === "x64" || input.arch === "arm64")) {
    const format = input.isAppImage ? "appimage" : input.linuxPackageFormat;
    if (format === "appimage") {
      return input.arch === "x64" ? "linux-x64-appimage" : "linux-arm64-appimage";
    }
    if (format === "deb") {
      return input.arch === "x64" ? "linux-x64-deb" : "linux-arm64-deb";
    }
  }
  return null;
}

export function desktopInstallModeFromAssetKey(
  assetKey: DesktopReleaseAssetKey,
): DesktopInstallMode {
  switch (assetKey) {
    case "darwin-arm64-dmg":
      return "dmg";
    case "win32-x64-nsis":
      return "nsis";
    case "linux-x64-appimage":
    case "linux-arm64-appimage":
      return "appimage";
    case "linux-x64-deb":
    case "linux-arm64-deb":
      return "deb";
  }
}

export function resolveDesktopUpdateMechanism(
  assetKey: DesktopReleaseAssetKey,
): DesktopUpdateMechanism {
  return assetKey === "darwin-arm64-dmg" ? "manual-installer" : "self-update";
}

export function desktopInstallModeForPlatform(input: {
  readonly platform: NodeJS.Platform | string;
  readonly arch: string;
  readonly isAppImage?: boolean;
  readonly linuxPackageFormat?: "appimage" | "deb" | undefined;
}): DesktopInstallMode | null {
  const assetKey = selectDesktopReleaseAssetKey(input);
  return assetKey ? desktopInstallModeFromAssetKey(assetKey) : null;
}
