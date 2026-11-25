// @effect-diagnostics nodeBuiltinImport:off -- BrokerService generates cryptographic nonces and traceIds via node:crypto.
import * as NodeCrypto from "node:crypto";

import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  AgentVelaRelayHealthResponseProofPayload,
  AgentVelaRelayMintResponseProofPayload,
  RelayTunnelOfflineError,
  type AgentVelaRelayConnectResponse,
  type AgentVelaRelayHealthProofPayload,
  type AgentVelaRelayMintProofPayload,
  type AgentVelaRelayStatusResponse,
  type RelayEndpointTimedOutError,
  type RelayForbiddenError,
  type RelayInternalError,
  type RelayNotFoundError,
  type RelayUserId,
} from "@t3tools/contracts/agentVelaRelay";
import {
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AuthService } from "../auth/AuthService.ts";
import { RelayConfig } from "../config.ts";
import { EnvironmentService, type StoredEnvironmentInfo } from "./EnvironmentService.ts";
import { collectHttpResponseBytes } from "../tunnel/httpStream.ts";
import { TunnelHub } from "../tunnel/TunnelHub.ts";

const MintResponseBodySchema = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  proof: TrimmedNonEmptyString,
});
const decodeMintResponseBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MintResponseBodySchema),
);

const HealthResponseBodySchema = Schema.Struct({
  environmentId: Schema.String,
  status: Schema.Literal("online"),
  descriptor: ExecutionEnvironmentDescriptor,
  checkedAt: IsoDateTime,
  proof: TrimmedNonEmptyString,
});
const decodeHealthResponseBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HealthResponseBodySchema),
);

const HEALTH_CLOCK_SKEW_MS = 60_000;
const newTraceId = (): string => NodeCrypto.randomUUID();
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

const encodeProofPayloadBody = (proof: string): Uint8Array =>
  utf8Encoder.encode(JSON.stringify({ proof }));

const invalidUpstreamError = (endpointStatus?: number) =>
  new RelayTunnelOfflineError({
    code: "tunnel_offline",
    reason: "upstream_invalid_response",
    ...(endpointStatus !== undefined ? { endpointStatus } : {}),
    traceId: newTraceId(),
  });

