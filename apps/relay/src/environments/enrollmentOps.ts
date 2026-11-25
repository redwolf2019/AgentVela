// @effect-diagnostics nodeBuiltinImport:off -- Enrollment token creation generates cryptographic IDs via node:crypto.
import * as NodeCrypto from "node:crypto";

import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  RelayAuthError,
  RelayEnrollmentTokenId,
  RelayNotFoundError,
  type AgentVelaRelayEndpoint,
  type AgentVelaRelayLinkChallengeResponse,
  type RelayCreateEnrollmentTokenRequest,
  type RelayCreateEnrollmentTokenResponse,
  type RelayEndpointKey,
  type RelayInternalError,
  type RelayUserId,
} from "@t3tools/contracts/agentVelaRelay";
import type * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { generateRandomToken, hashOpaqueToken } from "../auth/crypto.ts";
import type { ResolvedRelayConfig } from "../config.ts";
import type { RelayDatabase } from "../persistence/database.ts";
import { badProofError, upsertEnvironmentLink, verifySignedLinkProof } from "./linkingOps.ts";
import type { PresenceHub } from "./PresenceHub.ts";
import { decodeChallengeRows, decodeEnrollmentRows } from "./store.ts";

export interface EnrollmentOpsDeps {
  readonly config: ResolvedRelayConfig;
  readonly db: typeof RelayDatabase.Service;
  readonly presence: typeof PresenceHub.Service;
  readonly signature: Signature.Signature["Service"];
  readonly relayIssuer: string;
  readonly relayMintPublicKeyPem: string;
  readonly toEndpoint: (key: RelayEndpointKey) => AgentVelaRelayEndpoint;
  readonly internalError: () => RelayInternalError;
  readonly traceId: () => string;
}

export const createEnrollmentTokenOp = Effect.fn("EnvEnroll.createToken")(function* (
  deps: EnrollmentOpsDeps,
  input: {
    readonly userId: RelayUserId;
    readonly request: RelayCreateEnrollmentTokenRequest;
  },
) {
  const now = yield* DateTime.now;
  const ttlMinutes = input.request.ttlMinutes ?? deps.config.auth.enrollmentTokenTtlMinutes;
  const expiresAt = IsoDateTime.make(
    DateTime.formatIso(DateTime.add(now, { minutes: ttlMinutes })),
  );
  const tokenId = RelayEnrollmentTokenId.make(NodeCrypto.randomUUID());
  const enrollmentToken = TrimmedNonEmptyString.make(generateRandomToken("avr_enr_", 24));
  yield* deps.db.sql`
    INSERT INTO enrollment_tokens (
      token_id, user_id, token_hash, label_hint, expires_at, consumed_at, created_at
    ) VALUES (
      ${tokenId}, ${input.userId}, ${hashOpaqueToken(enrollmentToken)},
      ${input.request.labelHint ?? null}, ${expiresAt}, ${null}, ${DateTime.formatIso(now)}
    )
  `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));
  return { tokenId, enrollmentToken, expiresAt } satisfies RelayCreateEnrollmentTokenResponse;
});

export const createEnrollmentChallengeOp = Effect.fn("EnvEnroll.createChallenge")(function* (
  deps: EnrollmentOpsDeps,
  input: { readonly enrollmentToken: string },
) {
  const now = yield* DateTime.now;
  const nowIso = DateTime.formatIso(now);
  const raw = yield* deps.db.sql`
    SELECT token_id, user_id, token_hash, label_hint, expires_at, consumed_at
    FROM enrollment_tokens WHERE token_hash = ${hashOpaqueToken(input.enrollmentToken)} LIMIT 1
  `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));
  const row = (yield* decodeEnrollmentRows(raw).pipe(Effect.orDie))[0];
  if (!row) {
    return yield* new RelayNotFoundError({
      code: "not_found",
      resource: "enrollment_token",
      traceId: deps.traceId(),
    });
  }
  if (row.consumed_at !== null || row.expires_at <= nowIso) {
    return yield* new RelayAuthError({
      code: "auth_invalid",
      reason: "token_expired",
      traceId: deps.traceId(),
    });
  }
  const challenge = TrimmedNonEmptyString.make(generateRandomToken("avr_ec_", 24));
  const expiresAt = IsoDateTime.make(DateTime.formatIso(DateTime.add(now, { minutes: 5 })));
  yield* deps.db.sql`
    INSERT INTO relay_challenges (
      challenge_hash, kind, user_id, enrollment_token_id, expires_at, consumed_at, created_at
    ) VALUES (
      ${hashOpaqueToken(challenge)}, 'enroll', ${row.user_id}, ${row.token_id},
      ${expiresAt}, ${null}, ${nowIso}
    )
  `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));
  return { challenge, expiresAt } satisfies AgentVelaRelayLinkChallengeResponse;
});

