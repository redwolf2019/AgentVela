import { type ClientSurface, type EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  type AgentVelaRelayConnectResponse,
  type AgentVelaRelayDpopScope,
  type AgentVelaRelayEnvironmentRecord,
  type AgentVelaRelayLinkChallengeResponse,
  type AgentVelaRelayLinkRequest,
  type AgentVelaRelayLinkResponse,
  type AgentVelaRelayOkResponse,
  type AgentVelaRelayStatusResponse,
  AgentVelaRelayApi,
  AgentVelaRelayConnectScope,
  AgentVelaRelayStatusScope,
  type RelayAdminCreateInviteRequest,
  type RelayAdminCreateInviteResponse,
  type RelayAdminCreateUserRequest,
  type RelayAdminTunnelTelemetry,
  type RelayAdminUpdateUserRequest,
  type RelayCreateEnrollmentTokenRequest,
  type RelayCreateEnrollmentTokenResponse,
  type RelayInviteId,
  type RelayInviteRecord,
  type RelayUserId,
  type RelayUserRecord,
} from "@t3tools/contracts/agentVelaRelay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { ManagedRelayDpopSigner } from "./managedRelay.ts";
import {
  RelayApiRequestError,
  RelayDpopScopeError,
  type SelfHostedRelayError,
  hasMissingDpopScopes,
  toRelayApiRequestError,
  withRelayTimeout,
} from "./relayErrors.ts";
import { RelayAuthSession, bearerHeader } from "./relaySession.ts";

const STANDARD_REQUEST_TIMEOUT_MS = 10_000;
const TUNNEL_REQUEST_TIMEOUT_MS = 15_000;
const DPOP_TOKEN_EXPIRY_SKEW_MS = 10_000;

interface CachedDpopToken {
  readonly relayUrl: string;
  readonly userId: RelayUserId;
  readonly thumbprint: string;
  readonly scopes: ReadonlyArray<AgentVelaRelayDpopScope>;
  readonly accessToken: string;
  readonly expiresAtMillis: number;
}

export interface AgentVelaRelayClientOptions {
  readonly clientSurface: ClientSurface;
}

