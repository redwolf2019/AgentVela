import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { RELAY_USERNAME_PATTERN } from "@t3tools/contracts/agentVelaRelay";
import { type RelayPresence } from "@t3tools/client-runtime/relay";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export function formatAtomFailure(
  result: AsyncResult.AsyncResult<unknown, unknown>,
  fallback: string,
  resolve: MessageResolver = m,
): string {
  if (result._tag !== "Failure") {
    return fallback;
  }
  const cause = squashAtomCommandFailure(result);
  return (cause instanceof Error ? thrownErrorMessage(cause, resolve) : null) ?? fallback;
}

export function formatRelayHostLabel(relayUrl: string | null): string {
  if (!relayUrl) {
    return "";
  }
  try {
    return new URL(relayUrl).host;
  } catch {
    return relayUrl;
  }
}

export function buildEnrollmentCommand(relayUrl: string, enrollmentToken: string): string {
  return `t3 relay link --url ${relayUrl} --token ${enrollmentToken}`;
}

export function formatRelayBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))} B`;
  }
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatRelayDuration(isoStart: string, resolve: MessageResolver = m): string {
  const startMs = Date.parse(isoStart);
  if (!Number.isFinite(startMs)) {
    return "-";
  }
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return resolve(msg("{hours}h {minutes}m", { hours, minutes }));
  }
  if (minutes > 0) {
    return resolve(msg("{minutes}m {seconds}s", { minutes, seconds }));
  }
  return resolve(msg("{seconds}s", { seconds }));
}

export function presenceConnectionLabel(
  state: RelayPresence.RelayPresenceConnectionState,
  resolve: MessageResolver = m,
): string {
  switch (state) {
    case "connected":
      return resolve(msg("Live"));
    case "connecting":
      return resolve(msg("Connecting"));
    case "reconnecting":
      return resolve(msg("Reconnecting"));
    case "offline":
      return resolve(msg("Offline"));
    case "idle":
      return resolve(msg("Idle"));
  }
}

export function isValidRelayUsername(value: string): boolean {
  return RELAY_USERNAME_PATTERN.test(value.trim());
}

export function parseTrimmedNonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? TrimmedNonEmptyString.make(trimmed) : null;
}

export function parsePositiveIntInput(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return PositiveInt.make(parsed);
}
