import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { computeAndroidVersionCode, type ReleaseManifest } from "@t3tools/shared/releaseManifest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { canMaintainEnvironment, findEnvironmentUpdate } from "./environment-maintenance";

afterEach(() => vi.unstubAllGlobals());

function makeManifest(version: string): ReleaseManifest {
  return {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    publishedAt: "2026-11-27T00:00:00.000Z",
    androidVersionCode: computeAndroidVersionCode(version),
    desktop: {},
    cli: {
      "linux-x64": {
        fileName: `AgentVela-${version}-linux-x64.tar.gz`,
        sha256: "b".repeat(64),
        size: 1234,
      },
    },
    android: {},
  };
}

describe("environment maintenance access", () => {
  it("requires a connected authenticated session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it.each([
    { permissions: ["environment:maintain"], expected: true },
    { permissions: ["providers:manage"], expected: false },
    { permissions: [], expected: false },
  ] as const)(
    "honors exact permissions over legacy scopes: $permissions",
    ({ permissions, expected }) => {
      expect(
        canMaintainEnvironment(
          {
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "session",
              serverUpdateScope: "environment:maintain",
            },
            scopes: ["orchestration:operate"],
            permissions,
          },
          true,
        ),
      ).toBe(expected);
    },
  );
});

describe("environment release checks", () => {
  const signal = new AbortController().signal;

  it("checks release-manifest.json on redwolf2019/AgentVela without GitHub API calls", async () => {
    const manifest = makeManifest("0.2.0");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(
          "https://github.com/redwolf2019/AgentVela/releases/latest/download/release-manifest.json",
        );
        return new Response(JSON.stringify(manifest), { status: 200 });
      }),
    );

    expect(await findEnvironmentUpdate("0.1.11", signal)).toBe("0.2.0");
    expect(await findEnvironmentUpdate("0.2.0", signal)).toBeNull();
  });

  it("honors a configured user mirror URL and falls back across candidate paths", async () => {
    const manifest = makeManifest("1.4.0");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://mirror.example.com/agentvela/latest/download/release-manifest.json") {
        return new Response(null, { status: 404 });
      }
      if (url === "https://mirror.example.com/agentvela/release-manifest.json") {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await findEnvironmentUpdate("1.3.0", signal, {
        userMirrorUrl: "https://mirror.example.com/agentvela",
      }),
    ).toBe("1.4.0");
  });

  it("fails closed on invalid mirror URLs and reports HTTP or manifest errors", async () => {
    await expect(
      findEnvironmentUpdate("1.0.0", signal, { userMirrorUrl: "ftp://bad.example.com" }),
    ).rejects.toThrow("invalid");

    for (const status of [403, 429]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
      await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow(String(status));
    }

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "invalid" })));
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow("invalid");
  });
});
