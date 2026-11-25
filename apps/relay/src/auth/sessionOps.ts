// @effect-diagnostics nodeBuiltinImport:off -- Session operations generate cryptographic IDs via node:crypto.
import * as NodeCrypto from "node:crypto";

import {
  type RelayAuthError,
  type RelayAuthErrorReason,
  type RelayAuthSessionResponse,
  type RelayBadRequestError,
  type RelayConflictError,
  RelayForbiddenError,
  type RelayInternalError,
  type RelayLoginRequest,
  type RelayRefreshRequest,
  type RelayRegisterRequest,
  type RelayUserId,
  type RelayUserRole,
} from "@t3tools/contracts/agentVelaRelay";
import type * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ResolvedRelayConfig } from "../config.ts";
import type { RelayDatabase } from "../persistence/database.ts";
import { insertUserRecord } from "./adminOps.ts";
import { generateRandomToken, hashOpaqueToken, verifyPassword } from "./crypto.ts";
import {
  countUsers,
  decodeInviteRows,
  decodeSessionRows,
  findUserById,
  findUserByUsername,
  toRelayUserRecord,
  type UserRow,
} from "./store.ts";
import { signRelayAccessToken } from "./tokens.ts";

export interface SessionOpsDeps {
  readonly config: ResolvedRelayConfig;
  readonly db: typeof RelayDatabase.Service;
  readonly signature: Signature.Signature["Service"];
  readonly relayIssuer: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
  readonly authError: (reason: RelayAuthErrorReason) => RelayAuthError;
  readonly internalError: () => RelayInternalError;
  readonly traceId: () => string;
}

export const issueSessionForUserOp = Effect.fn("AuthSession.issue")(function* (
  deps: SessionOpsDeps,
  user: UserRow,
  meta?: { readonly clientSurface?: string; readonly deviceLabel?: string },
) {
  const now = yield* DateTime.now;
  const nowIso = DateTime.formatIso(now);
  const accessExp = DateTime.add(now, { seconds: deps.config.auth.accessTokenTtlSeconds });
  const refreshExp = DateTime.add(now, { days: deps.config.auth.refreshTokenTtlDays });
  const refreshToken = generateRandomToken("avr_rt_", 32);
  const accessToken = yield* signRelayAccessToken({
    signature: deps.signature,
    privateKeyPem: deps.privateKeyPem,
    issuer: deps.relayIssuer,
    userId: user.user_id,
    username: user.username,
    role: user.role,
    jti: NodeCrypto.randomUUID(),
    nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
    ttlSeconds: deps.config.auth.accessTokenTtlSeconds,
  }).pipe(Effect.mapError(deps.internalError));

  yield* deps.db.sql`
    INSERT INTO sessions (
      session_id, user_id, refresh_token_hash, device_label, client_surface,
      expires_at, revoked_at, created_at, last_used_at
    ) VALUES (
      ${NodeCrypto.randomUUID()}, ${user.user_id}, ${hashOpaqueToken(refreshToken)},
      ${meta?.deviceLabel ?? null}, ${meta?.clientSurface ?? null},
      ${DateTime.formatIso(refreshExp)}, ${null}, ${nowIso}, ${nowIso}
    )
  `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));

  return {
    user: toRelayUserRecord(user),
    accessToken,
    accessTokenExpiresAt: DateTime.formatIso(accessExp),
    refreshToken,
    refreshTokenExpiresAt: DateTime.formatIso(refreshExp),
  } satisfies RelayAuthSessionResponse;
});

export const loginUserOp = Effect.fn("AuthSession.login")(function* (
  deps: SessionOpsDeps,
  input: RelayLoginRequest,
) {
  const user = yield* findUserByUsername(deps.db.sql, input.username).pipe(
    Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }),
  );
  if (!user) {
    return yield* deps.authError("invalid_credentials");
  }
  const matches = yield* verifyPassword(input.password, user.password_hash).pipe(
    Effect.mapError(deps.internalError),
  );
  if (!matches) {
    return yield* deps.authError("invalid_credentials");
  }
  if (user.disabled !== 0) {
    return yield* deps.authError("account_disabled");
  }
  return yield* issueSessionForUserOp(deps, user, {
    ...(input.clientSurface ? { clientSurface: input.clientSurface } : {}),
    ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
  });
});

