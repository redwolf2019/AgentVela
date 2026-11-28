// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopReleaseClient from "./DesktopReleaseClient.ts";

function sha256Hex(content: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex").toLowerCase();
}

function makeManifestPayload(
  fileName: string,
  content: Uint8Array,
  digestOverride?: string,
  version = "0.1.12",
) {
  return JSON.stringify({
    schemaVersion: 1,
    version,
    tag: `v${version}`,
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

function startTestHttpServer(
  handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
): Effect.Effect<string, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer(handler);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      ),
  ).pipe(
    Effect.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected numeric port from test HTTP server.");
      }
      return `http://127.0.0.1:${address.port}`;
    }),
  );
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

  it.live(
    "follows HTTP 302 redirects via NodeHttpClient.layerUndici when fetching release manifest",
    () => {
      const payload = new TextEncoder().encode("dmg-0.1.16");
      const requestedPaths: Array<string> = [];

      return Effect.scoped(
        Effect.gen(function* () {
          const origin = yield* startTestHttpServer((req, res) => {
            const reqUrl = req.url ?? "/";
            requestedPaths.push(reqUrl);
            if (reqUrl === "/releases/latest/download/release-manifest.json") {
              res.writeHead(302, {
                Location: `${origin}/releases/download/v0.1.16/release-manifest.json`,
              });
              res.end();
              return;
            }
            if (reqUrl === "/releases/download/v0.1.16/release-manifest.json") {
              res.writeHead(302, { Location: `${origin}/cdn/release-manifest.json` });
              res.end();
              return;
            }
            if (reqUrl === "/cdn/release-manifest.json") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                makeManifestPayload("AgentVela-0.1.16-arm64.dmg", payload, undefined, "0.1.16"),
              );
              return;
            }
            res.writeHead(404).end("Not Found");
          });

          const client = yield* DesktopReleaseClient.DesktopReleaseClient;
          const fetched = yield* client.fetchLatestManifest(`${origin}/releases`);
          assert.equal(fetched.manifest.version, "0.1.16");
          assert.equal(
            fetched.matchedManifestUrl,
            `${origin}/releases/latest/download/release-manifest.json`,
          );
          assert.deepEqual(requestedPaths, [
            "/releases/latest/download/release-manifest.json",
            "/releases/download/v0.1.16/release-manifest.json",
            "/cdn/release-manifest.json",
          ]);
        }),
      ).pipe(
        Effect.provide(
          DesktopReleaseClient.layer.pipe(
            Layer.provide(NodeHttpClient.layerUndici),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  it.live(
    "follows HTTP 302 redirects via NodeHttpClient.layerUndici when resuming partial download",
    () => {
      const content = new TextEncoder().encode("hello-resumed-installer-via-redirect");
      const splitAt = 10;
      const prefix = content.subarray(0, splitAt);
      const suffix = content.subarray(splitAt);
      const digest = sha256Hex(content);
      const seenRequests: Array<{ readonly url: string; readonly range: string | undefined }> = [];

      return Effect.scoped(
        Effect.gen(function* () {
          const origin = yield* startTestHttpServer((req, res) => {
            const reqUrl = req.url ?? "/";
            const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
            seenRequests.push({ url: reqUrl, range });
            if (reqUrl === "/releases/download/v0.1.16/AgentVela-0.1.16-arm64.dmg") {
              res.writeHead(302, { Location: `${origin}/cdn/AgentVela-0.1.16-arm64.dmg` });
              res.end();
              return;
            }
            if (reqUrl === "/cdn/AgentVela-0.1.16-arm64.dmg" && range === `bytes=${splitAt}-`) {
              res.writeHead(206, {
                "Content-Range": `bytes ${splitAt}-${content.byteLength - 1}/${content.byteLength}`,
              });
              res.end(suffix);
              return;
            }
            res.writeHead(400).end("Unexpected request");
          });

          const fs = yield* FileSystem.FileSystem;
          const client = yield* DesktopReleaseClient.DesktopReleaseClient;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-release-redirect-dl-" });
          const partPath = `${dir}/AgentVela-0.1.16-arm64.dmg.part`;
          const metaPath = `${dir}/AgentVela-0.1.16-arm64.dmg.part.json`;
          yield* fs.writeFile(partPath, prefix);
          yield* fs.writeFileString(
            metaPath,
            JSON.stringify({ sha256: digest, size: content.byteLength }),
          );

          const downloadedPath = yield* client.downloadAsset({
            url: `${origin}/releases/download/v0.1.16/AgentVela-0.1.16-arm64.dmg`,
            targetDir: dir,
            asset: {
              fileName: "AgentVela-0.1.16-arm64.dmg",
              sha256: digest,
              size: content.byteLength,
            },
          });

          assert.equal(downloadedPath, `${dir}/AgentVela-0.1.16-arm64.dmg`);
          assert.equal(
            yield* fs.readFileString(downloadedPath),
            "hello-resumed-installer-via-redirect",
          );
          assert.isFalse(yield* fs.exists(partPath));
          assert.isFalse(yield* fs.exists(metaPath));
          assert.deepEqual(seenRequests, [
            {
              url: "/releases/download/v0.1.16/AgentVela-0.1.16-arm64.dmg",
              range: `bytes=${splitAt}-`,
            },
            {
              url: "/cdn/AgentVela-0.1.16-arm64.dmg",
              range: `bytes=${splitAt}-`,
            },
          ]);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            DesktopReleaseClient.layer.pipe(
              Layer.provide(NodeHttpClient.layerUndici),
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      );
    },
  );

  it.effect("refuses redirects to non-HTTPS non-loopback URLs before sending a request", () => {
    const requestedUrls: Array<string> = [];
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requestedUrls.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              status: 302,
              headers: { Location: "http://insecure.example.com/release-manifest.json" },
            }),
          ),
        );
      }),
    );

    return Effect.gen(function* () {
      const client = yield* DesktopReleaseClient.DesktopReleaseClient;
      const err = yield* client
        .fetchLatestManifest("https://mirror.example.com/releases")
        .pipe(Effect.flip);
      assert.equal(err.phase, "manifest");
      assert.isFalse(requestedUrls.includes("http://insecure.example.com/release-manifest.json"));
    }).pipe(
      Effect.provide(
        DesktopReleaseClient.layer.pipe(
          Layer.provide(httpLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("bounds redirect hops to 10 when the upstream loops", () => {
    let requests = 0;
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              status: 302,
              headers: { Location: "https://github.com/redwolf2019/AgentVela/loop" },
            }),
          ),
        );
      }),
    );

    return Effect.gen(function* () {
      const client = yield* DesktopReleaseClient.DesktopReleaseClient;
      const err = yield* client
        .fetchLatestManifest("https://github.com/redwolf2019/AgentVela/releases")
        .pipe(Effect.flip);
      assert.equal(err.phase, "manifest");
      assert.equal(requests, 11);
      assert.include(err.reason, "(HTTP 302)");
    }).pipe(
      Effect.provide(
        DesktopReleaseClient.layer.pipe(
          Layer.provide(httpLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("formats host-only manifest errors without leaking query credentials", () => {
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("Unavailable", { status: 503 })),
        ),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* DesktopReleaseClient.DesktopReleaseClient;
      const err = yield* client
        .fetchLatestManifest("https://mirror.example.com/releases?token=super-secret")
        .pipe(Effect.flip);
      assert.equal(err.phase, "manifest");
      assert.equal(
        err.reason,
        "Failed to fetch release manifest from mirror.example.com (HTTP 503).",
      );
      assert.notInclude(err.reason, "super-secret");
      assert.notInclude(err.reason, "https://");
    }).pipe(
      Effect.provide(
        DesktopReleaseClient.layer.pipe(
          Layer.provide(httpLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });
});
