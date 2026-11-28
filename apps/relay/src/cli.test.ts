// @effect-diagnostics nodeBuiltinImport:off -- CLI tests use Node temp directories and process stdout capture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runRelayCli } from "./cli.ts";

async function withTempDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-cli-test-"));
  try {
    await fn(dataDir);
  } finally {
    await NodeFSP.rm(dataDir, { recursive: true, force: true });
  }
}

async function runCliCaptureStdout(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  let output = "";
  const spy = vi.spyOn(NodeProcess.stdout, "write").mockImplementation((chunk: unknown) => {
    output += String(chunk);
    return true;
  });
  try {
    await runRelayCli(argv, env, cwd);
    return output;
  } finally {
    spy.mockRestore();
  }
}

interface ListedUser {
  readonly userId: string;
  readonly username: string;
  readonly role: string;
  readonly disabled: boolean;
}

async function listUsersJson(dataDir: string, env: NodeJS.ProcessEnv): Promise<Array<ListedUser>> {
  const stdout = await runCliCaptureStdout(
    ["admin", "user", "list", "--json"],
    { ...env, AGENT_VELA_RELAY_DATA_DIR: dataDir },
    dataDir,
  );
  const parsed = JSON.parse(stdout) as { readonly users: Array<ListedUser> };
  return parsed.users;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent-vela-relay admin CLI", () => {
  it("admin init --username redwolf uses --username when AGENT_VELA_RELAY_ADMIN_PASSWORD is set", async () => {
    await withTempDataDir(async (dataDir) => {
      const env = {
        AGENT_VELA_RELAY_DATA_DIR: dataDir,
        AGENT_VELA_RELAY_ADMIN_PASSWORD: "correct-horse-battery-staple",
      };
      const stdout = await runCliCaptureStdout(
        ["admin", "init", "--username", "redwolf"],
        env,
        dataDir,
      );
      expect(stdout).toContain("Initialized admin 'redwolf'");

      const users = await listUsersJson(dataDir, env);
      expect(users).toHaveLength(1);
      expect(users[0]?.username).toBe("redwolf");
      expect(users[0]?.role).toBe("admin");
    });
  });

  it("admin init --username overrides AGENT_VELA_RELAY_ADMIN_USERNAME", async () => {
    await withTempDataDir(async (dataDir) => {
      const env = {
        AGENT_VELA_RELAY_DATA_DIR: dataDir,
        AGENT_VELA_RELAY_ADMIN_USERNAME: "bob",
        AGENT_VELA_RELAY_ADMIN_PASSWORD: "correct-horse-battery-staple",
      };
      await runCliCaptureStdout(["admin", "init", "--username", "alice"], env, dataDir);

      const users = await listUsersJson(dataDir, env);
      expect(users.map((u) => u.username)).toEqual(["alice"]);
    });
  });

  it("admin init ignores weak env bootstrap password when --password is provided", async () => {
    await withTempDataDir(async (dataDir) => {
      const env = {
        AGENT_VELA_RELAY_DATA_DIR: dataDir,
        AGENT_VELA_RELAY_ADMIN_PASSWORD: "short",
      };
      const stdout = await runCliCaptureStdout(
        ["admin", "init", "--username", "carol", "--password", "explicit-strong-password"],
        env,
        dataDir,
      );
      expect(stdout).toContain("Initialized admin 'carol'");

      const users = await listUsersJson(dataDir, env);
      expect(users.map((u) => u.username)).toEqual(["carol"]);
    });
  });

  it("admin user list on an empty DB does not auto-bootstrap when env password is set", async () => {
    await withTempDataDir(async (dataDir) => {
      const users = await listUsersJson(dataDir, {
        AGENT_VELA_RELAY_ADMIN_PASSWORD: "correct-horse-battery-staple",
      });
      expect(users).toEqual([]);
    });
  });

  it("admin init falls back to admin when env username is empty and rejects re-init", async () => {
    await withTempDataDir(async (dataDir) => {
      const env = {
        AGENT_VELA_RELAY_DATA_DIR: dataDir,
        AGENT_VELA_RELAY_ADMIN_USERNAME: "",
        AGENT_VELA_RELAY_ADMIN_PASSWORD: "correct-horse-battery-staple",
      };
      const stdout = await runCliCaptureStdout(["admin", "init"], env, dataDir);
      expect(stdout).toContain("Initialized admin 'admin'");

      await expect(
        runCliCaptureStdout(["admin", "init", "--username", "second"], env, dataDir),
      ).rejects.toThrow("already_initialized");
    });
  });
});
