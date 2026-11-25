import { msg } from "gt-i18n";
import {
  type AgentVelaRelayDpopScope,
  AgentVelaRelayError,
  type AgentVelaRelayError as AgentVelaRelayErrorType,
  type RelayAuthError,
  type RelayBadRequestError,
  type RelayConflictError,
  type RelayForbiddenError,
  type RelayTunnelOfflineError,
} from "@t3tools/contracts/agentVelaRelay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClientError from "effect/http/HttpClientError";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "../connection/model.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import {
  type MarkedText,
  detailFromError,
  markedTextEnglish,
  translatableDetail,
} from "../errors/translatable.ts";
import { dpopFailureText } from "./errorPresentation.ts";
import type {
  ManagedRelayDpopKeyLoadError,
  ManagedRelayDpopProofCreationError,
} from "./managedRelay.ts";

export class RelayUrlInvalidError extends Schema.TaggedError<RelayUrlInvalidError>()(
  "RelayUrlInvalidError",
  {
    relayUrl: Schema.String,
    reason: Schema.Literals(["invalid_format", "public_http_disallowed"]),
  },
) {
  override get message(): string {
    return markedTextEnglish(this.i18nMessage);
  }

  get i18nMessage(): MarkedText {
    return this.reason === "public_http_disallowed"
      ? [
          msg(
            "Public relay addresses must use https://. Plain http:// is allowed only for loopback, LAN, or Tailscale addresses.",
          ),
        ]
      : [msg("Relay URL must be an absolute origin such as https://relay.example.com.")];
  }
}

export class RelayNotConfiguredError extends Schema.TaggedError<RelayNotConfiguredError>()(
  "RelayNotConfiguredError",
  {},
) {
  override get message(): string {
    return markedTextEnglish(this.i18nMessage);
  }

  get i18nMessage(): MarkedText {
    return [msg("No relay server URL is configured.")];
  }
}

export class RelaySessionUnavailableError extends Schema.TaggedError<RelaySessionUnavailableError>()(
  "RelaySessionUnavailableError",
  {
    reason: Schema.Literals(["signed_out", "relay_mismatch", "refresh_failed"]),
  },
) {
  override get message(): string {
    return markedTextEnglish(this.i18nMessage);
  }

  get i18nMessage(): MarkedText {
    switch (this.reason) {
      case "signed_out":
        return [msg("Sign in to the relay server first.")];
      case "relay_mismatch":
        return [msg("The relay session belongs to a different relay server.")];
      case "refresh_failed":
        return [msg("Your relay session expired. Sign in again.")];
    }
  }
}

export class RelayApiRequestError extends Schema.TaggedError<RelayApiRequestError>()(
  "RelayApiRequestError",
  {
    action: Schema.String,
    transportFailed: Schema.optionalKey(Schema.Boolean),
    cause: Schema.Defect(),
    relayError: Schema.optional(AgentVelaRelayError),
    status: Schema.optional(Schema.Number),
    traceId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return markedTextEnglish(this.i18nMessage);
  }

  get i18nMessage(): MarkedText {
    if (this.transportFailed) {
      return [
        msg("Relay request ({action}) could not reach the server.", { action: this.action }),
        NETWORK_BLOCKING_HINT,
      ];
    }
    if (this.relayError) {
      return agentVelaRelayErrorText(this.relayError);
    }
    if (this.status !== undefined) {
      return [
        msg("Relay returned HTTP {status} during {action}.", {
          status: this.status,
          action: this.action,
        }),
      ];
    }
    return [msg("Relay request ({action}) failed.", { action: this.action })];
  }
}

export class RelayApiTimeoutError extends Schema.TaggedError<RelayApiTimeoutError>()(
  "RelayApiTimeoutError",
  {
    action: Schema.String,
    timeoutMs: Schema.Number,
    traceId: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return markedTextEnglish(this.i18nMessage);
  }

  get i18nMessage(): MarkedText {
    return [
      msg("Relay request ({action}) timed out.", { action: this.action }),
      NETWORK_BLOCKING_HINT,
    ];
  }
}

export class RelayDpopScopeError extends Schema.TaggedError<RelayDpopScopeError>()(
  "RelayDpopScopeError",
  {
    requestedScopes: Schema.Array(Schema.String),
    grantedScopes: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return markedTextEnglish(this.i18nMessage);
  }

  get i18nMessage(): MarkedText {
    return [msg("Relay granted fewer DPoP scopes than requested.")];
  }
}

export type SelfHostedRelayError =
  | RelayUrlInvalidError
  | RelayNotConfiguredError
  | RelaySessionUnavailableError
  | RelayApiRequestError
  | RelayApiTimeoutError
  | RelayDpopScopeError
  | ManagedRelayDpopKeyLoadError
  | ManagedRelayDpopProofCreationError;

