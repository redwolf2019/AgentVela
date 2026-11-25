// @effect-diagnostics nodeBuiltinImport:off -- API handlers generate traceIds via node:crypto.
import * as NodeCrypto from "node:crypto";

import {
  AgentVelaRelayAdminAuth,
  AgentVelaRelayApi,
  AgentVelaRelayClientAuth,
  AgentVelaRelayClientPrincipal,
  AgentVelaRelayConnectScope,
  AgentVelaRelayDpopAuth,
  AgentVelaRelayStatusScope,
  RelayAuthError,
  RelayForbiddenError,
  RelayInternalError,
  RelayRateLimitedError,
} from "@t3tools/contracts/agentVelaRelay";
import { normalizeRelayIssuer } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { AuthService } from "../auth/AuthService.ts";
import { RelayConfig, type ResolvedRelayConfig } from "../config.ts";
import { BrokerService } from "../environments/BrokerService.ts";
import { EnvironmentService } from "../environments/EnvironmentService.ts";
import { TunnelHub } from "../tunnel/TunnelHub.ts";
import { RelayRateLimiter } from "./rateLimit.ts";

export const INTERNAL_CLIENT_IP_HEADER = "x-agentvela-internal-client-ip";

const newTraceId = (): string => NodeCrypto.randomUUID();

const readBearerCredential = (credential: Redacted.Redacted<string>): string =>
  Redacted.value(credential).trimStart();

const resolveRequestUrl = (
  request: HttpServerRequest.HttpServerRequest,
  config: ResolvedRelayConfig,
): string => {
  const urlOpt = HttpServerRequest.toURL(request);
  const rawUrl = urlOpt._tag === "Some" ? urlOpt.value : new URL(request.url, config.publicUrl);
  if (config.trustProxy) {
    return `${normalizeRelayIssuer(config.publicUrl)}${rawUrl.pathname}`;
  }
  return `${rawUrl.origin}${rawUrl.pathname}`;
};

const clientIpFromRequest = (request: HttpServerRequest.HttpServerRequest): string =>
  request.headers[INTERNAL_CLIENT_IP_HEADER] ?? "unknown";

const appendNoStoreHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, {
      "cache-control": "no-store",
      pragma: "no-cache",
    }),
  ),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    response.status === 401
      ? HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")
      : response,
  ),
);

const enforceRateLimit = Effect.fn("RelayApi.enforceRateLimit")(function* (
  check: () => { readonly allowed: boolean; readonly retryAfterSeconds: number },
) {
  const result = check();
  if (!result.allowed) {
    yield* HttpEffect.appendPreResponseHandler((_req, response) =>
      Effect.succeed(
        HttpServerResponse.setHeader(response, "retry-after", String(result.retryAfterSeconds)),
      ),
    );
    return yield* new RelayRateLimitedError({
      code: "rate_limited",
      retryAfterSeconds: result.retryAfterSeconds,
      traceId: newTraceId(),
    });
  }
});

export const layerClientAuthMiddleware = Layer.effect(
  AgentVelaRelayClientAuth,
  Effect.gen(function* () {
    const auth = yield* AuthService;
    return {
      relayBearer: Effect.fn("RelayApi.middleware.clientBearer")(function* (
        httpEffect,
        { credential },
      ) {
        const principal = yield* auth.authenticateBearerToken(readBearerCredential(credential));
        return yield* httpEffect.pipe(
          Effect.provideService(AgentVelaRelayClientPrincipal, principal),
        );
      }),
    };
  }),
);

export const layerAdminAuthMiddleware = Layer.effect(
  AgentVelaRelayAdminAuth,
  Effect.gen(function* () {
    const auth = yield* AuthService;
    return {
      relayAdminBearer: Effect.fn("RelayApi.middleware.adminBearer")(function* (
        httpEffect,
        { credential },
      ) {
        const principal = yield* auth.authenticateBearerToken(readBearerCredential(credential));
        if (principal.role !== "admin") {
          return yield* new RelayForbiddenError({
            code: "forbidden",
            reason: "admin_required",
            traceId: newTraceId(),
          });
        }
        return yield* httpEffect.pipe(
          Effect.provideService(AgentVelaRelayClientPrincipal, principal),
        );
      }),
    };
  }),
);

