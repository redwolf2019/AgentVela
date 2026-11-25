import { TrimmedNonEmptyString, type EnvironmentId } from "@t3tools/contracts";
import {
  AgentVelaRelayApi,
  type AgentVelaRelayLinkChallengeResponse,
  type AgentVelaRelayLinkResponse,
  type RelayAuthSessionResponse,
  type RelayDeviceAuthPollResponse,
  type RelayDeviceAuthStartResponse,
} from "@t3tools/contracts/agentVelaRelay";
import { normalizeRelayUrl } from "@t3tools/shared/relayUrl";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { saveRelayCliSession, type StoredRelayCliSession } from "./RelayState.ts";

const RELAY_HTTP_TIMEOUT = "15 seconds" as const;
const REFRESH_LEEWAY_MS = 60_000;

export class RelayApiClientError extends Schema.TaggedError<RelayApiClientError>()(
  "RelayApiClientError",
  {
    status: Schema.NullOr(Schema.Number),
    code: Schema.NullOr(Schema.String),
    reason: Schema.NullOr(Schema.String),
    detail: Schema.NullOr(Schema.String),
    traceId: Schema.NullOr(Schema.String),
    message: Schema.String,
  },
) {}

const isRelayApiClientError = Schema.is(RelayApiClientError);

const RelayTaggedErrorPayload = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  resource: Schema.optionalKey(Schema.String),
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  traceId: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
const decodeRelayErrorPayload = Schema.decodeUnknownOption(RelayTaggedErrorPayload);

function statusFromRelayErrorTag(tag: string | undefined): number | null {
  switch (tag) {
    case "RelayAuthError":
      return 401;
    case "RelayForbiddenError":
      return 403;
    case "RelayNotFoundError":
      return 404;
    case "RelayBadRequestError":
      return 400;
    case "RelayConflictError":
      return 409;
    case "RelayRateLimitedError":
      return 429;
    case "RelayTunnelOfflineError":
      return 502;
    case "RelayEndpointTimedOutError":
      return 504;
    case "RelayInternalError":
      return 500;
    default:
      return null;
  }
}

function mapRelayClientError(error: unknown): RelayApiClientError {
  if (isRelayApiClientError(error)) return error;
  const decoded = decodeRelayErrorPayload(error);
  if (decoded._tag === "Some") {
    const val = decoded.value;
    const message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : (val.detail ?? val.message ?? val.reason ?? val.code ?? "Relay request failed.");
    return new RelayApiClientError({
      status: statusFromRelayErrorTag(val._tag),
      code: val.code ?? null,
      reason: val.reason ?? val.resource ?? null,
      detail: val.detail ?? null,
      traceId: val.traceId ?? null,
      message,
    });
  }
  if (Predicate.isError(error)) {
    return new RelayApiClientError({
      status: null,
      code: null,
      reason: null,
      detail: null,
      traceId: null,
      message: error.message,
    });
  }
  return new RelayApiClientError({
    status: null,
    code: null,
    reason: null,
    detail: null,
    traceId: null,
    message: "Relay request failed.",
  });
}

function makeClient(relayUrl: string) {
  const normalized = normalizeRelayUrl(relayUrl);
  if (normalized === null) {
    return Effect.fail(
      new RelayApiClientError({
        status: null,
        code: "invalid_relay_url",
        reason: "invalid_relay_url",
        detail: null,
        traceId: null,
        message: "Relay URL must use https://, or http:// on loopback, RFC1918 LAN, or Tailscale.",
      }),
    );
  }
  return HttpApiClient.make(AgentVelaRelayApi, { baseUrl: normalized }).pipe(
    Effect.map((client) => ({ normalizedUrl: normalized, client })),
  );
}

const runRelayCall = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(RELAY_HTTP_TIMEOUT), Effect.mapError(mapRelayClientError));

const bearerHeaders = (accessToken: string) => ({
  authorization: TrimmedNonEmptyString.make(`Bearer ${accessToken}`),
});

export function toStoredCliSession(
  relayUrl: string,
  response: RelayAuthSessionResponse,
): StoredRelayCliSession {
  return {
    relayUrl: TrimmedNonEmptyString.make(relayUrl),
    userId: response.user.userId,
    username: response.user.username,
    role: response.user.role,
    accessToken: response.accessToken,
    accessTokenExpiresAt: response.accessTokenExpiresAt,
    refreshToken: response.refreshToken,
    refreshTokenExpiresAt: response.refreshTokenExpiresAt,
  };
}

export const loginToRelay = Effect.fn("relayApi.login")(function* (
  relayUrl: string,
  payload: Parameters<
    HttpApiClient.ForApi<typeof AgentVelaRelayApi>["authPublic"]["login"]
  >[0]["payload"],
) {
  const { normalizedUrl, client } = yield* makeClient(relayUrl);
  const session: RelayAuthSessionResponse = yield* runRelayCall(
    client.authPublic.login({ payload }),
  );
  return { normalizedUrl, session };
});

