import {
  RelayCloudEnvironmentHealthProofPayload,
  type RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialProofPayload,
  type RelayCloudMintCredentialRequest,
  type RelayEnvironmentHealthResponse,
  type RelayEnvironmentHealthResponseProofPayload,
  type RelayEnvironmentMintResponse,
  type RelayEnvironmentMintResponseProofPayload,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RelayState from "./RelayState.ts";

const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
const PROOF_MAX_LIFETIME_SECONDS = 5 * 60;
const PROOF_CLOCK_SKEW_SECONDS = 60;

export const RELAY_BROKER_REPLAY_MARKER_PREFIXES = [
  CLOUD_MINT_NONCE_PREFIX,
  CLOUD_MINT_JTI_PREFIX,
  CLOUD_HEALTH_NONCE_PREFIX,
  CLOUD_HEALTH_JTI_PREFIX,
] as const;

const SignedRelayRequest = Schema.Literals(["health", "mint"]);

export class RelayBrokerProofRejectedError extends Schema.TaggedError<RelayBrokerProofRejectedError>()(
  "RelayBrokerProofRejectedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Invalid cloud ${this.request} request.`;
  }
}

export class RelayBrokerProofReplayedError extends Schema.TaggedError<RelayBrokerProofReplayedError>()(
  "RelayBrokerProofReplayedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Cloud ${this.request} request was already consumed.`;
  }
}

const INTERNAL_OPERATION_MESSAGES = {
  "answer-health": "Could not answer cloud health request.",
  "issue-credential": "Could not issue cloud connection credential.",
} as const;