export const registerUserOp = Effect.fn("AuthSession.register")(function* (
  deps: SessionOpsDeps,
  input: RelayRegisterRequest,
): Effect.fn.Return<
  RelayAuthSessionResponse,
  RelayBadRequestError | RelayForbiddenError | RelayConflictError | RelayInternalError
> {
  const sql = deps.db.sql;
  const created = yield* deps.db
    .transactionImmediate(
      Effect.gen(function* () {
        if ((yield* countUsers(sql)) === 0) {
          return yield* new RelayForbiddenError({
            code: "forbidden",
            reason: "registration_closed",
            traceId: deps.traceId(),
          });
        }
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        let role: RelayUserRole = "member";
        if (input.inviteCode) {
          const inviteRaw = yield* sql`
            SELECT invite_id, code_prefix, code_hash, role, max_uses, uses_count,
              expires_at, revoked_at, created_by_user_id, created_at
            FROM invites WHERE code_hash = ${hashOpaqueToken(input.inviteCode)} LIMIT 1
          `;
          const invite = (yield* decodeInviteRows(inviteRaw).pipe(Effect.orDie))[0];
          const expired = invite?.expires_at ? invite.expires_at <= nowIso : false;
          if (!invite || invite.revoked_at || expired || invite.uses_count >= invite.max_uses) {
            return yield* new RelayForbiddenError({
              code: "forbidden",
              reason: "invite_invalid",
              traceId: deps.traceId(),
            });
          }
          yield* sql`
            UPDATE invites SET uses_count = uses_count + 1 WHERE invite_id = ${invite.invite_id}
          `;
          role = invite.role;
        } else if (!deps.config.auth.allowPublicRegistration) {
          return yield* new RelayForbiddenError({
            code: "forbidden",
            reason: "registration_closed",
            traceId: deps.traceId(),
          });
        }
        return yield* insertUserRecord({
          sql,
          username: input.username,
          password: input.password,
          role,
          internalError: deps.internalError,
          traceId: deps.traceId,
        });
      }),
    )
    .pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));
  return yield* issueSessionForUserOp(deps, created);
});

export const refreshSessionOp = Effect.fn("AuthSession.refresh")(function* (
  deps: SessionOpsDeps,
  input: RelayRefreshRequest,
) {
  const sql = deps.db.sql;
  const now = yield* DateTime.now;
  const nowIso = DateTime.formatIso(now);
  const nextRefresh = generateRandomToken("avr_rt_", 32);
  const nextRefreshExp = DateTime.formatIso(
    DateTime.add(now, { days: deps.config.auth.refreshTokenTtlDays }),
  );
  const user = yield* deps.db
    .transactionImmediate(
      Effect.gen(function* () {
        const raw = yield* sql`
          SELECT session_id, user_id, refresh_token_hash, expires_at, revoked_at
          FROM sessions WHERE refresh_token_hash = ${hashOpaqueToken(input.refreshToken)} LIMIT 1
        `;
        const session = (yield* decodeSessionRows(raw).pipe(Effect.orDie))[0];
        if (!session || session.revoked_at !== null) {
          return yield* deps.authError("invalid_token");
        }
        if (session.expires_at <= nowIso) {
          return yield* deps.authError("token_expired");
        }
        const loadedUser = yield* findUserById(sql, session.user_id);
        if (!loadedUser) {
          return yield* deps.authError("invalid_token");
        }
        if (loadedUser.disabled !== 0) {
          return yield* deps.authError("account_disabled");
        }
        yield* sql`
          UPDATE sessions
          SET refresh_token_hash = ${hashOpaqueToken(nextRefresh)},
              expires_at = ${nextRefreshExp},
              last_used_at = ${nowIso}
          WHERE session_id = ${session.session_id}
        `;
        return loadedUser;
      }),
    )
    .pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));

  const accessExp = DateTime.add(now, { seconds: deps.config.auth.accessTokenTtlSeconds });
  const accessToken = yield* signRelayAccessToken({
    signature: deps.signature,
    privateKeyPem: deps.privateKeyPem,
    issuer: deps.relayIssuer,
    userId: user.user_id,
    username: user.username,
    role: user.role,
    jti: NodeCrypto.randomUUID(),
    nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
    ttlSeconds: deps.config.auth.accessTokenTtlSeconds,
  }).pipe(Effect.mapError(deps.internalError));

  return {
    user: toRelayUserRecord(user),
    accessToken,
    accessTokenExpiresAt: DateTime.formatIso(accessExp),
    refreshToken: nextRefresh,
    refreshTokenExpiresAt: nextRefreshExp,
  } satisfies RelayAuthSessionResponse;
});

export const logoutUserOp = Effect.fn("AuthSession.logout")(function* (
  deps: SessionOpsDeps,
  input: { readonly userId: RelayUserId; readonly refreshToken?: string },
) {
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  yield* (
    input.refreshToken
      ? deps.db.sql`
          UPDATE sessions SET revoked_at = ${nowIso}
          WHERE user_id = ${input.userId} AND refresh_token_hash = ${hashOpaqueToken(input.refreshToken)}
        `
      : deps.db.sql`
          UPDATE sessions SET revoked_at = ${nowIso}
          WHERE user_id = ${input.userId} AND revoked_at IS NULL
        `
  ).pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));
  return { ok: true as const };
});
