// @effect-diagnostics nodeBuiltinImport:off -- EnvironmentService generates cryptographic IDs via node:crypto.
import * as NodeCrypto from "node:crypto";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  AgentVelaRelayTunnelLoginProofPayload,
  RelayAuthError,
  RelayBadRequestError,
  RelayConflictError,
  RelayForbiddenError,
  RelayInternalError,
  RelayNotFoundError,
  type AgentVelaRelayEndpoint,
  type AgentVelaRelayEnvironmentRecord,
  type AgentVelaRelayLinkChallengeResponse,
  type AgentVelaRelayLinkResponse,
  type RelayCreateEnrollmentTokenRequest,
  type RelayCreateEnrollmentTokenResponse,
  type RelayEndpointKey,
  type RelayUserId,
} from "@t3tools/contracts/agentVelaRelay";
import { RELAY_TUNNEL_LOGIN_TYP, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import { deriveRelayEnvironmentEndpoints } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AuthService } from "../auth/AuthService.ts";
import { generateRandomToken, hashOpaqueToken, timingSafeEqualStrings } from "../auth/crypto.ts";
import { isExpiredRelayJwtError } from "../auth/tokens.ts";
import { RelayConfig } from "../config.ts";
import { RelayDatabase } from "../persistence/database.ts";
import {
  createEnrollmentChallengeOp,
  createEnrollmentTokenOp,
  enrollEnvironmentOp,
} from "./enrollmentOps.ts";
import { badProofError, upsertEnvironmentLink, verifySignedLinkProof } from "./linkingOps.ts";
import { PresenceHub } from "./PresenceHub.ts";
import {
  decodeChallengeRows,
  decodeEnvironmentOwnerRows,
  parseDescriptor,
  type EnvironmentWithOwnerRowSchema,
  type StoredEnvironmentInfo,
} from "./store.ts";

export type { StoredEnvironmentInfo } from "./store.ts";

const newTraceId = (): string => NodeCrypto.randomUUID();
const internalError = () =>
  new RelayInternalError({
    code: "internal_error",
    reason: "persistence_failed",
    traceId: newTraceId(),
  });

