import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  AgentVelaRelayLinkProofPayload,
  RelayBadRequestError,
  RelayConflictError,
  RelayEndpointKey,
  type AgentVelaRelayEndpoint,
  type AgentVelaRelayEnvironmentRecord,
  type AgentVelaRelayLinkResponse,
  type RelayInternalError,
  type RelayUserId,
} from "@t3tools/contracts/agentVelaRelay";
import { decodeRelayJwt, RELAY_LINK_PROOF_TYP, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { generateRandomToken, generateRelayEndpointKey, hashOpaqueToken } from "../auth/crypto.ts";
import { isExpiredRelayJwtError } from "../auth/tokens.ts";
import type { RelayDatabase } from "../persistence/database.ts";
import { decodeEnvironmentRows, stringifyDescriptor } from "./store.ts";

const decodeLinkProofPayload = Schema.decodeUnknownEffect(AgentVelaRelayLinkProofPayload);

export function badProofError(
  traceId: string,
  reason: "invalid_proof" | "proof_expired" | "proof_replayed" | "challenge_invalid",
  detail?: string,
): RelayBadRequestError {
  return new RelayBadRequestError({
    code: "bad_request",
    reason,
    ...(detail ? { detail } : {}),
    traceId,
  });
}

export const verifySignedLinkProof = Effect.fn("EnvLinking.verifySignedLinkProof")(
  function* (input: {
    readonly proof: string;
    readonly relayIssuer: string;
    readonly signature: Signature.Signature["Service"];
    readonly traceId: () => string;
  }) {
    const unverifiedClaims = yield* decodeRelayJwt(input.proof).pipe(
      Effect.mapError(() =>
        badProofError(input.traceId(), "invalid_proof", "Malformed link proof JWT"),
      ),
    );
    const unverified = yield* decodeLinkProofPayload(unverifiedClaims).pipe(
      Effect.mapError(() =>
        badProofError(input.traceId(), "invalid_proof", "Malformed link proof claims"),
      ),
    );
    return yield* verifyRelayJwt(AgentVelaRelayLinkProofPayload, {
      token: input.proof,
      typ: RELAY_LINK_PROOF_TYP,
      issuer: `t3-env:${unverified.environmentId}`,
      audience: input.relayIssuer,
      publicKey: unverified.environmentPublicKey,
    }).pipe(
      Effect.provideService(Signature.Signature, input.signature),
      Effect.mapError((error) =>
        badProofError(
          input.traceId(),
          isExpiredRelayJwtError(error) ? "proof_expired" : "invalid_proof",
          error.message,
        ),
      ),
    );
  },
);

export const upsertEnvironmentLink = Effect.fn("EnvLinking.upsert")(function* (input: {
  readonly db: typeof RelayDatabase.Service;
  readonly relayIssuer: string;
  readonly relayMintPublicKeyPem: string;
  readonly toEndpoint: (key: RelayEndpointKey) => AgentVelaRelayEndpoint;
  readonly internalError: () => RelayInternalError;
  readonly traceId: () => string;
  readonly userId: RelayUserId;
  readonly proof: AgentVelaRelayLinkProofPayload;
  readonly labelOverride?: string;
}) {
  const now = yield* DateTime.now;
  const nowIso = IsoDateTime.make(DateTime.formatIso(now));
  const jtiAccepted = yield* input.db.consumeProofJtiInTransaction({
    scope: `env:link:${input.proof.environmentId}`,
    jti: input.proof.jti,
    expiresAtIso: DateTime.formatIso(DateTime.add(now, { minutes: 10 })),
    nowIso,
  });
  if (!jtiAccepted) {
    return yield* badProofError(
      input.traceId(),
      "proof_replayed",
      "Link proof jti already consumed",
    );
  }

  const existingRaw = yield* input.db.sql`
    SELECT environment_id, user_id, endpoint_key, label, environment_public_key,
           descriptor_json, credential_hash, linked_at, last_seen_at
    FROM environments WHERE environment_id = ${input.proof.environmentId} LIMIT 1
  `;
  const existing = (yield* decodeEnvironmentRows(existingRaw).pipe(Effect.orDie))[0];
  if (existing && existing.user_id !== input.userId) {
    return yield* new RelayConflictError({
      code: "conflict",
      reason: "environment_already_linked",
      traceId: input.traceId(),
    });
  }

  const endpointKey = existing
    ? existing.endpoint_key
    : RelayEndpointKey.make(generateRelayEndpointKey());
  const environmentCredential = generateRandomToken("avr_env_", 32);
  const descriptorJson = yield* stringifyDescriptor(input.proof.descriptor).pipe(
    Effect.mapError(input.internalError),
  );
  const rawLabel =
    input.labelOverride?.trim() || input.proof.descriptor.label.trim() || endpointKey;
  const label = TrimmedNonEmptyString.make(rawLabel);

  if (existing) {
    yield* input.db.sql`
      UPDATE environments
      SET label = ${label},
          environment_public_key = ${input.proof.environmentPublicKey},
          descriptor_json = ${descriptorJson},
          credential_hash = ${hashOpaqueToken(environmentCredential)}
      WHERE environment_id = ${input.proof.environmentId}
    `;
  } else {
    yield* input.db.sql`
      INSERT INTO environments (
        environment_id, user_id, endpoint_key, label, environment_public_key,
        descriptor_json, credential_hash, linked_at, last_seen_at
      ) VALUES (
        ${input.proof.environmentId}, ${input.userId}, ${endpointKey}, ${label},
        ${input.proof.environmentPublicKey}, ${descriptorJson},
        ${hashOpaqueToken(environmentCredential)}, ${nowIso}, ${null}
      )
    `;
  }
  const endpoint = input.toEndpoint(endpointKey);
  return {
    linkedRecord: {
      environmentId: input.proof.environmentId,
      label,
      endpoint,
      status: "offline" as const,
      linkedAt: existing ? existing.linked_at : nowIso,
      lastSeenAt: existing ? existing.last_seen_at : null,
    } satisfies AgentVelaRelayEnvironmentRecord,
    response: {
      ok: true as const,
      userId: input.userId,
      environmentId: input.proof.environmentId,
      endpoint,
      relayIssuer: input.relayIssuer,
      environmentCredential,
      relayMintPublicKey: input.relayMintPublicKeyPem,
    } satisfies AgentVelaRelayLinkResponse,
  };
});
