import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { ServerCheckForUpdateError, type ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import * as ServerReleaseMonitor from "./serverReleaseMonitor.ts";

const isServerCheckForUpdateError = Schema.is(ServerCheckForUpdateError);

function makeManifest(version: string, notes = "Bug fixes") {
  return {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    publishedAt: "2026-11-27T00:00:00.000Z",
    notes,
    androidVersionCode: 1_000_000,
    desktop: {},
    cli: {
      "linux-x64": {
        fileName: `t3-${version}-linux-x64.tar.gz`,
        sha256: "a".repeat(64),
        size: 1024,
      },
    },
    android: {},
  };
}

const makeHarness = Effect.fn("test.make_server_release_monitor_harness")(function* (options: {
  readonly mode?: "web" | "desktop";
  readonly launcherManaged?: boolean;
  readonly policy?: ManagedPolicyDocument;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userMirrorUrl?: string | null;
  readonly monitorOptions?: ServerReleaseMonitor.ServerReleaseMonitorOptions;
  readonly handler: (requestUrl: string) => Response;
}) {
  const baseConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-release-monitor-test-" })),
  );
  const configLayer = ServerConfig.layer({
    ...baseConfig,
    mode: options.mode ?? "web",
  });
  const requests: string[] = [];
  const httpClient = HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, options.handler(request.url)));
  });

  const monitor = yield* ServerReleaseMonitor.make({
    currentVersion: "1.0.0",
    isDevBuild: false,
    ...options.monitorOptions,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        configLayer,
        ManagedPolicy.layerTest(options.policy),
        Layer.succeed(ServiceLauncherClient.ServiceLauncherClient, {
          managed: options.launcherManaged ?? true,
          protocol: 4,
          requestUpdate: () => Effect.succeed("id"),
          prepareTrial: () => Effect.undefined,
        }),
        ServerSettings.layerTest(
          options.userMirrorUrl === undefined ? {} : { updateMirrorUrl: options.userMirrorUrl },
        ),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(HostProcess.Environment, options.env ?? {}),
      ),
    ),
  );

  return { monitor, requests };
});