export class RelayBrokerInternalError extends Schema.TaggedError<RelayBrokerInternalError>()(
  "RelayBrokerInternalError",
  {
    operation: Schema.Literals(["answer-health", "issue-credential"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return INTERNAL_OPERATION_MESSAGES[this.operation];
  }
}

export type RelayBrokerOperationError =
  | RelayBrokerProofRejectedError
  | RelayBrokerProofReplayedError
  | RelayBrokerInternalError
  | EnvironmentAuth.ServerAuthInternalError
  | ManagedLimits.ManagedPolicyRefusedError;

export class RelayBrokerService extends Context.Service<
  RelayBrokerService,
  {
    readonly answerHealthRequest: (
      request: RelayCloudEnvironmentHealthRequest,
    ) => Effect.Effect<RelayEnvironmentHealthResponse, RelayBrokerOperationError>;
    readonly mintCredential: (
      request: RelayCloudMintCredentialRequest,
    ) => Effect.Effect<RelayEnvironmentMintResponse, RelayBrokerOperationError>;
  }
>()("t3/relay/RelayBrokerService") {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function hasExactScope(scopes: ReadonlyArray<string>, expected: string): boolean {
  return scopes.length === 1 && scopes[0] === expected;
}

function hasBoundedProofLifetime(input: {
  readonly iat: number;
  readonly exp: number;
  readonly nowSeconds: number;
}): boolean {
  return (
    input.exp > input.iat &&
    input.exp - input.iat <= PROOF_MAX_LIFETIME_SECONDS &&
    input.iat <= input.nowSeconds + PROOF_CLOCK_SKEW_SECONDS &&
    input.exp >= input.nowSeconds - PROOF_CLOCK_SKEW_SECONDS
  );
}

function consumeReplayGuards(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly names: ReadonlyArray<string>;
  readonly value: Uint8Array;
}) {
  return Effect.forEach(
    input.names,
    (name) =>
      input.secrets.create(name, input.value).pipe(
        Effect.as(true),
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          ServerSecretStore.isSecretAlreadyExistsError(error)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      ),
    { concurrency: input.names.length },
  ).pipe(Effect.map((created) => created.every(Boolean)));
}

const mapInternal =
  (operation: RelayBrokerInternalError["operation"]) =>
  (cause: unknown): Effect.Effect<never, RelayBrokerInternalError> =>
    Effect.fail(new RelayBrokerInternalError({ operation, cause }));

const requireSecretText = <E>(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  key: string,
  onMissing: () => E,
) =>
  secrets
    .get(key)
    .pipe(
      Effect.flatMap((bytes) =>
        Option.isSome(bytes)
          ? Effect.succeed(textDecoder.decode(bytes.value))
          : Effect.fail(onMissing()),
      ),
    );

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const signature = yield* Signature.Signature;
  const signingKey = yield* EnvironmentSigningKey;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;

  const withSecrets = Effect.provideService(ServerSecretStore.ServerSecretStore, secrets);
  const replayMarkerName = Effect.fnUntraced(function* (prefix: string, value: string) {
    const hash = yield* digest.digest(Digest.sha256, textEncoder.encode(value)).pipe(Effect.orDie);
    return `${prefix}${Hex.encode(hash)}`;
  });

  const readVerificationContext = Effect.fn("RelayBrokerService.readVerificationContext")(
    function* () {
      const link = yield* RelayState.readRelayLinkConfig().pipe(
        withSecrets,
        Effect.catchIf(ServerSecretStore.isSecretStoreError, () => Effect.succeedNone),
      );
      if (Option.isSome(link)) {
        return {
          mintPublicKey: link.value.relayMintPublicKey,
          relayIssuer: link.value.relayIssuer,
          linkedUserId: link.value.userId,
        };
      }
      const mintPublicKey = yield* requireSecretText(
        secrets,
        CLOUD_MINT_PUBLIC_KEY,
        () => new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({}),
      );
      const relayIssuer = yield* requireSecretText(
        secrets,
        RELAY_ISSUER_SECRET,
        () => new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({}),
      ).pipe(
        Effect.catchTags({
          ServerAuthCloudRelayIssuerMissingError: () =>
            requireSecretText(
              secrets,
              RELAY_URL_SECRET,
              () => new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({}),
            ),
        }),
      );
      const linkedUserId = yield* requireSecretText(
        secrets,
        CLOUD_LINKED_USER_ID,
        () => new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({}),
      ).pipe(
        Effect.mapError((error) =>
          ServerSecretStore.isSecretStoreError(error)
            ? new EnvironmentAuth.ServerAuthLinkedCloudAccountReadError({ cause: error })
            : error,
        ),
      );
      return { mintPublicKey, relayIssuer, linkedUserId };
    },
  );

  const requireAllowed = () =>
    ManagedLimits.allowsConnect(managedPolicy)
      ? Effect.void
      : Effect.fail(ManagedLimits.refuseConnect(managedPolicy));

  const answerHealthRequest = Effect.fn("RelayBrokerService.health")(
    function* (request: RelayCloudEnvironmentHealthRequest) {
      yield* requireAllowed();
      const { mintPublicKey, relayIssuer, linkedUserId } = yield* readVerificationContext();
      const [environmentId, now] = yield* Effect.all([environment.getEnvironmentId, DateTime.now]);
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      const proofOption = yield* verifyRelayJwt(RelayCloudEnvironmentHealthProofPayload, {
        publicKey: mintPublicKey,
        token: request.proof,
        typ: RELAY_HEALTH_REQUEST_TYP,
        issuer: normalizeRelayIssuer(relayIssuer),
        audience: `t3-env:${environmentId}`,
      }).pipe(Effect.provideService(Signature.Signature, signature), Effect.option);
      if (
        Option.isNone(proofOption) ||
        proofOption.value.environmentId !== environmentId ||
        proofOption.value.sub !== linkedUserId ||
        !hasBoundedProofLifetime({ ...proofOption.value, nowSeconds }) ||
        !hasExactScope(proofOption.value.scope, "environment:status")
      ) {
        return yield* new RelayBrokerProofRejectedError({ request: "health" });
      }
      const proof = proofOption.value;
      const consumed = yield* consumeReplayGuards({
        secrets,
        names: [
          yield* replayMarkerName(CLOUD_HEALTH_JTI_PREFIX, proof.jti),
          yield* replayMarkerName(CLOUD_HEALTH_NONCE_PREFIX, proof.nonce),
        ],
        value: textEncoder.encode(DateTime.formatIso(now)),
      });
      if (!consumed) {
        return yield* new RelayBrokerProofReplayedError({ request: "health" });
      }
      const descriptor = yield* environment.getDescriptor;
      const responseExpiresAt = DateTime.add(now, { minutes: 5 });
      const responsePayload = {
        iss: `t3-env:${environmentId}`,
        aud: normalizeRelayIssuer(relayIssuer),
        sub: environmentId,
        jti: yield* random.uuidV4(),
        iat: nowSeconds,
        exp: Math.floor(responseExpiresAt.epochMilliseconds / 1_000),
        environmentId,
        requestNonce: proof.nonce,
        status: "online",
        descriptor,
        checkedAt: DateTime.formatIso(now),
      } satisfies RelayEnvironmentHealthResponseProofPayload;
      const responseProof = yield* signingKey
        .sign({ typ: RELAY_HEALTH_RESPONSE_TYP, payload: responsePayload })
        .pipe(
          Effect.mapError(
            (cause) => new EnvironmentAuth.ServerAuthCloudHealthJwtSigningError({ cause }),
          ),
        );
      return {
        environmentId,
        status: "online",
        descriptor,
        checkedAt: responsePayload.checkedAt,
        proof: responseProof,
      } satisfies RelayEnvironmentHealthResponse;
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, mapInternal("answer-health")),
  );

  const mintCredential = Effect.fn("RelayBrokerService.mintCredential")(
    function* (request: RelayCloudMintCredentialRequest) {
      yield* requireAllowed();
      const { mintPublicKey, relayIssuer, linkedUserId } = yield* readVerificationContext();
      const [environmentId, now] = yield* Effect.all([environment.getEnvironmentId, DateTime.now]);
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      const proofOption = yield* verifyRelayJwt(RelayCloudMintCredentialProofPayload, {
        publicKey: mintPublicKey,
        token: request.proof,
        typ: RELAY_MINT_REQUEST_TYP,
        issuer: normalizeRelayIssuer(relayIssuer),
        audience: `t3-env:${environmentId}`,
      }).pipe(Effect.provideService(Signature.Signature, signature), Effect.option);
      if (
        Option.isNone(proofOption) ||
        proofOption.value.environmentId !== environmentId ||
        proofOption.value.sub !== linkedUserId ||
        proofOption.value.cnf.jkt !== proofOption.value.clientProofKeyThumbprint ||
        !hasBoundedProofLifetime({ ...proofOption.value, nowSeconds }) ||
        !hasExactScope(proofOption.value.scope, "environment:connect")
      ) {
        return yield* new RelayBrokerProofRejectedError({ request: "mint" });
      }
      const proof = proofOption.value;
      const consumed = yield* consumeReplayGuards({
        secrets,
        names: [
          yield* replayMarkerName(CLOUD_MINT_JTI_PREFIX, proof.jti),
          yield* replayMarkerName(CLOUD_MINT_NONCE_PREFIX, proof.nonce),
        ],
        value: textEncoder.encode(DateTime.formatIso(now)),
      });
      if (!consumed) {
        return yield* new RelayBrokerProofReplayedError({ request: "mint" });
      }
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.catch(mapInternal("issue-credential")),
      );
      const issued = yield* environmentAuth.issueConnectCredential({
        proofKeyThumbprint: proof.clientProofKeyThumbprint,
        requireApproval: settings.requireConnectDeviceApproval,
      });
      const responsePayload = {
        iss: `t3-env:${environmentId}`,
        aud: normalizeRelayIssuer(relayIssuer),
        sub: environmentId,
        jti: yield* random.uuidV4(),
        iat: nowSeconds,
        exp: Math.floor(issued.expiresAt.epochMilliseconds / 1_000),
        environmentId,
        clientProofKeyThumbprint: proof.clientProofKeyThumbprint,
        requestNonce: proof.nonce,
        credential: issued.credential,
      } satisfies RelayEnvironmentMintResponseProofPayload;
      const responseProof = yield* signingKey
        .sign({ typ: RELAY_MINT_RESPONSE_TYP, payload: responsePayload })
        .pipe(
          Effect.mapError(
            (cause) => new EnvironmentAuth.ServerAuthCloudMintJwtSigningError({ cause }),
          ),
        );
      return {
        credential: issued.credential,
        expiresAt: DateTime.formatIso(issued.expiresAt),
        proof: responseProof,
      } satisfies RelayEnvironmentMintResponse;
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, mapInternal("issue-credential")),
  );

  return RelayBrokerService.of({ answerHealthRequest, mintCredential });
});

export const layer = Layer.effect(RelayBrokerService, make);
