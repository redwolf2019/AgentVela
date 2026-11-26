import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";
import { cleanupLegacyUsageFiles } from "./legacyUsageCleanup.ts";

describe("cleanupLegacyUsageFiles", () => {
  it.effect("removes legacy usage cache files while keeping unrelated files intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;

      const hostIdPath = path.join(config.baseDir, "usage-host-id");
      const ratesPath = path.join(config.stateDir, "usage-model-rates.json");
      const scanV1Path = path.join(config.stateDir, "usage-scan-cache.json");
      const scanV3Path = path.join(config.stateDir, "usage-scan-cache-v3.json");
      const unrelatedPath = path.join(config.stateDir, "keep-me.json");

      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(hostIdPath, "host-id");
      yield* fs.writeFileString(ratesPath, "{}");
      yield* fs.writeFileString(scanV1Path, "{}");
      yield* fs.writeFileString(scanV3Path, "{}");
      yield* fs.writeFileString(unrelatedPath, "ok");

      yield* cleanupLegacyUsageFiles;

      expect(yield* fs.exists(hostIdPath)).toBe(false);
      expect(yield* fs.exists(ratesPath)).toBe(false);
      expect(yield* fs.exists(scanV1Path)).toBe(false);
      expect(yield* fs.exists(scanV3Path)).toBe(false);
      expect(yield* fs.exists(unrelatedPath)).toBe(true);
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "legacy-usage-cleanup-" })),
      Effect.provide(NodeServices.layer),
    ),
  );
});
