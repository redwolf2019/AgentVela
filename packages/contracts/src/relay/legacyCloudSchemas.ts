import * as Schema from "effect/Schema";

export const EnvironmentCloudRelayConfigResult = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type EnvironmentCloudRelayConfigResult = typeof EnvironmentCloudRelayConfigResult.Type;

export const EnvironmentConnectReachabilityCause = Schema.Literals([
  "not_linked",
  "connector_not_running",
  "connector_not_ready",
  "edge_unreachable",
  "no_connector",
  "origin_unreachable",
  "dns_failed",
  "timeout",
  "unexpected_response",
]);
export type EnvironmentConnectReachabilityCause = typeof EnvironmentConnectReachabilityCause.Type;

/** Whether other devices can reach this environment through its T3 Connect tunnel. */
export const EnvironmentConnectReachability = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("reachable"),
    checkedAt: Schema.String,
    /** Null when cloudflared did not report a count. */
    readyConnections: Schema.NullOr(Schema.Int),
    protocol: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("unreachable"),
    checkedAt: Schema.String,
    cause: EnvironmentConnectReachabilityCause,
    reason: Schema.String,
    hint: Schema.NullOr(Schema.String),
    fix: Schema.String,
  }),
]);
export type EnvironmentConnectReachability = typeof EnvironmentConnectReachability.Type;

/**
 * Sections of docs/user/t3-connect-troubleshooting.md. Each is the GitHub anchor of a
 * heading there; the test fails when a heading is renamed without updating this list.
 */
const T3_CONNECT_TROUBLESHOOTING_SECTIONS = [
  "the-hosts-tunnel-is-offline",
  "port-7844-is-blocked-on-the-host",
  "the-tunnel-works-but-t3-code-does-not-answer",
  "the-t3-connect-address-does-not-resolve-or-answer",
  "this-device-cant-reach-t3-connect",
  "sign-in-account-or-link-problems",
  "the-clock-is-off",
  "the-host-runs-an-older-t3-code",
  "t3-connect-returned-an-error",
] as const;
export type T3ConnectTroubleshootingSection = (typeof T3_CONNECT_TROUBLESHOOTING_SECTIONS)[number];

/** Clients, the CLI, and server logs link here as "More info". */
export function t3ConnectTroubleshootingUrl(section: T3ConnectTroubleshootingSection): string {
  return `https://github.com/redwolf2019/AgentVela/blob/main/docs/user/t3-connect-troubleshooting.md#${section}`;
}

export const EnvironmentCloudLinkStateResult = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
  managedTunnelActive: Schema.optional(Schema.Boolean),
  publishAgentActivity: Schema.Boolean,
  holdWebhooksWhileOffline: Schema.optional(Schema.Boolean),
  linkRevoked: Schema.optional(Schema.Boolean),
  /** The latest check the server ran on its own, absent until one finishes. */
  reachability: Schema.optional(EnvironmentConnectReachability),
  /** The tunnel's public hostname, once cloudflared has connected. Older servers omit it. */
  tunnelHostname: Schema.optional(Schema.String),
  /** Whether this is the desktop app's own session, which may link from where it is. */
  linkableHere: Schema.optional(Schema.Boolean),
});
export type EnvironmentCloudLinkStateResult = typeof EnvironmentCloudLinkStateResult.Type;

export const EnvironmentCloudPreferencesRequest = Schema.Struct({
  publishAgentActivity: Schema.Boolean,
  holdWebhooksWhileOffline: Schema.optional(Schema.Boolean),
});
export type EnvironmentCloudPreferencesRequest = typeof EnvironmentCloudPreferencesRequest.Type;
