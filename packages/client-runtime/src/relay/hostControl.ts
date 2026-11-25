import { type EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { HostRelayStatus } from "@t3tools/contracts/agentVelaRelay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as HttpClient from "effect/http/HttpClient";
import { msg } from "gt-i18n";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  MarkedText,
  errorI18nMessage,
  markedTextEnglish,
  translatableMessage,
} from "../errors/translatable.ts";
import { executeConnectedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import { findErrorTraceId } from "../errors/errorTrace.ts";
import { AgentVelaRelayClient } from "./agentVelaRelayClient.ts";
import { RelayUrlConfig } from "./relayConfig.ts";
import { selfHostedRelayErrorText } from "./relayErrors.ts";
import { RelayAuthSession } from "./relaySession.ts";

const HOST_RELAY_REQUEST_TIMEOUT_MS = 20_000;

export class HostRelayControlError extends Schema.TaggedError<HostRelayControlError>()(
  "HostRelayControlError",
  {
    message: Schema.String,
    i18nMessage: Schema.optionalKey(MarkedText),
    traceId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

function mapHostError(fallbackMessage: string) {
  return (cause: unknown): HostRelayControlError => {
    const traceId = findErrorTraceId(cause) ?? undefined;
    if (cause instanceof Error) {
      const i18n = errorI18nMessage(cause);
      return new HostRelayControlError({
        message: cause.message,
        ...(i18n ? { i18nMessage: i18n } : {}),
        ...(traceId ? { traceId } : {}),
        cause,
      });
    }
    return new HostRelayControlError({
      ...translatableMessage(fallbackMessage),
      ...(traceId ? { traceId } : {}),
      cause,
    });
  };
}

function mapRelayError(fallbackMessage: string) {
  return (cause: Parameters<typeof selfHostedRelayErrorText>[0]): HostRelayControlError => {
    const text = selfHostedRelayErrorText(cause);
    const traceId = findErrorTraceId(cause) ?? undefined;
    return new HostRelayControlError({
      message: markedTextEnglish(text) || fallbackMessage,
      i18nMessage: text,
      ...(traceId ? { traceId } : {}),
      cause,
    });
  };
}

function runHostRelayRequest<A, E>(
  environmentId: EnvironmentId,
  fallbackMessage: string,
  input: Omit<
    Parameters<typeof executeConnectedEnvironmentHttpRequest<"relay", A, E, never>>[0],
    "group" | "timeoutMs"
  >,
): Effect.Effect<
  A,
  HostRelayControlError,
  EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
> {
  return Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
    registry.run(
      environmentId,
      executeConnectedEnvironmentHttpRequest({
        ...input,
        group: "relay",
        timeoutMs: HOST_RELAY_REQUEST_TIMEOUT_MS,
      }),
    ),
  ).pipe(Effect.mapError(mapHostError(fallbackMessage)));
}

export const readHostRelayStatus = Effect.fn("clientRuntime.relay.hostControl.readStatus")(
  function* (environmentId: EnvironmentId) {
    return yield* runHostRelayRequest(environmentId, msg("Could not read host relay status."), {
      method: "GET",
      url: (urls) => urls.status(),
      request: ({ client, headers }) => client.status({ headers }),
    });
  },
);

export const linkHostToRelay = Effect.fn("clientRuntime.relay.hostControl.link")(function* (
  environmentId: EnvironmentId,
): Effect.fn.Return<
  HostRelayStatus,
  HostRelayControlError,
  | EnvironmentRegistry.EnvironmentRegistry
  | HttpClient.HttpClient
  | RelayUrlConfig
  | AgentVelaRelayClient
> {
  const relayConfig = yield* RelayUrlConfig;
  const relayClient = yield* AgentVelaRelayClient;
  const relay = yield* relayConfig.requireCurrent.pipe(
    Effect.mapError(mapRelayError(msg("No relay server URL is configured."))),
  );
  const challenge = yield* relayClient.createLinkChallenge.pipe(
    Effect.mapError(mapRelayError(msg("Could not request a relay link challenge."))),
  );
  const proofResponse = yield* runHostRelayRequest(
    environmentId,
    msg("Could not obtain host link proof."),
    {
      method: "POST",
      url: (urls) => urls.linkProof(),
      request: ({ client, headers }) =>
        client.linkProof({
          headers,
          payload: {
            relayUrl: TrimmedNonEmptyString.make(relay.origin),
            challenge: TrimmedNonEmptyString.make(challenge.challenge),
          },
        }),
    },
  );
  if (proofResponse.environmentId !== environmentId) {
    return yield* new HostRelayControlError(
      translatableMessage(msg("Host returned a link proof for a different environment.")),
    );
  }
  const linked = yield* relayClient
    .linkEnvironment({ proof: TrimmedNonEmptyString.make(proofResponse.proof) })
    .pipe(Effect.mapError(mapRelayError(msg("Could not register environment with relay."))));

  if (linked.environmentId !== environmentId) {
    return yield* new HostRelayControlError(
      translatableMessage(msg("Relay returned link credentials for a different environment.")),
    );
  }
  return yield* runHostRelayRequest(
    environmentId,
    msg("Could not save relay configuration on host."),
    {
      method: "POST",
      url: (urls) => urls.config(),
      request: ({ client, headers }) =>
        client.config({
          headers,
          payload: {
            relayUrl: TrimmedNonEmptyString.make(relay.origin),
            relayIssuer: linked.relayIssuer,
            userId: linked.userId,
            endpoint: linked.endpoint,
            environmentCredential: linked.environmentCredential,
            relayMintPublicKey: linked.relayMintPublicKey,
          },
        }),
    },
  );
});

export const reconnectHostRelay = Effect.fn("clientRuntime.relay.hostControl.reconnect")(function* (
  environmentId: EnvironmentId,
) {
  return yield* runHostRelayRequest(environmentId, msg("Could not reconnect host relay tunnel."), {
    method: "POST",
    url: (urls) => urls.reconnect(),
    request: ({ client, headers }) => client.reconnect({ headers }),
  });
});

export const unlinkHostFromRelay = Effect.fn("clientRuntime.relay.hostControl.unlink")(function* (
  environmentId: EnvironmentId,
) {
  yield* runHostRelayRequest(environmentId, msg("Could not unlink host from relay."), {
    method: "POST",
    url: (urls) => urls.unlink(),
    request: ({ client, headers }) => client.unlink({ headers }),
  });
  const session = yield* RelayAuthSession;
  if ((yield* SubscriptionRef.get(session.state)).status !== "signed_in") {
    return;
  }
  const relayClient = yield* AgentVelaRelayClient;
  yield* relayClient.unlinkEnvironment(environmentId).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "RelayApiRequestError" && error.relayError?._tag === "RelayNotFoundError",
      () => Effect.void,
    ),
    Effect.mapError(mapRelayError(msg("Unlinked on host, but relay did not confirm removal."))),
  );
});
