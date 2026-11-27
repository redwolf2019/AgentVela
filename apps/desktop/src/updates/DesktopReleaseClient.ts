// @effect-diagnostics nodeBuiltinImport:off - Streaming binary downloads and SHA-256 verification use Node stream primitives to bound memory.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  type ReleaseManifest,
  type ReleaseManifestAsset,
  isSafeReleaseFileName,
  parseReleaseManifestJson,
  resolveReleaseManifestUrls,
} from "@t3tools/shared/releaseManifest";

const MANIFEST_FETCH_TIMEOUT = Duration.seconds(15);
const DOWNLOAD_STALL_TIMEOUT = Duration.seconds(30);
const CONTENT_RANGE_PATTERN = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i;

export class DesktopReleaseClientError extends Schema.TaggedError<DesktopReleaseClientError>()(
  "DesktopReleaseClientError",
  {
    phase: Schema.Literals(["manifest", "download", "verify"]),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface FetchedDesktopReleaseManifest {
  readonly manifest: ReleaseManifest;
  readonly matchedManifestUrl: string;
}

export interface DownloadDesktopAssetInput {
  readonly url: string;
  readonly targetDir: string;
  readonly asset: ReleaseManifestAsset;
  readonly onProgress?: ((percent: number) => Effect.Effect<void>) | undefined;
}

export class DesktopReleaseClient extends Context.Service<
  DesktopReleaseClient,
  {
    readonly fetchLatestManifest: (
      baseUrl: string,
    ) => Effect.Effect<FetchedDesktopReleaseManifest, DesktopReleaseClientError>;
    readonly downloadAsset: (
      input: DownloadDesktopAssetInput,
    ) => Effect.Effect<string, DesktopReleaseClientError>;
    readonly verifyFileSha256: (
      filePath: string,
      expectedSha256: string,
      expectedSize: number,
    ) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/updates/DesktopReleaseClient") {}

const DownloadPartMetadataSchema = Schema.fromJsonString(
  Schema.Struct({
    sha256: Schema.String,
    size: Schema.Number,
  }),
);
const decodePartMetadataOption = Schema.decodeUnknownOption(DownloadPartMetadataSchema);
const encodePartMetadata = Schema.encodeEffect(DownloadPartMetadataSchema);
const isDesktopReleaseClientError = Schema.is(DesktopReleaseClientError);

function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
    stream.on("error", reject);
  });
}

function verifyFileSha256Effect(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  expectedSha256: string,
  expectedSize: number,
): Effect.Effect<boolean> {
  return fileSystem.stat(filePath).pipe(
    Effect.flatMap((info) => {
      if (Number(info.size) !== expectedSize) {
        return Effect.succeed(false);
      }
      return Effect.tryPromise({
        try: () => hashFileSha256(filePath),
        catch: () => false as const,
      }).pipe(
        Effect.map((digest) => digest === expectedSha256.toLowerCase()),
        Effect.orElseSucceed(() => false),
      );
    }),
    Effect.orElseSucceed(() => false),
  );
}

const readPartOffset = Effect.fn("DesktopReleaseClient.readPartOffset")(
  function* (
    fileSystem: FileSystem.FileSystem,
    partPath: string,
    metaPath: string,
    asset: ReleaseManifestAsset,
  ) {
    const rawMeta = yield* fileSystem.readFileString(metaPath).pipe(Effect.option);
    if (rawMeta._tag === "None") return 0;
    const decoded = decodePartMetadataOption(rawMeta.value);
    if (decoded._tag === "None") return 0;
    const parsed = decoded.value;
    if (parsed.sha256 !== asset.sha256.toLowerCase() || parsed.size !== asset.size) {
      return 0;
    }
    const stat = yield* fileSystem.stat(partPath).pipe(Effect.option);
    if (stat._tag === "None") return 0;
    const bytes = Number(stat.value.size);
    return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= asset.size ? bytes : 0;
  },
  Effect.orElseSucceed(() => 0),
);