const refreshRelaySession = Effect.fn("relayApi.refresh")(function* (
  relayUrl: string,
  refreshToken: string,
) {
  const { normalizedUrl, client } = yield* makeClient(relayUrl);
  const session: RelayAuthSessionResponse = yield* runRelayCall(
    client.authPublic.refresh({
      payload: { refreshToken: TrimmedNonEmptyString.make(refreshToken) },
    }),
  );
  return { normalizedUrl, session };
});

export const logoutFromRelay = Effect.fn("relayApi.logout")(function* (
  relayUrl: string,
  accessToken: string,
  refreshToken?: string,
) {
  const { client } = yield* makeClient(relayUrl);
  const payload = refreshToken ? { refreshToken: TrimmedNonEmptyString.make(refreshToken) } : {};
  return yield* runRelayCall(
    client.authSession.logout({
      headers: bearerHeaders(accessToken),
      payload,
    }),
  );
});

export const startRelayDeviceAuth = Effect.fn("relayApi.startDeviceAuth")(function* (
  relayUrl: string,
  deviceLabel?: string,
) {
  const { normalizedUrl, client } = yield* makeClient(relayUrl);
  const payload = deviceLabel ? { deviceLabel: TrimmedNonEmptyString.make(deviceLabel) } : {};
  const res: RelayDeviceAuthStartResponse = yield* runRelayCall(
    client.authPublic.startDeviceAuth({ payload }),
  );
  return { normalizedUrl, ...res };
});

export const pollRelayDeviceAuth = Effect.fn("relayApi.pollDeviceAuth")(function* (
  relayUrl: string,
  deviceCode: string,
) {
  const { client } = yield* makeClient(relayUrl);
  const res: RelayDeviceAuthPollResponse = yield* runRelayCall(
    client.authPublic.pollDeviceAuth({
      payload: { deviceCode: TrimmedNonEmptyString.make(deviceCode) },
    }),
  );
  return res;
});

export const createRelayLinkChallenge = Effect.fn("relayApi.createLinkChallenge")(function* (
  relayUrl: string,
  accessToken: string,
) {
  const { client } = yield* makeClient(relayUrl);
  const res: AgentVelaRelayLinkChallengeResponse = yield* runRelayCall(
    client.environments.createLinkChallenge({ headers: bearerHeaders(accessToken) }),
  );
  return res;
});

export const linkRelayEnvironment = Effect.fn("relayApi.linkEnvironment")(function* (
  relayUrl: string,
  accessToken: string,
  proof: string,
) {
  const { client } = yield* makeClient(relayUrl);
  const res: AgentVelaRelayLinkResponse = yield* runRelayCall(
    client.environments.link({
      headers: bearerHeaders(accessToken),
      payload: { proof: TrimmedNonEmptyString.make(proof) },
    }),
  );
  return res;
});

export const unlinkRelayEnvironment = Effect.fn("relayApi.unlinkEnvironment")(function* (
  relayUrl: string,
  accessToken: string,
  environmentId: EnvironmentId,
) {
  const { client } = yield* makeClient(relayUrl);
  return yield* runRelayCall(
    client.environments.unlink({
      headers: bearerHeaders(accessToken),
      params: { environmentId },
    }),
  );
});

export const createRelayEnrollmentChallenge = Effect.fn("relayApi.createEnrollmentChallenge")(
  function* (relayUrl: string, enrollmentToken: string) {
    const { client } = yield* makeClient(relayUrl);
    const res: AgentVelaRelayLinkChallengeResponse = yield* runRelayCall(
      client.authPublic.createEnrollmentChallenge({
        payload: { enrollmentToken: TrimmedNonEmptyString.make(enrollmentToken) },
      }),
    );
    return res;
  },
);

export const enrollRelayEnvironment = Effect.fn("relayApi.enrollEnvironment")(function* (
  relayUrl: string,
  enrollmentToken: string,
  proof: string,
) {
  const { client } = yield* makeClient(relayUrl);
  const res: AgentVelaRelayLinkResponse = yield* runRelayCall(
    client.authPublic.enrollEnvironment({
      payload: {
        enrollmentToken: TrimmedNonEmptyString.make(enrollmentToken),
        proof: TrimmedNonEmptyString.make(proof),
      },
    }),
  );
  return res;
});

export const ensureFreshRelaySession = Effect.fn("relayApi.ensureFreshSession")(function* (
  session: StoredRelayCliSession,
) {
  const nowMs = (yield* DateTime.now).epochMilliseconds;
  const expiresMs = Date.parse(session.accessTokenExpiresAt);
  if (Number.isFinite(expiresMs) && expiresMs - nowMs > REFRESH_LEEWAY_MS) {
    return session;
  }
  const refreshed = yield* refreshRelaySession(session.relayUrl, session.refreshToken);
  const updated = toStoredCliSession(refreshed.normalizedUrl, refreshed.session);
  return yield* saveRelayCliSession(updated).pipe(Effect.mapError(mapRelayClientError));
});
