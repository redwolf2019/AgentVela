import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { GUEST_FAILURE } from "../orchestration-v2/GuestShareDecider.ts";
import type { RelayTunnelClient } from "../relay/RelayTunnelClient.ts";

export const GUEST_ACCESS_MESSAGES = {
  ...GUEST_FAILURE,
  invalid: "This guest link is not valid.",
  stale_page: "This page is for an older guest link. Reload it to continue.",
  unavailable: "This item is not available.",
  rejected: "The owner's server rejected this request.",
  empty: "Write a message or attach a file.",
  too_many_files: "Attach up to 4 files to a message.",
  too_large: "Attached files can total up to 10 MB per message.",
  unsupported_file: "This file cannot be attached. Images must be PNG, JPEG, GIF, or WebP.",
  files_busy: GUEST_FAILURE.filesBusy,
} as const;

export const mapGuestFailureReason = (
  cause: unknown,
): "inactive" | "used" | "busy" | "files_busy" | "rejected" =>
  cause === GUEST_FAILURE.inactive
    ? "inactive"
    : cause === GUEST_FAILURE.used
      ? "used"
      : cause === GUEST_FAILURE.busy
        ? "busy"
        : cause === GUEST_FAILURE.filesBusy
          ? "files_busy"
          : "rejected";

export const resolveGuestEndpoint = Effect.fn("guest.resolveGuestEndpoint")(function* (input: {
  readonly relayTunnel: Option.Option<RelayTunnelClient["Service"]>;
}) {
  if (Option.isNone(input.relayTunnel)) {
    return null;
  }
  const endpoint = yield* input.relayTunnel.value.getActiveEndpoint();
  return endpoint?.httpBaseUrl ?? null;
});

export function formatGuestShareUrl(host: string, credential: string): string {
  const base =
    host.startsWith("http://") || host.startsWith("https://")
      ? host.replace(/\/+$/u, "")
      : `https://${host}`;
  return `${base}/guest#${credential}`;
}
