#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- sha256 digests use node:crypto in build scripts.
import * as NodeCrypto from "node:crypto";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import {
  computeAndroidVersionCode,
  isStableReleaseVersion,
  parseReleaseManifest,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  ReleaseManifestSchema,
  type AndroidReleaseAssetKey,
  type CliReleaseAssetKey,
  type DesktopReleaseAssetKey,
  type ReleaseManifest,
  type ReleaseManifestAsset,
} from "@t3tools/shared/releaseManifest";

export class InvalidManifestVersionError extends Schema.TaggedError<InvalidManifestVersionError>()(
  "InvalidManifestVersionError",
  { version: Schema.String },
) {
  override get message(): string {
    return `Release version '${this.version}' must be canonical stable semver (X.Y.Z).`;
  }
}

export class ReleaseManifestMissingAssetsError extends Schema.TaggedError<ReleaseManifestMissingAssetsError>()(
  "ReleaseManifestMissingAssetsError",
  { missing: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Missing required release assets: ${this.missing.join(", ")}`;
  }
}

export class ReleaseManifestValidationError extends Schema.TaggedError<ReleaseManifestValidationError>()(
  "ReleaseManifestValidationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Generated release manifest failed validation: ${this.reason}`;
  }
}

const encodeReleaseManifestJson = Schema.encodeEffect(fromJsonStringPretty(ReleaseManifestSchema));

const REQUIRED_DESKTOP_ASSET_KEYS: ReadonlySet<DesktopReleaseAssetKey> = new Set([
  "darwin-arm64-dmg",
  "linux-x64-appimage",
  "linux-x64-deb",
  "win32-x64-nsis",
]);

const REQUIRED_CLI_ASSET_KEYS: ReadonlySet<CliReleaseAssetKey> = new Set([
  "darwin-arm64",
  "linux-x64",
  "win32-x64",
]);

const REQUIRED_ANDROID_ASSET_KEYS: ReadonlySet<AndroidReleaseAssetKey> = new Set(["arm64-v8a"]);

function desktopCandidates(version: string): Record<DesktopReleaseAssetKey, ReadonlyArray<string>> {
  return {
    "darwin-arm64-dmg": [`AgentVela-${version}-arm64.dmg`],
    "linux-x64-appimage": [
      `AgentVela-${version}-x86_64.AppImage`,
      `AgentVela-${version}-x64.AppImage`,
    ],
    "linux-x64-deb": [`AgentVela-${version}-amd64.deb`, `AgentVela-${version}-x64.deb`],
    "linux-arm64-appimage": [`AgentVela-${version}-arm64.AppImage`],
    "linux-arm64-deb": [`AgentVela-${version}-arm64.deb`],
    "win32-x64-nsis": [`AgentVela-${version}-x64.exe`],
  };
}

function cliCandidates(version: string): Record<CliReleaseAssetKey, ReadonlyArray<string>> {
  return {
    "darwin-arm64": [`AgentVela-${version}-darwin-arm64.tar.gz`],
    "linux-arm64": [`AgentVela-${version}-linux-arm64.tar.gz`],
    "linux-x64": [`AgentVela-${version}-linux-x64.tar.gz`],
    "win32-x64": [`AgentVela-${version}-win32-x64.zip`],
  };
}

function androidCandidates(version: string): Record<AndroidReleaseAssetKey, ReadonlyArray<string>> {
  return {
    "arm64-v8a": [`AgentVela-${version}-android-arm64-v8a.apk`],
  };
}

const hashAndStatAsset = Effect.fn("generate-release-manifest.hashAndStatAsset")(function* (
  dir: string,
  fileName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(dir, fileName);
  const stat = yield* fs.stat(filePath);
  if (stat.type !== "File") {
    return undefined;
  }
  const hash = NodeCrypto.createHash("sha256");
  yield* fs
    .stream(filePath)
    .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
  return {
    fileName,
    sha256: hash.digest("hex"),
    size: Number(stat.size),
  } satisfies ReleaseManifestAsset;
});

const collectAssetGroup = Effect.fn("generate-release-manifest.collectAssetGroup")(function* <
  K extends string,
>(
  dir: string,
  candidates: Record<K, ReadonlyArray<string>>,
  prefix: string,
  requiredKeys: ReadonlySet<K>,
  missing: string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const result: Partial<Record<K, ReleaseManifestAsset>> = {};
  const found: Array<ReleaseManifestAsset> = [];

  for (const [key, names] of Object.entries(candidates) as Array<[K, ReadonlyArray<string>]>) {
    let matched: ReleaseManifestAsset | undefined;
    for (const candidateName of names) {
      if (yield* fs.exists(path.join(dir, candidateName))) {
        matched = yield* hashAndStatAsset(dir, candidateName);
        if (matched) break;
      }
    }
    if (matched) {
      result[key] = matched;
      found.push(matched);
    } else if (requiredKeys.has(key)) {
      missing.push(`${prefix}.${key} (${names.join(" | ")})`);
    }
  }

  return { assets: result, found } as const;
});

export interface GenerateReleaseManifestInput {
  readonly dir: string;
  readonly version: string;
  readonly tag?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly notesFile?: string | undefined;
  readonly output?: string | undefined;
  readonly checksumsOutput?: string | undefined;
  readonly requireAll?: boolean | undefined;
}

