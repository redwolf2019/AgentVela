import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import { checkRequestDpopProof } from "./auth/dpop.ts";
import { makeDpopKey } from "./auth/dpop.testkit.ts";
import * as McpOAuth from "./auth/McpOAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { externalRequestUrl, requestUrl, trustedForwardedPrefix } from "./requestUrl.ts";

const layerTest = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-request-url-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

function makeSyntheticRequest(input: {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly remoteAddress?: string;
}): HttpServerRequest.HttpServerRequest {
  const base = HttpServerRequest.fromWeb(
    new Request(input.url, {
      method: input.method ?? "GET",
      headers: input.headers ?? {},
    }),
  );
  if (input.remoteAddress !== undefined && base.source && typeof base.source === "object") {
    Object.defineProperty(base.source, "socket", {
      value: { remoteAddress: input.remoteAddress },
      configurable: true,
    });
  }
  return base;
}

it.layer(layerTest)("requestUrl and externalRequestUrl", (it) => {
  it.effect("honors x-forwarded-host, x-forwarded-proto, and /e/<key> prefix from loopback", () =>
    Effect.sync(() => {
      const req = makeSyntheticRequest({
        url: "http://127.0.0.1:3773/oauth/token?foo=bar",
        headers: {
          host: "127.0.0.1:3773",
          "x-forwarded-host": "relay.example.com",
          "x-forwarded-proto": "https",
          "x-forwarded-prefix": "/e/0123456789abcdef",
        },
        remoteAddress: "::ffff:127.0.0.1",
      });

      const internal = requestUrl(req);
      const external = externalRequestUrl(req);
      assert.strictEqual(Option.getOrThrow(internal).pathname, "/oauth/token");
      assert.strictEqual(
        Option.getOrThrow(external).href,
        "https://relay.example.com/e/0123456789abcdef/oauth/token?foo=bar",
      );
      assert.strictEqual(trustedForwardedPrefix(req), "/e/0123456789abcdef");

      const oauthUrls = McpOAuth.requestUrls(req);
      assert.strictEqual(oauthUrls.issuer, "https://relay.example.com/e/0123456789abcdef");
      assert.strictEqual(oauthUrls.resource, "https://relay.example.com/e/0123456789abcdef/mcp");
    }),
  );

  it.effect("ignores forwarded host/prefix from non-loopback peers and rejects bad prefixes", () =>
    Effect.sync(() => {
      const remoteReq = makeSyntheticRequest({
        url: "http://192.168.1.50:3773/oauth/token",
        headers: {
          host: "192.168.1.50:3773",
          "x-forwarded-host": "evil.example.com",
          "x-forwarded-proto": "https",
          "x-forwarded-prefix": "/e/0123456789abcdef",
        },
        remoteAddress: "203.0.113.10",
      });
      assert.strictEqual(trustedForwardedPrefix(remoteReq), "");
      assert.strictEqual(
        Option.getOrThrow(externalRequestUrl(remoteReq)).href,
        "https://192.168.1.50:3773/oauth/token",
      );

      for (const badPrefix of ["/admin", "/e/ab", "/e/../../etc", "/e/0123456789abcdef/extra"]) {
        const badReq = makeSyntheticRequest({
          url: "http://127.0.0.1:3773/oauth/token",
          headers: {
            "x-forwarded-host": "relay.example.com",
            "x-forwarded-prefix": badPrefix,
          },
          remoteAddress: "127.0.0.1",
        });
        assert.strictEqual(trustedForwardedPrefix(badReq), "");
        assert.strictEqual(Option.getOrThrow(externalRequestUrl(badReq)).pathname, "/oauth/token");
      }
    }),
  );

  it.effect("verifies DPoP htu against path-prefixed external URL (including env-<hex> keys)", () =>
    Effect.gen(function* () {
      const key = makeDpopKey();
      const now = yield* DateTime.now;
      const iat = Math.floor(now.epochMilliseconds / 1_000);
      const accessToken = "dpop-access-token-1";
      const externalUrl = "https://relay.example.com/e/env-0123456789abcdef/oauth/token";
      const proof = key.sign({
        method: "POST",
        url: externalUrl,
        token: accessToken,
        iat,
      });

      const proxiedRequest = makeSyntheticRequest({
        url: "http://127.0.0.1:3773/oauth/token",
        method: "POST",
        headers: {
          host: "relay.example.com",
          "x-forwarded-host": "relay.example.com",
          "x-forwarded-proto": "https",
          "x-forwarded-prefix": "/e/env-0123456789abcdef",
          dpop: proof,
        },
        remoteAddress: "127.0.0.1",
      });

      const checked = yield* checkRequestDpopProof({
        request: proxiedRequest,
        expectedThumbprint: key.thumbprint,
        expectedAccessToken: accessToken,
      });
      assert.strictEqual(checked.thumbprint, key.thumbprint);

      // Mismatched external URL must fail verification.
      const wrongProof = key.sign({
        method: "POST",
        url: "https://relay.example.com/oauth/token",
        token: accessToken,
        iat,
      });
      const mismatched = yield* checkRequestDpopProof({
        request: proxiedRequest,
        proof: wrongProof,
        expectedThumbprint: key.thumbprint,
        expectedAccessToken: accessToken,
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(mismatched));
    }),
  );
});
