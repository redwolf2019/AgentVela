import * as Schema from "effect/Schema";

import { DpopFailureReason, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";

export const RelayAuthErrorReason = Schema.Literals([
  "missing_credentials",
  "invalid_credentials",
  "invalid_token",
  "token_expired",
  "invalid_dpop",
  "account_disabled",
]);
export type RelayAuthErrorReason = typeof RelayAuthErrorReason.Type;

export class RelayAuthError extends Schema.TaggedError<RelayAuthError>()(
  "RelayAuthError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: RelayAuthErrorReason,
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay authentication failed: ${this.reason}`;
  }
}

export const RelayForbiddenErrorReason = Schema.Literals([
  "admin_required",
  "registration_closed",
  "invite_invalid",
  "not_authorized",
  "environment_not_owned",
]);
export type RelayForbiddenErrorReason = typeof RelayForbiddenErrorReason.Type;

export class RelayForbiddenError extends Schema.TaggedError<RelayForbiddenError>()(
  "RelayForbiddenError",
  {
    code: Schema.Literal("forbidden"),
    reason: RelayForbiddenErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `Relay request forbidden: ${this.reason}`;
  }
}

export const RelayNotFoundResource = Schema.Literals([
  "user",
  "invite",
  "environment",
  "tunnel",
  "enrollment_token",
  "device_code",
]);
export type RelayNotFoundResource = typeof RelayNotFoundResource.Type;

export class RelayNotFoundError extends Schema.TaggedError<RelayNotFoundError>()(
  "RelayNotFoundError",
  {
    code: Schema.Literal("not_found"),
    resource: RelayNotFoundResource,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `Relay ${this.resource} not found`;
  }
}

export const RelayBadRequestErrorReason = Schema.Literals([
  "invalid_input",
  "invalid_proof",
  "proof_expired",
  "proof_replayed",
  "challenge_invalid",
  "password_too_weak",
]);
export type RelayBadRequestErrorReason = typeof RelayBadRequestErrorReason.Type;

export class RelayBadRequestError extends Schema.TaggedError<RelayBadRequestError>()(
  "RelayBadRequestError",
  {
    code: Schema.Literal("bad_request"),
    reason: RelayBadRequestErrorReason,
    detail: Schema.optionalKey(TrimmedNonEmptyString),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return this.detail ? `${this.reason}: ${this.detail}` : `Bad relay request: ${this.reason}`;
  }
}

export const RelayConflictErrorReason = Schema.Literals([
  "username_taken",
  "environment_key_mismatch",
  "environment_already_linked",
  "already_initialized",
]);
export type RelayConflictErrorReason = typeof RelayConflictErrorReason.Type;

export class RelayConflictError extends Schema.TaggedError<RelayConflictError>()(
  "RelayConflictError",
  {
    code: Schema.Literal("conflict"),
    reason: RelayConflictErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `Relay conflict: ${this.reason}`;
  }
}

export class RelayRateLimitedError extends Schema.TaggedError<RelayRateLimitedError>()(
  "RelayRateLimitedError",
  {
    code: Schema.Literal("rate_limited"),
    retryAfterSeconds: PositiveInt,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 429 },
) {
  override get message(): string {
    return `Relay rate limit exceeded; retry after ${this.retryAfterSeconds}s`;
  }
}

export const RelayTunnelOfflineReason = Schema.Literals([
  "tunnel_disconnected",
  "origin_unreachable",
  "upstream_invalid_response",
]);
export type RelayTunnelOfflineReason = typeof RelayTunnelOfflineReason.Type;

export class RelayTunnelOfflineError extends Schema.TaggedError<RelayTunnelOfflineError>()(
  "RelayTunnelOfflineError",
  {
    code: Schema.Literal("tunnel_offline"),
    reason: RelayTunnelOfflineReason,
    endpointStatus: Schema.optionalKey(Schema.Number),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 502 },
) {
  override get message(): string {
    return `Relay tunnel unavailable: ${this.reason}`;
  }
}

export class RelayEndpointTimedOutError extends Schema.TaggedError<RelayEndpointTimedOutError>()(
  "RelayEndpointTimedOutError",
  {
    code: Schema.Literal("endpoint_timed_out"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 504 },
) {
  override get message(): string {
    return "Relay environment request timed out";
  }
}

export const RelayInternalErrorReason = Schema.Literals([
  "database_unavailable",
  "persistence_failed",
  "internal_error",
]);
export type RelayInternalErrorReason = typeof RelayInternalErrorReason.Type;

export class RelayInternalError extends Schema.TaggedError<RelayInternalError>()(
  "RelayInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: RelayInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay internal error: ${this.reason}`;
  }
}

export const AgentVelaRelayError = Schema.Union([
  RelayAuthError,
  RelayForbiddenError,
  RelayNotFoundError,
  RelayBadRequestError,
  RelayConflictError,
  RelayRateLimitedError,
  RelayTunnelOfflineError,
  RelayEndpointTimedOutError,
  RelayInternalError,
]);
export type AgentVelaRelayError = typeof AgentVelaRelayError.Type;

export const AgentVelaRelayOkResponse = Schema.Struct({
  ok: Schema.Boolean,
});
export type AgentVelaRelayOkResponse = typeof AgentVelaRelayOkResponse.Type;

export const AgentVelaRelayHealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.Literal("agent-vela-relay"),
  version: TrimmedNonEmptyString,
});
export type AgentVelaRelayHealthResponse = typeof AgentVelaRelayHealthResponse.Type;
