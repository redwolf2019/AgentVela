import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";

const LEGACY_USAGE_SCAN_CACHE_PATTERN = /^usage-scan-cache(?:-v\d+)?\.json$/;

const removeFileIfPresent = Effect.fn("legacyUsageCleanup.removeFileIfPresent")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(filePath, { force: true }).pipe(
    Effect.catch((cause) =>
      Effect.logDebug("Ignoring failure while cleaning legacy usage file", {
        filePath,
        cause,
      }),
    ),
  );
});

/** Best-effort removal of retired usage cache and host-id files on startup. */
export const cleanupLegacyUsageFiles = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* removeFileIfPresent(path.join(config.baseDir, "usage-host-id"));
  yield* removeFileIfPresent(path.join(config.stateDir, "usage-model-rates.json"));

  const stateEntries = yield* fs
    .readDirectory(config.stateDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const entry of stateEntries) {
    if (LEGACY_USAGE_SCAN_CACHE_PATTERN.test(entry)) {
      yield* removeFileIfPresent(path.join(config.stateDir, entry));
    }
  }
});