export const enrollEnvironmentOp = Effect.fn("EnvEnroll.enroll")(function* (
  deps: EnrollmentOpsDeps,
  input: { readonly enrollmentToken: string; readonly proof: string },
) {
  const claims = yield* verifySignedLinkProof({
    proof: input.proof,
    relayIssuer: deps.relayIssuer,
    signature: deps.signature,
    traceId: deps.traceId,
  });
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const tokenHash = hashOpaqueToken(input.enrollmentToken);
  const outcome = yield* deps.db
    .transactionImmediate(
      Effect.gen(function* () {
        const rawToken = yield* deps.db.sql`
          SELECT token_id, user_id, token_hash, label_hint, expires_at, consumed_at
          FROM enrollment_tokens WHERE token_hash = ${tokenHash} LIMIT 1
        `;
        const tokenRow = (yield* decodeEnrollmentRows(rawToken).pipe(Effect.orDie))[0];
        if (!tokenRow) {
          return yield* new RelayNotFoundError({
            code: "not_found",
            resource: "enrollment_token",
            traceId: deps.traceId(),
          });
        }
        if (tokenRow.consumed_at !== null || tokenRow.expires_at <= nowIso) {
          return yield* new RelayAuthError({
            code: "auth_invalid",
            reason: "token_expired",
            traceId: deps.traceId(),
          });
        }
        const rawChallenge = yield* deps.db.sql`
          SELECT challenge_hash, kind, user_id, enrollment_token_id, expires_at, consumed_at
          FROM relay_challenges WHERE challenge_hash = ${hashOpaqueToken(claims.challenge)} LIMIT 1
        `;
        const challengeRow = (yield* decodeChallengeRows(rawChallenge).pipe(Effect.orDie))[0];
        if (
          !challengeRow ||
          challengeRow.kind !== "enroll" ||
          challengeRow.enrollment_token_id !== tokenRow.token_id ||
          challengeRow.consumed_at !== null ||
          challengeRow.expires_at <= nowIso
        ) {
          return yield* badProofError(
            deps.traceId(),
            "challenge_invalid",
            "Enrollment challenge is invalid",
          );
        }
        yield* deps.db.sql`
          UPDATE enrollment_tokens SET consumed_at = ${nowIso}
          WHERE token_id = ${tokenRow.token_id}
        `;
        yield* deps.db.sql`
          UPDATE relay_challenges SET consumed_at = ${nowIso}
          WHERE challenge_hash = ${challengeRow.challenge_hash}
        `;
        return yield* upsertEnvironmentLink({
          db: deps.db,
          relayIssuer: deps.relayIssuer,
          relayMintPublicKeyPem: deps.relayMintPublicKeyPem,
          toEndpoint: deps.toEndpoint,
          internalError: deps.internalError,
          traceId: deps.traceId,
          userId: tokenRow.user_id,
          proof: claims,
          ...(tokenRow.label_hint ? { labelOverride: tokenRow.label_hint } : {}),
        });
      }),
    )
    .pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));

  yield* deps.presence.publish(outcome.response.userId, {
    type: "environment.linked",
    environment: outcome.linkedRecord,
  });
  return outcome.response;
});
