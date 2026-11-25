import { TrimmedNonEmptyString } from "@t3tools/contracts";
import type {
  AgentVelaRelayLinkProofPayload,
  HostRelayConfigRequest,
  HostRelayLinkProofRequest,
  HostRelayLinkProofResponse,
  HostRelayStatus,
} from "@t3tools/contracts/agentVelaRelay";
import { normalizeRelayIssuer, RELAY_LINK_PROOF_TYP } from "@t3tools/shared/relayJwt";
import { normalizeRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  createRelayEnrollmentChallenge,
  createRelayLinkChallenge,
  enrollRelayEnvironment,
  linkRelayEnvironment,
  type RelayApiClientError,
} from "./RelayApiClient.ts";
import { clearRelayLinkConfig, readRelayLinkConfig, saveRelayLinkConfig } from "./RelayState.ts";
import { RelayTunnelClient } from "./RelayTunnelClient.ts";

export class RelayLinkBadRequestError extends Schema.TaggedError<RelayLinkBadRequestError>()(
  "RelayLinkBadRequestError",
  {
    message: Schema.String,
  },
) {}

export class RelayLinkInternalError extends Schema.TaggedError<RelayLinkInternalError>()(
  "RelayLinkInternalError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type RelayLinkOperationError =
  | RelayLinkBadRequestError
  | RelayLinkInternalError
  | ManagedLimits.ManagedPolicyRefusedError
  | RelayApiClientError;

export class RelayLinkService extends Context.Service<
  RelayLinkService,
  {
    readonly getStatus: () => Effect.Effect<HostRelayStatus, RelayLinkInternalError>;
    readonly createLinkProof: (
      input: HostRelayLinkProofRequest,
    ) => Effect.Effect<
      HostRelayLinkProofResponse,
      RelayLinkBadRequestError | RelayLinkInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly applyConfig: (
      input: HostRelayConfigRequest,
    ) => Effect.Effect<
      HostRelayStatus,
      RelayLinkBadRequestError | RelayLinkInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly reconnect: () => Effect.Effect<
      HostRelayStatus,
      RelayLinkBadRequestError | RelayLinkInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly unlink: () => Effect.Effect<{ readonly ok: true }, RelayLinkInternalError>;
    readonly linkWithAccessToken: (input: {
      readonly relayUrl: string;
      readonly accessToken: string;
    }) => Effect.Effect<HostRelayStatus, RelayLinkOperationError>;
    readonly enrollWithToken: (input: {
      readonly relayUrl: string;
      readonly enrollmentToken: string;
    }) => Effect.Effect<HostRelayStatus, RelayLinkOperationError>;
  }
>()("t3/relay/RelayLinkService") {}

const LINK_PROOF_TTL_SECONDS = 300;

export const layer = Layer.effect(
  RelayLinkService,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const identity = yield* ServerEnvironment.ServerEnvironment;
    const signingKey = yield* EnvironmentSigningKey;
    const random = yield* SecureRandom.SecureRandom;
    const httpClient = yield* HttpClient.HttpClient;
    const policyService = yield* ManagedPolicy.ManagedPolicy;
    const tunnelClient = yield* RelayTunnelClient;

    const withSecrets = Effect.provideService(ServerSecretStore.ServerSecretStore, secrets);
    const withHttp = Effect.provideService(HttpClient.HttpClient, httpClient);

    const mapInternal =
      (operation: string) =>
      (cause: unknown): RelayLinkInternalError =>
        new RelayLinkInternalError({
          message: `Relay ${operation} failed.`,
          cause,
        });

    const requireAllowed = ManagedLimits.allowsConnect(policyService)
      ? Effect.void
      : Effect.fail(ManagedLimits.refuseConnect(policyService));

    const getStatus = Effect.fn("RelayLinkService.getStatus")(function* () {
      const [link, tunnel] = yield* Effect.all([
        readRelayLinkConfig().pipe(withSecrets, Effect.mapError(mapInternal("read status"))),
        tunnelClient.getSnapshot(),
      ]);
      return {
        linked: Option.isSome(link),
        relayUrl: Option.isSome(link) ? link.value.relayUrl : null,
        relayIssuer: Option.isSome(link) ? link.value.relayIssuer : null,
        userId: Option.isSome(link) ? link.value.userId : null,
        endpoint: Option.isSome(link) ? link.value.endpoint : null,
        tunnel,
      } satisfies HostRelayStatus;
    });

    const createLinkProof = Effect.fn("RelayLinkService.createLinkProof")(function* (
      input: HostRelayLinkProofRequest,
    ) {
      yield* requireAllowed;
      const normalizedUrl = normalizeRelayUrl(input.relayUrl);
      if (normalizedUrl === null) {
        return yield* new RelayLinkBadRequestError({
          message:
            "Relay URL must use https://, or http:// on loopback, RFC1918 LAN, or Tailscale.",
        });
      }
      const [environmentId, descriptor, now, jti] = yield* Effect.all([
        identity.getEnvironmentId,
        identity.getDescriptor,
        DateTime.now,
        random.uuidV4().pipe(Effect.orDie),
      ]);
      const iat = Math.floor(now.epochMilliseconds / 1_000);
      const payload: AgentVelaRelayLinkProofPayload = {
        iss: TrimmedNonEmptyString.make(`t3-env:${environmentId}`),
        aud: TrimmedNonEmptyString.make(normalizeRelayIssuer(normalizedUrl)),
        sub: TrimmedNonEmptyString.make(environmentId),
        jti: TrimmedNonEmptyString.make(jti),
        iat,
        exp: iat + LINK_PROOF_TTL_SECONDS,
        challenge: TrimmedNonEmptyString.make(input.challenge.trim()),
        environmentId,
        environmentPublicKey: TrimmedNonEmptyString.make(signingKey.publicKey),
        descriptor,
      };
      const proof = yield* signingKey
        .sign({ typ: RELAY_LINK_PROOF_TYP, payload: payload as unknown as Record<string, unknown> })
        .pipe(Effect.mapError(mapInternal("sign link proof")));
      return {
        environmentId,
        environmentPublicKey: TrimmedNonEmptyString.make(signingKey.publicKey),
        descriptor,
        proof: TrimmedNonEmptyString.make(proof),
      } satisfies HostRelayLinkProofResponse;
    });

    const applyConfig = Effect.fn("RelayLinkService.applyConfig")(function* (
      input: HostRelayConfigRequest,
    ) {
      yield* requireAllowed;
      const saved = yield* saveRelayLinkConfig(input).pipe(
        withSecrets,
        Effect.catchTags({
          RelayStateValidationError: (error) =>
            Effect.fail(new RelayLinkBadRequestError({ message: error.message })),
        }),
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          Effect.fail(mapInternal("save config")(error)),
        ),
        Effect.mapError((err) =>
          err._tag === "RelayLinkBadRequestError" || err._tag === "RelayLinkInternalError"
            ? err
            : mapInternal("save config")(err),
        ),
      );
      yield* tunnelClient.configure(saved);
      return yield* getStatus();
    });

    const reconnect = Effect.fn("RelayLinkService.reconnect")(function* () {
      yield* requireAllowed;
      const link = yield* readRelayLinkConfig().pipe(
        withSecrets,
        Effect.mapError(mapInternal("read config")),
      );
      if (Option.isNone(link)) {
        return yield* new RelayLinkBadRequestError({
          message: "This environment is not linked to a self-hosted relay.",
        });
      }
      yield* tunnelClient.configure(link.value);
      return yield* getStatus();
    });

    const unlink = Effect.fn("RelayLinkService.unlink")(function* () {
      yield* tunnelClient.configure(null);
      yield* clearRelayLinkConfig().pipe(withSecrets, Effect.mapError(mapInternal("clear config")));
      return { ok: true as const };
    });

    const linkWithAccessToken = Effect.fn("RelayLinkService.linkWithAccessToken")(
      function* (input: { readonly relayUrl: string; readonly accessToken: string }) {
        yield* requireAllowed;
        const { challenge } = yield* createRelayLinkChallenge(
          input.relayUrl,
          input.accessToken,
        ).pipe(withHttp);
        const signed = yield* createLinkProof({
          relayUrl: TrimmedNonEmptyString.make(input.relayUrl),
          challenge,
        });
        const linked = yield* linkRelayEnvironment(
          input.relayUrl,
          input.accessToken,
          signed.proof,
        ).pipe(withHttp);
        return yield* applyConfig({
          relayUrl: TrimmedNonEmptyString.make(input.relayUrl),
          relayIssuer: linked.relayIssuer,
          userId: linked.userId,
          endpoint: linked.endpoint,
          environmentCredential: linked.environmentCredential,
          relayMintPublicKey: linked.relayMintPublicKey,
        });
      },
    );

    const enrollWithToken = Effect.fn("RelayLinkService.enrollWithToken")(function* (input: {
      readonly relayUrl: string;
      readonly enrollmentToken: string;
    }) {
      yield* requireAllowed;
      const { challenge } = yield* createRelayEnrollmentChallenge(
        input.relayUrl,
        input.enrollmentToken,
      ).pipe(withHttp);
      const signed = yield* createLinkProof({
        relayUrl: TrimmedNonEmptyString.make(input.relayUrl),
        challenge,
      });
      const linked = yield* enrollRelayEnvironment(
        input.relayUrl,
        input.enrollmentToken,
        signed.proof,
      ).pipe(withHttp);
      return yield* applyConfig({
        relayUrl: TrimmedNonEmptyString.make(input.relayUrl),
        relayIssuer: linked.relayIssuer,
        userId: linked.userId,
        endpoint: linked.endpoint,
        environmentCredential: linked.environmentCredential,
        relayMintPublicKey: linked.relayMintPublicKey,
      });
    });

    return RelayLinkService.of({
      getStatus,
      createLinkProof,
      applyConfig,
      reconnect,
      unlink,
      linkWithAccessToken,
      enrollWithToken,
    });
  }),
);
