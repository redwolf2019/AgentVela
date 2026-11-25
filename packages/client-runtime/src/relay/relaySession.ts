import { TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  AgentVelaRelayApi,
  type AgentVelaRelayHealthResponse,
  type AgentVelaRelayOkResponse,
  type RelayAuthConfigResponse,
  type RelayAuthSessionResponse,
  type RelayDeviceAuthApproveRequest,
  type RelayDeviceAuthPollRequest,
  type RelayDeviceAuthPollResponse,
  type RelayDeviceAuthStartRequest,
  type RelayDeviceAuthStartResponse,
  type RelayLoginRequest,
  type RelayRegisterRequest,
  type RelayUserId,
  RelayUserRecord,
} from "@t3tools/contracts/agentVelaRelay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import type { ConnectionAttemptError } from "../connection/model.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { RelayUrlConfig } from "./relayConfig.ts";
import {
  RelaySessionUnavailableError,
  type SelfHostedRelayError,
  mapSelfHostedRelayError,
  toRelayApiRequestError,
  withRelayTimeout,
} from "./relayErrors.ts";

const RELAY_AUTH_TIMEOUT_MS = 10_000;
const RELAY_LOGOUT_TIMEOUT_MS = 5_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 30_000;

export const StoredRelaySession = Schema.Struct({
  relayUrl: Schema.String,
  user: RelayUserRecord,
  accessToken: Schema.String,
  accessTokenExpiresAt: Schema.String,
  refreshToken: Schema.String,
  refreshTokenExpiresAt: Schema.String,
});
export type StoredRelaySession = typeof StoredRelaySession.Type;

