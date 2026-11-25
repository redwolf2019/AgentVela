import { parseRelayUrl } from "@t3tools/shared/relayUrl";

import { isRelayHostedWebUi } from "../hostedPairing";

export interface CloudPublicConfig {
  readonly relayUrl: string | null;
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function resolveDefaultRelayUrl(): string | null {
  const configured = trimNonEmpty(import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined);
  if (configured !== null) {
    return parseRelayUrl(configured)?.origin ?? null;
  }
  if (isRelayHostedWebUi() && typeof window !== "undefined" && window.location !== undefined) {
    return parseRelayUrl(window.location.origin)?.origin ?? null;
  }
  return null;
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    relayUrl: resolveDefaultRelayUrl(),
  };
}

export function hasCloudPublicConfig(): boolean {
  return true;
}