export class AgentVelaRelayClient extends Context.Service<
  AgentVelaRelayClient,
  {
    readonly listEnvironments: Effect.Effect<
      ReadonlyArray<AgentVelaRelayEnvironmentRecord>,
      SelfHostedRelayError
    >;
    readonly createLinkChallenge: Effect.Effect<
      AgentVelaRelayLinkChallengeResponse,
      SelfHostedRelayError
    >;
    readonly linkEnvironment: (
      input: AgentVelaRelayLinkRequest,
    ) => Effect.Effect<AgentVelaRelayLinkResponse, SelfHostedRelayError>;
    readonly unlinkEnvironment: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<AgentVelaRelayOkResponse, SelfHostedRelayError>;
    readonly createEnrollmentToken: (
      input?: RelayCreateEnrollmentTokenRequest,
    ) => Effect.Effect<RelayCreateEnrollmentTokenResponse, SelfHostedRelayError>;
    readonly connectEnvironment: (input: {
      readonly environmentId: EnvironmentId;
      readonly deviceId?: string;
    }) => Effect.Effect<AgentVelaRelayConnectResponse, SelfHostedRelayError>;
    readonly getEnvironmentStatus: (input: {
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<AgentVelaRelayStatusResponse, SelfHostedRelayError>;
    readonly listUsers: Effect.Effect<ReadonlyArray<RelayUserRecord>, SelfHostedRelayError>;
    readonly createUser: (
      payload: RelayAdminCreateUserRequest,
    ) => Effect.Effect<RelayUserRecord, SelfHostedRelayError>;
    readonly updateUser: (
      userId: RelayUserId,
      payload: RelayAdminUpdateUserRequest,
    ) => Effect.Effect<RelayUserRecord, SelfHostedRelayError>;
    readonly listInvites: Effect.Effect<ReadonlyArray<RelayInviteRecord>, SelfHostedRelayError>;
    readonly createInvite: (
      payload?: RelayAdminCreateInviteRequest,
    ) => Effect.Effect<RelayAdminCreateInviteResponse, SelfHostedRelayError>;
    readonly revokeInvite: (
      inviteId: RelayInviteId,
    ) => Effect.Effect<AgentVelaRelayOkResponse, SelfHostedRelayError>;
    readonly listTunnels: Effect.Effect<
      ReadonlyArray<RelayAdminTunnelTelemetry>,
      SelfHostedRelayError
    >;
    readonly kickTunnel: (
      environmentId: EnvironmentId,
      reason?: string,
    ) => Effect.Effect<AgentVelaRelayOkResponse, SelfHostedRelayError>;
    readonly resetDpopTokenCache: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/relay/agentVelaRelayClient") {}

function matchesDpopCache(
  entry: CachedDpopToken,
  query: {
    readonly relayUrl: string;
    readonly userId: RelayUserId;
    readonly thumbprint: string;
    readonly scopes: ReadonlyArray<AgentVelaRelayDpopScope>;
    readonly nowMillis: number;
  },
): boolean {
  return (
    entry.relayUrl === query.relayUrl &&
    entry.userId === query.userId &&
    entry.thumbprint === query.thumbprint &&
    entry.expiresAtMillis > query.nowMillis + DPOP_TOKEN_EXPIRY_SKEW_MS &&
    query.scopes.every((scope) => entry.scopes.includes(scope))
  );
}

function isRetryableAuthError(error: SelfHostedRelayError): boolean {
  return (
    error._tag === "RelayApiRequestError" &&
    error.relayError?._tag === "RelayAuthError" &&
    (error.relayError.reason === "token_expired" || error.relayError.reason === "invalid_token")
  );
}

const makeAgentVelaRelayClient = Effect.fn("AgentVelaRelayClient.make")(function* (
  options: AgentVelaRelayClientOptions,
) {
  const session = yield* RelayAuthSession;
  const signer = yield* ManagedRelayDpopSigner;
  const httpClient = yield* HttpClient.HttpClient;
  const dpopCache = yield* SynchronizedRef.make<ReadonlyArray<CachedDpopToken>>([]);

  yield* session.accountChanges.pipe(
    Stream.runForEach(() => SynchronizedRef.set(dpopCache, [])),
    Effect.forkScoped({ startImmediately: true }),
  );

  const runApi = <A, E>(
    relayUrl: string,
    action: string,
    timeoutMs: number,
    call: (client: HttpApiClient.ForApi<typeof AgentVelaRelayApi>) => Effect.Effect<A, E>,
  ): Effect.Effect<A, SelfHostedRelayError> =>
    HttpApiClient.make(AgentVelaRelayApi, { baseUrl: relayUrl }).pipe(
      Effect.flatMap(call),
      Effect.mapError((cause) => toRelayApiRequestError(action, cause)),
      (effect) => withRelayTimeout(action, timeoutMs, effect),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const runBearer = Effect.fn("AgentVelaRelayClient.runBearer")(function* <A, E>(
    action: string,
    call: (
      api: HttpApiClient.ForApi<typeof AgentVelaRelayApi>,
      headers: { readonly authorization: string },
    ) => Effect.Effect<A, E>,
  ): Effect.fn.Return<A, SelfHostedRelayError> {
    const first = yield* session.getValidAccessToken();
    const attempt = yield* runApi(first.relayUrl, action, STANDARD_REQUEST_TIMEOUT_MS, (api) =>
      call(api, bearerHeader(first.accessToken)),
    ).pipe(Effect.result);
    if (attempt._tag === "Success") return attempt.success;
    if (!isRetryableAuthError(attempt.failure)) return yield* attempt.failure;
    const retried = yield* session.getValidAccessToken({ forceRefresh: true });
    return yield* runApi(retried.relayUrl, action, STANDARD_REQUEST_TIMEOUT_MS, (api) =>
      call(api, bearerHeader(retried.accessToken)),
    );
  });

  const exchangeDpopToken = Effect.fn("AgentVelaRelayClient.exchangeDpopToken")(function* (input: {
    readonly relayUrl: string;
    readonly accessToken: string;
    readonly scopes: ReadonlyArray<AgentVelaRelayDpopScope>;
  }) {
    const urls = HttpApiClient.urlBuilder(AgentVelaRelayApi, { baseUrl: input.relayUrl });
    const proof = yield* signer.createProof({
      method: "POST",
      url: urls.authSession.exchangeDpopToken(),
    });
    const response = yield* runApi(
      input.relayUrl,
      "exchange relay DPoP token",
      STANDARD_REQUEST_TIMEOUT_MS,
      (api) =>
        api.authSession.exchangeDpopToken({
          headers: {
            authorization: TrimmedNonEmptyString.make(`Bearer ${input.accessToken}`),
            dpop: TrimmedNonEmptyString.make(proof),
          },
          payload: {
            scopes: [...input.scopes],
            clientSurface: options.clientSurface,
          },
        }),
    );
    if (hasMissingDpopScopes(input.scopes, response.scopes)) {
      return yield* new RelayDpopScopeError({
        requestedScopes: [...input.scopes],
        grantedScopes: [...response.scopes],
      });
    }
    return response;
  });

  const obtainDpopToken = Effect.fn("AgentVelaRelayClient.obtainDpopToken")(function* (input: {
    readonly scopes: ReadonlyArray<AgentVelaRelayDpopScope>;
    readonly thumbprint: string;
  }) {
    const auth = yield* session.getValidAccessToken();
    const nowMillis = yield* Clock.currentTimeMillis;
    const matchQuery = {
      relayUrl: auth.relayUrl,
      userId: auth.userId,
      thumbprint: input.thumbprint,
      scopes: input.scopes,
      nowMillis,
    };
    const fast = (yield* SynchronizedRef.get(dpopCache)).find((entry) =>
      matchesDpopCache(entry, matchQuery),
    );
    if (fast) return fast;

    return yield* SynchronizedRef.modifyEffect(dpopCache, (entries) =>
      Effect.gen(function* () {
        const lookupMillis = yield* Clock.currentTimeMillis;
        const active = entries.filter(
          (entry) => entry.expiresAtMillis > lookupMillis + DPOP_TOKEN_EXPIRY_SKEW_MS,
        );
        const existing = active.find((entry) =>
          matchesDpopCache(entry, { ...matchQuery, nowMillis: lookupMillis }),
        );
        if (existing) {
          return [existing, active] as const;
        }
        const exchangedWithAuth = yield* exchangeDpopToken({
          relayUrl: auth.relayUrl,
          accessToken: auth.accessToken,
          scopes: input.scopes,
        }).pipe(
          Effect.map((exchanged) => ({ auth, exchanged })),
          Effect.catchIf(isRetryableAuthError, () =>
            session.getValidAccessToken({ forceRefresh: true }).pipe(
              Effect.flatMap((fresh) =>
                exchangeDpopToken({
                  relayUrl: fresh.relayUrl,
                  accessToken: fresh.accessToken,
                  scopes: input.scopes,
                }).pipe(Effect.map((exchanged) => ({ auth: fresh, exchanged }))),
              ),
            ),
          ),
        );
        const created: CachedDpopToken = {
          relayUrl: exchangedWithAuth.auth.relayUrl,
          userId: exchangedWithAuth.auth.userId,
          thumbprint: input.thumbprint,
          scopes: [...exchangedWithAuth.exchanged.scopes],
          accessToken: exchangedWithAuth.exchanged.accessToken,
          expiresAtMillis: lookupMillis + exchangedWithAuth.exchanged.expiresIn * 1_000,
        };
        return [created, [...active, created]] as const;
      }),
    );
  });

  const executeDpopAttempt = Effect.fn("AgentVelaRelayClient.executeDpopAttempt")(function* <A, E>(
    action: string,
    scopes: ReadonlyArray<AgentVelaRelayDpopScope>,
    thumbprint: string,
    targetUrl: (
      urls: ReturnType<typeof HttpApiClient.urlBuilder<typeof AgentVelaRelayApi>>,
    ) => string,
    call: (input: {
      readonly api: HttpApiClient.ForApi<typeof AgentVelaRelayApi>;
      readonly thumbprint: string;
      readonly headers: { readonly authorization: string; readonly dpop: string };
    }) => Effect.Effect<A, E>,
    retryOnAuthFailure: boolean,
  ): Effect.fn.Return<A, SelfHostedRelayError> {
    const token = yield* obtainDpopToken({ scopes, thumbprint });
    const urls = HttpApiClient.urlBuilder(AgentVelaRelayApi, { baseUrl: token.relayUrl });
    const proof = yield* signer.createProof({
      method: "POST",
      url: targetUrl(urls),
      accessToken: token.accessToken,
    });
    const attempt = yield* runApi(token.relayUrl, action, TUNNEL_REQUEST_TIMEOUT_MS, (api) =>
      call({
        api,
        thumbprint,
        headers: {
          authorization: TrimmedNonEmptyString.make(`DPoP ${token.accessToken}`),
          dpop: TrimmedNonEmptyString.make(proof),
        },
      }),
    ).pipe(Effect.result);
    if (attempt._tag === "Success") return attempt.success;
    if (isRetryableAuthError(attempt.failure)) {
      yield* SynchronizedRef.update(dpopCache, (entries) =>
        entries.filter((entry) => entry.accessToken !== token.accessToken),
      );
      if (retryOnAuthFailure) {
        return yield* executeDpopAttempt(action, scopes, thumbprint, targetUrl, call, false);
      }
    }
    return yield* attempt.failure;
  });

  const runDpop = Effect.fn("AgentVelaRelayClient.runDpop")(function* <A, E>(
    action: string,
    scopes: ReadonlyArray<AgentVelaRelayDpopScope>,
    targetUrl: (
      urls: ReturnType<typeof HttpApiClient.urlBuilder<typeof AgentVelaRelayApi>>,
    ) => string,
    call: (input: {
      readonly api: HttpApiClient.ForApi<typeof AgentVelaRelayApi>;
      readonly thumbprint: string;
      readonly headers: { readonly authorization: string; readonly dpop: string };
    }) => Effect.Effect<A, E>,
  ): Effect.fn.Return<A, SelfHostedRelayError> {
    const thumbprint = yield* signer.thumbprint;
    return yield* executeDpopAttempt(action, scopes, thumbprint, targetUrl, call, true);
  });

  return AgentVelaRelayClient.of({
    listEnvironments: runBearer("list relay environments", (api, headers) =>
      api.environments.list({ headers }).pipe(Effect.map((response) => response.environments)),
    ).pipe(Effect.withSpan("AgentVelaRelayClient.listEnvironments")),
    createLinkChallenge: runBearer("create relay link challenge", (api, headers) =>
      api.environments.createLinkChallenge({ headers }),
    ).pipe(Effect.withSpan("AgentVelaRelayClient.createLinkChallenge")),
    linkEnvironment: Effect.fn("AgentVelaRelayClient.linkEnvironment")(function* (payload) {
      return yield* runBearer("link environment to relay", (api, headers) =>
        api.environments.link({ headers, payload }),
      );
    }),
    unlinkEnvironment: Effect.fn("AgentVelaRelayClient.unlinkEnvironment")(
      function* (environmentId) {
        return yield* runBearer("unlink relay environment", (api, headers) =>
          api.environments.unlink({ headers, params: { environmentId } }),
        );
      },
    ),
    createEnrollmentToken: Effect.fn("AgentVelaRelayClient.createEnrollmentToken")(
      function* (payload) {
        return yield* runBearer("create enrollment token", (api, headers) =>
          api.environments.createEnrollmentToken({ headers, payload: payload ?? {} }),
        );
      },
    ),
    connectEnvironment: Effect.fn("AgentVelaRelayClient.connectEnvironment")(function* (input) {
      const response = yield* runDpop(
        "connect relay environment",
        [AgentVelaRelayConnectScope],
        (urls) =>
          urls.connect.connectEnvironment({ params: { environmentId: input.environmentId } }),
        ({ api, thumbprint, headers }) =>
          api.connect.connectEnvironment({
            headers,
            params: { environmentId: input.environmentId },
            payload: {
              clientProofKeyThumbprint: TrimmedNonEmptyString.make(thumbprint),
              ...(input.deviceId ? { deviceId: TrimmedNonEmptyString.make(input.deviceId) } : {}),
            },
          }),
      );
      if (response.environmentId !== input.environmentId) {
        return yield* new RelayApiRequestError({
          action: "connect relay environment",
          cause: new Error(
            `Relay returned connect response for unexpected environment ${response.environmentId}`,
          ),
        });
      }
      return response;
    }),
    getEnvironmentStatus: Effect.fn("AgentVelaRelayClient.getEnvironmentStatus")(function* (input) {
      const response = yield* runDpop(
        "get relay environment status",
        [AgentVelaRelayStatusScope],
        (urls) =>
          urls.connect.getEnvironmentStatus({ params: { environmentId: input.environmentId } }),
        ({ api, headers }) =>
          api.connect.getEnvironmentStatus({
            headers,
            params: { environmentId: input.environmentId },
          }),
      );
      if (response.environmentId !== input.environmentId) {
        return yield* new RelayApiRequestError({
          action: "get relay environment status",
          cause: new Error(
            `Relay returned status for unexpected environment ${response.environmentId}`,
          ),
        });
      }
      return response;
    }),
    listUsers: runBearer("list relay users", (api, headers) =>
      api.admin.listUsers({ headers }).pipe(Effect.map((response) => response.users)),
    ).pipe(Effect.withSpan("AgentVelaRelayClient.listUsers")),
    createUser: Effect.fn("AgentVelaRelayClient.createUser")(function* (payload) {
      return yield* runBearer("create relay user", (api, headers) =>
        api.admin.createUser({ headers, payload }),
      );
    }),
    updateUser: Effect.fn("AgentVelaRelayClient.updateUser")(function* (userId, payload) {
      return yield* runBearer("update relay user", (api, headers) =>
        api.admin.updateUser({ headers, params: { userId }, payload }),
      );
    }),
    listInvites: runBearer("list relay invites", (api, headers) =>
      api.admin.listInvites({ headers }).pipe(Effect.map((response) => response.invites)),
    ).pipe(Effect.withSpan("AgentVelaRelayClient.listInvites")),
    createInvite: Effect.fn("AgentVelaRelayClient.createInvite")(function* (payload) {
      return yield* runBearer("create relay invite", (api, headers) =>
        api.admin.createInvite({ headers, payload: payload ?? {} }),
      );
    }),
    revokeInvite: Effect.fn("AgentVelaRelayClient.revokeInvite")(function* (inviteId) {
      return yield* runBearer("revoke relay invite", (api, headers) =>
        api.admin.revokeInvite({ headers, params: { inviteId } }),
      );
    }),
    listTunnels: runBearer("list relay tunnels", (api, headers) =>
      api.admin.listTunnels({ headers }).pipe(Effect.map((response) => response.tunnels)),
    ).pipe(Effect.withSpan("AgentVelaRelayClient.listTunnels")),
    kickTunnel: Effect.fn("AgentVelaRelayClient.kickTunnel")(function* (environmentId, reason) {
      return yield* runBearer("kick relay tunnel", (api, headers) =>
        api.admin.kickTunnel({
          headers,
          params: { environmentId },
          payload: reason ? { reason: TrimmedNonEmptyString.make(reason) } : {},
        }),
      );
    }),
    resetDpopTokenCache: SynchronizedRef.set(dpopCache, []).pipe(
      Effect.withSpan("AgentVelaRelayClient.resetDpopTokenCache"),
    ),
  });
});

export const layerAgentVelaRelayClient = (options: AgentVelaRelayClientOptions) =>
  Layer.effect(AgentVelaRelayClient, makeAgentVelaRelayClient(options));
