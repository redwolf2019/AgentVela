// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopReleaseClient from "./DesktopReleaseClient.ts";

function sha256Hex(content: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex").toLowerCase();
}

function makeManifestPayload(fileName: string, content: Uint8Array, digestOverride?: string) {
  return JSON.stringify({
    schemaVersion: 1,
    version: "0.1.12",
    tag: "v0.1.12",
    publishedAt: "2026-11-27T00:00:00.000Z",
    notes: "## Changes\n- Release manifest test",
    androidVersionCode: 1012,
    desktop: {
      "darwin-arm64-dmg": {
        fileName,
        sha256: digestOverride ?? sha256Hex(content),
        size: content.byteLength,
      },
    },
    cli: {},
    android: {},
  });
}

describe("DesktopReleaseClient", () => {
  it.effect("fetches manifest from mirror fallback after 404 on /latest/download", () => {
    const payload = new TextEncoder().encode("dmg-content");
    const requestedUrls: string[] = [];
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requestedUrls.push(request.url);
        if (request.url.endsWith("/latest/download/release-manifest.json")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(makeManifestPayload("AgentVela-0.1.12-arm64.dmg", payload), {
              status: 200,
            }),
          ),
        );
      }),
    );

    return Effect.gen(function* () {
      const client = yield* DesktopReleaseClient.DesktopReleaseClient;
      const fetched = yield* client.fetchLatestManifest("https://mirror.example.com/agentvela");
      assert.equal(fetched.manifest.version, "0.1.12");
      assert.equal(
        fetched.matchedManifestUrl,
        "https://mirror.example.com/agentvela/release-manifest.json",
      );
      assert.deepEqual(requestedUrls, [
        "https://mirror.example.com/agentvela/latest/download/release-manifest.json",
        "https://mirror.example.com/agentvela/release-manifest.json",
      ]);
    }).pipe(
      Effect.provide(
        DesktopReleaseClient.layer.pipe(
          Layer.provide(httpLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("resumes partial download via Range and verifies full SHA-256 before rename", () => {
    const content = new TextEncoder().encode("hello-resumed-installer-payload");
    const splitAt = 10;
    const prefix = content.subarray(0, splitAt);
    const suffix = content.subarray(splitAt);
    const digest = sha256Hex(content);
    const seenRangeHeaders: Array<string | undefined> = [];
    const progressValues: number[] = [];

    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const range = request.headers["range"];
        seenRangeHeaders.push(range);
        assert.equal(range, `bytes=${splitAt}-`);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(suffix, {
              status: 206,
              headers: {
                "content-range": `bytes ${splitAt}-${content.byteLength - 1}/${content.byteLength}`,
              },
            }),
          ),
        );
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const client = yield* DesktopReleaseClient.DesktopReleaseClient;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-release-client-resume-" });
        const partPath = `${dir}/AgentVela-0.1.12-arm64.dmg.part`;
        const metaPath = `${dir}/AgentVela-0.1.12-arm64.dmg.part.json`;
        yield* fs.writeFile(partPath, prefix);
        yield* fs.writeFileString(
          metaPath,
          JSON.stringify({ sha256: digest, size: content.byteLength }),
        );

        const downloadedPath = yield* client.downloadAsset({
          url: "https://mirror.example.com/AgentVela-0.1.12-arm64.dmg",
          targetDir: dir,
          asset: {
            fileName: "AgentVela-0.1.12-arm64.dmg",
            sha256: digest,
            size: content.byteLength,
          },
          onProgress: (p) =>
            Effect.sync(() => {
              progressValues.push(p);
            }),
        });

        assert.equal(downloadedPath, `${dir}/AgentVela-0.1.12-arm64.dmg`);
        assert.deepEqual(seenRangeHeaders, [`bytes=${splitAt}-`]);
        assert.equal(yield* fs.readFileString(downloadedPath), "hello-resumed-installer-payload");
        assert.isFalse(yield* fs.exists(partPath));
        assert.isFalse(yield* fs.exists(metaPath));
        assert.equal(progressValues.at(-1), 100);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          DesktopReleaseClient.layer.pipe(
            Layer.provide(httpLayer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
  });

  it.effect("deletes corrupted partial download and fails when SHA-256 mismatches", () => {
    const actual = new TextEncoder().encode("tampered-bytes");
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(actual, { status: 200 }))),
      ),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const client = yield* DesktopReleaseClient.DesktopReleaseClient;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-release-client-bad-" });
        const err = yield* client
          .downloadAsset({
            url: "https://mirror.example.com/AgentVela-0.1.12-arm64.dmg",
            targetDir: dir,
            asset: {
              fileName: "AgentVela-0.1.12-arm64.dmg",
              sha256: "f".repeat(64),
              size: actual.byteLength,
            },
          })
          .pipe(Effect.flip);

        assert.equal(err.phase, "verify");
        assert.isFalse(yield* fs.exists(`${dir}/AgentVela-0.1.12-arm64.dmg`));
        assert.isFalse(yield* fs.exists(`${dir}/AgentVela-0.1.12-arm64.dmg.part`));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          DesktopReleaseClient.layer.pipe(
            Layer.provide(httpLayer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
  });

  it.effect("rejects path-traversing release asset file names before creating files", () => {
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unexpected"))),
      ),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const client = yield* DesktopReleaseClient.DesktopReleaseClient;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-release-client-traversal-" });
        const err = yield* client
          .downloadAsset({
            url: "https://mirror.example.com/evil.dmg",
            targetDir: dir,
            asset: {
              fileName: "../evil.dmg",
              sha256: "a".repeat(64),
              size: 4,
            },
          })
          .pipe(Effect.flip);

        assert.equal(err.phase, "download");
        assert.isFalse(yield* fs.exists(`${dir}/../evil.dmg`));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          DesktopReleaseClient.layer.pipe(
            Layer.provide(httpLayer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
  });
});
