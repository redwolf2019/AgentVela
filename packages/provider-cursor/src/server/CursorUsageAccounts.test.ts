import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";
import { DEFAULT_CURSOR_API_ENDPOINT } from "./apiKey.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("CursorUsageAccounts", (it) => {
  it.effect("skips instances configured with a custom apiEndpoint or CURSOR_API_ENDPOINT", () =>
    Effect.gen(function* () {
      const readKeys: Array<string> = [];
      const accounts = yield* CursorUsageAccounts.CursorUsageAccounts.pipe(
        Effect.provide(
          CursorUsageAccounts.layer.pipe(
            Layer.provide(
              Layer.succeed(CursorAccountReader.CursorAccountReader, {
                read: (credential) => {
                  readKeys.push(credential.apiKey);
                  return Effect.succeed({
                    accountKey: `acct:${credential.apiKey}`,
                    records: [],
                    missing: false,
                    error: null,
                  });
                },
              }),
            ),
            Layer.provide(TestProviderHost.layer({ runBackgroundWork: false })),
          ),
        ),
      );

      yield* accounts.scan({
        instances: [
          {
            instanceId: ProviderInstanceId.make("cursor-custom-config"),
            config: { apiEndpoint: "https://proxy.example.com" },
            environment: { CURSOR_API_KEY: "key-config-override" },
          },
          {
            instanceId: ProviderInstanceId.make("cursor-custom-env"),
            environment: {
              CURSOR_API_ENDPOINT: "https://env-proxy.example.com/v1",
              CURSOR_API_KEY: "key-env-override",
            },
          },
          {
            instanceId: ProviderInstanceId.make("cursor-default"),
            config: { apiEndpoint: DEFAULT_CURSOR_API_ENDPOINT },
            environment: { CURSOR_API_KEY: "key-default" },
          },
        ],
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: true,
      });

      expect(readKeys).toEqual(["key-default"]);
    }),
  );
});
