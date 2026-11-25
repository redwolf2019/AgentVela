import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import type {
  RelayManagedEndpoint,
  RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import { joinEndpointUrl } from "@t3tools/shared/relayUrl";
import { parseUrl } from "@t3tools/shared/url";

export function isManagedTunnelActive(
  linkState: EnvironmentCloudLinkStateResult,
  relayProviderKind: RelayManagedEndpointProviderKind | undefined,
) {
  const localManagedTunnel = linkState.managedTunnelActive ?? linkState.linked;
  return (
    linkState.linkRevoked !== true &&
    localManagedTunnel &&
    (relayProviderKind === undefined ||
      relayProviderKind === "t3_relay" ||
      relayProviderKind === "cloudflare_tunnel")
  );
}

/**
 * Whether reaching `desired` links or relinks the environment, which needs `relay:configure`.
 * Unlinking and preference changes on the current link only need `relay:write`.
 */
export function cloudChangeReplacesLink(
  linkState: EnvironmentCloudLinkStateResult,
  relayProviderKind: RelayManagedEndpointProviderKind | undefined,
  desired: { readonly managedTunnel: boolean; readonly publish: boolean },
) {
  return (
    (desired.managedTunnel || desired.publish) &&
    (!linkState.linked ||
      linkState.linkRevoked === true ||
      isManagedTunnelActive(linkState, relayProviderKind) !== desired.managedTunnel)
  );
}

const TUNNEL_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function t3ConnectMcpUrl(input: {
  readonly thisMachine: boolean;
  readonly tunnelHostname: string | undefined;
  readonly relayEndpoint: RelayManagedEndpoint | undefined;
}): string | null {
  if (input.relayEndpoint?.providerKind === "t3_relay") {
    try {
      return joinEndpointUrl(input.relayEndpoint.httpBaseUrl, "/mcp");
    } catch {
      return null;
    }
  }
  const url = input.thisMachine
    ? parseUrl(`https://${input.tunnelHostname ?? ""}`)
    : input.relayEndpoint?.providerKind === "cloudflare_tunnel"
      ? parseUrl(input.relayEndpoint.httpBaseUrl)
      : null;
  return url?.protocol === "https:" && TUNNEL_HOSTNAME.test(url.hostname)
    ? `${url.origin}/mcp`
    : null;
}

/** Where T3 Connect can be turned on for an environment: from here, only by policy, or on its host. */
export type T3ConnectTurnOn =
  | { readonly kind: "here" }
  | { readonly kind: "policy"; readonly reason: string }
  | { readonly kind: "on-host" };

export function resolveT3ConnectTurnOn(input: {
  readonly linkableHere: boolean;
  readonly cloudConfigured: boolean;
  readonly canReadRelay: boolean;
  readonly canWriteRelay: boolean;
  readonly connectDenial: string | undefined;
}): T3ConnectTurnOn {
  if (input.connectDenial !== undefined) return { kind: "policy", reason: input.connectDenial };
  return input.linkableHere && input.cloudConfigured && input.canReadRelay && input.canWriteRelay
    ? { kind: "here" }
    : { kind: "on-host" };
}
