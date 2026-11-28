// @effect-diagnostics-next-line nodeBuiltinImport:off -- compute expected SHA-256 digest in test.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import {
  computeAndroidVersionCode,
  parseReleaseManifestJson,
} from "@t3tools/shared/releaseManifest";

import {
  generateReleaseManifest,
  InvalidManifestVersionError,
  ReleaseManifestMissingAssetsError,
} from "./generate-release-manifest.ts";

const ScriptTestLayer = Layer.mergeAll(NodeServices.layer, TestConsole.layer);

const REQUIRED_FILES = [
  "AgentVela-1.2.3-arm64.dmg",
  "AgentVela-1.2.3-x64.exe",
  "AgentVela-1.2.3-darwin-arm64.tar.gz",
  "AgentVela-1.2.3-win32-x64.zip",
  "AgentVela-1.2.3-android-arm64-v8a.apk",
] as const;

const OPTIONAL_LINUX_FILES = [
  "AgentVela-1.2.3-x64.AppImage",
  "AgentVela-1.2.3-linux-x64.tar.gz",
] as const;

it.layer(ScriptTestLayer)("generate-release-manifest", (it) => {
  it.effect("writes validated release-manifest.json and SHA256SUMS for the 5 required assets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gen-manifest-" });

      for (const fileName of REQUIRED_FILES) {
        yield* fs.writeFileString(path.join(dir, fileName), `payload:${fileName}\n`);
      }
      const notesPath = path.join(dir, "notes.md");
      yield* fs.writeFileString(notesPath, "Release notes body.\n");

      const result = yield* generateReleaseManifest({
        dir,
        version: "1.2.3",
        publishedAt: "2026-11-27T00:00:00.000Z",
        notesFile: notesPath,
        requireAll: true,
      });

      assert.equal(result.assetCount, 5);
      assert.equal(result.manifest.androidVersionCode, computeAndroidVersionCode("1.2.3"));
      assert.equal(result.manifest.notes, "Release notes body.");

      const manifestRaw = yield* fs.readFileString(result.outputPath);
      const parsed = parseReleaseManifestJson(manifestRaw);
      assert.isTrue(parsed.ok);
      if (parsed.ok) {
        assert.equal(
          parsed.manifest.desktop["darwin-arm64-dmg"]?.fileName,
          "AgentVela-1.2.3-arm64.dmg",
        );
        assert.equal(
          parsed.manifest.desktop["win32-x64-nsis"]?.fileName,
          "AgentVela-1.2.3-x64.exe",
        );
        assert.equal(parsed.manifest.desktop["linux-x64-appimage"], undefined);
        assert.equal(
          parsed.manifest.cli["darwin-arm64"]?.fileName,
          "AgentVela-1.2.3-darwin-arm64.tar.gz",
        );
        assert.equal(parsed.manifest.cli["win32-x64"]?.fileName, "AgentVela-1.2.3-win32-x64.zip");
        assert.equal(parsed.manifest.cli["linux-x64"], undefined);
        assert.equal(
          parsed.manifest.android["arm64-v8a"]?.fileName,
          "AgentVela-1.2.3-android-arm64-v8a.apk",
        );
      }

      const checksums = yield* fs.readFileString(result.checksumsPath);
      const expectedDigest = NodeCrypto.createHash("sha256")
        .update("payload:AgentVela-1.2.3-arm64.dmg\n")
        .digest("hex");
      assert.include(checksums, `${expectedDigest}  AgentVela-1.2.3-arm64.dmg\n`);
    }),
  );

  it.effect("hashes optional Linux assets when present alongside required assets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gen-manifest-opt-" });

      for (const fileName of [...REQUIRED_FILES, ...OPTIONAL_LINUX_FILES]) {
        yield* fs.writeFileString(path.join(dir, fileName), `payload:${fileName}\n`);
      }

      const result = yield* generateReleaseManifest({
        dir,
        version: "1.2.3",
        requireAll: true,
      });

      assert.equal(result.assetCount, 7);
      assert.equal(
        result.manifest.desktop["linux-x64-appimage"]?.fileName,
        "AgentVela-1.2.3-x64.AppImage",
      );
      assert.equal(result.manifest.cli["linux-x64"]?.fileName, "AgentVela-1.2.3-linux-x64.tar.gz");
    }),
  );

  it.effect("fails with missing required asset list and ignores absent optional Linux assets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gen-manifest-missing-" });
      yield* fs.writeFileString(`${dir}/AgentVela-1.2.3-arm64.dmg`, "dmg");

      const error = yield* Effect.flip(
        generateReleaseManifest({ dir, version: "1.2.3", requireAll: true }),
      );
      assert.instanceOf(error, ReleaseManifestMissingAssetsError);
      assert.include(error.message, "desktop.win32-x64-nsis");
      assert.include(error.message, "cli.darwin-arm64");
      assert.include(error.message, "cli.win32-x64");
      assert.include(error.message, "android.arm64-v8a");
      assert.notInclude(error.message, "linux-x64");
      assert.notInclude(error.message, "linux-arm64");
    }),
  );

  it.effect("rejects non-stable or v-prefixed versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gen-manifest-ver-" });

      for (const badVersion of ["v1.2.3", "1.2.3-nightly.20261127.1", "latest"]) {
        const error = yield* Effect.flip(generateReleaseManifest({ dir, version: badVersion }));
        assert.instanceOf(error, InvalidManifestVersionError);
      }
    }),
  );
});
