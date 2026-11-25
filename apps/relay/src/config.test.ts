// @effect-diagnostics nodeBuiltinImport:off -- Config tests use temporary directories and files via node:fs/promises and node:os.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { loadRelayConfig, parseBindAddress, parseRelayToml } from "./config.ts";

describe("relay config", () => {
  it("parses strict TOML sections, comments, booleans, ints, and quoted strings", () => {
    const parsed = parseRelayToml(`
      # Relay server settings
      [server]
      bind = "0.0.0.0:9090" # inline comment
      public_url = 'https://relay.example.com' # quoted # inside value
      serve_web_ui = true

      [tunnel]
      max_frame_bytes = 131072
      compression = false
    `);
    expect(parsed.server?.bind).toBe("0.0.0.0:9090");
    expect(parsed.server?.public_url).toBe("https://relay.example.com");
    expect(parsed.server?.serve_web_ui).toBe(true);
    expect(parsed.tunnel?.max_frame_bytes).toBe(131072);
    expect(parsed.tunnel?.compression).toBe(false);
  });

  it("parses IPv4 and IPv6 bind addresses", () => {
    expect(parseBindAddress("127.0.0.1:8787")).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(parseBindAddress("[::1]:9443")).toEqual({ host: "::1", port: 9443 });
    expect(() => parseBindAddress("127.0.0.1:99999")).toThrow();
    expect(() => parseBindAddress("localhost")).toThrow();
  });

  it.effect("loads TOML and lets AGENT_VELA_RELAY_* environment variables override fields", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-cfg-"))),
          (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
        );
        const configPath = NodePath.join(tempDir, "relay.toml");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            configPath,
            `
              [server]
              bind = "127.0.0.1:8787"
              public_url = "https://relay.example.com"
              data_dir = "./state"
              serve_web_ui = false

              [auth]
              access_token_ttl_seconds = 600
              allow_public_registration = false

              [tunnel]
              heartbeat_interval_seconds = 15
              heartbeat_timeout_seconds = 45
            `,
          ),
        );

        const resolved = yield* loadRelayConfig({
          configPath,
          env: {
            AGENT_VELA_RELAY_BIND: "0.0.0.0:9797",
            AGENT_VELA_RELAY_PUBLIC_URL: "http://100.80.1.2:9797",
            AGENT_VELA_RELAY_SERVE_WEB_UI: "true",
            AGENT_VELA_RELAY_ACCESS_TOKEN_TTL_SECONDS: "1200",
          },
          cwd: tempDir,
        });

        expect(resolved.bind).toEqual({ host: "0.0.0.0", port: 9797 });
        expect(resolved.publicUrl).toBe("http://100.80.1.2:9797");
        expect(resolved.serveWebUi).toBe(true);
        expect(resolved.auth.accessTokenTtlSeconds).toBe(1200);
        expect(resolved.dataDir).toBe(NodePath.join(tempDir, "state"));
        expect(resolved.sqlitePath).toBe(NodePath.join(tempDir, "state", "relay.sqlite"));
      }),
    ),
  );

  it.effect(
    "rejects public non-HTTPS URLs and allows private LAN, loopback, and Tailscale HTTP",
    () =>
      Effect.gen(function* () {
        const publicHttpErr = yield* Effect.flip(
          loadRelayConfig({
            env: { AGENT_VELA_RELAY_PUBLIC_URL: "http://relay.example.com" },
            cwd: "/tmp",
          }),
        );
        expect(publicHttpErr.message).toContain("public_url");

        const lanOk = yield* loadRelayConfig({
          env: { AGENT_VELA_RELAY_PUBLIC_URL: "http://192.168.10.20:8787/" },
          cwd: "/tmp",
        });
        expect(lanOk.publicUrl).toBe("http://192.168.10.20:8787");

        const httpsOk = yield* loadRelayConfig({
          env: { AGENT_VELA_RELAY_PUBLIC_URL: "https://relay.example.com/" },
          cwd: "/tmp",
        });
        expect(httpsOk.publicUrl).toBe("https://relay.example.com");
      }),
  );

  it.effect("rejects invalid heartbeat timeout ratios", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        loadRelayConfig({
          env: {
            AGENT_VELA_RELAY_TUNNEL_HEARTBEAT_INTERVAL_SECONDS: "30",
            AGENT_VELA_RELAY_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: "40",
          },
          cwd: "/tmp",
        }),
      );
      expect(err.message).toContain("heartbeat_timeout_seconds");
    }),
  );
});
