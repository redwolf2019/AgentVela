// @effect-diagnostics nodeBuiltinImport:off -- Exercises t3 relay and t3 up --relay CLI flows against a localhost mock relay HTTP server.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import * as BootService from "../cloud/bootService.ts";

function generateMintPublicKeyPem(): string {
  const { publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

function makeMockRelayServer() {
  const mintPublicKey = generateMintPublicKeyPem();
  const requests: Array<{ readonly method: string; readonly url: string; readonly auth?: string }> =
    [];
  let endpointKey = "0123456789abcdef";
  let unlinkedCount = 0;

  return Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer(async (req, res) => {
        let bodyText = "";
        for await (const chunk of req) bodyText += String(chunk);
        const url = req.url ?? "/";
        requests.push({
          method: req.method ?? "GET",
          url,
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        });
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        const relayOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const sessionPayload = {
          user: {
            userId: "user_1",
            username: "admin",
            role: "admin",
            disabled: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          accessToken: "avr_at_1",
          accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
          refreshToken: "avr_rt_1",
          refreshTokenExpiresAt: "2031-01-01T00:00:00.000Z",
        };
        if (req.method === "POST" && url === "/v1/auth/login") {
          send(200, sessionPayload);
          return;
        }
        if (req.method === "POST" && url === "/v1/auth/logout") {
          send(200, { ok: true });
          return;
        }
        if (req.method === "POST" && url === "/v1/auth/device/start") {
          send(200, {
            deviceCode: "dev_code_1",
            userCode: "ABCD-1234",
            verificationPath: "/device?code=ABCD-1234",
            expiresAt: "2030-01-01T00:00:00.000Z",
            intervalSeconds: 1,
          });
          return;
        }
        if (req.method === "POST" && url === "/v1/auth/device/poll") {
          send(200, { status: "approved", session: sessionPayload });
          return;
        }
        if (req.method === "POST" && url === "/v1/environments/link-challenges") {
          send(200, { challenge: "chl_1", expiresAt: "2030-01-01T00:00:00.000Z" });
          return;
        }
        if (req.method === "POST" && url === "/v1/environments/enroll/challenge") {
          send(200, { challenge: "enr_chl_1", expiresAt: "2030-01-01T00:00:00.000Z" });
          return;
        }
        if (
          req.method === "POST" &&
          (url === "/v1/environments/link" || url === "/v1/environments/enroll")
        ) {
          const parsed = JSON.parse(bodyText) as { readonly proof?: string };
          if (url === "/v1/environments/enroll") endpointKey = "fedcba9876543210";
          const jwtBody = JSON.parse(
            Buffer.from((parsed.proof ?? "..").split(".")[1] ?? "", "base64url").toString("utf8"),
          ) as { readonly environmentId: string };
          send(200, {
            ok: true,
            userId: "user_1",
            environmentId: jwtBody.environmentId,
            endpoint: {
              endpointKey,
              pathPrefix: `/e/${endpointKey}`,
              httpBaseUrl: `${relayOrigin}/e/${endpointKey}`,
              wsBaseUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/e/${endpointKey}`,
            },
            relayIssuer: relayOrigin,
            environmentCredential: "avr_env_secret_1",
            relayMintPublicKey: mintPublicKey,
          });
          return;
        }
        if (req.method === "DELETE" && url.startsWith("/v1/environments/")) {
          unlinkedCount++;
          send(200, { ok: true });
          return;
        }
        send(404, { code: "not_found" });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      return {
        url: `http://127.0.0.1:${address.port}`,
        requests,
        getUnlinkedCount: () => unlinkedCount,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    }),
    (mock) => Effect.promise(() => mock.close()),
  );
}

const layerBase = Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, NetService.layer);

describe("t3 relay and t3 up --relay CLI", () => {
  afterEach(() => vi.restoreAllMocks());

  const runCliCommand = (args: ReadonlyArray<string>) =>
    Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
      Effect.provideService(HostProcess.Environment, {}),
      Effect.flatMap(() => TestConsole.logLines),
      Effect.map((lines) => lines.map(String)),
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          Layer.fresh(TestConsole.layer),
          layerBase,
        ),
      ),
    );

  it.live("runs login, link, status --json, unlink (revoking remote), and logout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-relay-test-" });
      const relay = yield* makeMockRelayServer();

      const loginOut = yield* runCliCommand([
        "relay",
        "login",
        "--url",
        relay.url,
        "--username",
        "admin",
        "--password",
        "secretpass",
        "--base-dir",
        baseDir,
      ]);
      assert.include(loginOut.join("\n"), `Signed in to ${relay.url} as admin (admin).`);

      const linkOut = yield* runCliCommand(["relay", "link", "--base-dir", baseDir]);
      assert.include(linkOut.join("\n"), `${relay.url}/e/0123456789abcdef`);

      const statusLines = yield* runCliCommand([
        "relay",
        "status",
        "--json",
        "--base-dir",
        baseDir,
      ]);
      const parsed = JSON.parse(statusLines.join("\n")) as {
        readonly serverRunning: boolean;
        readonly status: {
          readonly linked: boolean;
          readonly endpoint: { readonly endpointKey: string };
        };
        readonly cliSession: { readonly username: string };
      };
      assert.isFalse(parsed.serverRunning);
      assert.isTrue(parsed.status.linked);
      assert.strictEqual(parsed.status.endpoint.endpointKey, "0123456789abcdef");
      assert.strictEqual(parsed.cliSession.username, "admin");

      yield* runCliCommand(["relay", "unlink", "--base-dir", baseDir]);
      expect(relay.getUnlinkedCount()).toBe(1);

      const afterUnlink = yield* runCliCommand([
        "relay",
        "status",
        "--json",
        "--base-dir",
        baseDir,
      ]);
      assert.isFalse(
        (JSON.parse(afterUnlink.join("\n")) as { readonly status: { readonly linked: boolean } })
          .status.linked,
      );

      const logoutOut = yield* runCliCommand(["relay", "logout", "--base-dir", baseDir]);
      assert.include(logoutOut.join("\n"), `Signed out from ${relay.url}.`);
    }).pipe(Effect.scoped, Effect.provide(layerBase)),
  );

  it.live("supports headless enrollment via t3 relay link --token and device-code login", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-relay-enroll-" });
      const relay = yield* makeMockRelayServer();

      const deviceLogin = yield* runCliCommand([
        "relay",
        "login",
        "--url",
        relay.url,
        "--device",
        "--base-dir",
        baseDir,
      ]);
      assert.include(deviceLogin.join("\n"), "ABCD-1234");
      assert.include(deviceLogin.join("\n"), `Signed in to ${relay.url} as admin`);

      const enrollOut = yield* runCliCommand([
        "relay",
        "link",
        "--url",
        relay.url,
        "--token",
        "avr_enr_one_time",
        "--base-dir",
        baseDir,
      ]);
      assert.include(enrollOut.join("\n"), `${relay.url}/e/fedcba9876543210`);
    }).pipe(Effect.scoped, Effect.provide(layerBase)),
  );

  it.live("wires t3 up --relay --relay-url --relay-token with BootService reconciliation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-up-relay-test-" });
      const relay = yield* makeMockRelayServer();
      let installs = 0;

      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.succeed({
              supported: true,
              installed: false,
              current: false,
              unitPath: "/tmp/t3.service",
              logPath: "/tmp/t3.log",
            }),
            withStopped: (op) => op,
            restart: Effect.succeed("restarted" as const),
            install: () =>
              Effect.sync(() => {
                installs++;
                return {
                  program: ["t3"],
                  baseDir,
                  unitPath: "/tmp/t3.service",
                  logPath: "/tmp/t3.log",
                };
              }),
            uninstall: Effect.succeed(false),
          }),
        ),
      );

      const upOut = yield* runCliCommand([
        "up",
        "--relay",
        "--relay-url",
        relay.url,
        "--relay-token",
        "avr_enr_up_flow",
        "--base-dir",
        baseDir,
      ]);
      expect(installs).toBe(1);
      assert.include(upOut.join("\n"), `${relay.url}/e/fedcba9876543210`);
      assert.include(upOut.join("\n"), "Open your self-hosted relay web UI on another device");
    }).pipe(Effect.scoped, Effect.provide(layerBase)),
  );
});