const isAgentVelaRelayError = Schema.is(AgentVelaRelayError);
const TRACEPARENT_TRACE_ID = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i;

function untypedHttpErrorFields(cause: unknown) {
  const response = HttpClientError.isHttpClientError(cause) ? cause.response : undefined;
  if (!response) return {};
  const traceId = TRACEPARENT_TRACE_ID.exec(response.headers.traceparent ?? "")?.[1];
  return { status: response.status, ...(traceId ? { traceId } : {}) };
}

export function toRelayApiRequestError(action: string, cause: unknown): RelayApiRequestError {
  return new RelayApiRequestError({
    action,
    transportFailed:
      HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError",
    cause,
    ...(isAgentVelaRelayError(cause)
      ? { relayError: cause, traceId: cause.traceId }
      : untypedHttpErrorFields(cause)),
  });
}

export function withRelayTimeout<A, E, R>(
  action: string,
  timeoutMs: number,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RelayApiTimeoutError, R> {
  return effect.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.currentParentSpan.pipe(
            Effect.map((span) => span.traceId),
            Effect.orElseSucceed(() => null),
            Effect.flatMap((traceId) =>
              Effect.fail(new RelayApiTimeoutError({ action, timeoutMs, traceId })),
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
}

export function hasMissingDpopScopes(
  requested: ReadonlyArray<AgentVelaRelayDpopScope>,
  granted: ReadonlyArray<AgentVelaRelayDpopScope>,
): boolean {
  const grantedSet = new Set(granted);
  return requested.some((scope) => !grantedSet.has(scope));
}

function relayAuthErrorText(error: RelayAuthError): MarkedText {
  switch (error.reason) {
    case "missing_credentials":
      return [msg("Relay session credentials are missing.")];
    case "invalid_credentials":
      return [msg("Invalid relay username or password.")];
    case "invalid_token":
      return [msg("Relay rejected the session token.")];
    case "token_expired":
      return [msg("Your relay session expired. Sign in again.")];
    case "account_disabled":
      return [msg("Your relay account has been disabled by an administrator.")];
    case "invalid_dpop":
      return dpopFailureText(msg("Relay rejected the DPoP proof."), error.dpopFailureReason);
  }
}

function relayForbiddenErrorText(error: RelayForbiddenError): MarkedText {
  switch (error.reason) {
    case "admin_required":
      return [msg("Administrator privileges are required for this relay action.")];
    case "registration_closed":
      return [msg("Registration is closed on this relay server.")];
    case "invite_invalid":
      return [msg("The invite code is invalid, expired, or has already been used.")];
    case "environment_not_owned":
      return [msg("This relay account does not own the requested environment.")];
    case "not_authorized":
      return [msg("Relay rejected the request as unauthorized.")];
  }
}

function relayBadRequestErrorText(error: RelayBadRequestError): MarkedText {
  switch (error.reason) {
    case "proof_expired":
      return [msg("The environment proof expired. Try linking again.")];
    case "proof_replayed":
      return [msg("Relay rejected a replayed environment proof.")];
    case "challenge_invalid":
      return [msg("The relay link challenge is invalid or expired.")];
    case "password_too_weak":
      return [msg("Password does not meet the relay server's strength requirements.")];
    case "invalid_proof":
      return [msg("Relay rejected the cryptographic environment proof.")];
    case "invalid_input":
      return error.detail
        ? [msg("Invalid relay request ({detail}).", { detail: error.detail })]
        : [msg("Relay rejected the request input.")];
  }
}

function relayConflictErrorText(error: RelayConflictError): MarkedText {
  switch (error.reason) {
    case "username_taken":
      return [msg("That relay username is already taken.")];
    case "environment_key_mismatch":
      return [msg("This environment key is already bound to a different public key.")];
    case "environment_already_linked":
      return [msg("This environment is already linked on the relay.")];
    case "already_initialized":
      return [msg("This relay server has already been initialized.")];
  }
}

function relayTunnelOfflineErrorText(error: RelayTunnelOfflineError): MarkedText {
  switch (error.reason) {
    case "tunnel_disconnected":
      return [msg("The environment's relay tunnel is offline.")];
    case "origin_unreachable":
      return [msg("Relay tunnel is online, but the host server did not answer.")];
    case "upstream_invalid_response":
      return [msg("The host server sent an invalid response over the relay tunnel.")];
  }
}

function agentVelaRelayErrorText(error: AgentVelaRelayErrorType): MarkedText {
  switch (error._tag) {
    case "RelayAuthError":
      return relayAuthErrorText(error);
    case "RelayForbiddenError":
      return relayForbiddenErrorText(error);
    case "RelayNotFoundError":
      return [msg("Relay {resource} could not be found.", { resource: error.resource })];
    case "RelayBadRequestError":
      return relayBadRequestErrorText(error);
    case "RelayConflictError":
      return relayConflictErrorText(error);
    case "RelayRateLimitedError":
      return [
        msg("Relay rate limit reached. Try again in {seconds}s.", {
          seconds: error.retryAfterSeconds,
        }),
      ];
    case "RelayTunnelOfflineError":
      return relayTunnelOfflineErrorText(error);
    case "RelayEndpointTimedOutError":
      return [msg("Relay timed out waiting for the environment to respond.")];
    case "RelayInternalError":
      return [msg("Relay encountered an internal error ({reason}).", { reason: error.reason })];
  }
}

export function selfHostedRelayErrorText(error: SelfHostedRelayError): MarkedText {
  if ("i18nMessage" in error && error.i18nMessage !== undefined) {
    return error.i18nMessage;
  }
  return [error.message];
}

function mapAgentVelaRelayError(error: AgentVelaRelayErrorType): ConnectionAttemptError {
  const text = agentVelaRelayErrorText(error);
  const fields = { ...translatableDetail(...text), traceId: error.traceId };
  switch (error._tag) {
    case "RelayAuthError":
      return new ConnectionBlockedError({
        reason: "authentication",
        ...fields,
        hop: "relay",
        ...(error.dpopFailureReason === "time_window" ? { failureCause: "clock_skew" } : {}),
      });
    case "RelayForbiddenError":
    case "RelayConflictError":
      return new ConnectionBlockedError({ reason: "permission", ...fields, hop: "relay" });
    case "RelayNotFoundError":
      return new ConnectionBlockedError({
        reason: error.resource === "environment" ? "permission" : "configuration",
        ...fields,
        hop: "relay",
        ...(error.resource === "environment" ? { failureCause: "not_linked" } : {}),
      });
    case "RelayBadRequestError":
      return new ConnectionBlockedError({ reason: "configuration", ...fields, hop: "relay" });
    case "RelayTunnelOfflineError": {
      const failureCause =
        error.reason === "tunnel_disconnected"
          ? "tunnel_down"
          : error.reason === "origin_unreachable"
            ? "origin_unreachable"
            : "invalid_response";
      return new ConnectionTransientError({
        reason: "endpoint-unavailable",
        ...fields,
        hop: error.reason === "tunnel_disconnected" ? "tunnel" : "server",
        via: "relay",
        failureCause,
        ...(error.endpointStatus !== undefined ? { httpStatus: error.endpointStatus } : {}),
      });
    }
    case "RelayEndpointTimedOutError":
      return new ConnectionTransientError({
        reason: "timeout",
        ...fields,
        hop: "tunnel",
        via: "relay",
        failureCause: "timeout",
      });
    case "RelayRateLimitedError":
      return new ConnectionTransientError({
        reason: "relay-unavailable",
        ...fields,
        hop: "relay",
        httpStatus: 429,
        failureCause: "relay_error",
      });
    case "RelayInternalError":
      return new ConnectionTransientError({
        reason: "relay-unavailable",
        ...fields,
        hop: "relay",
        httpStatus: 500,
        failureCause: "relay_error",
      });
  }
}

export function mapSelfHostedRelayError(error: SelfHostedRelayError): ConnectionAttemptError {
  switch (error._tag) {
    case "RelayUrlInvalidError":
    case "RelayNotConfiguredError":
      return new ConnectionBlockedError({
        reason: "configuration",
        ...detailFromError(error),
        hop: "relay",
      });
    case "RelaySessionUnavailableError":
      return new ConnectionBlockedError({
        reason: "authentication",
        ...detailFromError(error),
        hop: "relay",
      });
    case "RelayDpopScopeError":
      return new ConnectionBlockedError({
        reason: "permission",
        ...detailFromError(error),
        hop: "relay",
      });
    case "ManagedRelayDpopKeyLoadError":
    case "ManagedRelayDpopProofCreationError":
      return new ConnectionBlockedError({
        reason: "authentication",
        ...detailFromError(error),
        hop: "device",
      });
    case "RelayApiTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        ...detailFromError(error),
        hop: "relay",
        ...(error.traceId ? { traceId: error.traceId } : {}),
      });
    case "RelayApiRequestError":
      if (error.relayError) {
        return mapAgentVelaRelayError(error.relayError);
      }
      return new ConnectionTransientError({
        reason: "relay-unavailable",
        ...detailFromError(error),
        hop: "relay",
        ...(error.status !== undefined
          ? { httpStatus: error.status, failureCause: "relay_error" }
          : {}),
        ...(error.traceId ? { traceId: error.traceId } : {}),
      });
  }
}
