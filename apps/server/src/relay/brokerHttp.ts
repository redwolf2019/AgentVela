import {
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as ManagedLimits from "../policy/managedLimits.ts";
import {
  RelayBrokerInternalError,
  RelayBrokerProofRejectedError,
  RelayBrokerProofReplayedError,
  RelayBrokerService,
} from "./RelayBrokerService.ts";

const BROKER_CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendBrokerCredentialHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, BROKER_CREDENTIAL_RESPONSE_HEADERS)),
);

const logAndFailInternal = (message: string, cause: unknown) =>
  Effect.logError(message, { cause }).pipe(
    Effect.andThen(Effect.fail(new EnvironmentHttpInternalServerError({ message }))),
  );

const mapBrokerHttpError = <A, R>(
  effect: Effect.Effect<
    A,
    | RelayBrokerProofRejectedError
    | RelayBrokerProofReplayedError
    | RelayBrokerInternalError
    | EnvironmentAuth.ServerAuthInternalError
    | ManagedLimits.ManagedPolicyRefusedError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      RelayBrokerProofRejectedError: (err) =>
        Effect.fail(new EnvironmentHttpUnauthorizedError({ message: err.message })),
      RelayBrokerProofReplayedError: (err) =>
        Effect.fail(new EnvironmentHttpConflictError({ message: err.message })),
      ManagedPolicyRefusedError: (err) =>
        Effect.fail(new EnvironmentHttpForbiddenError({ message: err.message })),
      RelayBrokerInternalError: (err) => logAndFailInternal(err.message, err.cause),
    }),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (err) =>
      logAndFailInternal(err.message, err),
    ),
  );

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    const broker = yield* RelayBrokerService;
    return handlers
      .handle("health", ({ payload }) =>
        mapBrokerHttpError(broker.answerHealthRequest(payload)).pipe(
          Effect.tap(() => appendBrokerCredentialHeaders),
        ),
      )
      .handle("t3MintCredential", ({ payload }) =>
        mapBrokerHttpError(broker.mintCredential(payload)).pipe(
          Effect.tap(() => appendBrokerCredentialHeaders),
        ),
      );
  }),
);
