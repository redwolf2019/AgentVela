// @effect-diagnostics nodeBuiltinImport:off -- CORS e2e tests use Node temp directories and HTTP probes.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { RELAY_PRESENCE_EVENTS_PATH } from "@t3tools/contracts/agentVelaRelay";
import * as Effect from "effect/Effect";

import { startRelayServer } from "../server.ts";
import { makeRelayTestConfig, rawHttp } from "../testHelpers.ts";

function parseHeaderTokens(value: string | Array<string> | undefined): Set<string> {
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0),
  );
}

function withTestServer<E, R>(
  run: (ctx: { readonly baseUrl: string }) => Effect.Effect<void, E, R>,
  options?: {
    readonly serveWebUi?: boolean;
    readonly dpopMaxAttempts?: number;
  },
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const tempDir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-cors-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      let webUiDir: string | undefined;
      if (options?.serveWebUi) {
        webUiDir = NodePath.join(tempDir, "web-dist");
        yield* Effect.promise(() => NodeFSP.mkdir(webUiDir!, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(webUiDir!, "index.html"),
            "<!doctype html><h1>Relay</h1>",
          ),
        );
      }
      const baseConfig = makeRelayTestConfig({
        dataDir: tempDir,
        ...(webUiDir ? { webUiDir } : {}),
      });
      const config =
        options?.dpopMaxAttempts !== undefined
          ? {
              ...baseConfig,
              rateLimit: { ...baseConfig.rateLimit, dpopMaxAttempts: options.dpopMaxAttempts },
            }
          : baseConfig;
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => startRelayServer(config)),
        (handle) => Effect.promise(() => handle.close()),
      );
      yield* run({ baseUrl: server.localHttpUrl });
    }),
  );
}

