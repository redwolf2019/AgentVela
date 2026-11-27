// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopReleaseClient from "./DesktopReleaseClient.ts";
import * as DesktopReleaseInstaller from "./DesktopReleaseInstaller.ts";

function makeTestInstallerLayer(options: {
  readonly appImagePath?: string;
  readonly verified?: boolean;
  readonly ops?: Partial<DesktopReleaseInstaller.DesktopInstallerPlatformOps>;
  readonly events?: string[];
  readonly openPathResult?: string;
}) {
  const events = options.events ?? [];
  const electronApp = Layer.mock(ElectronApp.ElectronApp, {
    exit: (code) =>
      Effect.sync(() => {
        events.push(`exit:${code}`);
      }),
    quit: Effect.sync(() => {
      events.push("quit");
    }),
    relaunch: () =>
      Effect.sync(() => {
        events.push("relaunch");
      }),
  });
  const electronShell = Layer.mock(ElectronShell.ElectronShell, {
    openPath: (targetPath) =>
      Effect.sync(() => {
        events.push(`openPath:${targetPath}`);
        return options.openPathResult ?? "";
      }),
  });
  const releaseClient = DesktopReleaseClient.layerTest({
    fetchLatestManifest: () => Effect.die("unexpected fetchLatestManifest"),
    downloadAsset: () => Effect.die("unexpected downloadAsset"),
    verifyFileSha256: () => Effect.succeed(options.verified ?? true),
  });
  const mergedOps: DesktopReleaseInstaller.DesktopInstallerPlatformOps = {
    chmodFile: async (filePath, mode) => {
      events.push(`chmod:${mode.toString(8)}:${filePath}`);
    },
    replaceFile: async (src, dst) => {
      events.push(`replace:${src}->${dst}`);
    },
    spawnDetached: async (cmd, args, opts) => {
      events.push(`spawn:${cmd}:${args.join(" ")}:${opts.env?.APPIMAGE_SILENT_INSTALL ?? ""}`);
    },
    runCommand: async (cmd, args) => {
      events.push(`run:${cmd}:${args.join(" ")}`);
      return { code: 0, stderr: "" };
    },
    ...options.ops,
  };

  return Layer.effect(
    DesktopReleaseInstaller.DesktopReleaseInstaller,
    DesktopReleaseInstaller.makeWithOps(mergedOps),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        electronApp,
        electronShell,
        releaseClient,
        DesktopConfig.layerTest(options.appImagePath ? { APPIMAGE: options.appImagePath } : {}),
      ),
    ),
  );
}

describe("DesktopReleaseInstaller", () => {
  it.effect("rejects install if SHA-256 verification fails right before launch", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const installer = yield* DesktopReleaseInstaller.DesktopReleaseInstaller;
      const err = yield* installer
        .installAndRelaunch({
          mode: "dmg",
          filePath: "/tmp/AgentVela.dmg",
          expectedSha256: "a".repeat(64),
          expectedSize: 100,
        })
        .pipe(Effect.flip);

      assert.include(err.reason, "SHA-256 verification");
      assert.deepEqual(events, []);
    }).pipe(Effect.provide(makeTestInstallerLayer({ verified: false, events })));
  });

  it.effect(
    "atomically replaces AppImage, closes inherited FDs, sets APPIMAGE_SILENT_INSTALL, and exits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-appimage-install-" });
          const target = NodePath.join(dir, "AgentVela.AppImage");
          const downloaded = NodePath.join(dir, "AgentVela-0.1.12.AppImage");
          yield* fs.writeFileString(target, "old-appimage");
          yield* fs.writeFileString(downloaded, "new-appimage");

          const events: string[] = [];
          const layer = makeTestInstallerLayer({
            appImagePath: target,
            events,
            ops: {
              chmodFile: DesktopReleaseInstaller.defaultDesktopInstallerPlatformOps.chmodFile,
              replaceFile: DesktopReleaseInstaller.defaultDesktopInstallerPlatformOps.replaceFile,
            },
          });
          const result = yield* Effect.gen(function* () {
            const installer = yield* DesktopReleaseInstaller.DesktopReleaseInstaller;
            return yield* installer.installAndRelaunch({
              mode: "appimage",
              filePath: downloaded,
              expectedSha256: "a".repeat(64),
              expectedSize: 12,
            });
          }).pipe(Effect.provide(layer));

          assert.equal(result.mechanism, "self-update");
          assert.equal(yield* fs.readFileString(target), "new-appimage");
          assert.equal(NodeFS.statSync(target).mode & 0o777, 0o755);
          assert.deepEqual(events, [
            `spawn:bash:-p -c ${DesktopReleaseInstaller.CLOSE_INHERITED_FDS_THEN_EXEC} bash ${target}:true`,
            "exit:0",
          ]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("installs .deb via pkexec and relaunches", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const installer = yield* DesktopReleaseInstaller.DesktopReleaseInstaller;
      const result = yield* installer.installAndRelaunch({
        mode: "deb",
        filePath: "/tmp/AgentVela-0.1.12.deb",
        expectedSha256: "a".repeat(64),
        expectedSize: 100,
      });
      assert.equal(result.mechanism, "self-update");
      assert.isTrue(events[0]?.startsWith("run:pkexec:"));
      assert.deepEqual(events.slice(1), ["relaunch", "quit"]);
    }).pipe(Effect.provide(makeTestInstallerLayer({ events })));
  });

  it.effect(
    "falls back to shell.openPath for NSIS EACCES elevation and opens macOS dmg as manual-installer",
    () =>
      Effect.gen(function* () {
        const nsisEvents: string[] = [];
        const nsisLayer = makeTestInstallerLayer({
          events: nsisEvents,
          ops: {
            spawnDetached: async () => {
              const err = new Error("access denied") as NodeJS.ErrnoException;
              err.code = "EACCES";
              throw err;
            },
          },
        });
        const nsisResult = yield* Effect.gen(function* () {
          const installer = yield* DesktopReleaseInstaller.DesktopReleaseInstaller;
          return yield* installer.installAndRelaunch({
            mode: "nsis",
            filePath: "C:\\temp\\AgentVela-setup.exe",
            expectedSha256: "a".repeat(64),
            expectedSize: 100,
          });
        }).pipe(Effect.provide(nsisLayer));
        assert.equal(nsisResult.mechanism, "self-update");
        assert.deepEqual(nsisEvents, ["openPath:C:\\temp\\AgentVela-setup.exe", "quit"]);

        const dmgEvents: string[] = [];
        const dmgLayer = makeTestInstallerLayer({ events: dmgEvents });
        const dmgResult = yield* Effect.gen(function* () {
          const installer = yield* DesktopReleaseInstaller.DesktopReleaseInstaller;
          return yield* installer.installAndRelaunch({
            mode: "dmg",
            filePath: "/tmp/AgentVela-0.1.12-arm64.dmg",
            expectedSha256: "a".repeat(64),
            expectedSize: 100,
          });
        }).pipe(Effect.provide(dmgLayer));
        assert.equal(dmgResult.mechanism, "manual-installer");
        assert.deepEqual(dmgEvents, ["openPath:/tmp/AgentVela-0.1.12-arm64.dmg"]);
      }),
  );
});
