import { TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  type RelayAuthSessionResponse,
  RelayUserId,
  RelayUsername,
} from "@t3tools/contracts/agentVelaRelay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";
import {
  RelayUrlConfig,
  layerInMemoryRelayConfigStorage,
  layerRelayUrlConfig,
} from "./relayConfig.ts";
import {
  RelayAuthSession,
  RelaySessionStore,
  type StoredRelaySession,
  layerCloudSessionFromRelayAuth,
  layerInMemoryRelaySessionStore,
  layerRelayAuthSession,
} from "./relaySession.ts";

const RELAY_URL = "https://relay.example.com";
const OTHER_RELAY_URL = "https://relay-two.example.com";
const USER_1_ID = RelayUserId.make("user-1");

const ALICE_RECORD = {
  userId: USER_1_ID,
  username: RelayUsername.make("alice"),
  role: "admin" as const,
  disabled: false,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

function makeAuthResponse(overrides?: {
  readonly accessToken?: string;
  readonly accessTokenExpiresAt?: string;
  readonly refreshToken?: string;
  readonly user?: typeof ALICE_RECORD;
}): RelayAuthSessionResponse {
  return {
    user: overrides?.user ?? ALICE_RECORD,
    accessToken: TrimmedNonEmptyString.make(overrides?.accessToken ?? "access-1"),
    accessTokenExpiresAt: (overrides?.accessTokenExpiresAt ??
      "1970-01-01T00:05:00.000Z") as RelayAuthSessionResponse["accessTokenExpiresAt"],
    refreshToken: TrimmedNonEmptyString.make(overrides?.refreshToken ?? "refresh-1"),
    refreshTokenExpiresAt:
      "1970-01-02T00:00:00.000Z" as RelayAuthSessionResponse["refreshTokenExpiresAt"],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeTestLayer(
  fetchFn: typeof globalThis.fetch,
  options?: {
    readonly initialUrl?: string | null;
    readonly initialSession?: StoredRelaySession | null;
  },
) {
  const configLayer = layerRelayUrlConfig({
    defaultRelayUrl: options?.initialUrl === undefined ? RELAY_URL : options.initialUrl,
  }).pipe(Layer.provide(layerInMemoryRelayConfigStorage()));
  const storeLayer = layerInMemoryRelaySessionStore(options?.initialSession ?? null);
  const httpLayer = RpcHttp.layerRemoteHttpClient(fetchFn);
  const sessionLayer = layerRelayAuthSession.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(httpLayer),
  );
  const cloudSessionLayer = layerCloudSessionFromRelayAuth.pipe(Layer.provide(sessionLayer));
  return Layer.mergeAll(sessionLayer, cloudSessionLayer);
}

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

async function readRequestRecord(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<RecordedRequest> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const rawBody =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : input instanceof Request && method !== "GET" && method !== "HEAD"
          ? await input.clone().text()
          : "";
  return {
    url,
    method,
    authorization: headers.get("authorization"),
    body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
  };
}

describe("relaySession", () => {
  it.effect("handles getConfig, checkHealth, login, register, and getMe", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = [];
      const fetchFn: typeof globalThis.fetch = async (input, init) => {
        const req = await readRequestRecord(input, init);
        requests.push(req);
        const path = new URL(req.url).pathname;
        if (path === "/health") {
          return jsonResponse({ ok: true, service: "agent-vela-relay", version: "1.0.0" });
        }
        if (path === "/v1/auth/config") {
          return jsonResponse({ initialized: true, registrationOpen: true, version: "1.0.0" });
        }
        if (path === "/v1/auth/login") {
          return jsonResponse(makeAuthResponse({ accessToken: "login-access" }));
        }
        if (path === "/v1/auth/register") {
          return jsonResponse(makeAuthResponse({ accessToken: "register-access" }));
        }
        if (path === "/v1/auth/me") {
          return jsonResponse({
            ...ALICE_RECORD,
            updatedAt: "1970-01-01T00:01:00.000Z",
          });
        }
        return jsonResponse({ message: `unexpected ${path}` }, 500);
      };

      const program = Effect.gen(function* () {
        const session = yield* RelayAuthSession;
        const store = yield* RelaySessionStore;

        const health = yield* session.checkHealth;
        expect(health.service).toBe("agent-vela-relay");

        const cfg = yield* session.getConfig;
        expect(cfg.registrationOpen).toBe(true);

        const signedInUser = yield* session.login({
          username: RelayUsername.make("alice"),
          password: TrimmedNonEmptyString.make("correct-horse-battery"),
          clientSurface: "web",
        });
        expect(signedInUser.username).toBe("alice");
        expect(Option.isSome(yield* store.load)).toBe(true);
        expect((yield* SubscriptionRef.get(session.state)).status).toBe("signed_in");

        const profile = yield* session.getMe;
        expect(profile.updatedAt).toBe("1970-01-01T00:01:00.000Z");
        expect(Option.getOrThrow(yield* store.load).user.updatedAt).toBe(
          "1970-01-01T00:01:00.000Z",
        );

        const registeredUser = yield* session.register({
          username: RelayUsername.make("alice"),
          password: TrimmedNonEmptyString.make("correct-horse-battery"),
          inviteCode: TrimmedNonEmptyString.make("INV-123"),
        });
        expect(registeredUser.userId).toBe(USER_1_ID);
        expect(Option.getOrThrow(yield* store.load).accessToken).toBe("register-access");
      });

      yield* program.pipe(Effect.provide(makeTestLayer(fetchFn)));
      expect(requests.map((entry) => new URL(entry.url).pathname)).toEqual([
        "/health",
        "/v1/auth/config",
        "/v1/auth/login",
        "/v1/auth/me",
        "/v1/auth/register",
      ]);
      expect(requests[3]?.authorization).toBe("Bearer login-access");
    }),
  );

  it.effect("retries getMe once on token_expired and does not refresh on account_disabled", () =>
    Effect.gen(function* () {
      let meMode: "expired-once" | "disabled" = "expired-once";
      const paths: Array<string> = [];

      const fetchFn: typeof globalThis.fetch = async (input, init) => {
        const req = await readRequestRecord(input, init);
        const path = new URL(req.url).pathname;
        paths.push(path);

        if (path === "/v1/auth/me") {
          if (meMode === "expired-once" && req.authorization === "Bearer access-initial") {
            return jsonResponse(
              {
                _tag: "RelayAuthError",
                code: "auth_invalid",
                reason: "token_expired",
                traceId: "trace-exp",
              },
              401,
            );
          }
          if (meMode === "disabled") {
            return jsonResponse(
              {
                _tag: "RelayAuthError",
                code: "auth_invalid",
                reason: "account_disabled",
                traceId: "trace-dis",
              },
              401,
            );
          }
          return jsonResponse(ALICE_RECORD);
        }
        if (path === "/v1/auth/refresh") {
          return jsonResponse(makeAuthResponse({ accessToken: "access-refreshed" }));
        }
        return jsonResponse({}, 404);
      };

      const initialSession: StoredRelaySession = {
        relayUrl: RELAY_URL,
        user: ALICE_RECORD,
        accessToken: "access-initial",
        accessTokenExpiresAt: "1970-01-01T00:05:00.000Z",
        refreshToken: "refresh-1",
        refreshTokenExpiresAt: "1970-01-02T00:00:00.000Z",
      };

      yield* Effect.gen(function* () {
        const session = yield* RelayAuthSession;

        const profile = yield* session.getMe;
        expect(profile.userId).toBe(USER_1_ID);
        expect(paths).toEqual(["/v1/auth/me", "/v1/auth/refresh", "/v1/auth/me"]);

        // Explicit session.refresh forces a refresh even when token is fresh
        const forced = yield* session.refresh;
        expect(forced.accessToken).toBe("access-refreshed");
        expect(paths).toEqual([
          "/v1/auth/me",
          "/v1/auth/refresh",
          "/v1/auth/me",
          "/v1/auth/refresh",
        ]);

        meMode = "disabled";
        const disabledFailure = yield* session.getMe.pipe(Effect.flip);
        expect(disabledFailure._tag).toBe("RelayApiRequestError");
        if (disabledFailure._tag === "RelayApiRequestError") {
          expect(disabledFailure.relayError?._tag).toBe("RelayAuthError");
          if (disabledFailure.relayError?._tag === "RelayAuthError") {
            expect(disabledFailure.relayError.reason).toBe("account_disabled");
          }
        }
        // Refresh count stayed at 2; disabled error was not masked by refresh_failed
        expect(paths.filter((p) => p === "/v1/auth/refresh")).toHaveLength(2);
      }).pipe(Effect.provide(makeTestLayer(fetchFn, { initialSession })));
    }),
  );

  it.effect(
    "coalesces concurrent single-flight refreshes and transitions signed_out on auth failure",
    () =>
      Effect.gen(function* () {
        let refreshCount = 0;
        let shouldFailRefresh = false;
        let onRefreshStarted: (() => void) | undefined;
        const refreshStarted = new Promise<void>((resolve) => {
          onRefreshStarted = resolve;
        });
        let releaseRefresh: (() => void) | undefined;
        const refreshGate = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });

        const fetchFn: typeof globalThis.fetch = async (input, init) => {
          const req = await readRequestRecord(input, init);
          const path = new URL(req.url).pathname;
          if (path === "/v1/auth/refresh") {
            refreshCount += 1;
            if (shouldFailRefresh) {
              return jsonResponse(
                {
                  _tag: "RelayAuthError",
                  code: "auth_invalid",
                  reason: "invalid_token",
                  traceId: "trace-bad-refresh",
                },
                401,
              );
            }
            onRefreshStarted?.();
            await refreshGate;
            return jsonResponse(
              makeAuthResponse({ accessToken: "access-single-flight", refreshToken: "refresh-2" }),
            );
          }
          return jsonResponse({}, 404);
        };

        const expiredSession: StoredRelaySession = {
          relayUrl: RELAY_URL,
          user: ALICE_RECORD,
          accessToken: "access-expired",
          accessTokenExpiresAt: "1970-01-01T00:00:05.000Z",
          refreshToken: "refresh-1",
          refreshTokenExpiresAt: "1970-01-02T00:00:00.000Z",
        };

        yield* Effect.gen(function* () {
          const session = yield* RelayAuthSession;
          const store = yield* RelaySessionStore;

          const fiber1 = yield* session.getValidAccessToken().pipe(Effect.forkChild);
          yield* Effect.promise(() => refreshStarted);
          const fiber2 = yield* session.getValidAccessToken().pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.sync(() => releaseRefresh?.());

          const [tok1, tok2] = yield* Effect.all([Fiber.join(fiber1), Fiber.join(fiber2)]);
          expect(refreshCount).toBe(1);
          expect(tok1.accessToken).toBe("access-single-flight");
          expect(tok2.accessToken).toBe("access-single-flight");

          shouldFailRefresh = true;
          const refreshFail = yield* session.refresh.pipe(Effect.flip);
          expect(refreshFail._tag).toBe("RelaySessionUnavailableError");
          if (refreshFail._tag === "RelaySessionUnavailableError") {
            expect(refreshFail.reason).toBe("refresh_failed");
          }
          expect((yield* SubscriptionRef.get(session.state)).status).toBe("signed_out");
          expect(Option.isNone(yield* store.load)).toBe(true);
        }).pipe(Effect.provide(makeTestLayer(fetchFn, { initialSession: expiredSession })));
      }),
  );

  it.effect(
    "handles device auth, best-effort logout, relay URL isolation, and CloudSession identity",
    () =>
      Effect.gen(function* () {
        const requests: Array<RecordedRequest> = [];
        let failLogout = true;

        const fetchFn: typeof globalThis.fetch = async (input, init) => {
          const req = await readRequestRecord(input, init);
          requests.push(req);
          const path = new URL(req.url).pathname;
          if (path === "/v1/auth/device/start") {
            return jsonResponse({
              deviceCode: "dev-code-1",
              userCode: "ABCD-1234",
              verificationPath: "/device",
              expiresAt: "1970-01-01T00:10:00.000Z",
              intervalSeconds: 5,
            });
          }
          if (path === "/v1/auth/device/poll") {
            return jsonResponse({
              status: "approved",
              session: makeAuthResponse({ accessToken: "device-access" }),
            });
          }
          if (path === "/v1/auth/device/approve") {
            return jsonResponse({ ok: true });
          }
          if (path === "/v1/auth/refresh") {
            return jsonResponse(makeAuthResponse({ accessToken: "refreshed-cloud-token" }));
          }
          if (path === "/v1/auth/logout") {
            if (failLogout) {
              return jsonResponse({ message: "server error" }, 500);
            }
            return jsonResponse({ ok: true });
          }
          return jsonResponse({}, 404);
        };

        yield* Effect.gen(function* () {
          const config = yield* RelayUrlConfig;
          const session = yield* RelayAuthSession;
          const cloud = yield* ClientCapabilities.CloudSession;
          const store = yield* RelaySessionStore;
          const accountEvents = yield* Queue.unbounded<string | null>();
          const twoChangesReady = yield* Deferred.make<void>();
          let changeCount = 0;

          const watcher = yield* session.accountChanges.pipe(
            Stream.runForEach((key) =>
              Effect.gen(function* () {
                yield* Queue.offer(accountEvents, key);
                changeCount += 1;
                if (changeCount >= 2) {
                  yield* Deferred.succeed(twoChangesReady, undefined);
                }
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );

          expect(Option.isNone(yield* cloud.identity)).toBe(true);

          const started = yield* session.startDeviceAuth({
            deviceLabel: TrimmedNonEmptyString.make("laptop"),
          });
          expect(started.userCode).toBe("ABCD-1234");
          const polled = yield* session.pollDeviceAuth({ deviceCode: started.deviceCode });
          expect(polled.status).toBe("approved");
          if (polled.status === "approved") {
            yield* session.adoptSession(polled.session);
          }

          const approved = yield* session.approveDeviceAuth({
            userCode: TrimmedNonEmptyString.make("ABCD-1234"),
          });
          expect(approved.ok).toBe(true);

          const identityBefore = Option.getOrThrow(yield* cloud.identity);
          expect(identityBefore.accountId).toBe(`${RELAY_URL}:user-1`);
          expect(yield* cloud.clerkToken).toBe("device-access");

          // Identity object reference must remain strictly equal across token refreshes
          yield* session.refresh;
          const identityAfterRefresh = Option.getOrThrow(yield* cloud.identity);
          expect(identityAfterRefresh).toBe(identityBefore);
          expect(yield* cloud.clerkToken).toBe("refreshed-cloud-token");

          // Best-effort logout succeeds locally even if remote /v1/auth/logout returns 500
          yield* session.logout;
          expect((yield* SubscriptionRef.get(session.state)).status).toBe("signed_out");
          expect(Option.isNone(yield* store.load)).toBe(true);
          expect(Option.isNone(yield* cloud.identity)).toBe(true);

          // Switching relay URL while signed in clears the old relay session
          failLogout = false;
          yield* session.adoptSession(makeAuthResponse({ accessToken: "before-switch" }));
          yield* config.setRelayUrl(OTHER_RELAY_URL);
          yield* Effect.yieldNow;
          const postSwitchState = yield* SubscriptionRef.get(session.state);
          expect(postSwitchState.status).toBe("signed_out");
          expect(postSwitchState.relayUrl).toBe(OTHER_RELAY_URL);

          yield* Deferred.await(twoChangesReady);
          yield* Fiber.interrupt(watcher);
          const keys = Array.from(yield* Queue.takeAll(accountEvents));
          expect(keys[0]).toBe(`${RELAY_URL}:user-1`);
          expect(keys[1]).toBeNull();
        }).pipe(Effect.provide(makeTestLayer(fetchFn)));

        expect(requests.some((req) => new URL(req.url).pathname === "/v1/auth/logout")).toBe(true);
      }),
  );
});