it.layer(NodeServices.layer)("ServerReleaseMonitor", (it) => {
  it.effect(
    "checks release-manifest.json and reports available updates with sanitized releaseUrl",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-27T12:00:00.000Z"));
        const { monitor, requests } = yield* makeHarness({
          monitorOptions: { isDevBuild: true },
          handler: () => Response.json(makeManifest("1.2.0", "Faster indexing")),
        });

        const subscribed = yield* monitor.subscribeChanges;
        const eventsFiber = yield* Stream.take(subscribed, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        const state = yield* monitor.checkNow();
        const events = yield* Fiber.join(eventsFiber);

        assert.deepStrictEqual(requests, [
          "https://github.com/redwolf2019/AgentVela/releases/latest/download/release-manifest.json",
        ]);
        assert.equal(state.status, "available");
        assert.equal(state.enabled, false);
        assert.equal(state.latestVersion, "1.2.0");
        assert.equal(state.releaseNotes, "Faster indexing");
        assert.equal(
          state.releaseUrl,
          "https://github.com/redwolf2019/AgentVela/releases/tag/v1.2.0",
        );
        assert.equal(state.canSelfUpdate, true);
        assert.equal(state.checkedAt, "2026-11-27T12:00:00.000Z");
        assert.equal(events[0]?.status, "checking");
        assert.equal(events[1]?.status, "available");
      }),
  );

  it.effect("reports up-to-date when current version matches latest release", () =>
    Effect.gen(function* () {
      const { monitor } = yield* makeHarness({
        monitorOptions: { currentVersion: "1.2.0", isDevBuild: true },
        launcherManaged: false,
        handler: () => Response.json(makeManifest("1.2.0")),
      });

      const state = yield* monitor.checkNow();
      assert.equal(state.status, "up-to-date");
      assert.equal(state.latestVersion, "1.2.0");
      assert.equal(state.canSelfUpdate, false);
    }),
  );

  it.effect("applies mirror precedence policy > env > user setting and falls back on 404", () =>
    Effect.gen(function* () {
      const envAndUser = yield* makeHarness({
        env: { T3CODE_RELEASE_BASE_URL: "https://env.example.com/releases?token=secret" },
        userMirrorUrl: "https://user.example.com/releases",
        monitorOptions: { isDevBuild: true },
        handler: (url) =>
          new URL(url).pathname.endsWith("/latest/download/release-manifest.json")
            ? new Response("", { status: 404 })
            : Response.json(makeManifest("1.3.0")),
      });

      const stateFromEnv = yield* envAndUser.monitor.checkNow();
      assert.deepStrictEqual(envAndUser.requests, [
        "https://env.example.com/releases/latest/download/release-manifest.json?token=secret",
        "https://env.example.com/releases/release-manifest.json?token=secret",
      ]);
      // Tokenized mirror URLs must not expose query credentials in releaseUrl.
      assert.equal(stateFromEnv.releaseUrl, "https://github.com/redwolf2019/AgentVela/releases");

      const policyWins = yield* makeHarness({
        policy: {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: { updates: { mode: "auto", feedUrl: "https://policy.example.com/mirror" } },
        },
        env: { T3CODE_RELEASE_BASE_URL: "https://env.example.com/releases" },
        userMirrorUrl: "https://user.example.com/releases",
        monitorOptions: { isDevBuild: true },
        handler: () => Response.json(makeManifest("1.4.0")),
      });
      yield* policyWins.monitor.checkNow();
      assert.deepStrictEqual(policyWins.requests, [
        "https://policy.example.com/mirror/latest/download/release-manifest.json",
      ]);
    }),
  );

  it.effect(
    "fails closed on invalid mirror URL or managed policy mode off without network calls",
    () =>
      Effect.gen(function* () {
        const policyOff = yield* makeHarness({
          policy: {
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { updates: { mode: "off" } },
          },
          handler: () => new Response("unexpected"),
        });
        const policyErr = yield* policyOff.monitor.checkNow().pipe(Effect.flip);
        expect(isServerCheckForUpdateError(policyErr)).toBe(true);
        assert.equal(policyErr.reason, "Example Corp manages T3 Code updates.");
        assert.deepStrictEqual(policyOff.requests, []);

        const disabledEnv = yield* makeHarness({
          env: { T3CODE_RELEASE_BASE_URL: "off" },
          handler: () => new Response("unexpected"),
        });
        const disabledErr = yield* disabledEnv.monitor.checkNow().pipe(Effect.flip);
        assert.include(disabledErr.reason, "turned off");
        assert.deepStrictEqual(disabledEnv.requests, []);

        const invalidEnv = yield* makeHarness({
          env: { T3CODE_RELEASE_BASE_URL: "http://insecure.example.com/releases" },
          handler: () => new Response("unexpected"),
        });
        const invalidErr = yield* invalidEnv.monitor.checkNow().pipe(Effect.flip);
        assert.include(invalidErr.reason, "invalid");
        assert.deepStrictEqual(invalidEnv.requests, []);
      }),
  );

  it.effect("redacts mirror query secrets from check error messages", () =>
    Effect.gen(function* () {
      const { monitor } = yield* makeHarness({
        env: { T3CODE_RELEASE_BASE_URL: "https://cdn.example.com/releases?token=topsecret" },
        monitorOptions: { isDevBuild: true },
        handler: () => new Response("forbidden", { status: 503 }),
      });

      const error = yield* monitor.checkNow().pipe(Effect.flip);
      assert.notInclude(error.reason, "topsecret");
      assert.include(error.reason, "cdn.example.com");
      const state = yield* monitor.getState;
      assert.equal(state.status, "error");
      assert.equal(state.errorMessage, error.reason);
      assert.isTrue(Number.isFinite(Date.parse(state.checkedAt!)));
    }),
  );

  it.effect(
    "disables background polling in desktop mode or when T3CODE_DISABLE_AUTO_UPDATE=1",
    () =>
      Effect.gen(function* () {
        const desktop = yield* makeHarness({
          mode: "desktop",
          handler: () => Response.json(makeManifest("1.2.0")),
        });
        const envDisabled = yield* makeHarness({
          env: { T3CODE_DISABLE_AUTO_UPDATE: "1" },
          handler: () => Response.json(makeManifest("1.2.0")),
        });

        yield* TestClock.adjust("15 seconds");
        assert.deepStrictEqual(desktop.requests, []);
        assert.deepStrictEqual(envDisabled.requests, []);
        assert.equal((yield* desktop.monitor.getState).enabled, false);
        assert.equal((yield* envDisabled.monitor.getState).enabled, false);
      }),
  );

  it.effect("runs startup check after 15 seconds and polls again every 4 hours when enabled", () =>
    Effect.gen(function* () {
      const { monitor, requests } = yield* makeHarness({
        handler: () => Response.json(makeManifest("1.5.0")),
      });
      assert.equal((yield* monitor.getState).enabled, true);
      assert.equal(requests.length, 0);

      yield* TestClock.adjust("15 seconds");
      assert.equal(requests.length, 1);
      assert.equal((yield* monitor.getState).latestVersion, "1.5.0");

      yield* TestClock.adjust("4 hours");
      assert.equal(requests.length, 2);
    }),
  );
});