export const layerDpopAuthMiddleware = Layer.effect(
  AgentVelaRelayDpopAuth,
  Effect.gen(function* () {
    const config = yield* RelayConfig;
    const auth = yield* AuthService;
    return {
      relayDpop: Effect.fn("RelayApi.middleware.relayDpop")(function* (httpEffect, { credential }) {
        yield* appendDpopChallengeHeader;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization =
          request.headers.authorization ?? `DPoP ${readBearerCredential(credential)}`;
        if (!/^DPoP\s+/iu.test(authorization)) {
          return yield* new RelayAuthError({
            code: "auth_invalid",
            reason: "invalid_dpop",
            dpopFailureReason: "invalid_proof",
            traceId: newTraceId(),
          });
        }
        const dpopHeader = request.headers.dpop;
        if (!dpopHeader || dpopHeader.trim().length === 0) {
          return yield* new RelayAuthError({
            code: "auth_invalid",
            reason: "invalid_dpop",
            dpopFailureReason: "invalid_proof",
            traceId: newTraceId(),
          });
        }
        const rawPath = (request.url ?? "").split("?", 1)[0] ?? "";
        const requiredScope = rawPath.endsWith("/status")
          ? AgentVelaRelayStatusScope
          : rawPath.endsWith("/connect")
            ? AgentVelaRelayConnectScope
            : undefined;
        const principal = yield* auth.authenticateDpopRequest({
          authorizationHeader: authorization,
          dpopHeader,
          method: request.method,
          url: resolveRequestUrl(request, config),
          ...(requiredScope ? { requiredScope } : {}),
        });
        return yield* httpEffect.pipe(
          Effect.provideService(AgentVelaRelayClientPrincipal, principal),
        );
      }),
    };
  }),
);

const layerHealthGroup = HttpApiBuilder.group(
  AgentVelaRelayApi,
  "health",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* RelayConfig;
    return handlers.handle("health", () =>
      Effect.succeed({
        ok: true,
        service: "agent-vela-relay" as const,
        version: config.version,
      }),
    );
  }),
);

const layerAuthPublicGroup = HttpApiBuilder.group(
  AgentVelaRelayApi,
  "authPublic",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* AuthService;
    const environments = yield* EnvironmentService;
    const rateLimiter = yield* RelayRateLimiter;
    const checkAuthLimit = (scope: string) =>
      HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap((req) =>
          enforceRateLimit(() => rateLimiter.allowAuth(`${scope}:${clientIpFromRequest(req)}`)),
        ),
      );

    return handlers
      .handle("getConfig", () => auth.getConfig())
      .handle("login", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendNoStoreHeaders;
          yield* checkAuthLimit("login");
          return yield* auth.login(payload);
        }),
      )
      .handle("register", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendNoStoreHeaders;
          yield* checkAuthLimit("register");
          return yield* auth.register(payload);
        }),
      )
      .handle("refresh", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendNoStoreHeaders;
          yield* checkAuthLimit("refresh");
          return yield* auth.refresh(payload);
        }),
      )
      .handle("startDeviceAuth", ({ payload }) =>
        Effect.gen(function* () {
          yield* checkAuthLimit("device-start");
          return yield* auth.startDeviceAuth(payload);
        }),
      )
      .handle("pollDeviceAuth", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendNoStoreHeaders;
          yield* checkAuthLimit("device-poll");
          return yield* auth.pollDeviceAuth(payload);
        }),
      )
      .handle("createEnrollmentChallenge", ({ payload }) =>
        Effect.gen(function* () {
          yield* checkAuthLimit("enroll-challenge");
          return yield* environments.createEnrollmentChallenge(payload);
        }),
      )
      .handle("enrollEnvironment", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendNoStoreHeaders;
          yield* checkAuthLimit("enroll");
          return yield* environments.enroll(payload);
        }),
      );
  }),
);

const layerAuthSessionGroup = HttpApiBuilder.group(
  AgentVelaRelayApi,
  "authSession",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* RelayConfig;
    const auth = yield* AuthService;
    return handlers
      .handle("getMe", () =>
        Effect.flatMap(AgentVelaRelayClientPrincipal, (principal) => auth.getMe(principal.userId)),
      )
      .handle("logout", ({ payload }) =>
        Effect.flatMap(AgentVelaRelayClientPrincipal, (principal) =>
          auth.logout({
            userId: principal.userId,
            ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
          }),
        ),
      )
      .handle("approveDeviceAuth", ({ payload }) =>
        Effect.flatMap(AgentVelaRelayClientPrincipal, (principal) =>
          auth.approveDeviceAuth({ userId: principal.userId, userCode: payload.userCode }),
        ),
      )
      .handle("exchangeDpopToken", ({ headers, payload }) =>
        Effect.gen(function* () {
          yield* appendNoStoreHeaders;
          yield* appendDpopChallengeHeader;
          const principal = yield* AgentVelaRelayClientPrincipal;
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* auth.exchangeDpopToken({
            principal,
            dpopProof: headers.dpop,
            requestUrl: resolveRequestUrl(request, config),
            scopes: payload.scopes,
          });
        }),
      );
  }),
);

