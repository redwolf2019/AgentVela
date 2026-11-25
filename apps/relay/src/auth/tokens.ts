import {
  AgentVelaRelayDpopScope,
  RelayUserId,
  RelayUserRole,
  RelayUsername,
} from "@t3tools/contracts/agentVelaRelay";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import {
  normalizeRelayIssuer,
  RelayJwtError,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Signature from "effect/crypto/Signature";

export const RELAY_ACCESS_TOKEN_TYP = "agentvela-access+jwt" as const;
export const RELAY_DPOP_TOKEN_TYP = "agentvela-dpop+jwt" as const;

export const RelayAccessTokenClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: RelayUserId,
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  username: RelayUsername,
  role: RelayUserRole,
});
export type RelayAccessTokenClaims = typeof RelayAccessTokenClaims.Type;

export const RelayDpopTokenClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: RelayUserId,
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  username: RelayUsername,
  role: RelayUserRole,
  cnf: Schema.Struct({
    jkt: Schema.String,
  }),
  scope: Schema.Array(AgentVelaRelayDpopScope),
});
export type RelayDpopTokenClaims = typeof RelayDpopTokenClaims.Type;

export function isExpiredRelayJwtError(error: RelayJwtError): boolean {
  const diagnostic = RelayJwtError.diagnosticCode(error);
  return diagnostic.includes("Expired") || diagnostic.includes("exp");
}

export const signRelayAccessToken = Effect.fn("AuthTokens.signAccessToken")(function* (input: {
  readonly signature: Signature.Signature["Service"];
  readonly privateKeyPem: string;
  readonly issuer: string;
  readonly userId: RelayUserId;
  readonly username: RelayUsername;
  readonly role: RelayUserRole;
  readonly jti: string;
  readonly nowEpochSeconds: number;
  readonly ttlSeconds: number;
}) {
  const issuer = normalizeRelayIssuer(input.issuer);
  const claims: RelayAccessTokenClaims = {
    iss: issuer,
    aud: issuer,
    sub: input.userId,
    jti: input.jti,
    iat: input.nowEpochSeconds,
    exp: input.nowEpochSeconds + input.ttlSeconds,
    username: input.username,
    role: input.role,
  };
  return yield* signRelayJwt({
    typ: RELAY_ACCESS_TOKEN_TYP,
    payload: claims,
    privateKey: input.privateKeyPem,
  }).pipe(Effect.provideService(Signature.Signature, input.signature));
});

export const verifyRelayAccessToken = Effect.fn("AuthTokens.verifyAccessToken")(function* (input: {
  readonly signature: Signature.Signature["Service"];
  readonly token: string;
  readonly publicKeyPem: string;
  readonly issuer: string;
  readonly ttlSeconds: number;
}) {
  const issuer = normalizeRelayIssuer(input.issuer);
  return yield* verifyRelayJwt(RelayAccessTokenClaims, {
    token: input.token,
    typ: RELAY_ACCESS_TOKEN_TYP,
    issuer,
    audience: issuer,
    publicKey: input.publicKeyPem,
    maxTokenAge: Duration.seconds(input.ttlSeconds + 60),
  }).pipe(Effect.provideService(Signature.Signature, input.signature));
});

export const signRelayDpopToken = Effect.fn("AuthTokens.signDpopToken")(function* (input: {
  readonly signature: Signature.Signature["Service"];
  readonly privateKeyPem: string;
  readonly issuer: string;
  readonly userId: RelayUserId;
  readonly username: RelayUsername;
  readonly role: RelayUserRole;
  readonly jti: string;
  readonly proofKeyThumbprint: string;
  readonly scopes: ReadonlyArray<AgentVelaRelayDpopScope>;
  readonly nowEpochSeconds: number;
  readonly ttlSeconds: number;
}) {
  const issuer = normalizeRelayIssuer(input.issuer);
  const claims: RelayDpopTokenClaims = {
    iss: issuer,
    aud: issuer,
    sub: input.userId,
    jti: input.jti,
    iat: input.nowEpochSeconds,
    exp: input.nowEpochSeconds + input.ttlSeconds,
    username: input.username,
    role: input.role,
    cnf: { jkt: input.proofKeyThumbprint },
    scope: [...input.scopes],
  };
  return yield* signRelayJwt({
    typ: RELAY_DPOP_TOKEN_TYP,
    payload: claims,
    privateKey: input.privateKeyPem,
  }).pipe(Effect.provideService(Signature.Signature, input.signature));
});

export const verifyRelayDpopToken = Effect.fn("AuthTokens.verifyDpopToken")(function* (input: {
  readonly signature: Signature.Signature["Service"];
  readonly token: string;
  readonly publicKeyPem: string;
  readonly issuer: string;
  readonly ttlSeconds: number;
}) {
  const issuer = normalizeRelayIssuer(input.issuer);
  return yield* verifyRelayJwt(RelayDpopTokenClaims, {
    token: input.token,
    typ: RELAY_DPOP_TOKEN_TYP,
    issuer,
    audience: issuer,
    publicKey: input.publicKeyPem,
    maxTokenAge: Duration.seconds(input.ttlSeconds + 60),
  }).pipe(Effect.provideService(Signature.Signature, input.signature));
});

export const verifyRelayClientDpopProof = Effect.fn("AuthTokens.verifyClientDpopProof")(
  function* (input: {
    readonly proof: string;
    readonly method: string;
    readonly url: string;
    readonly nowEpochSeconds: number;
    readonly expectedThumbprint?: string;
    readonly expectedAccessToken?: string;
  }) {
    return yield* Effect.sync(() =>
      verifyDpopProof({
        proof: input.proof,
        method: input.method,
        url: input.url,
        nowEpochSeconds: input.nowEpochSeconds,
        ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
        ...(input.expectedAccessToken ? { expectedAccessToken: input.expectedAccessToken } : {}),
      }),
    );
  },
);
