import {
  RelayBadRequestError,
  RelayNotFoundError,
  type RelayAuthSessionResponse,
  type RelayDeviceAuthPollResponse,
  type RelayDeviceAuthStartRequest,
  type RelayDeviceAuthStartResponse,
  type RelayInternalError,
  type RelayUserId,
} from "@t3tools/contracts/agentVelaRelay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ResolvedRelayConfig } from "../config.ts";
import type { RelayDatabase } from "../persistence/database.ts";
import { generateDeviceUserCode, generateRandomToken, hashOpaqueToken } from "./crypto.ts";
import { decodeDeviceCodeRows, findUserById, type UserRow } from "./store.ts";

export interface DeviceAuthDeps {
  readonly config: ResolvedRelayConfig;
  readonly db: typeof RelayDatabase.Service;
  readonly internalError: () => RelayInternalError;
  readonly traceId: () => string;
  readonly issueSessionForUser: (
    user: UserRow,
    meta?: { readonly clientSurface?: string; readonly deviceLabel?: string },
  ) => Effect.Effect<RelayAuthSessionResponse, RelayInternalError>;
}

export const startDeviceAuthOp = Effect.fn("AuthDevice.start")(function* (
  deps: DeviceAuthDeps,
  input: RelayDeviceAuthStartRequest,
) {
  const now = yield* DateTime.now;
  const expiresAtIso = DateTime.formatIso(
    DateTime.add(now, { minutes: deps.config.auth.deviceCodeTtlMinutes }),
  );
  const deviceCode = generateRandomToken("avr_dc_", 32);
  const userCode = generateDeviceUserCode();
  yield* deps.db.sql`
    INSERT INTO device_codes (
      device_code_hash, user_code, device_label, status, approved_user_id, expires_at, created_at
    ) VALUES (
      ${hashOpaqueToken(deviceCode)}, ${userCode}, ${input.deviceLabel ?? null},
      'pending', ${null}, ${expiresAtIso}, ${DateTime.formatIso(now)}
    )
  `.pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));

  return {
    deviceCode,
    userCode,
    verificationPath: "/relay/device",
    expiresAt: expiresAtIso,
    intervalSeconds: 3,
  } satisfies RelayDeviceAuthStartResponse;
});

export const approveDeviceAuthOp = Effect.fn("AuthDevice.approve")(function* (
  deps: DeviceAuthDeps,
  input: { readonly userId: RelayUserId; readonly userCode: string },
) {
  const normalized = input.userCode.trim().toUpperCase();
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  return yield* deps.db
    .transactionImmediate(
      Effect.gen(function* () {
        const raw = yield* deps.db.sql`
          SELECT device_code_hash, user_code, device_label, status, approved_user_id, expires_at
          FROM device_codes WHERE user_code = ${normalized} LIMIT 1
        `;
        const row = (yield* decodeDeviceCodeRows(raw).pipe(Effect.orDie))[0];
        if (!row) {
          return yield* new RelayNotFoundError({
            code: "not_found",
            resource: "device_code",
            traceId: deps.traceId(),
          });
        }
        if (row.expires_at <= nowIso || row.status !== "pending") {
          return yield* new RelayBadRequestError({
            code: "bad_request",
            reason: "challenge_invalid",
            detail: "Device code is expired or already used",
            traceId: deps.traceId(),
          });
        }
        yield* deps.db.sql`
          UPDATE device_codes SET status = 'approved', approved_user_id = ${input.userId}
          WHERE device_code_hash = ${row.device_code_hash}
        `;
        return { ok: true as const };
      }),
    )
    .pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));
});

export const pollDeviceAuthOp = Effect.fn("AuthDevice.poll")(function* (
  deps: DeviceAuthDeps,
  input: { readonly deviceCode: string },
) {
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const hash = hashOpaqueToken(input.deviceCode);
  const approved = yield* deps.db
    .transactionImmediate(
      Effect.gen(function* () {
        const raw = yield* deps.db.sql`
          SELECT device_code_hash, user_code, device_label, status, approved_user_id, expires_at
          FROM device_codes WHERE device_code_hash = ${hash} LIMIT 1
        `;
        const row = (yield* decodeDeviceCodeRows(raw).pipe(Effect.orDie))[0];
        if (!row || row.status === "consumed") {
          return yield* new RelayNotFoundError({
            code: "not_found",
            resource: "device_code",
            traceId: deps.traceId(),
          });
        }
        if (row.expires_at <= nowIso || row.status === "expired") {
          yield* deps.db.sql`
            UPDATE device_codes SET status = 'expired' WHERE device_code_hash = ${hash}
          `;
          return { status: "expired" as const };
        }
        if (row.status === "pending" || !row.approved_user_id) {
          return { status: "pending" as const };
        }
        const user = yield* findUserById(deps.db.sql, row.approved_user_id);
        if (!user || user.disabled !== 0) {
          yield* deps.db.sql`
            UPDATE device_codes SET status = 'expired' WHERE device_code_hash = ${hash}
          `;
          return { status: "expired" as const };
        }
        yield* deps.db.sql`
          UPDATE device_codes SET status = 'consumed' WHERE device_code_hash = ${hash}
        `;
        return {
          status: "approved" as const,
          user,
          ...(row.device_label ? { deviceLabel: row.device_label } : {}),
        };
      }),
    )
    .pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));

  if (approved.status !== "approved") {
    return approved;
  }
  const session = yield* deps.issueSessionForUser(approved.user, {
    ...(approved.deviceLabel ? { deviceLabel: approved.deviceLabel } : {}),
    clientSurface: "cli",
  });
  return { status: "approved", session } satisfies RelayDeviceAuthPollResponse;
});
