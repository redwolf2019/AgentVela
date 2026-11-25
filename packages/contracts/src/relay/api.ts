import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";

import { EnvironmentId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import {
  AgentVelaRelayAdminAuth,
  AgentVelaRelayClientAuth,
  AgentVelaRelayDpopAuth,
  RelayAdminCreateInviteRequest,
  RelayAdminCreateInviteResponse,
  RelayAdminCreateUserRequest,
  RelayAdminListInvitesResponse,
  RelayAdminListUsersResponse,
  RelayAdminUpdateUserRequest,
  RelayAuthConfigResponse,
  RelayAuthSessionResponse,
  RelayBearerAuthHeaders,
  RelayDeviceAuthApproveRequest,
  RelayDeviceAuthPollRequest,
  RelayDeviceAuthPollResponse,
  RelayDeviceAuthStartRequest,
  RelayDeviceAuthStartResponse,
  RelayDpopAuthHeaders,
  RelayDpopTokenExchangeRequest,
  RelayDpopTokenExchangeResponse,
  RelayEndpointKey,
  RelayInviteId,
  RelayLoginRequest,
  RelayLogoutRequest,
  RelayRefreshRequest,
  RelayRegisterRequest,
  RelayUserId,
  RelayUserRecord,
} from "./auth.ts";
import {
  AgentVelaRelayConnectRequest,
  AgentVelaRelayConnectResponse,
  AgentVelaRelayLinkChallengeResponse,
  AgentVelaRelayLinkRequest,
  AgentVelaRelayLinkResponse,
  AgentVelaRelayListEnvironmentsResponse,
  AgentVelaRelayStatusResponse,
  RelayAdminKickTunnelRequest,
  RelayAdminListTunnelsResponse,
  RelayCreateEnrollmentTokenRequest,
  RelayCreateEnrollmentTokenResponse,
  RelayEnrollChallengeRequest,
  RelayEnrollEnvironmentRequest,
} from "./environments.ts";
import {
  AgentVelaRelayHealthResponse,
  AgentVelaRelayOkResponse,
  RelayAuthError,
  RelayBadRequestError,
  RelayConflictError,
  RelayEndpointTimedOutError,
  RelayForbiddenError,
  RelayInternalError,
  RelayNotFoundError,
  RelayRateLimitedError,
  RelayTunnelOfflineError,
} from "./errors.ts";

export const RELAY_TUNNEL_CONNECT_PATH = "/v1/tunnel/connect" as const;
export const RELAY_PRESENCE_EVENTS_PATH = "/v1/events" as const;

const HealthGroup = HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: AgentVelaRelayHealthResponse,
      error: RelayInternalError,
    }).annotate(OpenApi.Summary, "Check relay health"),
  )
  .annotate(OpenApi.Description, "Service health and readiness.");

