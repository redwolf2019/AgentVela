// @effect-diagnostics nodeBuiltinImport:off -- Auth tests sign P-256 DPoP proofs via node:crypto.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AgentVelaRelayConnectScope,
  AgentVelaRelayStatusScope,
} from "@t3tools/contracts/agentVelaRelay";
import { computeDpopAccessTokenHash, type DpopPublicJwk } from "@t3tools/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { AuthService, layerRelayAuth } from "./AuthService.ts";
import {
  layerRelayConfigFromValues,
  RELAY_SERVICE_VERSION,
  type ResolvedRelayConfig,
} from "../config.ts";
import { layerRelaySqliteLive } from "../persistence/database.ts";

function makeTestConfig(overrides?: Partial<ResolvedRelayConfig["auth"]>): ResolvedRelayConfig {
  return {
    bind: { host: "127.0.0.1", port: 8787 },
    publicUrl: "https://relay.example.com",
    dataDir: ":memory:",
    sqlitePath: ":memory:",
    serveWebUi: false,
    trustProxy: false,
    auth: {
      allowPublicRegistration: false,
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
      enrollmentTokenTtlMinutes: 15,
      deviceCodeTtlMinutes: 10,
      ...overrides,
    },
    tunnel: {
      maxFrameBytes: 262_144,
      heartbeatIntervalMs: 20_000,
      heartbeatTimeoutMs: 60_000,
      compression: true,
      initialStreamWindowBytes: 524_288,
      proxyTimeoutMs: 30_000,
    },
    rateLimit: {
      loginMaxAttempts: 10,
      loginWindowSeconds: 60,
      dpopMaxAttempts: 60,
      proxyMaxRequests: 600,
    },
    version: RELAY_SERVICE_VERSION,
  };
}

function makeAuthLayer(config = makeTestConfig()) {
  const cfgLayer = layerRelayConfigFromValues(config);
  const dbLayer = layerRelaySqliteLive.pipe(Layer.provideMerge(cfgLayer));
  return layerRelayAuth.pipe(
    Layer.provideMerge(dbLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCryptoLayer.layer),
  );
}

function signTestDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly jti: string;
  readonly iat: number;
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk;
  readonly accessToken?: string;
}): string {
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti,
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const sig = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

describe("AuthService", () => {
  it.effect(
    "bootstraps admin, enforces closed registration and invites, and rotates refresh tokens",
    () =>
      Effect.gen(function* () {
        const auth = yield* AuthService;
        expect(yield* auth.getConfig()).toEqual({
          initialized: false,
          registrationOpen: false,
          version: RELAY_SERVICE_VERSION,
        });

        const uninitRegErr = yield* Effect.flip(
          auth.register({ username: "alice", password: "strong-password-123" }),
        );
        expect(uninitRegErr.reason).toBe("registration_closed");

        const weakErr = yield* Effect.flip(
          auth.bootstrapAdmin({ username: "admin", password: "change-me-to-a-long-secret" }),
        );
        expect(weakErr.reason).toBe("password_too_weak");

        const admin = yield* auth.bootstrapAdmin({
          username: "admin",
          password: "super-strong-admin-passphrase",
        });
        expect(admin.role).toBe("admin");
        expect((yield* auth.getConfig()).initialized).toBe(true);

        const dupErr = yield* Effect.flip(
          auth.bootstrapAdmin({
            username: "admin2",
            password: "another-strong-passphrase",
          }),
        );
        expect(dupErr.reason).toBe("already_initialized");

        const closedErr = yield* Effect.flip(
          auth.register({ username: "alice", password: "strong-password-123" }),
        );
        expect(closedErr.reason).toBe("registration_closed");

        const invite = yield* auth.createInvite({
          createdByUserId: admin.userId,
          request: { role: "member", maxUses: 1, ttlHours: 1 },
        });

        const aliceSession = yield* auth.register({
          username: "alice",
          password: "alice-strong-passphrase-1",
          inviteCode: invite.code,
        });
        expect(aliceSession.user.username).toBe("alice");
        expect(aliceSession.user.role).toBe("member");

        const reusedInviteErr = yield* Effect.flip(
          auth.register({
            username: "bob",
            password: "bob-strong-passphrase-1",
            inviteCode: invite.code,
          }),
        );
        expect(reusedInviteErr.reason).toBe("invite_invalid");

        const rotated = yield* auth.refresh({ refreshToken: aliceSession.refreshToken });
        expect(rotated.refreshToken).not.toBe(aliceSession.refreshToken);

        const replayErr = yield* Effect.flip(
          auth.refresh({ refreshToken: aliceSession.refreshToken }),
        );
        expect(replayErr.reason).toBe("invalid_token");

        yield* auth.logout({ userId: rotated.user.userId, refreshToken: rotated.refreshToken });
        const loggedOutErr = yield* Effect.flip(
          auth.refresh({ refreshToken: rotated.refreshToken }),
        );
        expect(loggedOutErr.reason).toBe("invalid_token");
      }).pipe(Effect.provide(makeAuthLayer())),
  );

  it.effect("protects last active admin and revokes sessions when disabling users", () =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      const admin = yield* auth.bootstrapAdmin({
        username: "rootadmin",
        password: "root-admin-secret-phrase",
      });
      const lastAdminErr = yield* Effect.flip(
        auth.updateUser({ userId: admin.userId, patch: { disabled: true } }),
      );
      expect(lastAdminErr._tag).toBe("RelayBadRequestError");
      if (lastAdminErr._tag === "RelayBadRequestError") {
        expect(lastAdminErr.reason).toBe("invalid_input");
      }

      const member = yield* auth.createUser({
        username: "member1",
        password: "member-one-passphrase",
        role: "member",
      });
      const session = yield* auth.login({
        username: "member1",
        password: "member-one-passphrase",
      });
      const verified = yield* auth.authenticateBearerToken(session.accessToken);
      expect(verified.userId).toBe(member.userId);

      yield* auth.updateUser({ userId: member.userId, patch: { disabled: true } });
      const disabledErr = yield* Effect.flip(auth.authenticateBearerToken(session.accessToken));
      expect(disabledErr.reason).toBe("account_disabled");
    }).pipe(Effect.provide(makeAuthLayer())),
  );

  it.effect("completes CLI device-code auth once and rejects consumed or expired codes", () =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      const admin = yield* auth.bootstrapAdmin({
        username: "admin",
        password: "device-auth-admin-passphrase",
      });

      const started = yield* auth.startDeviceAuth({ deviceLabel: "macbook-cli" });
      expect(yield* auth.pollDeviceAuth({ deviceCode: started.deviceCode })).toEqual({
        status: "pending",
      });

      yield* auth.approveDeviceAuth({ userId: admin.userId, userCode: started.userCode });
      const polled = yield* auth.pollDeviceAuth({ deviceCode: started.deviceCode });
      expect(polled.status).toBe("approved");

      const replayPollErr = yield* Effect.flip(
        auth.pollDeviceAuth({ deviceCode: started.deviceCode }),
      );
      expect(replayPollErr._tag).toBe("RelayNotFoundError");

      const expiring = yield* auth.startDeviceAuth({});
      yield* TestClock.adjust("15 minutes");
      const expired = yield* auth.pollDeviceAuth({ deviceCode: expiring.deviceCode });
      expect(expired).toEqual({ status: "expired" });
    }).pipe(Effect.provide(makeAuthLayer())),
  );

  it.effect("mints and verifies DPoP tokens while blocking proof replay and scope mismatch", () =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      yield* auth.bootstrapAdmin({
        username: "admin",
        password: "dpop-admin-secret-passphrase",
      });
      const session = yield* auth.login({
        username: "admin",
        password: "dpop-admin-secret-passphrase",
      });
      const principal = yield* auth.authenticateBearerToken(session.accessToken);

      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
        namedCurve: "P-256",
      });
      const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
      const nowEpoch = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);

      const exchangeProof = signTestDpopProof({
        method: "POST",
        url: "https://relay.example.com/v1/auth/dpop-token",
        jti: "exch-1",
        iat: nowEpoch,
        privateKey,
        publicJwk,
      });

      const dpop = yield* auth.exchangeDpopToken({
        principal,
        dpopProof: exchangeProof,
        requestUrl: "https://relay.example.com/v1/auth/dpop-token",
        scopes: [AgentVelaRelayConnectScope],
      });

      const connectProof = signTestDpopProof({
        method: "POST",
        url: "https://relay.example.com/v1/environments/env-1/connect",
        jti: "req-1",
        iat: nowEpoch,
        privateKey,
        publicJwk,
        accessToken: dpop.accessToken,
      });

      const authed = yield* auth.authenticateDpopRequest({
        authorizationHeader: `DPoP ${dpop.accessToken}`,
        dpopHeader: connectProof,
        method: "POST",
        url: "https://relay.example.com/v1/environments/env-1/connect",
        requiredScope: AgentVelaRelayConnectScope,
      });
      expect(authed.userId).toBe(principal.userId);

      const replayErr = yield* Effect.flip(
        auth.authenticateDpopRequest({
          authorizationHeader: `DPoP ${dpop.accessToken}`,
          dpopHeader: connectProof,
          method: "POST",
          url: "https://relay.example.com/v1/environments/env-1/connect",
          requiredScope: AgentVelaRelayConnectScope,
        }),
      );
      expect(replayErr.reason).toBe("invalid_dpop");

      const statusProof = signTestDpopProof({
        method: "POST",
        url: "https://relay.example.com/v1/environments/env-1/status",
        jti: "req-2",
        iat: nowEpoch,
        privateKey,
        publicJwk,
        accessToken: dpop.accessToken,
      });
      const wrongScopeErr = yield* Effect.flip(
        auth.authenticateDpopRequest({
          authorizationHeader: `DPoP ${dpop.accessToken}`,
          dpopHeader: statusProof,
          method: "POST",
          url: "https://relay.example.com/v1/environments/env-1/status",
          requiredScope: AgentVelaRelayStatusScope,
        }),
      );
      expect(wrongScopeErr.reason).toBe("invalid_token");
    }).pipe(Effect.provide(makeAuthLayer())),
  );
});
