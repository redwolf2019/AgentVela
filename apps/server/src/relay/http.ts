import {
  type EnvironmentScopeRequiredError,
  AuthRelayConfigureScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";
import type * as ManagedLimits from "../policy/managedLimits.ts";
import {
  type RelayLinkBadRequestError,
  type RelayLinkInternalError,
  RelayLinkService,
} from "./RelayLinkService.ts";

const RELAY_CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendRelayCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, RELAY_CREDENTIAL_RESPONSE_HEADERS)),
);

const mapRelayHttpErrors = <A, R>(
  effect: Effect.Effect<
    A,
    | RelayLinkBadRequestError
    | RelayLinkInternalError
    | ManagedLimits.ManagedPolicyRefusedError
    | EnvironmentScopeRequiredError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      RelayLinkBadRequestError: (err) =>
        Effect.fail(new EnvironmentHttpBadRequestError({ message: err.message })),
      ManagedPolicyRefusedError: (err) =>
        Effect.fail(new EnvironmentHttpForbiddenError({ message: err.message })),
      RelayLinkInternalError: (err) =>
        Effect.logError(err.message, { cause: err.cause }).pipe(
          Effect.andThen(
            Effect.fail(new EnvironmentHttpInternalServerError({ message: err.message })),
          ),
        ),
    }),
  );

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "relay",
  Effect.fnUntraced(function* (handlers) {
    const relayLinks = yield* RelayLinkService;
    return handlers
      .handle("status", () =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayReadScope);
          return yield* relayLinks.getStatus();
        }).pipe(mapRelayHttpErrors),
      )
      .handle("linkProof", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayConfigureScope);
          const proof = yield* relayLinks.createLinkProof(payload);
          yield* appendRelayCredentialResponseHeaders;
          return proof;
        }).pipe(mapRelayHttpErrors),
      )
      .handle("config", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayConfigureScope);
          const status = yield* relayLinks.applyConfig(payload);
          yield* appendRelayCredentialResponseHeaders;
          return status;
        }).pipe(mapRelayHttpErrors),
      )
      .handle("reconnect", () =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          return yield* relayLinks.reconnect();
        }).pipe(mapRelayHttpErrors),
      )
      .handle("unlink", () =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          return yield* relayLinks.unlink();
        }).pipe(mapRelayHttpErrors),
      );
  }),
);
