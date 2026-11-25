import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  RelayInviteId,
  RelayUserId,
  RelayUserRole,
  RelayUsername,
  type RelayInviteRecord,
  type RelayUserRecord,
} from "@t3tools/contracts/agentVelaRelay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

export const UserRowSchema = Schema.Struct({
  user_id: RelayUserId,
  username: RelayUsername,
  password_hash: Schema.String,
  role: RelayUserRole,
  disabled: Schema.Number,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type UserRow = typeof UserRowSchema.Type;

export const SigningKeyRowSchema = Schema.Struct({
  key_id: Schema.String,
  public_key_spki_b64u: Schema.String,
  private_key_pkcs8_b64u: Schema.String,
  created_at: Schema.String,
});

export const InviteRowSchema = Schema.Struct({
  invite_id: RelayInviteId,
  code_prefix: TrimmedNonEmptyString,
  code_hash: Schema.String,
  role: RelayUserRole,
  max_uses: PositiveInt,
  uses_count: NonNegativeInt,
  expires_at: Schema.NullOr(IsoDateTime),
  revoked_at: Schema.NullOr(IsoDateTime),
  created_by_user_id: RelayUserId,
  created_at: IsoDateTime,
});
export type InviteRow = typeof InviteRowSchema.Type;

export const SessionRowSchema = Schema.Struct({
  session_id: Schema.String,
  user_id: RelayUserId,
  refresh_token_hash: Schema.String,
  expires_at: Schema.String,
  revoked_at: Schema.NullOr(Schema.String),
});

export const DeviceCodeRowSchema = Schema.Struct({
  device_code_hash: Schema.String,
  user_code: Schema.String,
  device_label: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "approved", "consumed", "expired"]),
  approved_user_id: Schema.NullOr(RelayUserId),
  expires_at: Schema.String,
});

const CountRowSchema = Schema.Struct({
  count: Schema.Number,
});

export const decodeUserRows = Schema.decodeUnknownEffect(Schema.Array(UserRowSchema));
export const decodeSigningKeyRows = Schema.decodeUnknownEffect(Schema.Array(SigningKeyRowSchema));
export const decodeInviteRows = Schema.decodeUnknownEffect(Schema.Array(InviteRowSchema));
export const decodeSessionRows = Schema.decodeUnknownEffect(Schema.Array(SessionRowSchema));
export const decodeDeviceCodeRows = Schema.decodeUnknownEffect(Schema.Array(DeviceCodeRowSchema));
export const decodeCountRows = Schema.decodeUnknownEffect(Schema.Array(CountRowSchema));

export function toRelayUserRecord(row: UserRow): RelayUserRecord {
  return {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    disabled: row.disabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toRelayInviteRecord(row: InviteRow): RelayInviteRecord {
  return {
    inviteId: row.invite_id,
    codePrefix: row.code_prefix,
    role: row.role,
    maxUses: row.max_uses,
    usesCount: row.uses_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

export const findUserById = Effect.fn("AuthStore.findUserById")(function* (
  sql: SqlClient.SqlClient,
  userId: RelayUserId,
) {
  const raw = yield* sql`
    SELECT user_id, username, password_hash, role, disabled, created_at, updated_at
    FROM users WHERE user_id = ${userId} LIMIT 1
  `;
  const rows = yield* decodeUserRows(raw).pipe(Effect.orDie);
  return rows[0] ?? null;
});

export const findUserByUsername = Effect.fn("AuthStore.findUserByUsername")(function* (
  sql: SqlClient.SqlClient,
  username: string,
) {
  const raw = yield* sql`
    SELECT user_id, username, password_hash, role, disabled, created_at, updated_at
    FROM users WHERE username = ${username} LIMIT 1
  `;
  const rows = yield* decodeUserRows(raw).pipe(Effect.orDie);
  return rows[0] ?? null;
});

export const countUsers = Effect.fn("AuthStore.countUsers")(function* (sql: SqlClient.SqlClient) {
  const raw = yield* sql`SELECT COUNT(*) AS count FROM users`;
  const rows = yield* decodeCountRows(raw).pipe(Effect.orDie);
  return rows[0]?.count ?? 0;
});

export const countActiveAdmins = Effect.fn("AuthStore.countActiveAdmins")(function* (
  sql: SqlClient.SqlClient,
) {
  const raw = yield* sql`
    SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0
  `;
  const rows = yield* decodeCountRows(raw).pipe(Effect.orDie);
  return rows[0]?.count ?? 0;
});
