// @effect-diagnostics nodeBuiltinImport:off -- DPoP token exchange generates jtis via node:crypto.
import * as NodeCrypto from "node:crypto";

import type {
  AgentVelaRelayDpopScope,
  RelayAuthError,
  RelayAuthErrorReason,
  RelayDpopTokenExchangeResponse,
  RelayInternalError,
  RelayUserId,
  RelayUserRole,
  RelayUsername,
} from "@t3tools/contracts/agentVelaRelay";
import type * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ResolvedRelayConfig } from "../config.ts";
import type { RelayDatabase } from "../persistence/database.ts";
import { findUserById } from "./store.ts";
import {
  isExpiredRelayJwtError,
  signRelayDpopToken,
  verifyRelayClientDpopProof,
  verifyRelayDpopToken,
} from "./tokens.ts";

export interface AuthenticatedRelayClient {
  readonly userId: RelayUserId;
  readonly username: RelayUsername;
  readonly role: RelayUserRole;
  readonly token: string;
}

export interface AuthenticatedDpopClient extends AuthenticatedRelayClient {
  readonly proofKeyThumbprint: string;
  readonly dpopScopes: ReadonlyArray<AgentVelaRelayDpopScope>;
}

export interface DpopOpsDeps {
  readonly config: ResolvedRelayConfig;
  readonly db: typeof RelayDatabase.Service;
  readonly signature: Signature.Signature["Service"];
  readonly relayIssuer: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
  readonly authError: (
    reason: RelayAuthErrorReason,
    dpopFailureReason?: "invalid_proof",
  ) => RelayAuthError;
  readonly internalError: () => RelayInternalError;
}

const normalizeDpopToken = (headerValue: string): string | null =>
  /^DPoP\s+(\S+)$/i.exec(headerValue.trim())?.[1] ?? null;

export const exchangeDpopTokenOp = Effect.fn("AuthDpop.exchange")(function* (
  deps: DpopOpsDeps,
  input: {
    readonly principal: AuthenticatedRelayClient;
    readonly dpopProof: string;
    readonly requestUrl: string;
    readonly scopes: ReadonlyArray<AgentVelaRelayDpopScope>;
  },
) {
  const now = yield* DateTime.now;
  const nowEpoch = Math.floor(now.epochMilliseconds / 1_000);
  const verified = yield* verifyRelayClientDpopProof({
    proof: input.dpopProof,
    method: "POST",
    url: input.requestUrl,
    nowEpochSeconds: nowEpoch,
  });

  if (!verified.ok) {
    return yield* deps.authError("invalid_dpop", "invalid_proof");
  }
  const replayExpiry = DateTime.formatIso(DateTime.add(now, { minutes: 5 }));
  const acceptedJti = yield* deps.db
    .consumeProofJti({
      scope: "dpop:exchange",
      jti: `${verified.thumbprint}:${verified.jti}`,
      expiresAtIso: replayExpiry,
      nowIso: DateTime.formatIso(now),
    })
    .pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));
  if (!acceptedJti) {
    return yield* deps.authError("invalid_dpop", "invalid_proof");
  }

  const accessToken = yield* signRelayDpopToken({
    signature: deps.signature,
    privateKeyPem: deps.privateKeyPem,
    issuer: deps.relayIssuer,
    userId: input.principal.userId,
    username: input.principal.username,
    role: input.principal.role,
    jti: NodeCrypto.randomUUID(),
    proofKeyThumbprint: verified.thumbprint,
    scopes: input.scopes,
    nowEpochSeconds: nowEpoch,
    ttlSeconds: deps.config.auth.accessTokenTtlSeconds,
  }).pipe(Effect.mapError(deps.internalError));

  return {
    accessToken,
    tokenType: "DPoP" as const,
    expiresIn: deps.config.auth.accessTokenTtlSeconds,
    scopes: [...input.scopes],
  } satisfies RelayDpopTokenExchangeResponse;
});

export const authenticateDpopRequestOp = Effect.fn("AuthDpop.authenticate")(function* (
  deps: DpopOpsDeps,
  input: {
    readonly authorizationHeader: string;
    readonly dpopHeader: string;
    readonly method: string;
    readonly url: string;
    readonly requiredScope?: AgentVelaRelayDpopScope;
  },
) {
  const token = normalizeDpopToken(input.authorizationHeader);
  if (!token) {
    return yield* deps.authError("invalid_dpop", "invalid_proof");
  }
  const now = yield* DateTime.now;
  const nowEpoch = Math.floor(now.epochMilliseconds / 1_000);
  const claims = yield* verifyRelayDpopToken({
    signature: deps.signature,
    token,
    publicKeyPem: deps.publicKeyPem,
    issuer: deps.relayIssuer,
    ttlSeconds: deps.config.auth.accessTokenTtlSeconds,
  }).pipe(
    Effect.mapError((error) =>
      deps.authError(isExpiredRelayJwtError(error) ? "token_expired" : "invalid_token"),
    ),
  );
  if (input.requiredScope && !claims.scope.includes(input.requiredScope)) {
    return yield* deps.authError("invalid_token");
  }
  const user = yield* findUserById(deps.db.sql, claims.sub).pipe(
    Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }),
  );
  if (!user) {
    return yield* deps.authError("invalid_token");
  }
  if (user.disabled !== 0) {
    return yield* deps.authError("account_disabled");
  }
  const proof = yield* verifyRelayClientDpopProof({
    proof: input.dpopHeader,
    method: input.method,
    url: input.url,
    nowEpochSeconds: nowEpoch,
    expectedThumbprint: claims.cnf.jkt,
    expectedAccessToken: token,
  });
  if (!proof.ok) {
    return yield* deps.authError("invalid_dpop", "invalid_proof");
  }
  const acceptedJti = yield* deps.db
    .consumeProofJti({
      scope: "dpop:request",
      jti: `${proof.thumbprint}:${proof.jti}`,
      expiresAtIso: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      nowIso: DateTime.formatIso(now),
    })
    .pipe(Effect.catchTags({ SqlError: () => Effect.fail(deps.internalError()) }));
  if (!acceptedJti) {
    return yield* deps.authError("invalid_dpop", "invalid_proof");
  }
  return {
    userId: user.user_id,
    username: user.username,
    role: user.role,
    token,
    proofKeyThumbprint: claims.cnf.jkt,
    dpopScopes: claims.scope,
  } satisfies AuthenticatedDpopClient;
});
