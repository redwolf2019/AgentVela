import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "../environment.ts";
import { RelayEndpointKey, RelayEnrollmentTokenId, RelayUserId, RelayUsername } from "./auth.ts";

const RelaySignedJwtClaims = {
  iss: TrimmedNonEmptyString,
  aud: TrimmedNonEmptyString,
  sub: TrimmedNonEmptyString,
  jti: TrimmedNonEmptyString,
  iat: Schema.Int,
  exp: Schema.Int,
} as const;

export const AgentVelaRelayEndpoint = Schema.Struct({
  endpointKey: RelayEndpointKey,
  pathPrefix: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
});
export type AgentVelaRelayEndpoint = typeof AgentVelaRelayEndpoint.Type;

export const AgentVelaRelayEnvironmentStatus = Schema.Literals(["online", "offline"]);
export type AgentVelaRelayEnvironmentStatus = typeof AgentVelaRelayEnvironmentStatus.Type;

export const AgentVelaRelayEnvironmentRecord = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  endpoint: AgentVelaRelayEndpoint,
  status: AgentVelaRelayEnvironmentStatus,
  linkedAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
});
export type AgentVelaRelayEnvironmentRecord = typeof AgentVelaRelayEnvironmentRecord.Type;

export const AgentVelaRelayListEnvironmentsResponse = Schema.Struct({
  environments: Schema.Array(AgentVelaRelayEnvironmentRecord),
});
export type AgentVelaRelayListEnvironmentsResponse =
  typeof AgentVelaRelayListEnvironmentsResponse.Type;

