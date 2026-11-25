// @effect-diagnostics nodeBuiltinImport:off -- AuthService generates cryptographic IDs via node:crypto.
import * as NodeCrypto from "node:crypto";

import {
  type AgentVelaRelayDpopScope,
  type RelayAdminCreateInviteRequest,
  type RelayAdminCreateInviteResponse,
  type RelayAdminCreateUserRequest,
  type RelayAdminListInvitesResponse,
  type RelayAdminListUsersResponse,
  type RelayAdminUpdateUserRequest,
  type RelayAuthConfigResponse,
  RelayAuthError,
  type RelayAuthErrorReason,
  type RelayAuthSessionResponse,
  RelayBadRequestError,
  RelayConflictError,
  type RelayDeviceAuthPollResponse,
  type RelayDeviceAuthStartRequest,
  type RelayDeviceAuthStartResponse,
  type RelayDpopTokenExchangeResponse,
  type RelayForbiddenError,
  RelayInternalError,
  type RelayInviteId,
  type RelayLoginRequest,
  type RelayNotFoundError,
  type RelayRefreshRequest,
  type RelayRegisterRequest,
  type RelayUserId,
  type RelayUserRecord,
} from "@t3tools/contracts/agentVelaRelay";
import { normalizeRelayIssuer, signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayConfig } from "../config.ts";
import { RelayDatabase } from "../persistence/database.ts";
import {
  adminCreateInvite,
  adminListInvites,
  adminListUsers,
  adminRevokeInvite,
  adminUpdateUser,
  insertUserRecord,
} from "./adminOps.ts";
import { generateEd25519PemKeypair, isAcceptableRelayPassword } from "./crypto.ts";
import { approveDeviceAuthOp, pollDeviceAuthOp, startDeviceAuthOp } from "./deviceAuthOps.ts";
import {
  authenticateDpopRequestOp,
  exchangeDpopTokenOp,
  type AuthenticatedDpopClient,
  type AuthenticatedRelayClient,
} from "./dpopOps.ts";
import {
  issueSessionForUserOp,
  loginUserOp,
  logoutUserOp,
  refreshSessionOp,
  registerUserOp,
} from "./sessionOps.ts";
import { countUsers, decodeSigningKeyRows, findUserById, toRelayUserRecord } from "./store.ts";
import { isExpiredRelayJwtError, verifyRelayAccessToken } from "./tokens.ts";

export type { AuthenticatedDpopClient, AuthenticatedRelayClient } from "./dpopOps.ts";

const newTraceId = (): string => NodeCrypto.randomUUID();
const authError = (reason: RelayAuthErrorReason, dpopFailureReason?: "invalid_proof") =>
  new RelayAuthError({
    code: "auth_invalid",
    reason,
    ...(dpopFailureReason ? { dpopFailureReason } : {}),
    traceId: newTraceId(),
  });
const internalError = () =>
  new RelayInternalError({
    code: "internal_error",
    reason: "persistence_failed",
    traceId: newTraceId(),
  });

const normalizeBearerToken = (headerValue: string): string | null =>
  /^Bearer\s+(\S+)$/i.exec(headerValue.trim())?.[1] ?? null;

