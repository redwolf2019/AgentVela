import type { EnvironmentId } from "@t3tools/contracts";
import {
  type AgentVelaRelayEndpoint,
  type AgentVelaRelayEnvironmentRecord,
  type AgentVelaRelayStatusResponse,
} from "@t3tools/contracts/agentVelaRelay";
import {
  RelayAuthInvalidError,
  type RelayClientEnvironmentRecord,
  type RelayEnvironmentConnectResponse,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentEndpointUnavailableError,
  type RelayEnvironmentStatusResponse,
  RelayInternalError,
  type RelayManagedEndpoint,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { AgentVelaRelayClient } from "./agentVelaRelayClient.ts";
import {
  EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
  RelayEnvironmentDiscovery,
  type RelayDiscoveredEnvironment,
  type RelayEnvironmentDiscoveryState,
} from "./discovery.ts";
import {
  ManagedRelayClient,
  type ManagedRelayClientError,
  type ManagedRelayRequestAction,
  type ManagedRelayRequestActivity,
  ManagedRelayRequestFailedError,
  ManagedRelayRequestProofCreationError,
  ManagedRelayRequestTimeoutError,
  ManagedRelayUrlInvalidError,
} from "./managedRelay.ts";
import { SelfHostedRelayDiscovery, type SelfHostedRelayDiscoveryState } from "./presence.ts";
import { RelayUrlConfig } from "./relayConfig.ts";
import type { SelfHostedRelayError } from "./relayErrors.ts";

const FALLBACK_TRACE_ID = "self-hosted-relay";

const ACTION_ACTIVITY: Record<ManagedRelayRequestAction, ManagedRelayRequestActivity> = {
  "exchange relay DPoP access token": "Relay DPoP access token exchange",
  "list relay-managed environments": "Relay environment listing",
  "list relay client devices": "Relay client device listing",
  "create relay environment link challenge": "Relay environment link challenge",
  "link relay environment": "Relay environment linking",
  "unlink relay environment": "Relay environment unlinking",
  "get relay environment status": "Relay environment status request",
  "connect relay environment": "Relay environment connection",
  "register relay mobile device": "Relay mobile device registration",
  "unregister relay mobile device": "Relay mobile device unregistration",
  "register relay live activity": "Relay Live Activity registration",
  "read relay agent activity snapshot": "Relay agent activity snapshot",
  "read linked T3 Chat account": "Relay T3 Chat link lookup",
  "start T3 Chat linking": "Relay T3 Chat link request",
  "unlink T3 Chat account": "Relay T3 Chat unlinking",
};

function toLegacyManagedEndpoint(endpoint: AgentVelaRelayEndpoint): RelayManagedEndpoint {
  return {
    httpBaseUrl: endpoint.httpBaseUrl,
    wsBaseUrl: endpoint.wsBaseUrl,
    providerKind: "t3_relay",
  };
}

export function toLegacyEnvironmentRecord(
  record: AgentVelaRelayEnvironmentRecord,
): RelayClientEnvironmentRecord {
  return {
    environmentId: record.environmentId,
    label: record.label,
    endpoint: toLegacyManagedEndpoint(record.endpoint),
    linkedAt: record.linkedAt,
  };
}

function toLegacyStatusResponse(
  status: AgentVelaRelayStatusResponse,
): RelayEnvironmentStatusResponse {
  return {
    environmentId: status.environmentId,
    endpoint: toLegacyManagedEndpoint(status.endpoint),
    status: status.status,
    checkedAt: status.checkedAt,
    ...(status.descriptor !== undefined ? { descriptor: status.descriptor } : {}),
  };
}

function toLegacyProtectedError(error: SelfHostedRelayError) {
  if (error._tag !== "RelayApiRequestError" || error.relayError === undefined) {
    return undefined;
  }
  const relayError = error.relayError;
  switch (relayError._tag) {
    case "RelayAuthError":
      return new RelayAuthInvalidError({
        code: "auth_invalid",
        reason:
          relayError.reason === "invalid_dpop"
            ? "invalid_dpop"
            : relayError.reason === "missing_credentials"
              ? "missing_bearer"
              : "invalid_bearer",
        ...(relayError.dpopFailureReason
          ? { dpopFailureReason: relayError.dpopFailureReason }
          : {}),
        traceId: relayError.traceId,
      });
    case "RelayNotFoundError":
      return relayError.resource === "environment"
        ? new RelayEnvironmentConnectNotAuthorizedError({
            code: "environment_connect_not_authorized",
            reason: "environment_link_not_found",
            traceId: relayError.traceId,
          })
        : undefined;
    case "RelayForbiddenError":
      return new RelayEnvironmentConnectNotAuthorizedError({
        code: "environment_connect_not_authorized",
        ...(relayError.reason === "environment_not_owned"
          ? { reason: "environment_link_not_found" }
          : {}),
        traceId: relayError.traceId,
      });
    case "RelayTunnelOfflineError":
      return new RelayEnvironmentEndpointUnavailableError({
        code: "environment_endpoint_unavailable",
        reason:
          relayError.reason === "upstream_invalid_response"
            ? "endpoint_response_invalid"
            : "endpoint_request_failed",
        endpointFailure:
          relayError.reason === "tunnel_disconnected"
            ? "tunnel_down"
            : relayError.reason === "origin_unreachable"
              ? "origin_unreachable"
              : "invalid_response",
        ...(relayError.endpointStatus !== undefined
          ? { endpointStatus: relayError.endpointStatus }
          : {}),
        traceId: relayError.traceId,
      });
    case "RelayEndpointTimedOutError":
      return new RelayEnvironmentEndpointTimedOutError({
        code: "environment_endpoint_timed_out",
        traceId: relayError.traceId,
      });
    case "RelayInternalError":
      return new RelayInternalError({
        code: "internal_error",
        reason:
          relayError.reason === "database_unavailable"
            ? "database_unavailable"
            : relayError.reason === "persistence_failed"
              ? "persistence_failed"
              : "internal_error",
        traceId: relayError.traceId,
      });
    default:
      return undefined;
  }
}

function toManagedRelayClientError(
  action: ManagedRelayRequestAction,
  error: SelfHostedRelayError,
): ManagedRelayClientError {
  switch (error._tag) {
    case "ManagedRelayDpopKeyLoadError":
      return error;
    case "ManagedRelayDpopProofCreationError":
      return new ManagedRelayRequestProofCreationError({
        method: error.method,
        url: error.url,
        cause: error.cause,
      });
    case "RelayUrlInvalidError":
      return new ManagedRelayUrlInvalidError({ relayUrl: error.relayUrl });
    case "RelayNotConfiguredError":
      return new ManagedRelayUrlInvalidError({ relayUrl: "" });
    case "RelaySessionUnavailableError":
      return new ManagedRelayRequestFailedError({
        action,
        cause: error,
        relayError: new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: error.reason === "signed_out" ? "missing_bearer" : "invalid_bearer",
          traceId: FALLBACK_TRACE_ID,
        }),
        status: 401,
        traceId: FALLBACK_TRACE_ID,
      });
    case "RelayApiTimeoutError":
      return new ManagedRelayRequestTimeoutError({
        activity: ACTION_ACTIVITY[action],
        timeoutMs: error.timeoutMs,
        traceId: error.traceId,
      });
    case "RelayDpopScopeError":
      return new ManagedRelayRequestFailedError({ action, cause: error });
    case "RelayApiRequestError": {
      const legacyRelayError = toLegacyProtectedError(error);
      return new ManagedRelayRequestFailedError({
        action,
        ...(error.transportFailed ? { transportFailed: true } : {}),
        cause: error,
        ...(legacyRelayError ? { relayError: legacyRelayError } : {}),
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.traceId ? { traceId: error.traceId } : {}),
      });
    }
  }
}