function streamResponseToFile(
  response: HttpClientResponse.HttpClientResponse,
  partPath: string,
  startOffset: number,
  expectedSize: number,
  onProgress?: ((percent: number) => Effect.Effect<void>) | undefined,
): Effect.Effect<void, DesktopReleaseClientError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const writeStream = yield* Effect.acquireRelease(
        Effect.try({
          try: () => NodeFS.createWriteStream(partPath, { flags: startOffset > 0 ? "a" : "w" }),
          catch: (cause) =>
            new DesktopReleaseClientError({
              phase: "download",
              reason: "Could not open temporary update file for writing.",
              cause,
            }),
        }),
        (stream) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                stream.end(() => resolve());
              }),
          ),
      );

      let written = startOffset;
      yield* response.stream.pipe(
        Stream.timeoutOrElse({
          duration: DOWNLOAD_STALL_TIMEOUT,
          orElse: () => Stream.fail(new Cause.TimeoutError()),
        }),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () =>
                new Promise<void>((resolve, reject) => {
                  const ok = writeStream.write(chunk, (error) => {
                    if (error) reject(error);
                    else resolve();
                  });
                  if (!ok) {
                    writeStream.once("drain", () => resolve());
                  }
                }),
              catch: (cause) =>
                new DesktopReleaseClientError({
                  phase: "download",
                  reason: "Failed writing downloaded update chunk to disk.",
                  cause,
                }),
            });
            written += chunk.byteLength;
            if (onProgress && expectedSize > 0) {
              const percent = Math.min(99, Math.floor((written / expectedSize) * 100));
              yield* onProgress(percent);
            }
          }),
        ),
        Effect.mapError((cause) =>
          isDesktopReleaseClientError(cause)
            ? cause
            : new DesktopReleaseClientError({
                phase: "download",
                reason:
                  cause instanceof Cause.TimeoutError
                    ? "Update download timed out while waiting for data."
                    : "Update download stream failed.",
                cause,
              }),
        ),
      );
    }),
  );
}

