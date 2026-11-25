import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "../environment.ts";
import { RelayUserId } from "./auth.ts";
import { AgentVelaRelayEndpoint } from "./environments.ts";

export const HostRelayTunnelState = Schema.Literals([
  "disconnected",
  "connecting",
  "online",
  "error",
]);
export type HostRelayTunnelState = typeof HostRelayTunnelState.Type;

export const HostRelayTunnelSnapshot = Schema.Struct({
  state: HostRelayTunnelState,
  runId: Schema.NullOr(PositiveInt),
  rttMs: Schema.NullOr(NonNegativeInt),
  activeStreams: NonNegativeInt,
  connectedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  compression: Schema.Boolean,
});
export type HostRelayTunnelSnapshot = typeof HostRelayTunnelSnapshot.Type;

export const HostRelayStatus = Schema.Struct({
  linked: Schema.Boolean,
  relayUrl: Schema.NullOr(TrimmedNonEmptyString),
  relayIssuer: Schema.NullOr(TrimmedNonEmptyString),
  userId: Schema.NullOr(RelayUserId),
  endpoint: Schema.NullOr(AgentVelaRelayEndpoint),
  tunnel: HostRelayTunnelSnapshot,
});
export type HostRelayStatus = typeof HostRelayStatus.Type;

export const HostRelayLinkProofRequest = Schema.Struct({
  relayUrl: TrimmedNonEmptyString,
  challenge: TrimmedNonEmptyString,
});
export type HostRelayLinkProofRequest = typeof HostRelayLinkProofRequest.Type;

export const HostRelayLinkProofResponse = Schema.Struct({
  environmentId: EnvironmentId,
  environmentPublicKey: TrimmedNonEmptyString,
  descriptor: ExecutionEnvironmentDescriptor,
  proof: TrimmedNonEmptyString,
});
export type HostRelayLinkProofResponse = typeof HostRelayLinkProofResponse.Type;

export const HostRelayConfigRequest = Schema.Struct({
  relayUrl: TrimmedNonEmptyString,
  relayIssuer: TrimmedNonEmptyString,
  userId: RelayUserId,
  endpoint: AgentVelaRelayEndpoint,
  environmentCredential: TrimmedNonEmptyString,
  relayMintPublicKey: TrimmedNonEmptyString,
});
export type HostRelayConfigRequest = typeof HostRelayConfigRequest.Type;
