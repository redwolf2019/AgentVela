import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isNewerStableVersion,
  parseReleaseManifestJson,
  resolveEffectiveReleaseBaseUrl,
  resolveReleaseManifestUrls,
} from "@t3tools/shared/releaseManifest";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return (
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return (
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.latestVersion !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}

export interface FindEnvironmentUpdateOptions {
  readonly userMirrorUrl?: string | null;
}

export async function findEnvironmentUpdate(
  currentVersion: string,
  signal: AbortSignal,
  options?: FindEnvironmentUpdateOptions,
) {
  const resolvedBase = resolveEffectiveReleaseBaseUrl({
    userMirrorUrl: options?.userMirrorUrl ?? null,
  });
  if (!resolvedBase.ok) {
    throw new Error(
      resolvedBase.reason === "disabled"
        ? m(msg("Server updates are disabled by update mirror configuration."))
        : m(msg("Update mirror URL is invalid.")),
    );
  }

  let lastError: unknown;
  for (const url of resolveReleaseManifestUrls(resolvedBase.url)) {
    try {
      const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
      if (!response.ok) {
        lastError = new Error(
          m(msg("Could not check releases ({status}). Try again.", { status: response.status })),
        );
        continue;
      }
      const parsed = parseReleaseManifestJson(await response.text());
      if (!parsed.ok) {
        lastError = new Error(m(msg("Release manifest is invalid.")));
        continue;
      }
      const candidateVersion = parsed.manifest.version;
      return isNewerStableVersion(candidateVersion, currentVersion) ? candidateVersion : null;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(m(msg("Could not check for updates.")));
}