const AuthPublicGroup = HttpApiGroup.make("authPublic")
  .add(
    HttpApiEndpoint.get("getConfig", "/v1/auth/config", {
      success: RelayAuthConfigResponse,
      error: RelayInternalError,
    }).annotate(OpenApi.Summary, "Read relay auth configuration"),
    HttpApiEndpoint.post("login", "/v1/auth/login", {
      payload: RelayLoginRequest,
      success: RelayAuthSessionResponse,
      error: [RelayAuthError, RelayBadRequestError, RelayRateLimitedError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Sign in with username and password"),
    HttpApiEndpoint.post("register", "/v1/auth/register", {
      payload: RelayRegisterRequest,
      success: RelayAuthSessionResponse,
      error: [
        RelayBadRequestError,
        RelayForbiddenError,
        RelayConflictError,
        RelayRateLimitedError,
        RelayInternalError,
      ],
    }).annotate(OpenApi.Summary, "Register a relay account"),
    HttpApiEndpoint.post("refresh", "/v1/auth/refresh", {
      payload: RelayRefreshRequest,
      success: RelayAuthSessionResponse,
      error: [RelayAuthError, RelayRateLimitedError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Refresh a relay session"),
    HttpApiEndpoint.post("startDeviceAuth", "/v1/auth/device/start", {
      payload: RelayDeviceAuthStartRequest,
      success: RelayDeviceAuthStartResponse,
      error: [RelayBadRequestError, RelayRateLimitedError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Start CLI device authorization flow"),
    HttpApiEndpoint.post("pollDeviceAuth", "/v1/auth/device/poll", {
      payload: RelayDeviceAuthPollRequest,
      success: RelayDeviceAuthPollResponse,
      error: [RelayNotFoundError, RelayRateLimitedError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Poll CLI device authorization status"),
    HttpApiEndpoint.post("createEnrollmentChallenge", "/v1/environments/enroll/challenge", {
      payload: RelayEnrollChallengeRequest,
      success: AgentVelaRelayLinkChallengeResponse,
      error: [RelayAuthError, RelayNotFoundError, RelayRateLimitedError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Request a challenge for headless environment enrollment"),
    HttpApiEndpoint.post("enrollEnvironment", "/v1/environments/enroll", {
      payload: RelayEnrollEnvironmentRequest,
      success: AgentVelaRelayLinkResponse,
      error: [
        RelayAuthError,
        RelayBadRequestError,
        RelayConflictError,
        RelayNotFoundError,
        RelayRateLimitedError,
        RelayInternalError,
      ],
    }).annotate(OpenApi.Summary, "Enroll an environment using a one-time enrollment token"),
  )
  .annotate(
    OpenApi.Description,
    "Unauthenticated login, refresh, device-code, and enrollment APIs.",
  );

const AgentVelaRelayDpopTokenEndpoint = HttpApiEndpoint.post(
  "exchangeDpopToken",
  "/v1/auth/dpop-token",
  {
    headers: RelayDpopAuthHeaders,
    payload: RelayDpopTokenExchangeRequest,
    success: RelayDpopTokenExchangeResponse,
    error: [RelayAuthError, RelayBadRequestError, RelayInternalError],
  },
).annotate(OpenApi.Summary, "Exchange a relay session token for a DPoP-bound token");

const AuthSessionGroup = HttpApiGroup.make("authSession")
  .add(
    HttpApiEndpoint.get("getMe", "/v1/auth/me", {
      headers: RelayBearerAuthHeaders,
      success: RelayUserRecord,
      error: [RelayAuthError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Read signed-in relay account"),
    HttpApiEndpoint.post("logout", "/v1/auth/logout", {
      headers: RelayBearerAuthHeaders,
      payload: RelayLogoutRequest,
      success: AgentVelaRelayOkResponse,
      error: [RelayAuthError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Revoke a relay refresh session"),
    HttpApiEndpoint.post("approveDeviceAuth", "/v1/auth/device/approve", {
      headers: RelayBearerAuthHeaders,
      payload: RelayDeviceAuthApproveRequest,
      success: AgentVelaRelayOkResponse,
      error: [RelayAuthError, RelayBadRequestError, RelayNotFoundError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Approve a pending CLI device code"),
    AgentVelaRelayDpopTokenEndpoint,
  )
  .annotate(OpenApi.Description, "Authenticated relay user session endpoints.")
  .middleware(AgentVelaRelayClientAuth);

const EnvironmentsGroup = HttpApiGroup.make("environments")
  .add(
    HttpApiEndpoint.get("list", "/v1/environments", {
      headers: RelayBearerAuthHeaders,
      success: AgentVelaRelayListEnvironmentsResponse,
      error: [RelayAuthError, RelayInternalError],
    }).annotate(OpenApi.Summary, "List linked environments"),
    HttpApiEndpoint.post("createLinkChallenge", "/v1/environments/link-challenges", {
      headers: RelayBearerAuthHeaders,
      success: AgentVelaRelayLinkChallengeResponse,
      error: [RelayAuthError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Create a challenge for linking an environment"),
    HttpApiEndpoint.post("link", "/v1/environments/link", {
      headers: RelayBearerAuthHeaders,
      payload: AgentVelaRelayLinkRequest,
      success: AgentVelaRelayLinkResponse,
      error: [RelayAuthError, RelayBadRequestError, RelayConflictError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Link an environment to the signed-in relay account"),
    HttpApiEndpoint.delete("unlink", "/v1/environments/:environmentId", {
      headers: RelayBearerAuthHeaders,
      params: Schema.Struct({ environmentId: EnvironmentId }),
      success: AgentVelaRelayOkResponse,
      error: [RelayAuthError, RelayForbiddenError, RelayNotFoundError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Unlink an environment"),
    HttpApiEndpoint.post("createEnrollmentToken", "/v1/environments/enrollment-tokens", {
      headers: RelayBearerAuthHeaders,
      payload: RelayCreateEnrollmentTokenRequest,
      success: RelayCreateEnrollmentTokenResponse,
      error: [RelayAuthError, RelayBadRequestError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Create a short-lived one-time environment enrollment token"),
  )
  .annotate(OpenApi.Description, "Environment registration and enrollment management.")
  .middleware(AgentVelaRelayClientAuth);

const AgentVelaRelayConnectEnvironmentEndpoint = HttpApiEndpoint.post(
  "connectEnvironment",
  "/v1/environments/:environmentId/connect",
  {
    headers: RelayDpopAuthHeaders,
    params: Schema.Struct({ environmentId: EnvironmentId }),
    payload: AgentVelaRelayConnectRequest,
    success: AgentVelaRelayConnectResponse,
    error: [
      RelayAuthError,
      RelayForbiddenError,
      RelayNotFoundError,
      RelayTunnelOfflineError,
      RelayEndpointTimedOutError,
      RelayInternalError,
    ],
  },
).annotate(OpenApi.Summary, "Mint a DPoP-bound bootstrap credential for an environment");

const AgentVelaRelayEnvironmentStatusEndpoint = HttpApiEndpoint.post(
  "getEnvironmentStatus",
  "/v1/environments/:environmentId/status",
  {
    headers: RelayDpopAuthHeaders,
    params: Schema.Struct({ environmentId: EnvironmentId }),
    success: AgentVelaRelayStatusResponse,
    error: [
      RelayAuthError,
      RelayForbiddenError,
      RelayNotFoundError,
      RelayTunnelOfflineError,
      RelayEndpointTimedOutError,
      RelayInternalError,
    ],
  },
).annotate(OpenApi.Summary, "Check live status of a linked environment");

const ConnectGroup = HttpApiGroup.make("connect")
  .add(AgentVelaRelayConnectEnvironmentEndpoint, AgentVelaRelayEnvironmentStatusEndpoint)
  .annotate(OpenApi.Description, "DPoP-authenticated environment status and connection brokering.")
  .middleware(AgentVelaRelayDpopAuth);

const AdminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("listUsers", "/v1/admin/users", {
      headers: RelayBearerAuthHeaders,
      success: RelayAdminListUsersResponse,
      error: [RelayAuthError, RelayForbiddenError, RelayInternalError],
    }).annotate(OpenApi.Summary, "List all relay users"),
    HttpApiEndpoint.post("createUser", "/v1/admin/users", {
      headers: RelayBearerAuthHeaders,
      payload: RelayAdminCreateUserRequest,
      success: RelayUserRecord,
      error: [
        RelayAuthError,
        RelayForbiddenError,
        RelayBadRequestError,
        RelayConflictError,
        RelayInternalError,
      ],
    }).annotate(OpenApi.Summary, "Create a relay user"),
    HttpApiEndpoint.patch("updateUser", "/v1/admin/users/:userId", {
      headers: RelayBearerAuthHeaders,
      params: Schema.Struct({ userId: RelayUserId }),
      payload: RelayAdminUpdateUserRequest,
      success: RelayUserRecord,
      error: [
        RelayAuthError,
        RelayForbiddenError,
        RelayBadRequestError,
        RelayNotFoundError,
        RelayInternalError,
      ],
    }).annotate(OpenApi.Summary, "Update user role, password, or disabled flag"),
    HttpApiEndpoint.get("listInvites", "/v1/admin/invites", {
      headers: RelayBearerAuthHeaders,
      success: RelayAdminListInvitesResponse,
      error: [RelayAuthError, RelayForbiddenError, RelayInternalError],
    }).annotate(OpenApi.Summary, "List relay invite codes"),
    HttpApiEndpoint.post("createInvite", "/v1/admin/invites", {
      headers: RelayBearerAuthHeaders,
      payload: RelayAdminCreateInviteRequest,
      success: RelayAdminCreateInviteResponse,
      error: [RelayAuthError, RelayForbiddenError, RelayBadRequestError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Create a relay invite code"),
    HttpApiEndpoint.delete("revokeInvite", "/v1/admin/invites/:inviteId", {
      headers: RelayBearerAuthHeaders,
      params: Schema.Struct({ inviteId: RelayInviteId }),
      success: AgentVelaRelayOkResponse,
      error: [RelayAuthError, RelayForbiddenError, RelayNotFoundError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Revoke an invite code"),
    HttpApiEndpoint.get("listTunnels", "/v1/admin/tunnels", {
      headers: RelayBearerAuthHeaders,
      success: RelayAdminListTunnelsResponse,
      error: [RelayAuthError, RelayForbiddenError, RelayInternalError],
    }).annotate(OpenApi.Summary, "List active tunnel telemetry"),
    HttpApiEndpoint.post("kickTunnel", "/v1/admin/tunnels/:environmentId/kick", {
      headers: RelayBearerAuthHeaders,
      params: Schema.Struct({ environmentId: EnvironmentId }),
      payload: RelayAdminKickTunnelRequest,
      success: AgentVelaRelayOkResponse,
      error: [RelayAuthError, RelayForbiddenError, RelayNotFoundError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Force disconnect an active tunnel"),
  )
  .annotate(OpenApi.Description, "Administrator user, invite, and tunnel telemetry management.")
  .middleware(AgentVelaRelayAdminAuth);

const HookParams = Schema.Struct({
  endpointKey: RelayEndpointKey,
  hookId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
});
const RELAY_HOOK_PATH = "/v1/hooks/:endpointKey/:hookId/:token";
const hookEndpointSpec = { params: HookParams } as const;

const HooksGroup = HttpApiGroup.make("hooks")
  .add(
    HttpApiEndpoint.get("forwardGet", RELAY_HOOK_PATH, hookEndpointSpec),
    HttpApiEndpoint.post("forwardPost", RELAY_HOOK_PATH, hookEndpointSpec),
    HttpApiEndpoint.put("forwardPut", RELAY_HOOK_PATH, hookEndpointSpec),
    HttpApiEndpoint.patch("forwardPatch", RELAY_HOOK_PATH, hookEndpointSpec),
  )
  .annotate(OpenApi.Description, "Forward live webhook requests to online environments.");

export const AgentVelaRelayApi = HttpApi.make("AgentVelaRelayApi")
  .add(
    HealthGroup,
    AuthPublicGroup,
    AuthSessionGroup,
    EnvironmentsGroup,
    ConnectGroup,
    AdminGroup,
    HooksGroup,
  )
  .annotate(OpenApi.Title, "AgentVela Relay API")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(OpenApi.Description, "Self-hosted control-plane and tunnel broker API for AgentVela.");
export type AgentVelaRelayApi = typeof AgentVelaRelayApi;
