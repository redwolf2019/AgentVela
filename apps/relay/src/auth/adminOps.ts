// @effect-diagnostics nodeBuiltinImport:off -- Admin user and invite operations generate cryptographic IDs via node:crypto.
import * as NodeCrypto from "node:crypto";

import {
  RelayBadRequestError,
  RelayConflictError,
  RelayInviteId,
  RelayNotFoundError,
  RelayUserId,
  RelayUsername,
  type RelayAdminCreateInviteRequest,
  type RelayAdminCreateInviteResponse,
  type RelayAdminListInvitesResponse,
  type RelayAdminListUsersResponse,
  type RelayAdminUpdateUserRequest,
  type RelayInternalError,
  type RelayUserRecord,
  type RelayUserRole,
  type RelayUsername as RelayUsernameType,
} from "@t3tools/contracts/agentVelaRelay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/sql/SqlError";

import type { RelayDatabase } from "../persistence/database.ts";
import {
  generateRandomToken,
  hashOpaqueToken,
  hashPassword,
  isAcceptableRelayPassword,
  MIN_RELAY_PASSWORD_LENGTH,
} from "./crypto.ts";
import {
  countActiveAdmins,
  decodeInviteRows,
  decodeUserRows,
  findUserById,
  toRelayInviteRecord,
  toRelayUserRecord,
  type UserRow,
} from "./store.ts";

const decodeUsername = Schema.decodeUnknownSync(RelayUsername);
export const isValidRelayUsername = (value: string): value is RelayUsernameType => {
  try {
    decodeUsername(value);
    return true;
  } catch {
    return false;
  }
};

export const isUniqueConstraintError = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /UNIQUE constraint/i.test(message);
};

export const insertUserRecord = Effect.fn("AuthAdmin.insertUserRecord")(function* (input: {
  readonly sql: (typeof RelayDatabase.Service)["sql"];
  readonly username: string;
  readonly password: string;
  readonly role: RelayUserRole;
  readonly internalError: () => RelayInternalError;
  readonly traceId: () => string;
}) {
  if (!isValidRelayUsername(input.username)) {
    return yield* new RelayBadRequestError({
      code: "bad_request",
      reason: "invalid_input",
      detail: "Username must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$",
      traceId: input.traceId(),
    });
  }
  if (!isAcceptableRelayPassword(input.password)) {
    return yield* new RelayBadRequestError({
      code: "bad_request",
      reason: "password_too_weak",
      detail: `Password must be at least ${MIN_RELAY_PASSWORD_LENGTH} characters and not a placeholder`,
      traceId: input.traceId(),
    });
  }
  const passwordHash = yield* hashPassword(input.password).pipe(
    Effect.mapError(input.internalError),
  );
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const userId = RelayUserId.make(NodeCrypto.randomUUID());
  yield* input.sql`
    INSERT INTO users (user_id, username, password_hash, role, disabled, created_at, updated_at)
    VALUES (${userId}, ${input.username}, ${passwordHash}, ${input.role}, 0, ${nowIso}, ${nowIso})
  `.pipe(
    Effect.mapError((cause) =>
      isUniqueConstraintError(cause)
        ? new RelayConflictError({
            code: "conflict",
            reason: "username_taken",
            traceId: input.traceId(),
          })
        : input.internalError(),
    ),
  );
  return {
    user_id: userId,
    username: decodeUsername(input.username),
    password_hash: passwordHash,
    role: input.role,
    disabled: 0,
    created_at: nowIso,
    updated_at: nowIso,
  } satisfies UserRow;
});

export const adminListUsers = Effect.fn("AuthAdmin.listUsers")(function* (
  sql: (typeof RelayDatabase.Service)["sql"],
  internalError: () => RelayInternalError,
) {
  const raw = yield* sql`
    SELECT user_id, username, password_hash, role, disabled, created_at, updated_at
    FROM users ORDER BY created_at ASC
  `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
  const rows = yield* decodeUserRows(raw).pipe(Effect.orDie);
  return { users: rows.map(toRelayUserRecord) } satisfies RelayAdminListUsersResponse;
});