describe("AgentVela Relay browser CORS", () => {
  it.live("answers cross-origin and originless preflights and actual API responses", () =>
    withTestServer(
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const crossOriginPreflight = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "OPTIONS",
              path: "/v1/auth/login",
              headers: {
                origin: "http://localhost:5733",
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type, traceparent, b3",
              },
            }),
          );
          expect(crossOriginPreflight.status).toBe(204);
          expect(crossOriginPreflight.headers["access-control-allow-origin"]).toBe("*");
          expect(crossOriginPreflight.headers["access-control-allow-credentials"]).toBeUndefined();
          expect(crossOriginPreflight.headers["access-control-max-age"]).toBe("600");
          expect(
            crossOriginPreflight.headers["access-control-allow-private-network"],
          ).toBeUndefined();

          const allowedMethods = parseHeaderTokens(
            crossOriginPreflight.headers["access-control-allow-methods"],
          );
          for (const method of ["get", "head", "post", "patch", "delete", "options"]) {
            expect(allowedMethods.has(method)).toBe(true);
          }

          const allowedHeaders = parseHeaderTokens(
            crossOriginPreflight.headers["access-control-allow-headers"],
          );
          for (const header of [
            "authorization",
            "b3",
            "cache-control",
            "content-type",
            "dpop",
            "traceparent",
            "tracestate",
          ]) {
            expect(allowedHeaders.has(header)).toBe(true);
          }

          // Packaged Electron strips Origin on the wire, while Chromium still enforces CORS.
          const originlessPreflight = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "OPTIONS",
              path: "/v1/auth/login",
              headers: {
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type",
              },
            }),
          );
          expect(originlessPreflight.status).toBe(204);
          expect(originlessPreflight.headers["access-control-allow-origin"]).toBe("*");
          expect(
            parseHeaderTokens(originlessPreflight.headers["access-control-allow-methods"]).has(
              "post",
            ),
          ).toBe(true);
          expect(
            parseHeaderTokens(originlessPreflight.headers["access-control-allow-headers"]).has(
              "content-type",
            ),
          ).toBe(true);

          const originlessLogin = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "POST",
              path: "/v1/auth/login",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                username: "admin",
                password: "e2e-relay-admin-passphrase",
              }),
            }),
          );
          expect(originlessLogin.status).toBe(200);
          expect(originlessLogin.headers["access-control-allow-origin"]).toBe("*");
          const exposedHeaders = parseHeaderTokens(
            originlessLogin.headers["access-control-expose-headers"],
          );
          for (const header of ["retry-after", "traceparent", "www-authenticate"]) {
            expect(exposedHeaders.has(header)).toBe(true);
          }
          const loginSession = JSON.parse(originlessLogin.body.toString("utf8")) as {
            readonly accessToken: string;
          };

          const pnaPreflight = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "OPTIONS",
              path: "/health",
              headers: {
                origin: "https://app.example.com",
                "access-control-request-method": "GET",
                "access-control-request-private-network": "true",
              },
            }),
          );
          expect(pnaPreflight.status).toBe(204);
          expect(pnaPreflight.headers["access-control-allow-origin"]).toBe("*");
          expect(pnaPreflight.headers["access-control-allow-private-network"]).toBe("true");
          expect(
            parseHeaderTokens(pnaPreflight.headers.vary).has(
              "access-control-request-private-network",
            ),
          ).toBe(true);

          const healthRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "GET",
              path: "/health",
              headers: { origin: "http://localhost:5733" },
            }),
          );
          expect(healthRes.status).toBe(200);
          expect(healthRes.headers["access-control-allow-origin"]).toBe("*");

          const authConfigRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "GET",
              path: "/v1/auth/config",
              headers: { origin: "http://localhost:5733" },
            }),
          );
          expect(authConfigRes.status).toBe(200);
          expect(authConfigRes.headers["access-control-allow-origin"]).toBe("*");

          const badLoginRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "POST",
              path: "/v1/auth/login",
              headers: {
                origin: "http://localhost:5733",
                "content-type": "application/json",
              },
              body: JSON.stringify({ username: "admin", password: "wrong-password" }),
            }),
          );
          expect(badLoginRes.status).toBe(401);
          expect(badLoginRes.headers["access-control-allow-origin"]).toBe("*");

          const ssePreflight = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "OPTIONS",
              path: RELAY_PRESENCE_EVENTS_PATH,
              headers: {
                origin: "http://localhost:5733",
                "access-control-request-method": "GET",
                "access-control-request-headers": "authorization, cache-control",
              },
            }),
          );
          expect(ssePreflight.status).toBe(204);
          expect(ssePreflight.headers["access-control-allow-origin"]).toBe("*");
          const sseAllowedHeaders = parseHeaderTokens(
            ssePreflight.headers["access-control-allow-headers"],
          );
          expect(sseAllowedHeaders.has("authorization")).toBe(true);
          expect(sseAllowedHeaders.has("cache-control")).toBe(true);

          const sseUnauth = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "GET",
              path: RELAY_PRESENCE_EVENTS_PATH,
              headers: { origin: "http://localhost:5733" },
            }),
          );
          expect(sseUnauth.status).toBe(401);
          expect(sseUnauth.headers["access-control-allow-origin"]).toBe("*");

          const sseLive = yield* Effect.promise(
            () =>
              new Promise<{
                readonly status: number;
                readonly headers: NodeHttp.IncomingHttpHeaders;
              }>((resolve, reject) => {
                const target = new URL(baseUrl);
                const req = NodeHttp.get(
                  {
                    hostname: target.hostname,
                    port: target.port,
                    path: RELAY_PRESENCE_EVENTS_PATH,
                    headers: {
                      origin: "http://localhost:5733",
                      authorization: `Bearer ${loginSession.accessToken}`,
                      "cache-control": "no-cache",
                    },
                  },
                  (res) => {
                    resolve({ status: res.statusCode ?? 0, headers: res.headers });
                    req.destroy();
                  },
                );
                req.on("error", reject);
              }),
          );
          expect(sseLive.status).toBe(200);
          expect(sseLive.headers["content-type"]).toContain("text/event-stream");
          expect(sseLive.headers["access-control-allow-origin"]).toBe("*");

          const hookPreflight = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "OPTIONS",
              path: "/v1/hooks/env-key/hk1/tok1",
              headers: { origin: "http://localhost:5733" },
            }),
          );
          expect(hookPreflight.headers["access-control-allow-origin"]).toBeUndefined();

          const hookPost = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "POST",
              path: "/v1/hooks/env-key/hk1/tok1",
              headers: {
                origin: "http://localhost:5733",
                "content-type": "application/json",
              },
              body: "{}",
            }),
          );
          expect(hookPost.headers["access-control-allow-origin"]).toBeUndefined();

          const uiRes = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "GET",
              path: "/",
              headers: { origin: "http://localhost:5733" },
            }),
          );
          expect(uiRes.status).toBe(200);
          expect(uiRes.headers["access-control-allow-origin"]).toBeUndefined();

          const offlineProxy = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "GET",
              path: "/e/env-offline-1/hello",
              headers: { origin: "http://localhost:5733" },
            }),
          );
          expect(offlineProxy.status).toBe(404);
          expect(offlineProxy.headers["access-control-allow-origin"]).toBe("*");

          const offlineMcpProxy = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "GET",
              path: "/e/env-offline-1/mcp",
              headers: { origin: "http://localhost:5733" },
            }),
          );
          expect(offlineMcpProxy.status).toBe(404);
          expect(offlineMcpProxy.headers["access-control-allow-origin"]).toBeUndefined();
        }),
      { serveWebUi: true },
    ),
  );

  it.live("exempts OPTIONS from DPoP rate limiting and includes CORS headers on 429", () =>
    withTestServer(
      ({ baseUrl }) =>
        Effect.gen(function* () {
          for (let i = 0; i < 2; i += 1) {
            const preflight = yield* Effect.promise(() =>
              rawHttp({
                baseUrl,
                method: "OPTIONS",
                path: "/v1/auth/dpop-token",
                headers: {
                  origin: "http://localhost:5733",
                  "access-control-request-method": "POST",
                  "access-control-request-headers": "authorization, content-type, dpop",
                },
              }),
            );
            expect(preflight.status).toBe(204);
            expect(preflight.headers["access-control-allow-origin"]).toBe("*");
          }

          const firstAttempt = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "POST",
              path: "/v1/auth/dpop-token",
              headers: {
                origin: "http://localhost:5733",
                "content-type": "application/json",
              },
              body: "{}",
            }),
          );
          expect(firstAttempt.status).toBe(401);
          expect(firstAttempt.headers["access-control-allow-origin"]).toBe("*");

          const limitedAttempt = yield* Effect.promise(() =>
            rawHttp({
              baseUrl,
              method: "POST",
              path: "/v1/auth/dpop-token",
              headers: {
                origin: "http://localhost:5733",
                "content-type": "application/json",
              },
              body: "{}",
            }),
          );
          expect(limitedAttempt.status).toBe(429);
          expect(limitedAttempt.headers["access-control-allow-origin"]).toBe("*");
          expect(limitedAttempt.headers["retry-after"]).toBeDefined();
          expect(
            parseHeaderTokens(limitedAttempt.headers["access-control-expose-headers"]).has(
              "retry-after",
            ),
          ).toBe(true);
        }),
      { dpopMaxAttempts: 1 },
    ),
  );
});