export class AuthService extends Context.Service<
  AuthService,
  {
    readonly relayIssuer: string;
    readonly relayMintPublicKeyPem: string;
    readonly signRelayProof: (input: {
      readonly typ: string;
      readonly payload: Record<string, unknown>;
    }) => Effect.Effect<string, RelayInternalError>;
    readonly getConfig: () => Effect.Effect<RelayAuthConfigResponse, RelayInternalError>;
    readonly bootstrapAdmin: (input: {
      readonly username: string;
      readonly password: string;
    }) => Effect.Effect<
      RelayUserRecord,
      RelayBadRequestError | RelayConflictError | RelayInternalError
    >;
    readonly login: (
      input: RelayLoginRequest,
    ) => Effect.Effect<
      RelayAuthSessionResponse,
      RelayAuthError | RelayBadRequestError | RelayInternalError
    >;
    readonly register: (
      input: RelayRegisterRequest,
    ) => Effect.Effect<
      RelayAuthSessionResponse,
      RelayBadRequestError | RelayForbiddenError | RelayConflictError | RelayInternalError
    >;
    readonly refresh: (
      input: RelayRefreshRequest,
    ) => Effect.Effect<RelayAuthSessionResponse, RelayAuthError | RelayInternalError>;
    readonly logout: (input: {
      readonly userId: RelayUserId;
      readonly refreshToken?: string;
    }) => Effect.Effect<{ readonly ok: true }, RelayInternalError>;
    readonly getMe: (
      userId: RelayUserId,
    ) => Effect.Effect<RelayUserRecord, RelayAuthError | RelayInternalError>;
    readonly startDeviceAuth: (
      input: RelayDeviceAuthStartRequest,
    ) => Effect.Effect<RelayDeviceAuthStartResponse, RelayBadRequestError | RelayInternalError>;
    readonly approveDeviceAuth: (input: {
      readonly userId: RelayUserId;
      readonly userCode: string;
    }) => Effect.Effect<
      { readonly ok: true },
      RelayBadRequestError | RelayNotFoundError | RelayInternalError
    >;
    readonly pollDeviceAuth: (input: {
      readonly deviceCode: string;
    }) => Effect.Effect<RelayDeviceAuthPollResponse, RelayNotFoundError | RelayInternalError>;
    readonly exchangeDpopToken: (input: {
      readonly principal: AuthenticatedRelayClient;
      readonly dpopProof: string;
      readonly requestUrl: string;
      readonly scopes: ReadonlyArray<AgentVelaRelayDpopScope>;
    }) => Effect.Effect<
      RelayDpopTokenExchangeResponse,
      RelayAuthError | RelayBadRequestError | RelayInternalError
    >;
    readonly authenticateBearerToken: (
      token: string,
    ) => Effect.Effect<AuthenticatedRelayClient, RelayAuthError | RelayInternalError>;
    readonly authenticateDpopRequest: (input: {
      readonly authorizationHeader: string;
      readonly dpopHeader: string;
      readonly method: string;
      readonly url: string;
      readonly requiredScope?: AgentVelaRelayDpopScope;
    }) => Effect.Effect<AuthenticatedDpopClient, RelayAuthError | RelayInternalError>;
    readonly listUsers: () => Effect.Effect<RelayAdminListUsersResponse, RelayInternalError>;
    readonly createUser: (
      input: RelayAdminCreateUserRequest,
    ) => Effect.Effect<
      RelayUserRecord,
      RelayBadRequestError | RelayConflictError | RelayInternalError
    >;
    readonly updateUser: (input: {
      readonly userId: RelayUserId;
      readonly patch: RelayAdminUpdateUserRequest;
    }) => Effect.Effect<
      RelayUserRecord,
      RelayBadRequestError | RelayNotFoundError | RelayInternalError
    >;
    readonly listInvites: () => Effect.Effect<RelayAdminListInvitesResponse, RelayInternalError>;
    readonly createInvite: (input: {
      readonly createdByUserId: RelayUserId;
      readonly request: RelayAdminCreateInviteRequest;
    }) => Effect.Effect<RelayAdminCreateInviteResponse, RelayBadRequestError | RelayInternalError>;
    readonly revokeInvite: (
      inviteId: RelayInviteId,
    ) => Effect.Effect<{ readonly ok: true }, RelayNotFoundError | RelayInternalError>;
  }
>()("agent-vela-relay/auth/AuthService") {}