export const adminUpdateUser = Effect.fn("AuthAdmin.updateUser")(function* (input: {
  readonly db: typeof RelayDatabase.Service;
  readonly userId: RelayUserId;
  readonly patch: RelayAdminUpdateUserRequest;
  readonly internalError: () => RelayInternalError;
  readonly traceId: () => string;
}) {
  const nextHash =
    input.patch.password !== undefined
      ? isAcceptableRelayPassword(input.patch.password)
        ? yield* hashPassword(input.patch.password).pipe(Effect.mapError(input.internalError))
        : yield* new RelayBadRequestError({
            code: "bad_request",
            reason: "password_too_weak",
            detail: `Password must be at least ${MIN_RELAY_PASSWORD_LENGTH} characters`,
            traceId: input.traceId(),
          })
      : undefined;
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  return yield* input.db
    .transactionImmediate(
      Effect.gen(function* () {
        const existing = yield* findUserById(input.db.sql, input.userId);
        if (!existing) {
          return yield* new RelayNotFoundError({
            code: "not_found",
            resource: "user",
            traceId: input.traceId(),
          });
        }
        const nextRole = input.patch.role ?? existing.role;
        const nextDisabled = input.patch.disabled ?? existing.disabled !== 0;
        const wasActiveAdmin = existing.role === "admin" && existing.disabled === 0;
        const staysActiveAdmin = nextRole === "admin" && !nextDisabled;
        if (wasActiveAdmin && !staysActiveAdmin && (yield* countActiveAdmins(input.db.sql)) <= 1) {
          return yield* new RelayBadRequestError({
            code: "bad_request",
            reason: "invalid_input",
            detail: "Cannot disable or demote the last active admin",
            traceId: input.traceId(),
          });
        }
        yield* input.db.sql`
          UPDATE users
          SET role = ${nextRole},
              disabled = ${nextDisabled ? 1 : 0},
              password_hash = ${nextHash ?? existing.password_hash},
              updated_at = ${nowIso}
          WHERE user_id = ${input.userId}
        `;
        if (nextDisabled || nextHash !== undefined) {
          yield* input.db.sql`
            UPDATE sessions SET revoked_at = ${nowIso}
            WHERE user_id = ${input.userId} AND revoked_at IS NULL
          `;
        }
        return {
          userId: existing.user_id,
          username: existing.username,
          role: nextRole,
          disabled: nextDisabled,
          createdAt: existing.created_at,
          updatedAt: nowIso,
        } satisfies RelayUserRecord;
      }),
    )
    .pipe(
      Effect.catchTags({
        SqlError: (_error: SqlError.SqlError) => Effect.fail(input.internalError()),
      }),
    );
});

export const adminListInvites = Effect.fn("AuthAdmin.listInvites")(function* (
  sql: (typeof RelayDatabase.Service)["sql"],
  internalError: () => RelayInternalError,
) {
  const raw = yield* sql`
    SELECT invite_id, code_prefix, code_hash, role, max_uses, uses_count,
           expires_at, revoked_at, created_by_user_id, created_at
    FROM invites ORDER BY created_at DESC
  `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
  const rows = yield* decodeInviteRows(raw).pipe(Effect.orDie);
  return { invites: rows.map(toRelayInviteRecord) } satisfies RelayAdminListInvitesResponse;
});

export const adminCreateInvite = Effect.fn("AuthAdmin.createInvite")(function* (input: {
  readonly sql: (typeof RelayDatabase.Service)["sql"];
  readonly createdByUserId: RelayUserId;
  readonly request: RelayAdminCreateInviteRequest;
  readonly internalError: () => RelayInternalError;
}) {
  const now = yield* DateTime.now;
  const nowIso = DateTime.formatIso(now);
  const inviteId = RelayInviteId.make(NodeCrypto.randomUUID());
  const rawCode = generateRandomToken("avr_inv_", 24);
  const codePrefix = rawCode.slice(0, 14);
  const role = input.request.role ?? "member";
  const maxUses = input.request.maxUses ?? 1;
  const expiresAt = input.request.ttlHours
    ? DateTime.formatIso(DateTime.add(now, { hours: input.request.ttlHours }))
    : null;
  yield* input.sql`
    INSERT INTO invites (
      invite_id, code_prefix, code_hash, role, max_uses, uses_count,
      expires_at, revoked_at, created_by_user_id, created_at
    ) VALUES (
      ${inviteId}, ${codePrefix}, ${hashOpaqueToken(rawCode)}, ${role},
      ${maxUses}, 0, ${expiresAt}, ${null}, ${input.createdByUserId}, ${nowIso}
    )
  `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(input.internalError()) }));
  return {
    invite: {
      inviteId,
      codePrefix,
      role,
      maxUses,
      usesCount: 0,
      expiresAt,
      revokedAt: null,
      createdByUserId: input.createdByUserId,
      createdAt: nowIso,
    },
    code: rawCode,
  } satisfies RelayAdminCreateInviteResponse;
});

export const adminRevokeInvite = Effect.fn("AuthAdmin.revokeInvite")(function* (input: {
  readonly sql: (typeof RelayDatabase.Service)["sql"];
  readonly inviteId: RelayInviteId;
  readonly internalError: () => RelayInternalError;
  readonly traceId: () => string;
}) {
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const updated = yield* input.sql`
    UPDATE invites SET revoked_at = ${nowIso}
    WHERE invite_id = ${input.inviteId} AND revoked_at IS NULL
    RETURNING invite_id
  `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(input.internalError()) }));
  if ((updated as ReadonlyArray<unknown>).length === 0) {
    return yield* new RelayNotFoundError({
      code: "not_found",
      resource: "invite",
      traceId: input.traceId(),
    });
  }
  return { ok: true as const };
});