export const generateReleaseManifest = Effect.fn("generate-release-manifest.run")(function* (
  input: GenerateReleaseManifestInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!isStableReleaseVersion(input.version) || input.version.startsWith("v")) {
    return yield* new InvalidManifestVersionError({ version: input.version });
  }

  const resolvedDir = path.resolve(input.dir);
  const missing: string[] = [];

  const [desktopGroup, cliGroup, androidGroup] = yield* Effect.all([
    collectAssetGroup(
      resolvedDir,
      desktopCandidates(input.version),
      "desktop",
      REQUIRED_DESKTOP_ASSET_KEYS,
      missing,
    ),
    collectAssetGroup(
      resolvedDir,
      cliCandidates(input.version),
      "cli",
      REQUIRED_CLI_ASSET_KEYS,
      missing,
    ),
    collectAssetGroup(
      resolvedDir,
      androidCandidates(input.version),
      "android",
      REQUIRED_ANDROID_ASSET_KEYS,
      missing,
    ),
  ]);

  if (input.requireAll && missing.length > 0) {
    return yield* new ReleaseManifestMissingAssetsError({ missing });
  }

  let notes: string | undefined;
  if (input.notesFile) {
    const rawNotes = yield* fs
      .readFileString(path.resolve(input.notesFile))
      .pipe(Effect.orElseSucceed(() => ""));
    const trimmed = rawNotes.trim();
    if (trimmed.length > 0) {
      notes = trimmed;
    }
  }

  const candidate: ReleaseManifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    version: input.version,
    tag: input.tag?.trim() || `v${input.version}`,
    publishedAt: input.publishedAt?.trim() || DateTime.formatIso(yield* DateTime.now),
    ...(notes !== undefined ? { notes } : {}),
    androidVersionCode: computeAndroidVersionCode(input.version),
    desktop: desktopGroup.assets,
    cli: cliGroup.assets,
    android: androidGroup.assets,
  };

  const validated = parseReleaseManifest(candidate);
  if (!validated.ok) {
    return yield* new ReleaseManifestValidationError({ reason: validated.error });
  }

  const outputPath = path.resolve(input.output ?? path.join(resolvedDir, "release-manifest.json"));
  const checksumsPath = path.resolve(input.checksumsOutput ?? path.join(resolvedDir, "SHA256SUMS"));
  const allAssets = [...desktopGroup.found, ...cliGroup.found, ...androidGroup.found].toSorted(
    (left, right) => left.fileName.localeCompare(right.fileName),
  );
  const checksumsBody =
    allAssets.map((asset) => `${asset.sha256}  ${asset.fileName}`).join("\n") +
    (allAssets.length > 0 ? "\n" : "");
  const manifestJson = yield* encodeReleaseManifestJson(validated.manifest).pipe(
    Effect.mapError((cause) => new ReleaseManifestValidationError({ reason: String(cause) })),
  );

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* fs.writeFileString(outputPath, `${manifestJson}\n`);
  yield* fs.makeDirectory(path.dirname(checksumsPath), { recursive: true });
  yield* fs.writeFileString(checksumsPath, checksumsBody);

  return {
    manifest: validated.manifest,
    outputPath,
    checksumsPath,
    assetCount: allAssets.length,
  } as const;
});

export const generateReleaseManifestCommand = Command.make(
  "generate-release-manifest",
  {
    dir: Flag.String("dir").pipe(Flag.withDescription("Directory holding built release assets.")),
    version: Flag.String("version").pipe(Flag.withDescription("Canonical stable version (X.Y.Z).")),
    tag: Flag.String("tag").pipe(Flag.optional, Flag.withDescription("Git release tag (vX.Y.Z).")),
    publishedAt: Flag.String("published-at").pipe(
      Flag.optional,
      Flag.withDescription("ISO-8601 release timestamp."),
    ),
    notesFile: Flag.String("notes-file").pipe(
      Flag.optional,
      Flag.withDescription("Optional markdown release notes path."),
    ),
    output: Flag.String("output").pipe(
      Flag.optional,
      Flag.withDescription("Manifest output file path (defaults to <dir>/release-manifest.json)."),
    ),
    checksumsOutput: Flag.String("checksums-output").pipe(
      Flag.optional,
      Flag.withDescription("SHA256SUMS output file path (defaults to <dir>/SHA256SUMS)."),
    ),
    requireAll: Flag.Boolean("require-all").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Fail if any required release platform asset is absent."),
    ),
  },
  (flags) =>
    generateReleaseManifest({
      dir: flags.dir,
      version: flags.version,
      tag: Option.getOrUndefined(flags.tag),
      publishedAt: Option.getOrUndefined(flags.publishedAt),
      notesFile: Option.getOrUndefined(flags.notesFile),
      output: Option.getOrUndefined(flags.output),
      checksumsOutput: Option.getOrUndefined(flags.checksumsOutput),
      requireAll: flags.requireAll,
    }).pipe(
      Effect.flatMap((result) =>
        Console.log(
          `[release-manifest] Wrote ${result.outputPath} and ${result.checksumsPath} (${result.assetCount} assets).`,
        ),
      ),
    ),
).pipe(Command.withDescription("Generate release-manifest.json and SHA256SUMS for a release."));

if (import.meta.main) {
  Command.run(generateReleaseManifestCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