const ensureSigningKeypair = Effect.fn("AuthService.ensureSigningKeypair")(function* (
  db: typeof RelayDatabase.Service,
) {
  return yield* db.transactionImmediate(
    Effect.gen(function* () {
      const existingRaw = yield* db.sql`
        SELECT key_id, public_key_spki_b64u, private_key_pkcs8_b64u, created_at
        FROM relay_signing_keys WHERE key_id = 'primary' LIMIT 1
      `;
      const first = (yield* decodeSigningKeyRows(existingRaw).pipe(Effect.orDie))[0];
      if (first) {
        return {
          publicKeyPem: first.public_key_spki_b64u,
          privateKeyPem: first.private_key_pkcs8_b64u,
        };
      }
      const pair = generateEd25519PemKeypair();
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* db.sql`
        INSERT INTO relay_signing_keys (key_id, public_key_spki_b64u, private_key_pkcs8_b64u, created_at)
        VALUES ('primary', ${pair.publicKeyPem}, ${pair.privateKeyPem}, ${nowIso})
      `;
      return pair;
    }),
  );
});

export const layerRelayAuth = Layer.effect(
  AuthService,
  Effect.gen(function* () {
    const config = yield* RelayConfig;
    const db = yield* RelayDatabase;
    const signature = yield* Signature.Signature;
    const sql = db.sql;
    const relayIssuer = normalizeRelayIssuer(config.publicUrl);
    const keypair = yield* ensureSigningKeypair(db);

    const bootstrapAdmin = Effect.fn("AuthService.bootstrapAdmin")(function* (input: {
      readonly username: string;
      readonly password: string;
    }) {
      return yield* db
        .transactionImmediate(
          Effect.gen(function* () {
            if ((yield* countUsers(sql)) > 0) {
              return yield* new RelayConflictError({
                code: "conflict",
                reason: "already_initialized",
                traceId: newTraceId(),
              });
            }
            const created = yield* insertUserRecord({
              sql,
              username: input.username,
              password: input.password,
              role: "admin",
              internalError,
              traceId: newTraceId,
            });
            return toRelayUserRecord(created);
          }),
        )
        .pipe(Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }));
    });

    if (config.auth.bootstrapAdminPassword !== undefined) {
      if (!isAcceptableRelayPassword(config.auth.bootstrapAdminPassword)) {
        return yield* new RelayBadRequestError({
          code: "bad_request",
          reason: "password_too_weak",
          detail: "AGENT_VELA_RELAY_ADMIN_PASSWORD must not be empty or a placeholder",
          traceId: newTraceId(),
        });
      }
      const existingCount = yield* countUsers(sql).pipe(
        Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }),
      );
      if (existingCount === 0) {
        yield* bootstrapAdmin({
          username: config.auth.bootstrapAdminUsername ?? "admin",
          password: config.auth.bootstrapAdminPassword,
        });
      }
    }

    const sessionDeps = {
      config,
      db,
      signature,
      relayIssuer,
      publicKeyPem: keypair.publicKeyPem,
      privateKeyPem: keypair.privateKeyPem,
      authError,
      internalError,
      traceId: newTraceId,
    };

    const deviceDeps = {
      config,
      db,
      internalError,
      traceId: newTraceId,
      issueSessionForUser: (
        user: Parameters<typeof issueSessionForUserOp>[1],
        meta?: Parameters<typeof issueSessionForUserOp>[2],
      ) => issueSessionForUserOp(sessionDeps, user, meta),
    };

    const getConfig = Effect.fn("AuthService.getConfig")(function* () {
      const total = yield* countUsers(sql).pipe(
        Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }),
      );
      return {
        initialized: total > 0,
        registrationOpen: config.auth.allowPublicRegistration,
        version: config.version,
      } satisfies RelayAuthConfigResponse;
    });

    const getMe = Effect.fn("AuthService.getMe")(function* (userId: RelayUserId) {
      const user = yield* findUserById(sql, userId).pipe(
        Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }),
      );
      if (!user) {
        return yield* authError("invalid_token");
      }
      if (user.disabled !== 0) {
        return yield* authError("account_disabled");
      }
      return toRelayUserRecord(user);
    });

    const authenticateBearerToken = Effect.fn("AuthService.authenticateBearerToken")(function* (
      rawToken: string,
    ) {
      const token = normalizeBearerToken(rawToken) ?? rawToken.trim();
      if (token.length === 0) {
        return yield* authError("missing_credentials");
      }
      const claims = yield* verifyRelayAccessToken({
        signature,
        token,
        publicKeyPem: keypair.publicKeyPem,
        issuer: relayIssuer,
        ttlSeconds: config.auth.accessTokenTtlSeconds,
      }).pipe(
        Effect.mapError((error) =>
          authError(isExpiredRelayJwtError(error) ? "token_expired" : "invalid_token"),
        ),
      );
      const user = yield* findUserById(sql, claims.sub).pipe(
        Effect.catchTags({ SqlError: () => Effect.fail(internalError()) }),
      );
      if (!user) {
        return yield* authError("invalid_token");
      }
      if (user.disabled !== 0) {
        return yield* authError("account_disabled");
      }
      return {
        userId: user.user_id,
        username: user.username,
        role: user.role,
        token,
      } satisfies AuthenticatedRelayClient;
    });

    const signRelayProof = Effect.fn("AuthService.signRelayProof")(function* (input: {
      readonly typ: string;
      readonly payload: Record<string, unknown>;
    }) {
      return yield* signRelayJwt({
        typ: input.typ,
        payload: input.payload,
        privateKey: keypair.privateKeyPem,
      }).pipe(
        Effect.provideService(Signature.Signature, signature),
        Effect.mapError(internalError),
      );
    });

    return AuthService.of({
      relayIssuer,
      relayMintPublicKeyPem: keypair.publicKeyPem,
      signRelayProof,
      getConfig,
      bootstrapAdmin,
      login: Effect.fn("AuthService.login")((input) => loginUserOp(sessionDeps, input)),
      register: Effect.fn("AuthService.register")((input) => registerUserOp(sessionDeps, input)),
      refresh: Effect.fn("AuthService.refresh")((input) => refreshSessionOp(sessionDeps, input)),
      logout: Effect.fn("AuthService.logout")((input) => logoutUserOp(sessionDeps, input)),
      getMe,
      startDeviceAuth: Effect.fn("AuthService.startDeviceAuth")((input) =>
        startDeviceAuthOp(deviceDeps, input),
      ),
      approveDeviceAuth: Effect.fn("AuthService.approveDeviceAuth")((input) =>
        approveDeviceAuthOp(deviceDeps, input),
      ),
      pollDeviceAuth: Effect.fn("AuthService.pollDeviceAuth")((input) =>
        pollDeviceAuthOp(deviceDeps, input),
      ),
      exchangeDpopToken: Effect.fn("AuthService.exchangeDpopToken")((input) =>
        exchangeDpopTokenOp(sessionDeps, input),
      ),
      authenticateBearerToken,
      authenticateDpopRequest: Effect.fn("AuthService.authenticateDpopRequest")((input) =>
        authenticateDpopRequestOp(sessionDeps, input),
      ),
      listUsers: Effect.fn("AuthService.listUsers")(() => adminListUsers(sql, internalError)),
      createUser: Effect.fn("AuthService.createUser")((input) =>
        insertUserRecord({
          sql,
          username: input.username,
          password: input.password,
          role: input.role,
          internalError,
          traceId: newTraceId,
        }).pipe(Effect.map(toRelayUserRecord)),
      ),
      updateUser: Effect.fn("AuthService.updateUser")((input) =>
        adminUpdateUser({
          db,
          userId: input.userId,
          patch: input.patch,
          internalError,
          traceId: newTraceId,
        }),
      ),
      listInvites: Effect.fn("AuthService.listInvites")(() => adminListInvites(sql, internalError)),
      createInvite: Effect.fn("AuthService.createInvite")((input) =>
        adminCreateInvite({
          sql,
          createdByUserId: input.createdByUserId,
          request: input.request,
          internalError,
        }),
      ),
      revokeInvite: Effect.fn("AuthService.revokeInvite")((inviteId) =>
        adminRevokeInvite({ sql, inviteId, internalError, traceId: newTraceId }),
      ),
    });
  }),
);
