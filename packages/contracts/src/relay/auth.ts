import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as OpenApi from "effect/http-api/OpenApi";

import {
  ClientSurface,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { RelayAuthError, RelayForbiddenError, RelayInternalError } from "./errors.ts";

export const RelayUserId = TrimmedNonEmptyString.pipe(Schema.brand("RelayUserId"));
export type RelayUserId = typeof RelayUserId.Type;

export const RelayInviteId = TrimmedNonEmptyString.pipe(Schema.brand("RelayInviteId"));
export type RelayInviteId = typeof RelayInviteId.Type;

export const RelayEnrollmentTokenId = TrimmedNonEmptyString.pipe(
  Schema.brand("RelayEnrollmentTokenId"),
);
export type RelayEnrollmentTokenId = typeof RelayEnrollmentTokenId.Type;

export const RELAY_ENDPOINT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{3,63}$/;
export const RelayEndpointKey = TrimmedNonEmptyString.check(
  Schema.isPattern(RELAY_ENDPOINT_KEY_PATTERN),
).pipe(Schema.brand("RelayEndpointKey"));
export type RelayEndpointKey = typeof RelayEndpointKey.Type;

export const RELAY_USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/;
export const RelayUsername = TrimmedNonEmptyString.check(Schema.isPattern(RELAY_USERNAME_PATTERN));
export type RelayUsername = typeof RelayUsername.Type;

export const RelayUserRole = Schema.Literals(["admin", "member"]);
export type RelayUserRole = typeof RelayUserRole.Type;

export const RelayUserRecord = Schema.Struct({
  userId: RelayUserId,
  username: RelayUsername,
  role: RelayUserRole,
  disabled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RelayUserRecord = typeof RelayUserRecord.Type;

export const RelayAuthConfigResponse = Schema.Struct({
  initialized: Schema.Boolean,
  registrationOpen: Schema.Boolean,
  version: TrimmedNonEmptyString,
});
export type RelayAuthConfigResponse = typeof RelayAuthConfigResponse.Type;

export const RelayLoginRequest = Schema.Struct({
  username: RelayUsername,
  password: TrimmedNonEmptyString,
  clientSurface: Schema.optionalKey(ClientSurface),
  deviceLabel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayLoginRequest = typeof RelayLoginRequest.Type;

export const RelayRegisterRequest = Schema.Struct({
  username: RelayUsername,
  password: TrimmedNonEmptyString,
  inviteCode: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayRegisterRequest = typeof RelayRegisterRequest.Type;

export const RelayAuthSessionResponse = Schema.Struct({
  user: RelayUserRecord,
  accessToken: TrimmedNonEmptyString,
  accessTokenExpiresAt: IsoDateTime,
  refreshToken: TrimmedNonEmptyString,
  refreshTokenExpiresAt: IsoDateTime,
});
export type RelayAuthSessionResponse = typeof RelayAuthSessionResponse.Type;

export const RelayRefreshRequest = Schema.Struct({
  refreshToken: TrimmedNonEmptyString,
});
export type RelayRefreshRequest = typeof RelayRefreshRequest.Type;

export const RelayLogoutRequest = Schema.Struct({
  refreshToken: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayLogoutRequest = typeof RelayLogoutRequest.Type;

export const RelayDeviceAuthStartRequest = Schema.Struct({
  deviceLabel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayDeviceAuthStartRequest = typeof RelayDeviceAuthStartRequest.Type;

export const RelayDeviceAuthStartResponse = Schema.Struct({
  deviceCode: TrimmedNonEmptyString,
  userCode: TrimmedNonEmptyString,
  verificationPath: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  intervalSeconds: PositiveInt,
});
export type RelayDeviceAuthStartResponse = typeof RelayDeviceAuthStartResponse.Type;

export const RelayDeviceAuthApproveRequest = Schema.Struct({
  userCode: TrimmedNonEmptyString,
});
export type RelayDeviceAuthApproveRequest = typeof RelayDeviceAuthApproveRequest.Type;

export const RelayDeviceAuthPollRequest = Schema.Struct({
  deviceCode: TrimmedNonEmptyString,
});
export type RelayDeviceAuthPollRequest = typeof RelayDeviceAuthPollRequest.Type;

export const RelayDeviceAuthPollResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    session: RelayAuthSessionResponse,
  }),
  Schema.Struct({
    status: Schema.Literal("expired"),
  }),
]);
export type RelayDeviceAuthPollResponse = typeof RelayDeviceAuthPollResponse.Type;

export const AgentVelaRelayConnectScope = "environment:connect" as const;
export const AgentVelaRelayStatusScope = "environment:status" as const;
export const AgentVelaRelayDpopScope = Schema.Literals([
  AgentVelaRelayConnectScope,
  AgentVelaRelayStatusScope,
]);
export type AgentVelaRelayDpopScope = typeof AgentVelaRelayDpopScope.Type;

export const RelayDpopTokenExchangeRequest = Schema.Struct({
  scopes: Schema.Array(AgentVelaRelayDpopScope).check(Schema.isMinLength(1)),
  clientSurface: ClientSurface,
});
export type RelayDpopTokenExchangeRequest = typeof RelayDpopTokenExchangeRequest.Type;

export const RelayDpopTokenExchangeResponse = Schema.Struct({
  accessToken: TrimmedNonEmptyString,
  tokenType: Schema.Literal("DPoP"),
  expiresIn: PositiveInt,
  scopes: Schema.Array(AgentVelaRelayDpopScope),
});
export type RelayDpopTokenExchangeResponse = typeof RelayDpopTokenExchangeResponse.Type;

export const RelayAdminCreateUserRequest = Schema.Struct({
  username: RelayUsername,
  password: TrimmedNonEmptyString,
  role: RelayUserRole,
});
export type RelayAdminCreateUserRequest = typeof RelayAdminCreateUserRequest.Type;

export const RelayAdminUpdateUserRequest = Schema.Struct({
  role: Schema.optionalKey(RelayUserRole),
  disabled: Schema.optionalKey(Schema.Boolean),
  password: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RelayAdminUpdateUserRequest = typeof RelayAdminUpdateUserRequest.Type;

export const RelayAdminListUsersResponse = Schema.Struct({
  users: Schema.Array(RelayUserRecord),
});
export type RelayAdminListUsersResponse = typeof RelayAdminListUsersResponse.Type;

// Invite reads expose only a non-sensitive prefix so raw codes cannot be replayed from list APIs.
export const RelayInviteRecord = Schema.Struct({
  inviteId: RelayInviteId,
  codePrefix: TrimmedNonEmptyString,
  role: RelayUserRole,
  maxUses: PositiveInt,
  usesCount: NonNegativeInt,
  expiresAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  createdByUserId: RelayUserId,
  createdAt: IsoDateTime,
});
export type RelayInviteRecord = typeof RelayInviteRecord.Type;

export const RelayAdminCreateInviteRequest = Schema.Struct({
  role: Schema.optionalKey(RelayUserRole),
  maxUses: Schema.optionalKey(PositiveInt),
  ttlHours: Schema.optionalKey(PositiveInt),
});
export type RelayAdminCreateInviteRequest = typeof RelayAdminCreateInviteRequest.Type;

export const RelayAdminCreateInviteResponse = Schema.Struct({
  invite: RelayInviteRecord,
  code: TrimmedNonEmptyString,
});
export type RelayAdminCreateInviteResponse = typeof RelayAdminCreateInviteResponse.Type;

export const RelayAdminListInvitesResponse = Schema.Struct({
  invites: Schema.Array(RelayInviteRecord),
});
export type RelayAdminListInvitesResponse = typeof RelayAdminListInvitesResponse.Type;

export class AgentVelaRelayClientPrincipal extends Context.Service<
  AgentVelaRelayClientPrincipal,
  {
    readonly userId: RelayUserId;
    readonly username: RelayUsername;
    readonly role: RelayUserRole;
    readonly token: string;
    readonly proofKeyThumbprint?: string;
    readonly dpopScopes?: ReadonlyArray<AgentVelaRelayDpopScope>;
  }
>()("@t3tools/contracts/relay/auth/AgentVelaRelayClientPrincipal") {}

const RelayBearerSecurity = HttpApiSecurity.http({ scheme: "bearer" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Short-lived bearer access token issued by agent-vela-relay.",
  ),
);

const RelayDpopSecurity = HttpApiSecurity.http({ scheme: "DPoP" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "DPoP-bound relay access token accompanied by a matching DPoP proof header.",
  ),
);

export class AgentVelaRelayClientAuth extends HttpApiMiddleware.Service<
  AgentVelaRelayClientAuth,
  { provides: AgentVelaRelayClientPrincipal }
>()("AgentVelaRelayClientAuth", {
  error: [RelayAuthError, RelayInternalError],
  security: { relayBearer: RelayBearerSecurity },
}) {}

export class AgentVelaRelayAdminAuth extends HttpApiMiddleware.Service<
  AgentVelaRelayAdminAuth,
  { provides: AgentVelaRelayClientPrincipal }
>()("AgentVelaRelayAdminAuth", {
  error: [RelayAuthError, RelayForbiddenError, RelayInternalError],
  security: { relayAdminBearer: RelayBearerSecurity },
}) {}

export class AgentVelaRelayDpopAuth extends HttpApiMiddleware.Service<
  AgentVelaRelayDpopAuth,
  { provides: AgentVelaRelayClientPrincipal }
>()("AgentVelaRelayDpopAuth", {
  error: [RelayAuthError, RelayInternalError],
  security: { relayDpop: RelayDpopSecurity },
}) {}

export const RelayBearerAuthHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
});

export const RelayDpopAuthHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
  dpop: TrimmedNonEmptyString,
});