export class EnvironmentService extends Context.Service<
  EnvironmentService,
  {
    readonly toEndpoint: (endpointKey: RelayEndpointKey) => AgentVelaRelayEndpoint;
    readonly toRecord: (
      row: StoredEnvironmentInfo,
      status: "online" | "offline",
    ) => AgentVelaRelayEnvironmentRecord;
    readonly listUserEnvironments: (
      userId: RelayUserId,
    ) => Effect.Effect<ReadonlyArray<StoredEnvironmentInfo>, RelayInternalError>;
    readonly getOwnedEnvironment: (input: {
      readonly userId: RelayUserId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<
      StoredEnvironmentInfo,
      RelayNotFoundError | RelayForbiddenError | RelayInternalError
    >;
    readonly findByEndpointKey: (
      endpointKey: RelayEndpointKey,
    ) => Effect.Effect<StoredEnvironmentInfo | null, RelayInternalError>;
    readonly createLinkChallenge: (
      userId: RelayUserId,
    ) => Effect.Effect<AgentVelaRelayLinkChallengeResponse, RelayInternalError>;
    readonly link: (input: {
      readonly userId: RelayUserId;
      readonly proof: string;
    }) => Effect.Effect<
      AgentVelaRelayLinkResponse,
      RelayBadRequestError | RelayConflictError | RelayInternalError
    >;
    readonly unlink: (input: {
      readonly userId: RelayUserId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<
      { readonly ok: true },
      RelayNotFoundError | RelayForbiddenError | RelayInternalError
    >;
    readonly createEnrollmentToken: (input: {
      readonly userId: RelayUserId;
      readonly request: RelayCreateEnrollmentTokenRequest;
    }) => Effect.Effect<
      RelayCreateEnrollmentTokenResponse,
      RelayBadRequestError | RelayInternalError
    >;
    readonly createEnrollmentChallenge: (input: {
      readonly enrollmentToken: string;
    }) => Effect.Effect<
      AgentVelaRelayLinkChallengeResponse,
      RelayAuthError | RelayNotFoundError | RelayInternalError
    >;
    readonly enroll: (input: {
      readonly enrollmentToken: string;
      readonly proof: string;
    }) => Effect.Effect<
      AgentVelaRelayLinkResponse,
      | RelayAuthError
      | RelayBadRequestError
      | RelayConflictError
      | RelayNotFoundError
      | RelayInternalError
    >;
    readonly verifyTunnelLogin: (input: {
      readonly environmentId: EnvironmentId;
      readonly credential: string;
      readonly proof: string;
    }) => Effect.Effect<
      StoredEnvironmentInfo,
      RelayAuthError | RelayNotFoundError | RelayInternalError
    >;
    readonly touchLastSeen: (
      environmentId: EnvironmentId,
      seenAtIso: IsoDateTime,
    ) => Effect.Effect<void, RelayInternalError>;
  }
>()("agent-vela-relay/environments/EnvironmentService") {}

export const layerEnvironmentService = Layer.effect(
  EnvironmentService,
  Effect.gen(function* () {
    const config = yield* RelayConfig;
    const db = yield* RelayDatabase;
    const auth = yield* AuthService;
    const presence = yield* PresenceHub;
    const signature = yield* Signature.Signature;
    const sql = db.sql;

    const toEndpoint = (endpointKey: RelayEndpointKey): AgentVelaRelayEndpoint => {
      const derived = deriveRelayEnvironmentEndpoints(config.publicUrl, endpointKey);
      if (!derived) {
        const base = config.publicUrl.replace(/\/+$/, "");
        const wsBase = base.replace(/^http/i, "ws");
        return {
          endpointKey,
          pathPrefix: `/e/${endpointKey}`,
          httpBaseUrl: `${base}/e/${endpointKey}`,
          wsBaseUrl: `${wsBase}/e/${endpointKey}`,
        };
      }
      return {
        endpointKey,
        pathPrefix: derived.pathPrefix,
        httpBaseUrl: derived.httpBaseUrl,
        wsBaseUrl: derived.wsBaseUrl,
      };
    };

    const toRecord = (
      info: StoredEnvironmentInfo,
      status: "online" | "offline",
    ): AgentVelaRelayEnvironmentRecord => ({
      environmentId: info.environmentId,
      label: info.label,
      endpoint: info.endpoint,
      status,
      linkedAt: info.linkedAt,
      lastSeenAt: info.lastSeenAt,
    });

    const hydrateRow = Effect.fn("EnvironmentService.hydrateRow")(function* (
      row: typeof EnvironmentWithOwnerRowSchema.Type,
    ) {
      const descriptor = yield* parseDescriptor(row.descriptor_json).pipe(
        Effect.mapError(internalError),
      );
      return {
        environmentId: row.environment_id,
        userId: row.user_id,
        username: row.username,
        endpointKey: row.endpoint_key,
        endpoint: toEndpoint(row.endpoint_key),
        label: row.label,
        environmentPublicKey: row.environment_public_key,
        descriptor,
        linkedAt: row.linked_at,
        lastSeenAt: row.last_seen_at,
      } satisfies StoredEnvironmentInfo;
    });

    const listUserEnvironments = Effect.fn("EnvironmentService.listUserEnvironments")(function* (
      userId: RelayUserId,
    ) {
      const raw = yield* sql`
        SELECT e.environment_id, e.user_id, e.endpoint_key, e.label, e.environment_public_key,
               e.descriptor_json, e.credential_hash, e.linked_at, e.last_seen_at,
               u.username, u.role AS owner_role
        FROM environments e
        JOIN users u ON u.user_id = e.user_id
        WHERE e.user_id = ${userId}
        ORDER BY e.linked_at ASC
      `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
      const rows = yield* decodeEnvironmentOwnerRows(raw).pipe(Effect.orDie);
      return yield* Effect.forEach(rows, hydrateRow);
    });

    const getOwnedEnvironment = Effect.fn("EnvironmentService.getOwnedEnvironment")(
      function* (input: { readonly userId: RelayUserId; readonly environmentId: EnvironmentId }) {
        const raw = yield* sql`
        SELECT e.environment_id, e.user_id, e.endpoint_key, e.label, e.environment_public_key,
               e.descriptor_json, e.credential_hash, e.linked_at, e.last_seen_at,
               u.username, u.role AS owner_role
        FROM environments e
        JOIN users u ON u.user_id = e.user_id
        WHERE e.environment_id = ${input.environmentId} LIMIT 1
      `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
        const row = (yield* decodeEnvironmentOwnerRows(raw).pipe(Effect.orDie))[0];
        if (!row) {
          return yield* new RelayNotFoundError({
            code: "not_found",
            resource: "environment",
            traceId: newTraceId(),
          });
        }
        if (row.user_id !== input.userId) {
          return yield* new RelayForbiddenError({
            code: "forbidden",
            reason: "environment_not_owned",
            traceId: newTraceId(),
          });
        }
        return yield* hydrateRow(row);
      },
    );

    const findByEndpointKey = Effect.fn("EnvironmentService.findByEndpointKey")(function* (
      endpointKey: RelayEndpointKey,
    ) {
      const raw = yield* sql`
        SELECT e.environment_id, e.user_id, e.endpoint_key, e.label, e.environment_public_key,
               e.descriptor_json, e.credential_hash, e.linked_at, e.last_seen_at,
               u.username, u.role AS owner_role
        FROM environments e
        JOIN users u ON u.user_id = e.user_id
        WHERE e.endpoint_key = ${endpointKey} LIMIT 1
      `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
      const row = (yield* decodeEnvironmentOwnerRows(raw).pipe(Effect.orDie))[0];
      return row ? yield* hydrateRow(row) : null;
    });

    const createLinkChallenge = Effect.fn("EnvironmentService.createLinkChallenge")(function* (
      userId: RelayUserId,
    ) {
      const now = yield* DateTime.now;
      const expiresAt = IsoDateTime.make(DateTime.formatIso(DateTime.add(now, { minutes: 5 })));
      const challenge = TrimmedNonEmptyString.make(generateRandomToken("avr_chl_", 24));
      yield* sql`
        INSERT INTO relay_challenges (
          challenge_hash, kind, user_id, enrollment_token_id, expires_at, consumed_at, created_at
        ) VALUES (
          ${hashOpaqueToken(challenge)}, 'link', ${userId}, ${null},
          ${expiresAt}, ${null}, ${DateTime.formatIso(now)}
        )
      `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
      return { challenge, expiresAt } satisfies AgentVelaRelayLinkChallengeResponse;
    });

    const link = Effect.fn("EnvironmentService.link")(function* (input: {
      readonly userId: RelayUserId;
      readonly proof: string;
    }) {
      const claims = yield* verifySignedLinkProof({
        proof: input.proof,
        relayIssuer: auth.relayIssuer,
        signature,
        traceId: newTraceId,
      });
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const outcome = yield* db
        .transactionImmediate(
          Effect.gen(function* () {
            const raw = yield* sql`
              SELECT challenge_hash, kind, user_id, enrollment_token_id, expires_at, consumed_at
              FROM relay_challenges WHERE challenge_hash = ${hashOpaqueToken(claims.challenge)} LIMIT 1
            `;
            const challengeRow = (yield* decodeChallengeRows(raw).pipe(Effect.orDie))[0];
            if (
              !challengeRow ||
              challengeRow.kind !== "link" ||
              challengeRow.user_id !== input.userId ||
              challengeRow.consumed_at !== null ||
              challengeRow.expires_at <= nowIso
            ) {
              return yield* badProofError(
                newTraceId(),
                "challenge_invalid",
                "Link challenge is invalid or expired",
              );
            }
            yield* sql`
              UPDATE relay_challenges SET consumed_at = ${nowIso}
              WHERE challenge_hash = ${challengeRow.challenge_hash}
            `;
            return yield* upsertEnvironmentLink({
              db,
              relayIssuer: auth.relayIssuer,
              relayMintPublicKeyPem: auth.relayMintPublicKeyPem,
              toEndpoint,
              internalError,
              traceId: newTraceId,
              userId: input.userId,
              proof: claims,
            });
          }),
        )
        .pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
      yield* presence.publish(input.userId, {
        type: "environment.linked",
        environment: outcome.linkedRecord,
      });
      return outcome.response;
    });

    const unlink = Effect.fn("EnvironmentService.unlink")(function* (input: {
      readonly userId: RelayUserId;
      readonly environmentId: EnvironmentId;
    }) {
      yield* db
        .transactionImmediate(
          Effect.gen(function* () {
            const raw = yield* sql`
              SELECT environment_id, user_id FROM environments WHERE environment_id = ${input.environmentId} LIMIT 1
            `;
            const row = (raw as ReadonlyArray<{ user_id: string }>)[0];
            if (!row) {
              return yield* new RelayNotFoundError({
                code: "not_found",
                resource: "environment",
                traceId: newTraceId(),
              });
            }
            if (row.user_id !== input.userId) {
              return yield* new RelayForbiddenError({
                code: "forbidden",
                reason: "environment_not_owned",
                traceId: newTraceId(),
              });
            }
            yield* sql`DELETE FROM environments WHERE environment_id = ${input.environmentId}`;
          }),
        )
        .pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
      yield* presence.publish(input.userId, {
        type: "environment.unlinked",
        environmentId: input.environmentId,
      });
      return { ok: true as const };
    });

    const verifyTunnelLogin = Effect.fn("EnvironmentService.verifyTunnelLogin")(function* (input: {
      readonly environmentId: EnvironmentId;
      readonly credential: string;
      readonly proof: string;
    }) {
      const raw = yield* sql`
        SELECT e.environment_id, e.user_id, e.endpoint_key, e.label, e.environment_public_key,
               e.descriptor_json, e.credential_hash, e.linked_at, e.last_seen_at,
               u.username, u.role AS owner_role
        FROM environments e
        JOIN users u ON u.user_id = e.user_id
        WHERE e.environment_id = ${input.environmentId} LIMIT 1
      `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
      const row = (yield* decodeEnvironmentOwnerRows(raw).pipe(Effect.orDie))[0];
      if (!row) {
        return yield* new RelayNotFoundError({
          code: "not_found",
          resource: "environment",
          traceId: newTraceId(),
        });
      }
      if (!timingSafeEqualStrings(hashOpaqueToken(input.credential), row.credential_hash)) {
        return yield* new RelayAuthError({
          code: "auth_invalid",
          reason: "invalid_credentials",
          traceId: newTraceId(),
        });
      }
      const now = yield* DateTime.now;
      const verifiedProof = yield* verifyRelayJwt(AgentVelaRelayTunnelLoginProofPayload, {
        token: input.proof,
        typ: RELAY_TUNNEL_LOGIN_TYP,
        issuer: `t3-env:${input.environmentId}`,
        audience: auth.relayIssuer,
        publicKey: row.environment_public_key,
      }).pipe(
        Effect.provideService(Signature.Signature, signature),
        Effect.mapError(
          (error) =>
            new RelayAuthError({
              code: "auth_invalid",
              reason: isExpiredRelayJwtError(error) ? "token_expired" : "invalid_token",
              traceId: newTraceId(),
            }),
        ),
      );
      if (verifiedProof.environmentId !== input.environmentId) {
        return yield* new RelayAuthError({
          code: "auth_invalid",
          reason: "invalid_token",
          traceId: newTraceId(),
        });
      }
      const acceptedJti = yield* db
        .consumeProofJti({
          scope: `tunnel:login:${input.environmentId}`,
          jti: verifiedProof.jti,
          expiresAtIso: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          nowIso: DateTime.formatIso(now),
        })
        .pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
      if (!acceptedJti) {
        return yield* new RelayAuthError({
          code: "auth_invalid",
          reason: "invalid_token",
          traceId: newTraceId(),
        });
      }
      return yield* hydrateRow(row);
    });

    const touchLastSeen = Effect.fn("EnvironmentService.touchLastSeen")(function* (
      environmentId: EnvironmentId,
      seenAtIso: IsoDateTime,
    ) {
      yield* sql`
        UPDATE environments SET last_seen_at = ${seenAtIso}
        WHERE environment_id = ${environmentId}
      `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
    });

    const enrollDeps = {
      config,
      db,
      presence,
      signature,
      relayIssuer: auth.relayIssuer,
      relayMintPublicKeyPem: auth.relayMintPublicKeyPem,
      toEndpoint,
      internalError,
      traceId: newTraceId,
    };

    return EnvironmentService.of({
      toEndpoint,
      toRecord,
      listUserEnvironments,
      getOwnedEnvironment,
      findByEndpointKey,
      createLinkChallenge,
      link,
      unlink,
      createEnrollmentToken: Effect.fn("EnvironmentService.createEnrollmentToken")((input) =>
        createEnrollmentTokenOp(enrollDeps, input),
      ),
      createEnrollmentChallenge: Effect.fn("EnvironmentService.createEnrollmentChallenge")(
        (input) => createEnrollmentChallengeOp(enrollDeps, input),
      ),
      enroll: Effect.fn("EnvironmentService.enroll")((input) =>
        enrollEnvironmentOp(enrollDeps, input),
      ),
      verifyTunnelLogin,
      touchLastSeen,
    });
  }),
);