function unsupportedLegacyOperation(
  action: ManagedRelayRequestAction,
): Effect.Effect<never, ManagedRelayClientError> {
  return Effect.fail(
    new ManagedRelayRequestFailedError({
      action,
      cause: new Error(`${action} is removed in self-hosted agent-vela-relay.`),
    }),
  );
}

const makeManagedRelayBridge = Effect.fn("ManagedRelayBridge.make")(function* () {
  const relayClient = yield* AgentVelaRelayClient;
  const relayConfig = yield* RelayUrlConfig;
  let currentRelayUrl = Option.getOrNull(yield* relayConfig.current)?.origin ?? "";

  yield* relayConfig.changes.pipe(
    Stream.runForEach((parsed) =>
      Effect.sync(() => {
        currentRelayUrl = Option.getOrNull(parsed)?.origin ?? "";
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  return ManagedRelayClient.of({
    get relayUrl() {
      return currentRelayUrl;
    },
    listEnvironments: Effect.fn("ManagedRelayBridge.listEnvironments")(() =>
      relayClient.listEnvironments.pipe(
        Effect.map((records) => records.map(toLegacyEnvironmentRecord)),
        Effect.mapError((error) =>
          toManagedRelayClientError("list relay-managed environments", error),
        ),
      ),
    ),
    unlinkEnvironment: Effect.fn("ManagedRelayBridge.unlinkEnvironment")((input) =>
      relayClient
        .unlinkEnvironment(input.environmentId)
        .pipe(
          Effect.mapError((error) => toManagedRelayClientError("unlink relay environment", error)),
        ),
    ),
    getEnvironmentStatus: Effect.fn("ManagedRelayBridge.getEnvironmentStatus")((input) =>
      relayClient.getEnvironmentStatus({ environmentId: input.environmentId }).pipe(
        Effect.map(toLegacyStatusResponse),
        Effect.mapError((error) =>
          toManagedRelayClientError("get relay environment status", error),
        ),
      ),
    ),
    connectEnvironment: Effect.fn("ManagedRelayBridge.connectEnvironment")(
      (input): Effect.Effect<RelayEnvironmentConnectResponse, ManagedRelayClientError> =>
        relayClient
          .connectEnvironment({
            environmentId: input.environmentId as EnvironmentId,
            ...(input.deviceId ? { deviceId: input.deviceId } : {}),
          })
          .pipe(
            Effect.map((connected) => ({
              environmentId: connected.environmentId,
              endpoint: toLegacyManagedEndpoint(connected.endpoint),
              credential: connected.credential,
              expiresAt: connected.expiresAt,
            })),
            Effect.mapError((error) =>
              toManagedRelayClientError("connect relay environment", error),
            ),
          ),
    ),
    listDevices: Effect.fn("ManagedRelayBridge.listDevices")(() =>
      unsupportedLegacyOperation("list relay client devices"),
    ),
    createEnvironmentLinkChallenge: Effect.fn("ManagedRelayBridge.createChallenge")(() =>
      unsupportedLegacyOperation("create relay environment link challenge"),
    ),
    linkEnvironment: Effect.fn("ManagedRelayBridge.linkEnvironment")(() =>
      unsupportedLegacyOperation("link relay environment"),
    ),
    getT3ChatLink: Effect.fn("ManagedRelayBridge.getT3ChatLink")(() =>
      unsupportedLegacyOperation("read linked T3 Chat account"),
    ),
    createT3ChatLinkRequest: Effect.fn("ManagedRelayBridge.createT3ChatLinkRequest")(() =>
      unsupportedLegacyOperation("start T3 Chat linking"),
    ),
    unlinkT3Chat: Effect.fn("ManagedRelayBridge.unlinkT3Chat")(() =>
      unsupportedLegacyOperation("unlink T3 Chat account"),
    ),
    registerDevice: Effect.fn("ManagedRelayBridge.registerDevice")(() =>
      unsupportedLegacyOperation("register relay mobile device"),
    ),
    unregisterDevice: Effect.fn("ManagedRelayBridge.unregisterDevice")(() =>
      unsupportedLegacyOperation("unregister relay mobile device"),
    ),
    registerLiveActivity: Effect.fn("ManagedRelayBridge.registerLiveActivity")(() =>
      unsupportedLegacyOperation("register relay live activity"),
    ),
    getAgentActivitySnapshot: Effect.fn("ManagedRelayBridge.getAgentActivitySnapshot")(() =>
      unsupportedLegacyOperation("read relay agent activity snapshot"),
    ),
    resetTokenCache: relayClient.resetDpopTokenCache,
  });
});

export const layerManagedRelayBridge = Layer.effect(ManagedRelayClient, makeManagedRelayBridge());

function toDiscoveryState(
  selfHosted: SelfHostedRelayDiscoveryState,
): RelayEnvironmentDiscoveryState {
  const environments = new Map<string, RelayDiscoveredEnvironment>();
  for (const [environmentId, entry] of selfHosted.environments) {
    environments.set(environmentId, {
      environment: toLegacyEnvironmentRecord(entry.environment),
      availability: entry.availability,
      status: Option.map(entry.lastStatus, toLegacyStatusResponse),
      error: Option.none(),
    });
  }
  return {
    environments,
    listed: selfHosted.listed,
    refreshing: selfHosted.connectionState === "connecting" && !selfHosted.listed,
    offline: selfHosted.connectionState === "offline",
    error: selfHosted.error,
  };
}

const makeRelayEnvironmentDiscoveryFromSelfHosted = Effect.fn(
  "ManagedRelayBridge.makeDiscoveryFromSelfHosted",
)(function* () {
  const selfHosted = yield* SelfHostedRelayDiscovery;
  const state = yield* SubscriptionRef.make<RelayEnvironmentDiscoveryState>(
    EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
  );
  yield* SubscriptionRef.set(state, toDiscoveryState(yield* SubscriptionRef.get(selfHosted.state)));
  yield* SubscriptionRef.changes(selfHosted.state).pipe(
    Stream.runForEach((next) => SubscriptionRef.set(state, toDiscoveryState(next))),
    Effect.forkScoped({ startImmediately: true }),
  );
  return RelayEnvironmentDiscovery.of({
    state,
    refresh: selfHosted.refresh,
  });
});

export const layerRelayEnvironmentDiscoveryFromSelfHosted: Layer.Layer<
  RelayEnvironmentDiscovery,
  never,
  SelfHostedRelayDiscovery
> = Layer.effect(RelayEnvironmentDiscovery, makeRelayEnvironmentDiscoveryFromSelfHosted());