export class BrokerService extends Context.Service<
  BrokerService,
  {
    readonly connectEnvironment: (input: {
      readonly userId: RelayUserId;
      readonly environmentId: EnvironmentId;
      readonly proofKeyThumbprint: string;
      readonly deviceId?: string;
    }) => Effect.Effect<
      AgentVelaRelayConnectResponse,
      | RelayNotFoundError
      | RelayForbiddenError
      | RelayTunnelOfflineError
      | RelayEndpointTimedOutError
      | RelayInternalError
    >;
    readonly getEnvironmentStatus: (input: {
      readonly userId: RelayUserId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<
      AgentVelaRelayStatusResponse,
      | RelayNotFoundError
      | RelayForbiddenError
      | RelayTunnelOfflineError
      | RelayEndpointTimedOutError
      | RelayInternalError
    >;
  }
>()("agent-vela-relay/environments/BrokerService") {}

const verifyMintProofResponse = Effect.fn("BrokerService.verifyMintProof")(function* (input: {
  readonly signature: Signature.Signature["Service"];
  readonly relayIssuer: string;
  readonly env: StoredEnvironmentInfo;
  readonly nonce: string;
  readonly proofKeyThumbprint: string;
  readonly parsed: typeof MintResponseBodySchema.Type;
}) {
  const verified = yield* verifyRelayJwt(AgentVelaRelayMintResponseProofPayload, {
    token: input.parsed.proof,
    typ: RELAY_MINT_RESPONSE_TYP,
    issuer: `t3-env:${input.env.environmentId}`,
    audience: input.relayIssuer,
    publicKey: input.env.environmentPublicKey,
  }).pipe(
    Effect.provideService(Signature.Signature, input.signature),
    Effect.mapError(() => invalidUpstreamError()),
  );
  const expiresAtOpt = DateTime.make(input.parsed.expiresAt);
  const expMatches =
    Option.isSome(expiresAtOpt) &&
    Math.floor(expiresAtOpt.value.epochMilliseconds / 1_000) === verified.exp;
  if (
    verified.environmentId !== input.env.environmentId ||
    verified.requestNonce !== input.nonce ||
    verified.clientProofKeyThumbprint !== input.proofKeyThumbprint ||
    verified.credential !== input.parsed.credential ||
    !expMatches
  ) {
    return yield* invalidUpstreamError();
  }
});

const verifyHealthProofResponse = Effect.fn("BrokerService.verifyHealthProof")(function* (input: {
  readonly signature: Signature.Signature["Service"];
  readonly relayIssuer: string;
  readonly env: StoredEnvironmentInfo;
  readonly nonce: string;
  readonly requestStartedAt: DateTime.DateTime;
  readonly parsed: typeof HealthResponseBodySchema.Type;
}) {
  const verified = yield* verifyRelayJwt(AgentVelaRelayHealthResponseProofPayload, {
    token: input.parsed.proof,
    typ: RELAY_HEALTH_RESPONSE_TYP,
    issuer: `t3-env:${input.env.environmentId}`,
    audience: input.relayIssuer,
    publicKey: input.env.environmentPublicKey,
  }).pipe(
    Effect.provideService(Signature.Signature, input.signature),
    Effect.mapError(() => invalidUpstreamError()),
  );
  const nowAfter = yield* DateTime.now;
  const checkedAtOpt = DateTime.make(input.parsed.checkedAt);
  const validWindow =
    Option.isSome(checkedAtOpt) &&
    checkedAtOpt.value.epochMilliseconds >=
      input.requestStartedAt.epochMilliseconds - HEALTH_CLOCK_SKEW_MS &&
    checkedAtOpt.value.epochMilliseconds <= nowAfter.epochMilliseconds + HEALTH_CLOCK_SKEW_MS;
  if (
    !validWindow ||
    input.parsed.environmentId !== input.env.environmentId ||
    verified.environmentId !== input.env.environmentId ||
    verified.requestNonce !== input.nonce ||
    verified.status !== input.parsed.status ||
    verified.checkedAt !== input.parsed.checkedAt ||
    stableStringify(verified.descriptor) !== stableStringify(input.parsed.descriptor)
  ) {
    return yield* invalidUpstreamError();
  }
});

export const layerBrokerService = Layer.effect(
  BrokerService,
  Effect.gen(function* () {
    const config = yield* RelayConfig;
    const auth = yield* AuthService;
    const environments = yield* EnvironmentService;
    const tunnelHub = yield* TunnelHub;
    const signature = yield* Signature.Signature;

    const publicParsed = new URL(config.publicUrl);
    const externalHost = publicParsed.host;
    const externalProto = publicParsed.protocol === "https:" ? "https" : "http";

    const connectEnvironment = Effect.fn("BrokerService.connectEnvironment")(function* (input: {
      readonly userId: RelayUserId;
      readonly environmentId: EnvironmentId;
      readonly proofKeyThumbprint: string;
      readonly deviceId?: string;
    }) {
      const env = yield* environments.getOwnedEnvironment({
        userId: input.userId,
        environmentId: input.environmentId,
      });
      const now = yield* DateTime.now;
      const nonce = NodeCrypto.randomUUID();
      const mintPayload: AgentVelaRelayMintProofPayload = {
        iss: auth.relayIssuer,
        aud: `t3-env:${env.environmentId}`,
        sub: input.userId,
        jti: NodeCrypto.randomUUID(),
        iat: Math.floor(now.epochMilliseconds / 1_000),
        exp: Math.floor(DateTime.add(now, { minutes: 2 }).epochMilliseconds / 1_000),
        environmentId: env.environmentId,
        clientProofKeyThumbprint: TrimmedNonEmptyString.make(input.proofKeyThumbprint),
        cnf: { jkt: TrimmedNonEmptyString.make(input.proofKeyThumbprint) },
        ...(input.deviceId ? { deviceId: TrimmedNonEmptyString.make(input.deviceId) } : {}),
        nonce: TrimmedNonEmptyString.make(nonce),
        scope: ["environment:connect"],
      };
      const proof = yield* auth.signRelayProof({
        typ: RELAY_MINT_REQUEST_TYP,
        payload: mintPayload as unknown as Record<string, unknown>,
      });
      const httpRes = yield* tunnelHub.openHttpByEnvironmentId(env.environmentId, {
        method: "POST",
        path: "/api/t3-connect/mint-credential",
        headers: [
          ["content-type", "application/json"],
          ["accept", "application/json"],
        ],
        body: encodeProofPayloadBody(proof),
        externalHost,
        externalProto,
        pathPrefix: env.endpoint.pathPrefix,
        timeoutMs: config.tunnel.proxyTimeoutMs,
      });
      const bodyBytes = yield* Effect.tryPromise({
        try: () => collectHttpResponseBytes(httpRes),
        catch: () => invalidUpstreamError(httpRes.status),
      });
      if (httpRes.status < 200 || httpRes.status >= 300) {
        return yield* invalidUpstreamError(httpRes.status);
      }
      const parsed = yield* decodeMintResponseBody(utf8Decoder.decode(bodyBytes)).pipe(
        Effect.mapError(() => invalidUpstreamError(httpRes.status)),
      );
      yield* verifyMintProofResponse({
        signature,
        relayIssuer: auth.relayIssuer,
        env,
        nonce,
        proofKeyThumbprint: input.proofKeyThumbprint,
        parsed,
      });
      return {
        environmentId: env.environmentId,
        endpoint: env.endpoint,
        credential: parsed.credential,
        expiresAt: parsed.expiresAt,
      } satisfies AgentVelaRelayConnectResponse;
    });

    const getEnvironmentStatus = Effect.fn("BrokerService.getEnvironmentStatus")(function* (input: {
      readonly userId: RelayUserId;
      readonly environmentId: EnvironmentId;
    }) {
      const env = yield* environments.getOwnedEnvironment({
        userId: input.userId,
        environmentId: input.environmentId,
      });
      const now = yield* DateTime.now;
      const checkedAtNow = IsoDateTime.make(DateTime.formatIso(now));
      if (!tunnelHub.isOnline(env.environmentId)) {
        return {
          environmentId: env.environmentId,
          endpoint: env.endpoint,
          status: "offline" as const,
          checkedAt: checkedAtNow,
        } satisfies AgentVelaRelayStatusResponse;
      }

      const nonce = NodeCrypto.randomUUID();
      const healthPayload: AgentVelaRelayHealthProofPayload = {
        iss: auth.relayIssuer,
        aud: `t3-env:${env.environmentId}`,
        sub: input.userId,
        jti: NodeCrypto.randomUUID(),
        iat: Math.floor(now.epochMilliseconds / 1_000),
        exp: Math.floor(DateTime.add(now, { minutes: 2 }).epochMilliseconds / 1_000),
        environmentId: env.environmentId,
        nonce: TrimmedNonEmptyString.make(nonce),
        scope: ["environment:status"],
      };
      const proof = yield* auth.signRelayProof({
        typ: RELAY_HEALTH_REQUEST_TYP,
        payload: healthPayload as unknown as Record<string, unknown>,
      });

      const httpResOpt = yield* tunnelHub
        .openHttpByEnvironmentId(env.environmentId, {
          method: "POST",
          path: "/api/t3-connect/health",
          headers: [
            ["content-type", "application/json"],
            ["accept", "application/json"],
          ],
          body: encodeProofPayloadBody(proof),
          externalHost,
          externalProto,
          pathPrefix: env.endpoint.pathPrefix,
          timeoutMs: config.tunnel.proxyTimeoutMs,
        })
        .pipe(Effect.option);
      if (
        Option.isNone(httpResOpt) ||
        httpResOpt.value.status < 200 ||
        httpResOpt.value.status >= 300
      ) {
        return {
          environmentId: env.environmentId,
          endpoint: env.endpoint,
          status: "offline" as const,
          checkedAt: checkedAtNow,
        } satisfies AgentVelaRelayStatusResponse;
      }

      const httpRes = httpResOpt.value;
      const bodyBytes = yield* Effect.tryPromise({
        try: () => collectHttpResponseBytes(httpRes),
        catch: () => invalidUpstreamError(httpRes.status),
      });
      const parsed = yield* decodeHealthResponseBody(utf8Decoder.decode(bodyBytes)).pipe(
        Effect.mapError(() => invalidUpstreamError(httpRes.status)),
      );
      yield* verifyHealthProofResponse({
        signature,
        relayIssuer: auth.relayIssuer,
        env,
        nonce,
        requestStartedAt: now,
        parsed,
      });

      const rttMs = tunnelHub.getRttMs(env.environmentId);
      return {
        environmentId: env.environmentId,
        endpoint: env.endpoint,
        status: "online" as const,
        checkedAt: parsed.checkedAt,
        descriptor: parsed.descriptor,
        ...(rttMs !== null ? { rttMs } : {}),
      } satisfies AgentVelaRelayStatusResponse;
    });

    return BrokerService.of({ connectEnvironment, getEnvironmentStatus });
  }),
);
