import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDesktopSshCliRunner } from "./DesktopSshEnvironment.ts";

const packagedEnvironment = DesktopEnvironment.DesktopEnvironment.pipe(
  Effect.provide(
    DesktopEnvironment.layer({
      dirname: "/Applications/T3 Code.app/Contents/Resources/app.asar/dist-electron",
      homeDirectory: "/Users/alice",
      platform: "darwin",
      processArch: "arm64",
      appVersion: "0.0.22",
      appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
      ),
    ),
  ),
);

describe("resolveDesktopSshCliRunner", () => {
  it.effect("downloads the remote runner from the release mirror", () =>
    Effect.gen(function* () {
      const environment = yield* packagedEnvironment;

      const runner = resolveDesktopSshCliRunner(environment, {
        [CLI_RELEASE_BASE_URL_ENV]: "https://mirror.example.com/t3code",
      });

      assert.deepStrictEqual(runner, {
        archiveVersion: "0.0.22",
        releaseBaseUrl: "https://mirror.example.com/t3code",
      });
    }),
  );

  it.effect("disables remote archive downloads when update policy mode is off", () =>
    Effect.gen(function* () {
      const environment = yield* packagedEnvironment;

      const runner = resolveDesktopSshCliRunner(
        environment,
        {
          [CLI_RELEASE_BASE_URL_ENV]: "https://mirror.example.com/t3code",
        },
        {
          updatePolicy: {
            mode: "off",
            feedUrl: "https://policy.example.com/t3code",
            message: "Managed by Example Corp.",
          },
        },
      );

      assert.deepStrictEqual(runner, {
        archiveVersion: "0.0.22",
        disableArchiveDownload: true,
        archiveDownloadDisabledMessage: "Managed by Example Corp.",
      });
    }),
  );

  it.effect("prefers the managed update feed URL over T3CODE_RELEASE_BASE_URL", () =>
    Effect.gen(function* () {
      const environment = yield* packagedEnvironment;

      const runner = resolveDesktopSshCliRunner(
        environment,
        {
          [CLI_RELEASE_BASE_URL_ENV]: "https://env.example.com/t3code",
        },
        {
          updatePolicy: {
            mode: "auto",
            feedUrl: "https://policy.example.com/t3code",
            message: "Managed by Example Corp.",
          },
        },
      );

      assert.deepStrictEqual(runner, {
        archiveVersion: "0.0.22",
        releaseBaseUrl: "https://policy.example.com/t3code",
      });
    }),
  );

  it.effect("falls back to saved user mirror URL when policy and env are absent", () =>
    Effect.gen(function* () {
      const environment = yield* packagedEnvironment;

      const runner = resolveDesktopSshCliRunner(
        environment,
        {},
        { userMirrorUrl: "https://user-mirror.example.com/releases" },
      );

      assert.deepStrictEqual(runner, {
        archiveVersion: "0.0.22",
        releaseBaseUrl: "https://user-mirror.example.com/releases",
      });
    }),
  );
});
