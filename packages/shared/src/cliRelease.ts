const CLI_RELEASE_REPOSITORY = "redwolf2019/AgentVela";
export const CLI_RELEASES_PAGE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases`;
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";

// Keep aligned with CLI_RELEASE_ASSET_KEYS in ./releaseManifest.ts and SSH remote script in packages/ssh/src/tunnel.ts.
// Node single-executables do not support darwin-x64 and segfault at startup.
const CLI_ARCHIVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/** Use System32 bsdtar on Windows; Git-for-Windows GNU tar cannot open zip archives. */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

function resolveCliDownloadRootUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL;
  try {
    const parsed = new URL(trimmed);
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    if (cleanPath.endsWith("/releases")) {
      parsed.pathname = `${cleanPath}/download`;
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    // Fall back to direct string normalization for callers passing non-URL test stubs.
  }
  return trimmed.replace(/\/+$/, "");
}

export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${resolveCliDownloadRootUrl(baseUrl)}/v${version}`;
}

/** `segments` added to `baseUrl`'s path, keeping its query, such as a signed mirror URL's token. */
export function releaseAssetUrl(baseUrl: string, ...segments: ReadonlyArray<string>): string {
  const url = new URL(baseUrl);
  url.pathname = [url.pathname.replace(/\/+$/, ""), ...segments.map(encodeURIComponent)].join("/");
  return url.toString();
}

/** A file of release `version`, from `baseUrl` laid out as GitHub's release downloads or `/releases`. */
export function cliReleaseAssetUrl(
  version: string,
  fileName: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return releaseAssetUrl(resolveCliDownloadRootUrl(baseUrl), `v${version}`, fileName);
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview";

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}