function validatePartialResponse(
  status: number,
  contentRangeHeader: string | undefined,
  requestedOffset: number,
  expectedSize: number,
): { readonly mode: "append"; readonly offset: number } | { readonly mode: "restart" } | null {
  if (status === 200) {
    return { mode: "restart" };
  }
  if (status !== 206 || !contentRangeHeader) {
    return null;
  }
  const match = CONTENT_RANGE_PATTERN.exec(contentRangeHeader.trim());
  if (!match?.[1] || !match[3]) {
    return null;
  }
  const start = Number(match[1]);
  const total = match[3] === "*" ? expectedSize : Number(match[3]);
  if (start === requestedOffset && total === expectedSize) {
    return { mode: "append", offset: start };
  }
  return null;
}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const verifyFileSha256 = (
    filePath: string,
    expectedSha256: string,
    expectedSize: number,
  ): Effect.Effect<boolean> =>
    verifyFileSha256Effect(fileSystem, filePath, expectedSha256, expectedSize);

  const fetchFromManifestUrl = Effect.fn("desktop.releaseClient.fetchUrl")(function* (
    manifestUrl: string,
  ) {
    const body = yield* httpClient.get(manifestUrl).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout(MANIFEST_FETCH_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new DesktopReleaseClientError({
            phase: "manifest",
            reason: `Failed to fetch release manifest from ${manifestUrl}.`,
            cause,
          }),
      ),
    );
    const parsed = parseReleaseManifestJson(body);
    if (!parsed.ok) {
      return yield* new DesktopReleaseClientError({
        phase: "manifest",
        reason: `Invalid release manifest at ${manifestUrl}: ${parsed.error}`,
      });
    }
    return { manifest: parsed.manifest, matchedManifestUrl: manifestUrl };
  });

  const fetchLatestManifest = Effect.fn("desktop.releaseClient.fetchLatestManifest")(function* (
    baseUrl: string,
  ) {
    const candidateUrls = resolveReleaseManifestUrls(baseUrl);
    let lastError: DesktopReleaseClientError | undefined;
    for (const candidateUrl of candidateUrls) {
      const attempt = yield* fetchFromManifestUrl(candidateUrl).pipe(Effect.result);
      if (attempt._tag === "Success") {
        return attempt.success;
      }
      lastError = attempt.failure;
    }
    return yield* (
      lastError ??
      new DesktopReleaseClientError({
        phase: "manifest",
        reason: "No release manifest URL could be resolved.",
      })
    );
  });

  const performDownloadAttempt = (input: {
    readonly url: string;
    readonly partPath: string;
    readonly metaPath: string;
    readonly asset: ReleaseManifestAsset;
    readonly requestedOffset: number;
    readonly onProgress?: ((percent: number) => Effect.Effect<void>) | undefined;
  }): Effect.Effect<void, DesktopReleaseClientError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const request =
          input.requestedOffset > 0
            ? HttpClientRequest.get(input.url).pipe(
                HttpClientRequest.setHeader("range", `bytes=${input.requestedOffset}-`),
              )
            : HttpClientRequest.get(input.url);
        const response = yield* httpClient.execute(request).pipe(
          Effect.timeout(DOWNLOAD_STALL_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new DesktopReleaseClientError({
                phase: "download",
                reason: "Failed to start update package download.",
                cause,
              }),
          ),
        );

        if (input.requestedOffset > 0 && response.status === 416) {
          const alreadyValid = yield* verifyFileSha256(
            input.partPath,
            input.asset.sha256,
            input.asset.size,
          );
          if (alreadyValid) return;
          yield* fileSystem.remove(input.partPath, { force: true }).pipe(Effect.ignore);
          yield* fileSystem.remove(input.metaPath, { force: true }).pipe(Effect.ignore);
          return yield* performDownloadAttempt({ ...input, requestedOffset: 0 });
        }

        const checked = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopReleaseClientError({
                phase: "download",
                reason: `Update download returned HTTP ${response.status}.`,
                cause,
              }),
          ),
        );

        const partialDecision = validatePartialResponse(
          checked.status,
          checked.headers["content-range"],
          input.requestedOffset,
          input.asset.size,
        );
        const startOffset = partialDecision?.mode === "append" ? partialDecision.offset : 0;

        yield* encodePartMetadata({
          sha256: input.asset.sha256.toLowerCase(),
          size: input.asset.size,
        }).pipe(
          Effect.flatMap((encoded) => fileSystem.writeFileString(input.metaPath, encoded)),
          Effect.mapError(
            (cause) =>
              new DesktopReleaseClientError({
                phase: "download",
                reason: "Could not write update download metadata.",
                cause,
              }),
          ),
        );

        yield* streamResponseToFile(
          checked,
          input.partPath,
          startOffset,
          input.asset.size,
          input.onProgress,
        );
      }),
    );

  const downloadAsset = Effect.fn("desktop.releaseClient.downloadAsset")(function* (
    input: DownloadDesktopAssetInput,
  ) {
    if (!isSafeReleaseFileName(input.asset.fileName)) {
      return yield* new DesktopReleaseClientError({
        phase: "download",
        reason: `Unsafe release asset file name: ${input.asset.fileName}.`,
      });
    }
    yield* fileSystem.makeDirectory(input.targetDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopReleaseClientError({
            phase: "download",
            reason: "Could not create update download directory.",
            cause,
          }),
      ),
    );
    const targetPath = path.join(input.targetDir, input.asset.fileName);
    if (yield* verifyFileSha256(targetPath, input.asset.sha256, input.asset.size)) {
      if (input.onProgress) yield* input.onProgress(100);
      return targetPath;
    }

    const partPath = `${targetPath}.part`;
    const metaPath = `${targetPath}.part.json`;
    const resumeOffset = yield* readPartOffset(fileSystem, partPath, metaPath, input.asset);

    yield* performDownloadAttempt({
      url: input.url,
      partPath,
      metaPath,
      asset: input.asset,
      requestedOffset: resumeOffset,
      onProgress: input.onProgress,
    });

    const verified = yield* verifyFileSha256(partPath, input.asset.sha256, input.asset.size);
    if (!verified) {
      yield* fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore);
      yield* fileSystem.remove(metaPath, { force: true }).pipe(Effect.ignore);
      return yield* new DesktopReleaseClientError({
        phase: "verify",
        reason: `Checksum verification failed for ${input.asset.fileName}.`,
      });
    }

    yield* fileSystem.rename(partPath, targetPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopReleaseClientError({
            phase: "verify",
            reason: `Could not finalize downloaded update ${input.asset.fileName}.`,
            cause,
          }),
      ),
    );
    yield* fileSystem.remove(metaPath, { force: true }).pipe(Effect.ignore);
    if (input.onProgress) yield* input.onProgress(100);
    return targetPath;
  });

  return DesktopReleaseClient.of({
    fetchLatestManifest,
    downloadAsset,
    verifyFileSha256,
  });
});

export const layer = Layer.effect(DesktopReleaseClient, make);

export const layerTest = (
  service: DesktopReleaseClient["Service"],
): Layer.Layer<DesktopReleaseClient> => Layer.succeed(DesktopReleaseClient, service);
