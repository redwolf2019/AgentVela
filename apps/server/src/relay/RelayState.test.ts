import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  RelayEndpointKey,
  RelayUserId,
  RelayUsername,
  type AgentVelaRelayEndpoint,
} from "@t3tools/contracts/agentVelaRelay";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Jwk from "effect/jose/Jwk";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as RelayState from "./RelayState.ts";

const layerTest = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-state-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const decoder = new TextDecoder();

const generateEd25519SpkiPem = Effect.gen(function* () {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const key = yield* Jwk.importPublic(pair.publicKey, "EdDSA");
  return yield* Jwk.exportSpki(key, { format: "pem" });
});

const makeEndpoint = (base: string, key = "0123456789abcdef"): AgentVelaRelayEndpoint => {
  const wsBase = base.replace(/^http/i, "ws");
  return {
    endpointKey: RelayEndpointKey.make(key),
    pathPrefix: TrimmedNonEmptyString.make(`/e/${key}`),
    httpBaseUrl: TrimmedNonEmptyString.make(`${base}/e/${key}`),
    wsBaseUrl: TrimmedNonEmptyString.make(`${wsBase}/e/${key}`),
  };
};

it.layer(layerTest)("RelayState", (it) => {
  it.effect("persists, reads, syncs legacy broker keys safely, and clears relay config", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const mintPem = yield* generateEd25519SpkiPem;
      const relayUrl = "https://relay.example.com";
      const userId = RelayUserId.make("user_01");

      const saved = yield* RelayState.saveRelayLinkConfig({
        relayUrl: `${relayUrl}/`,
        relayIssuer: `${relayUrl}/`,
        userId,
        endpoint: makeEndpoint(relayUrl),
        environmentCredential: "avr_env_secret_1",
        relayMintPublicKey: mintPem,
      });

      assert.strictEqual(saved.relayUrl, relayUrl);
      assert.strictEqual(saved.relayIssuer, relayUrl);

      const loaded = yield* RelayState.readRelayLinkConfig();
      assert.isTrue(Option.isSome(loaded));
      if (Option.isSome(loaded)) {
        assert.strictEqual(loaded.value.userId, userId);
        assert.strictEqual(loaded.value.endpoint.httpBaseUrl, `${relayUrl}/e/0123456789abcdef`);
      }

      // Synced secrets for CloudLink health/mint and RelayDeliveryProof must exist.
      const [mintKey, issuer, url, linkedUser] = yield* Effect.all([
        secrets.get(CLOUD_MINT_PUBLIC_KEY),
        secrets.get(RELAY_ISSUER_SECRET),
        secrets.get(RELAY_URL_SECRET),
        secrets.get(CLOUD_LINKED_USER_ID),
      ]);
      assert.strictEqual(decoder.decode(Option.getOrThrow(mintKey)), mintPem.trim());
      assert.strictEqual(decoder.decode(Option.getOrThrow(issuer)), relayUrl);
      assert.strictEqual(decoder.decode(Option.getOrThrow(url)), relayUrl);
      assert.strictEqual(decoder.decode(Option.getOrThrow(linkedUser)), userId);

      // Legacy AgentAwarenessRelay / cloudflared secrets must NOT be set.
      assert.isTrue(Option.isNone(yield* secrets.get("cloud-relay-environment-credential")));
      assert.isTrue(Option.isNone(yield* secrets.get("cloud-publish-agent-activity")));
      assert.isTrue(Option.isNone(yield* secrets.get("cloud-endpoint-runtime-config")));

      yield* RelayState.clearRelayLinkConfig();
      assert.isTrue(Option.isNone(yield* RelayState.readRelayLinkConfig()));
      assert.isTrue(Option.isNone(yield* secrets.get(CLOUD_MINT_PUBLIC_KEY)));
      assert.isTrue(Option.isNone(yield* secrets.get(RELAY_URL_SECRET)));
      assert.isTrue(Option.isNone(yield* secrets.get(CLOUD_LINKED_USER_ID)));
    }),
  );

  it.effect(
    "allows https and private/loopback/tailscale http URLs while rejecting public http",
    () =>
      Effect.gen(function* () {
        const mintPem = yield* generateEd25519SpkiPem;
        const userId = RelayUserId.make("user_02");
        for (const allowed of [
          "http://127.0.0.1:4310",
          "http://192.168.1.50:4310",
          "http://100.64.0.10:4310",
        ]) {
          const res = yield* RelayState.saveRelayLinkConfig({
            relayUrl: allowed,
            relayIssuer: allowed,
            userId,
            endpoint: makeEndpoint(allowed),
            environmentCredential: "avr_env_secret_2",
            relayMintPublicKey: mintPem,
          });
          assert.strictEqual(res.relayUrl, allowed);
        }

        const rejected = yield* RelayState.saveRelayLinkConfig({
          relayUrl: "http://relay.example.com",
          relayIssuer: "http://relay.example.com",
          userId,
          endpoint: makeEndpoint("http://relay.example.com"),
          environmentCredential: "avr_env_secret_3",
          relayMintPublicKey: mintPem,
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(rejected));
      }),
  );

  it.effect("rejects invalid or non-Ed25519 mint public keys", () =>
    Effect.gen(function* () {
      const bad = yield* RelayState.saveRelayLinkConfig({
        relayUrl: "https://relay.example.com",
        relayIssuer: "https://relay.example.com",
        userId: RelayUserId.make("user_03"),
        endpoint: makeEndpoint("https://relay.example.com"),
        environmentCredential: "avr_env_secret_4",
        relayMintPublicKey: "not-a-valid-pem",
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(bad));
    }),
  );

  it.effect("persists and clears CLI user session", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const iso = DateTime.formatIso(now);
      yield* RelayState.saveRelayCliSession({
        relayUrl: TrimmedNonEmptyString.make("https://relay.example.com/"),
        userId: RelayUserId.make("user_04"),
        username: RelayUsername.make("alice"),
        role: "admin",
        accessToken: TrimmedNonEmptyString.make("access_1"),
        accessTokenExpiresAt: IsoDateTime.make(
          DateTime.formatIso(DateTime.add(now, { minutes: 10 })),
        ),
        refreshToken: TrimmedNonEmptyString.make("refresh_1"),
        refreshTokenExpiresAt: IsoDateTime.make(DateTime.formatIso(DateTime.add(now, { days: 7 }))),
      });
      const loaded = yield* RelayState.readRelayCliSession();
      assert.isTrue(Option.isSome(loaded));
      if (Option.isSome(loaded)) {
        assert.strictEqual(loaded.value.relayUrl, "https://relay.example.com");
        assert.strictEqual(loaded.value.username, "alice");
        assert.strictEqual(loaded.value.role, "admin");
      }
      assert.isString(iso);
      yield* RelayState.clearRelayCliSession();
      assert.isTrue(Option.isNone(yield* RelayState.readRelayCliSession()));
    }),
  );
});
