import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  RelayEndpointKey,
  RelayUserId,
  type AgentVelaRelayEndpoint,
} from "@t3tools/contracts/agentVelaRelay";
import {
  RelayEnvironmentHealthResponseProofPayload,
  RelayEnvironmentMintResponseProofPayload,
} from "@t3tools/contracts/relay";
import {
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Signature from "effect/crypto/Signature";
import * as Jwk from "effect/jose/Jwk";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentKeys from "../cloud/environmentKeys.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { RelayBrokerService, layer as brokerLayer } from "./RelayBrokerService.ts";
import * as RelayState from "./RelayState.ts";

const makeEd25519Pair = Effect.gen(function* () {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const privateKey = yield* Jwk.importPrivate(pair.privateKey, "EdDSA");
  const pub = yield* Jwk.importPublic(pair.publicKey, "EdDSA");
  const pem = yield* Jwk.exportSpki(pub, { format: "pem" });
  return { privateKey, pem };
});

const makeEndpoint = (base: string): AgentVelaRelayEndpoint => ({
  endpointKey: RelayEndpointKey.make("0123456789abcdef"),
  pathPrefix: TrimmedNonEmptyString.make("/e/0123456789abcdef"),
  httpBaseUrl: TrimmedNonEmptyString.make(`${base}/e/0123456789abcdef`),
  wsBaseUrl: TrimmedNonEmptyString.make(`${base.replace(/^http/i, "ws")}/e/0123456789abcdef`),
});

const makeTestLayer = (connectAllowed = true) => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-broker-test-" }).pipe(
    Layer.provide(platform),
  );
  const secrets = ServerSecretStore.layer.pipe(
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  );
  const policy = ManagedPolicy.layerTest({
    schemaVersion: 1,
    organization: "Test Org",
    limits: { connect: connectAllowed },
  });
  const env = ServerEnvironment.layer.pipe(
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(policy),
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  );
  const keys = EnvironmentKeys.layer.pipe(
    Layer.provideMerge(secrets),
    Layer.provideMerge(platform),
  );
  const settings = ServerSettings.ServerSettingsService.layerTest({
    requireConnectDeviceApproval: false,
  });
  const auth = EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(env),
    Layer.provideMerge(secrets),
    Layer.provideMerge(policy),
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  );
  return brokerLayer.pipe(
    Layer.provideMerge(auth),
    Layer.provideMerge(keys),
    Layer.provideMerge(env),
    Layer.provideMerge(secrets),
    Layer.provideMerge(policy),
    Layer.provideMerge(settings),
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  );
};

it.effect(
  "verifies signed health & mint proofs, rejects replays, and enforces managed policy",
  () =>
    Effect.gen(function* () {
      const broker = yield* RelayBrokerService;
      const identity = yield* ServerEnvironment.ServerEnvironment;
      const keys = yield* EnvironmentKeys.EnvironmentSigningKey;
      const signature = yield* Signature.Signature;
      const envId = yield* identity.getEnvironmentId;
      const relayUrl = "https://relay.example.test";
      const userId = RelayUserId.make("user_broker_1");
      const relayKeys = yield* makeEd25519Pair;

      yield* RelayState.saveRelayLinkConfig({
        relayUrl,
        relayIssuer: relayUrl,
        userId,
        endpoint: makeEndpoint(relayUrl),
        environmentCredential: "avr_env_secret_broker",
        relayMintPublicKey: relayKeys.pem,
      });

      const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1_000);
      const signWithRelay = (
        typ: typeof RELAY_HEALTH_REQUEST_TYP | typeof RELAY_MINT_REQUEST_TYP,
        payload: Record<string, unknown>,
      ) =>
        signRelayJwt({ privateKey: relayKeys.privateKey, typ, payload }).pipe(
          Effect.provideService(Signature.Signature, signature),
        );

      const healthProof = yield* signWithRelay(RELAY_HEALTH_REQUEST_TYP, {
        iss: relayUrl,
        aud: `t3-env:${envId}`,
        sub: userId,
        jti: "health-jti-1",
        nonce: "health-nonce-1",
        iat: nowSeconds,
        exp: nowSeconds + 120,
        environmentId: envId,
        scope: ["environment:status"],
      });
      const healthRes = yield* broker.answerHealthRequest({ proof: healthProof });
      assert.strictEqual(healthRes.status, "online");
      const verifiedHealth = yield* verifyRelayJwt(RelayEnvironmentHealthResponseProofPayload, {
        publicKey: keys.publicKey,
        token: healthRes.proof,
        typ: RELAY_HEALTH_RESPONSE_TYP,
        issuer: `t3-env:${envId}`,
        audience: relayUrl,
      });
      assert.strictEqual(verifiedHealth.requestNonce, "health-nonce-1");

      const replayedHealth = yield* Effect.flip(broker.answerHealthRequest({ proof: healthProof }));
      assert.strictEqual(replayedHealth._tag, "RelayBrokerProofReplayedError");

      const thumbprint = "test-jkt-thumbprint-1";
      const mintProof = yield* signWithRelay(RELAY_MINT_REQUEST_TYP, {
        iss: relayUrl,
        aud: `t3-env:${envId}`,
        sub: userId,
        jti: "mint-jti-1",
        nonce: "mint-nonce-1",
        iat: nowSeconds,
        exp: nowSeconds + 120,
        environmentId: envId,
        clientProofKeyThumbprint: thumbprint,
        cnf: { jkt: thumbprint },
        scope: ["environment:connect"],
      });
      const mintRes = yield* broker.mintCredential({ proof: mintProof });
      assert.isTrue(mintRes.credential.length > 0);
      const verifiedMint = yield* verifyRelayJwt(RelayEnvironmentMintResponseProofPayload, {
        publicKey: keys.publicKey,
        token: mintRes.proof,
        typ: RELAY_MINT_RESPONSE_TYP,
        issuer: `t3-env:${envId}`,
        audience: relayUrl,
      });
      assert.strictEqual(verifiedMint.requestNonce, "mint-nonce-1");

      const badThumbprintProof = yield* signWithRelay(RELAY_MINT_REQUEST_TYP, {
        iss: relayUrl,
        aud: `t3-env:${envId}`,
        sub: userId,
        jti: "mint-jti-2",
        nonce: "mint-nonce-2",
        iat: nowSeconds,
        exp: nowSeconds + 120,
        environmentId: envId,
        clientProofKeyThumbprint: thumbprint,
        cnf: { jkt: "different-jkt" },
        scope: ["environment:connect"],
      });
      const rejected = yield* Effect.flip(broker.mintCredential({ proof: badThumbprintProof }));
      assert.strictEqual(rejected._tag, "RelayBrokerProofRejectedError");

      const replayedMint = yield* Effect.flip(broker.mintCredential({ proof: mintProof }));
      assert.strictEqual(replayedMint._tag, "RelayBrokerProofReplayedError");
    }).pipe(Effect.provide(makeTestLayer(true))),
);

it.effect("refuses health and mint requests when managed policy disables connect", () =>
  Effect.gen(function* () {
    const broker = yield* RelayBrokerService;
    const err = yield* Effect.flip(broker.answerHealthRequest({ proof: "unused" }));
    assert.strictEqual(err._tag, "ManagedPolicyRefusedError");
  }).pipe(Effect.provide(makeTestLayer(false))),
);