export const AgentVelaRelayLinkChallengeResponse = Schema.Struct({
  challenge: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type AgentVelaRelayLinkChallengeResponse = typeof AgentVelaRelayLinkChallengeResponse.Type;

export const AgentVelaRelayLinkProofPayload = Schema.Struct({
  ...RelaySignedJwtClaims,
  challenge: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  environmentPublicKey: TrimmedNonEmptyString,
  descriptor: ExecutionEnvironmentDescriptor,
});
export type AgentVelaRelayLinkProofPayload = typeof AgentVelaRelayLinkProofPayload.Type;

export const AgentVelaRelayLinkRequest = Schema.Struct({
  proof: TrimmedNonEmptyString,
});
export type AgentVelaRelayLinkRequest = typeof AgentVelaRelayLinkRequest.Type;

export const AgentVelaRelayLinkResponse = Schema.Struct({
  ok: Schema.Literal(true),
  userId: RelayUserId,
  environmentId: EnvironmentId,
  endpoint: AgentVelaRelayEndpoint,
  relayIssuer: TrimmedNonEmptyString,
  environmentCredential: TrimmedNonEmptyString,
  relayMintPublicKey: TrimmedNonEmptyString,
});
export type AgentVelaRelayLinkResponse = typeof AgentVelaRelayLinkResponse.Type;

export const RelayCreateEnrollmentTokenRequest = Schema.Struct({
  labelHint: Schema.optionalKey(TrimmedNonEmptyString),
  ttlMinutes: Schema.optionalKey(PositiveInt),
});
export type RelayCreateEnrollmentTokenRequest = typeof RelayCreateEnrollmentTokenRequest.Type;

export const RelayCreateEnrollmentTokenResponse = Schema.Struct({
  tokenId: RelayEnrollmentTokenId,
  enrollmentToken: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type RelayCreateEnrollmentTokenResponse = typeof RelayCreateEnrollmentTokenResponse.Type;

export const RelayEnrollChallengeRequest = Schema.Struct({
  enrollmentToken: TrimmedNonEmptyString,
});
export type RelayEnrollChallengeRequest = typeof RelayEnrollChallengeRequest.Type;

export const RelayEnrollEnvironmentRequest = Schema.Struct({
  enrollmentToken: TrimmedNonEmptyString,
  proof: TrimmedNonEmptyString,
});
export type RelayEnrollEnvironmentRequest = typeof RelayEnrollEnvironmentRequest.Type;

export const AgentVelaRelayConnectRequest = Schema.Struct({
  deviceId: Schema.optionalKey(TrimmedNonEmptyString),
  clientProofKeyThumbprint: TrimmedNonEmptyString,
});
export type AgentVelaRelayConnectRequest = typeof AgentVelaRelayConnectRequest.Type;

export const AgentVelaRelayConnectResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: AgentVelaRelayEndpoint,
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type AgentVelaRelayConnectResponse = typeof AgentVelaRelayConnectResponse.Type;

export const AgentVelaRelayStatusResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: AgentVelaRelayEndpoint,
  status: AgentVelaRelayEnvironmentStatus,
  checkedAt: IsoDateTime,
  descriptor: Schema.optionalKey(ExecutionEnvironmentDescriptor),
  rttMs: Schema.optionalKey(NonNegativeInt),
});
export type AgentVelaRelayStatusResponse = typeof AgentVelaRelayStatusResponse.Type;

export const AgentVelaRelayMintProofPayload = Schema.Struct({
  ...RelaySignedJwtClaims,
  environmentId: EnvironmentId,
  clientProofKeyThumbprint: TrimmedNonEmptyString,
  cnf: Schema.Struct({
    jkt: TrimmedNonEmptyString,
  }),
  deviceId: Schema.optionalKey(TrimmedNonEmptyString),
  nonce: TrimmedNonEmptyString,
  scope: Schema.Array(Schema.Literal("environment:connect")),
});
export type AgentVelaRelayMintProofPayload = typeof AgentVelaRelayMintProofPayload.Type;

export const AgentVelaRelayMintResponseProofPayload = Schema.Struct({
  ...RelaySignedJwtClaims,
  environmentId: EnvironmentId,
  clientProofKeyThumbprint: TrimmedNonEmptyString,
  requestNonce: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
});
export type AgentVelaRelayMintResponseProofPayload =
  typeof AgentVelaRelayMintResponseProofPayload.Type;

export const AgentVelaRelayHealthProofPayload = Schema.Struct({
  ...RelaySignedJwtClaims,
  environmentId: EnvironmentId,
  nonce: TrimmedNonEmptyString,
  scope: Schema.Array(Schema.Literal("environment:status")),
});
export type AgentVelaRelayHealthProofPayload = typeof AgentVelaRelayHealthProofPayload.Type;

export const AgentVelaRelayHealthResponseProofPayload = Schema.Struct({
  ...RelaySignedJwtClaims,
  environmentId: EnvironmentId,
  requestNonce: TrimmedNonEmptyString,
  status: Schema.Literal("online"),
  descriptor: ExecutionEnvironmentDescriptor,
  checkedAt: IsoDateTime,
});
export type AgentVelaRelayHealthResponseProofPayload =
  typeof AgentVelaRelayHealthResponseProofPayload.Type;

export const AgentVelaRelayTunnelLoginProofPayload = Schema.Struct({
  ...RelaySignedJwtClaims,
  environmentId: EnvironmentId,
  endpointKey: Schema.optionalKey(RelayEndpointKey),
  nonce: TrimmedNonEmptyString,
});
export type AgentVelaRelayTunnelLoginProofPayload =
  typeof AgentVelaRelayTunnelLoginProofPayload.Type;

export const AgentVelaRelayHookDeliveryProofPayload = Schema.Struct({
  ...RelaySignedJwtClaims,
  environmentId: EnvironmentId,
  deliveryId: TrimmedNonEmptyString,
  receivedAt: IsoDateTime,
  hookId: TrimmedNonEmptyString,
});
export type AgentVelaRelayHookDeliveryProofPayload =
  typeof AgentVelaRelayHookDeliveryProofPayload.Type;

export const RelayPresenceEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    environments: Schema.Array(AgentVelaRelayEnvironmentRecord),
  }),
  Schema.Struct({
    type: Schema.Literal("environment.online"),
    environmentId: EnvironmentId,
    endpoint: AgentVelaRelayEndpoint,
    lastSeenAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("environment.offline"),
    environmentId: EnvironmentId,
    checkedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("environment.linked"),
    environment: AgentVelaRelayEnvironmentRecord,
  }),
  Schema.Struct({
    type: Schema.Literal("environment.unlinked"),
    environmentId: EnvironmentId,
  }),
  Schema.Struct({
    type: Schema.Literal("heartbeat"),
    serverTime: IsoDateTime,
  }),
]);
export type RelayPresenceEvent = typeof RelayPresenceEvent.Type;

export const RelayAdminTunnelTelemetry = Schema.Struct({
  environmentId: EnvironmentId,
  endpointKey: RelayEndpointKey,
  label: TrimmedNonEmptyString,
  userId: RelayUserId,
  username: RelayUsername,
  runId: PositiveInt,
  connectedAt: IsoDateTime,
  lastHeartbeatAt: IsoDateTime,
  rttMs: Schema.NullOr(NonNegativeInt),
  activeStreams: NonNegativeInt,
  bytesIn: NonNegativeInt,
  bytesOut: NonNegativeInt,
  compression: Schema.Boolean,
});
export type RelayAdminTunnelTelemetry = typeof RelayAdminTunnelTelemetry.Type;

export const RelayAdminListTunnelsResponse = Schema.Struct({
  tunnels: Schema.Array(RelayAdminTunnelTelemetry),
});
export type RelayAdminListTunnelsResponse = typeof RelayAdminListTunnelsResponse.Type;

export const RelayAdminKickTunnelRequest = Schema.Struct({
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayAdminKickTunnelRequest = typeof RelayAdminKickTunnelRequest.Type;