const layerEnvironmentsGroup = HttpApiBuilder.group(
  AgentVelaRelayApi,
  "environments",
  Effect.fnUntraced(function* (handlers) {
    const environments = yield* EnvironmentService;
    const tunnelHub = yield* TunnelHub;
    return handlers
      .handle("list", () =>
        Effect.flatMap(AgentVelaRelayClientPrincipal, (principal) =>
          tunnelHub.listEnvironmentsForUser(principal.userId),
        ),
      )
      .handle("createLinkChallenge", () =>
        Effect.flatMap(AgentVelaRelayClientPrincipal, (principal) =>
          environments.createLinkChallenge(principal.userId),
        ),
      )
      .handle("link", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendNoStoreHeaders;
          const principal = yield* AgentVelaRelayClientPrincipal;
          return yield* environments.link({ userId: principal.userId, proof: payload.proof });
        }),
      )
      .handle("unlink", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* AgentVelaRelayClientPrincipal;
          const result = yield* environments.unlink({
            userId: principal.userId,
            environmentId: params.environmentId,
          });
          tunnelHub.disconnectIfActive(params.environmentId, "Environment unlinked");
          return result;
        }),
      )
      .handle("createEnrollmentToken", ({ payload }) =>
        Effect.flatMap(AgentVelaRelayClientPrincipal, (principal) =>
          environments.createEnrollmentToken({
            userId: principal.userId,
            request: payload,
          }),
        ),
      );
  }),
);

const layerConnectGroup = HttpApiBuilder.group(
  AgentVelaRelayApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    const broker = yield* BrokerService;
    return handlers
      .handle("connectEnvironment", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* appendNoStoreHeaders;
          const principal = yield* AgentVelaRelayClientPrincipal;
          const thumbprint = principal.proofKeyThumbprint;
          if (!thumbprint) {
            return yield* new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId: newTraceId(),
            });
          }
          if (payload.clientProofKeyThumbprint !== thumbprint) {
            return yield* new RelayAuthError({
              code: "auth_invalid",
              reason: "invalid_dpop",
              dpopFailureReason: "invalid_proof",
              traceId: newTraceId(),
            });
          }
          return yield* broker.connectEnvironment({
            userId: principal.userId,
            environmentId: params.environmentId,
            proofKeyThumbprint: thumbprint,
            ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
          });
        }),
      )
      .handle("getEnvironmentStatus", ({ params }) =>
        Effect.flatMap(AgentVelaRelayClientPrincipal, (principal) =>
          broker.getEnvironmentStatus({
            userId: principal.userId,
            environmentId: params.environmentId,
          }),
        ),
      );
  }),
);

const layerAdminGroup = HttpApiBuilder.group(
  AgentVelaRelayApi,
  "admin",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* AuthService;
    const tunnelHub = yield* TunnelHub;
    return handlers
      .handle("listUsers", () => auth.listUsers())
      .handle("createUser", ({ payload }) => auth.createUser(payload))
      .handle("updateUser", ({ params, payload }) =>
        auth.updateUser({ userId: params.userId, patch: payload }),
      )
      .handle("listInvites", () => auth.listInvites())
      .handle("createInvite", ({ payload }) =>
        Effect.flatMap(AgentVelaRelayClientPrincipal, (principal) =>
          auth.createInvite({ createdByUserId: principal.userId, request: payload }),
        ),
      )
      .handle("revokeInvite", ({ params }) => auth.revokeInvite(params.inviteId))
      .handle("listTunnels", () => Effect.sync(() => tunnelHub.listTunnels()))
      .handle("kickTunnel", ({ params, payload }) =>
        tunnelHub.kickTunnel({
          environmentId: params.environmentId,
          ...(payload.reason ? { reason: payload.reason } : {}),
        }),
      );
  }),
);

const layerHooksGroup = HttpApiBuilder.group(AgentVelaRelayApi, "hooks", (handlers) => {
  const unhandled = () => Effect.void;
  return Effect.succeed(
    handlers
      .handle("forwardGet", unhandled)
      .handle("forwardPost", unhandled)
      .handle("forwardPut", unhandled)
      .handle("forwardPatch", unhandled),
  );
});

export const layerAgentVelaRelayHttpApi = Layer.mergeAll(
  layerHealthGroup,
  layerAuthPublicGroup,
  layerAuthSessionGroup,
  layerEnvironmentsGroup,
  layerConnectGroup,
  layerAdminGroup,
  layerHooksGroup,
).pipe(
  Layer.provideMerge(layerClientAuthMiddleware),
  Layer.provideMerge(layerAdminAuthMiddleware),
  Layer.provideMerge(layerDpopAuthMiddleware),
);