export class RelaySessionStore extends Context.Service<
  RelaySessionStore,
  {
    readonly load: Effect.Effect<Option.Option<StoredRelaySession>>;
    readonly save: (session: StoredRelaySession) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/relay/relaySession/RelaySessionStore") {}

export function layerInMemoryRelaySessionStore(
  initial: StoredRelaySession | null = null,
): Layer.Layer<RelaySessionStore> {
  return Layer.effect(
    RelaySessionStore,
    Ref.make<Option.Option<StoredRelaySession>>(Option.fromNullishOr(initial)).pipe(
      Effect.map((stored) =>
        RelaySessionStore.of({
          load: Ref.get(stored),
          save: Effect.fn("RelaySessionStore.save")((session) =>
            Ref.set(stored, Option.some(session)),
          ),
          clear: Ref.set(stored, Option.none()),
        }),
      ),
    ),
  );
}

export type RelaySessionState =
  | {
      readonly status: "signed_out";
      readonly relayUrl: string | null;
      readonly user: null;
    }
  | {
      readonly status: "signed_in";
      readonly relayUrl: string;
      readonly user: RelayUserRecord;
      readonly accessTokenExpiresAt: string;
      readonly refreshTokenExpiresAt: string;
    };

export interface ValidRelayAccessToken {
  readonly relayUrl: string;
  readonly userId: RelayUserId;
  readonly accessToken: string;
}

export class RelayAuthSession extends Context.Service<
  RelayAuthSession,
  {
    readonly state: SubscriptionRef.SubscriptionRef<RelaySessionState>;
    readonly accountChanges: Stream.Stream<string | null>;
    readonly getConfig: Effect.Effect<RelayAuthConfigResponse, SelfHostedRelayError>;
    readonly checkHealth: Effect.Effect<AgentVelaRelayHealthResponse, SelfHostedRelayError>;
    readonly login: (
      input: RelayLoginRequest,
    ) => Effect.Effect<RelayUserRecord, SelfHostedRelayError>;
    readonly register: (
      input: RelayRegisterRequest,
    ) => Effect.Effect<RelayUserRecord, SelfHostedRelayError>;
    readonly refresh: Effect.Effect<StoredRelaySession, SelfHostedRelayError>;
    readonly getValidAccessToken: (options?: {
      readonly forceRefresh?: boolean;
    }) => Effect.Effect<ValidRelayAccessToken, SelfHostedRelayError>;
    readonly getMe: Effect.Effect<RelayUserRecord, SelfHostedRelayError>;
    readonly logout: Effect.Effect<void>;
    readonly startDeviceAuth: (
      input?: RelayDeviceAuthStartRequest,
    ) => Effect.Effect<RelayDeviceAuthStartResponse, SelfHostedRelayError>;
    readonly pollDeviceAuth: (
      input: RelayDeviceAuthPollRequest,
    ) => Effect.Effect<RelayDeviceAuthPollResponse, SelfHostedRelayError>;
    readonly adoptSession: (
      session: RelayAuthSessionResponse,
    ) => Effect.Effect<RelayUserRecord, SelfHostedRelayError>;
    readonly approveDeviceAuth: (
      input: RelayDeviceAuthApproveRequest,
    ) => Effect.Effect<AgentVelaRelayOkResponse, SelfHostedRelayError>;
  }
>()("@t3tools/client-runtime/relay/relaySession/RelayAuthSession") {}

function toSignedOutState(relayUrl: string | null): RelaySessionState {
  return { status: "signed_out", relayUrl, user: null };
}

function toSignedInState(session: StoredRelaySession): RelaySessionState {
  return {
    status: "signed_in",
    relayUrl: session.relayUrl,
    user: session.user,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
  };
}

function toStoredSession(relayUrl: string, response: RelayAuthSessionResponse): StoredRelaySession {
  return {
    relayUrl,
    user: response.user,
    accessToken: response.accessToken,
    accessTokenExpiresAt: response.accessTokenExpiresAt,
    refreshToken: response.refreshToken,
    refreshTokenExpiresAt: response.refreshTokenExpiresAt,
  };
}

function parseIsoMillis(iso: string): number {
  const millis = Date.parse(iso);
  return Number.isFinite(millis) ? millis : 0;
}

function relayAccountKey(state: RelaySessionState): string | null {
  return state.status === "signed_in" ? `${state.relayUrl}:${state.user.userId}` : null;
}

export function bearerHeader(accessToken: string) {
  return { authorization: TrimmedNonEmptyString.make(`Bearer ${accessToken}`) };
}

function isTokenRejectedError(error: SelfHostedRelayError): boolean {
  return (
    error._tag === "RelayApiRequestError" &&
    error.relayError?._tag === "RelayAuthError" &&
    (error.relayError.reason === "token_expired" || error.relayError.reason === "invalid_token")
  );
}

const makeRelayAuthSession = Effect.fn("RelayAuthSession.make")(function* () {
  const relayConfig = yield* RelayUrlConfig;
  const store = yield* RelaySessionStore;
  const httpClient = yield* HttpClient.HttpClient;
  const sessionLock = yield* Semaphore.make(1);

  const initialRelayUrl = Option.getOrNull(yield* relayConfig.current)?.origin ?? null;
  const loadedSession = Option.getOrNull(yield* store.load);
  let initialSession: StoredRelaySession | null = null;
  if (
    loadedSession !== null &&
    initialRelayUrl !== null &&
    loadedSession.relayUrl === initialRelayUrl
  ) {
    initialSession = loadedSession;
  } else if (loadedSession !== null) {
    yield* store.clear;
  }

  const storedRef = yield* Ref.make<StoredRelaySession | null>(initialSession);
  const state = yield* SubscriptionRef.make<RelaySessionState>(
    initialSession ? toSignedInState(initialSession) : toSignedOutState(initialRelayUrl),
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

  const activeClientContext = Effect.fn("RelayAuthSession.activeOrigin")(function* () {
    return (yield* relayConfig.requireCurrent).origin;
  });

  const persistIfSameRelay = Effect.fn("RelayAuthSession.persistIfSameRelay")(function* (
    expectedRelayUrl: string,
    next: StoredRelaySession,
  ) {
    const active = Option.getOrNull(yield* relayConfig.current)?.origin ?? null;
    if (active !== expectedRelayUrl) {
      return yield* new RelaySessionUnavailableError({ reason: "relay_mismatch" });
    }
    yield* store.save(next);
    yield* Ref.set(storedRef, next);
    yield* SubscriptionRef.set(state, toSignedInState(next));
    return next;
  });

  const clearSessionLocked = Effect.fn("RelayAuthSession.clearSessionLocked")(function* (
    relayUrl: string | null,
  ) {
    yield* store.clear;
    yield* Ref.set(storedRef, null);
    yield* SubscriptionRef.set(state, toSignedOutState(relayUrl));
  });

  yield* relayConfig.changes.pipe(
    Stream.runForEach((nextParsed) =>
      sessionLock.withPermits(1)(clearSessionLocked(Option.getOrNull(nextParsed)?.origin ?? null)),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const refreshLocked = Effect.fn("RelayAuthSession.refreshLocked")(function* (options?: {
    readonly failedAccessToken?: string;
    readonly force?: boolean;
  }): Effect.fn.Return<StoredRelaySession, SelfHostedRelayError> {
    const relayUrl = yield* activeClientContext();
    const current = yield* Ref.get(storedRef);
    if (current === null) {
      return yield* new RelaySessionUnavailableError({ reason: "signed_out" });
    }
    if (current.relayUrl !== relayUrl) {
      yield* clearSessionLocked(relayUrl);
      return yield* new RelaySessionUnavailableError({ reason: "relay_mismatch" });
    }
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      options?.force !== true &&
      current.accessToken !== options?.failedAccessToken &&
      parseIsoMillis(current.accessTokenExpiresAt) > nowMs + ACCESS_TOKEN_REFRESH_SKEW_MS
    ) {
      return current;
    }
    const result = yield* runApi(relayUrl, "refresh relay session", RELAY_AUTH_TIMEOUT_MS, (api) =>
      api.authPublic.refresh({
        payload: { refreshToken: TrimmedNonEmptyString.make(current.refreshToken) },
      }),
    ).pipe(Effect.result);

    if (result._tag === "Failure") {
      if (
        result.failure._tag === "RelayApiRequestError" &&
        result.failure.relayError?._tag === "RelayAuthError"
      ) {
        yield* clearSessionLocked(relayUrl);
        return yield* new RelaySessionUnavailableError({ reason: "refresh_failed" });
      }
      return yield* result.failure;
    }
    return yield* persistIfSameRelay(relayUrl, toStoredSession(relayUrl, result.success));
  });

  const getValidAccessToken = Effect.fn("RelayAuthSession.getValidAccessToken")(
    function* (options?: {
      readonly forceRefresh?: boolean;
    }): Effect.fn.Return<ValidRelayAccessToken, SelfHostedRelayError> {
      const relayUrl = yield* activeClientContext();
      const current = yield* Ref.get(storedRef);
      if (current === null) {
        return yield* new RelaySessionUnavailableError({ reason: "signed_out" });
      }
      if (current.relayUrl !== relayUrl) {
        return yield* new RelaySessionUnavailableError({ reason: "relay_mismatch" });
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const isFresh =
        options?.forceRefresh !== true &&
        parseIsoMillis(current.accessTokenExpiresAt) > nowMs + ACCESS_TOKEN_REFRESH_SKEW_MS;
      if (isFresh) {
        return { relayUrl, userId: current.user.userId, accessToken: current.accessToken };
      }
      const refreshed = yield* sessionLock.withPermits(1)(
        refreshLocked(
          options?.forceRefresh === true ? { failedAccessToken: current.accessToken } : undefined,
        ),
      );
      return { relayUrl, userId: refreshed.user.userId, accessToken: refreshed.accessToken };
    },
  );

  const withBearerRetry = Effect.fn("RelayAuthSession.withBearerRetry")(function* <A, E>(
    action: string,
    call: (
      api: HttpApiClient.ForApi<typeof AgentVelaRelayApi>,
      token: ValidRelayAccessToken,
    ) => Effect.Effect<A, E>,
  ): Effect.fn.Return<A, SelfHostedRelayError> {
    const first = yield* getValidAccessToken();
    const attempt = yield* runApi(first.relayUrl, action, RELAY_AUTH_TIMEOUT_MS, (api) =>
      call(api, first),
    ).pipe(Effect.result);
    if (attempt._tag === "Success") return attempt.success;
    if (!isTokenRejectedError(attempt.failure)) return yield* attempt.failure;
    const retried = yield* getValidAccessToken({ forceRefresh: true });
    return yield* runApi(retried.relayUrl, action, RELAY_AUTH_TIMEOUT_MS, (api) =>
      call(api, retried),
    );
  });

  const adoptForOrigin = Effect.fn("RelayAuthSession.adoptForOrigin")(function* (
    expectedRelayUrl: string,
    response: RelayAuthSessionResponse,
  ) {
    const saved = yield* sessionLock.withPermits(1)(
      persistIfSameRelay(expectedRelayUrl, toStoredSession(expectedRelayUrl, response)),
    );
    return saved.user;
  });

  const getConfig = activeClientContext().pipe(
    Effect.flatMap((relayUrl) =>
      runApi(relayUrl, "read relay auth configuration", RELAY_AUTH_TIMEOUT_MS, (api) =>
        api.authPublic.getConfig(),
      ),
    ),
    Effect.withSpan("RelayAuthSession.getConfig"),
  );

  const checkHealth = activeClientContext().pipe(
    Effect.flatMap((relayUrl) =>
      runApi(relayUrl, "check relay health", RELAY_AUTH_TIMEOUT_MS, (api) => api.health.health()),
    ),
    Effect.withSpan("RelayAuthSession.checkHealth"),
  );

  const login = Effect.fn("RelayAuthSession.login")(function* (payload: RelayLoginRequest) {
    const relayUrl = yield* activeClientContext();
    const response = yield* runApi(relayUrl, "sign in to relay", RELAY_AUTH_TIMEOUT_MS, (api) =>
      api.authPublic.login({ payload }),
    );
    return yield* adoptForOrigin(relayUrl, response);
  });

  const register = Effect.fn("RelayAuthSession.register")(function* (
    payload: RelayRegisterRequest,
  ) {
    const relayUrl = yield* activeClientContext();
    const response = yield* runApi(
      relayUrl,
      "register relay account",
      RELAY_AUTH_TIMEOUT_MS,
      (api) => api.authPublic.register({ payload }),
    );
    return yield* adoptForOrigin(relayUrl, response);
  });

  const getMe = Effect.gen(function* () {
    const user = yield* withBearerRetry("load relay profile", (api, token) =>
      api.authSession.getMe({ headers: bearerHeader(token.accessToken) }),
    );
    yield* sessionLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(storedRef);
        if (current !== null && current.user.userId === user.userId) {
          const updated: StoredRelaySession = { ...current, user };
          yield* store.save(updated);
          yield* Ref.set(storedRef, updated);
          yield* SubscriptionRef.set(state, toSignedInState(updated));
        }
      }),
    );
    return user;
  }).pipe(Effect.withSpan("RelayAuthSession.getMe"));

  const logout = Effect.gen(function* () {
    const captured = yield* sessionLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(storedRef);
        const relayUrl = Option.getOrNull(yield* relayConfig.current)?.origin ?? null;
        yield* clearSessionLocked(relayUrl);
        return current;
      }),
    );
    if (captured === null) return;
    yield* runApi(captured.relayUrl, "sign out of relay", RELAY_LOGOUT_TIMEOUT_MS, (api) =>
      api.authSession.logout({
        headers: bearerHeader(captured.accessToken),
        payload: { refreshToken: TrimmedNonEmptyString.make(captured.refreshToken) },
      }),
    ).pipe(Effect.ignore);
  }).pipe(Effect.withSpan("RelayAuthSession.logout"));

  const accountChanges = SubscriptionRef.changes(state).pipe(
    Stream.map(relayAccountKey),
    Stream.changes,
    Stream.drop(1),
  );

  return RelayAuthSession.of({
    state,
    accountChanges,
    getConfig,
    checkHealth,
    login,
    register,
    refresh: sessionLock.withPermits(1)(refreshLocked({ force: true })),
    getValidAccessToken,
    getMe,
    logout,
    startDeviceAuth: Effect.fn("RelayAuthSession.startDeviceAuth")(function* (input) {
      const relayUrl = yield* activeClientContext();
      return yield* runApi(relayUrl, "start device authorization", RELAY_AUTH_TIMEOUT_MS, (api) =>
        api.authPublic.startDeviceAuth({ payload: input ?? {} }),
      );
    }),
    pollDeviceAuth: Effect.fn("RelayAuthSession.pollDeviceAuth")(function* (payload) {
      const relayUrl = yield* activeClientContext();
      return yield* runApi(relayUrl, "poll device authorization", RELAY_AUTH_TIMEOUT_MS, (api) =>
        api.authPublic.pollDeviceAuth({ payload }),
      );
    }),
    adoptSession: Effect.fn("RelayAuthSession.adoptSession")(function* (session) {
      const relayUrl = yield* activeClientContext();
      return yield* adoptForOrigin(relayUrl, session);
    }),
    approveDeviceAuth: Effect.fn("RelayAuthSession.approveDeviceAuth")(function* (payload) {
      return yield* withBearerRetry("approve device authorization", (api, token) =>
        api.authSession.approveDeviceAuth({
          headers: bearerHeader(token.accessToken),
          payload,
        }),
      );
    }),
  });
});

export const layerRelayAuthSession = Layer.effect(RelayAuthSession, makeRelayAuthSession());

export const layerCloudSessionFromRelayAuth = Layer.effect(
  ClientCapabilities.CloudSession,
  Effect.gen(function* () {
    const session = yield* RelayAuthSession;
    // Reference identity must remain stable across token refreshes for RemoteEnvironmentAuthorization.
    let cachedIdentity: {
      readonly key: string;
      readonly value: ClientCapabilities.CloudSessionIdentity;
    } | null = null;

    return ClientCapabilities.CloudSession.of({
      identity: SubscriptionRef.get(session.state).pipe(
        Effect.map((current) => {
          const key = relayAccountKey(current);
          if (key === null) {
            cachedIdentity = null;
            return Option.none();
          }
          if (cachedIdentity?.key !== key) {
            cachedIdentity = { key, value: { accountId: key } };
          }
          return Option.some(cachedIdentity.value);
        }),
      ),
      clerkToken: session.getValidAccessToken().pipe(
        Effect.map((token) => token.accessToken),
        Effect.mapError((error): ConnectionAttemptError => mapSelfHostedRelayError(error)),
      ),
    });
  }),
);
