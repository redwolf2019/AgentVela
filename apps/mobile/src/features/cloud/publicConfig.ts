import Constants from "expo-constants";
import { normalizeRelayUrl } from "@t3tools/shared/relayUrl";

export interface CloudPublicConfig {
  readonly relay: {
    readonly url: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | ({
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    } & {
      readonly hostedAppUrl?: unknown;
    })
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveHostedAppUrl(extra: ExpoExtra = Constants.expoConfig?.extra): string | null {
  const raw = trimNonEmpty(extra?.hostedAppUrl);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function resolveDefaultRelayUrl(
  extra: ExpoExtra = Constants.expoConfig?.extra,
): string | null {
  return normalizeRelayUrl(trimNonEmpty(extra?.relay?.url) ?? "");
}

export function resolveCloudPublicConfig(
  extra: ExpoExtra = Constants.expoConfig?.extra,
): CloudPublicConfig {
  return {
    relay: {
      url: resolveDefaultRelayUrl(extra),
    },
  };
}

export function hasCloudPublicConfig(): boolean {
  return true;
}
