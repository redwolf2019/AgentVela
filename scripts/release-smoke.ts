// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const workspaceFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/mobile/package.json",
  "apps/mobile/modules/t3-highlights/package.json",
  "apps/mobile/modules/t3-source-text/package.json",
  "apps/mobile/modules/t3-review-diff/package.json",
  "apps/mobile/modules/t3-terminal/package.json",
  "apps/marketing/package.json",
  "apps/relay/package.json",
  "oxlint-plugin-t3code/package.json",
  "packages/client-runtime/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "packages/ssh/package.json",
  "packages/tailscale/package.json",
  "packages/provider-core/package.json",
  "packages/provider-testing/package.json",
  "packages/provider-pi/package.json",
  "packages/provider-acp/package.json",
  "packages/provider-acp-registry/package.json",
  "packages/provider-cursor/package.json",
  "packages/provider-fx/package.json",
  "packages/provider-grok/package.json",
  "packages/provider-kiro/package.json",
  "packages/provider-muse/package.json",
  "packages/provider-opencode/package.json",
  "packages/issue-tracker-linear/package.json",
  "packages/secret-provider-core/package.json",
  "packages/secret-provider-definitions/package.json",
  "packages/secret-provider-onepassword/package.json",
  "packages/source-control-azure-devops/package.json",
  "packages/source-control-bitbucket/package.json",
  "packages/source-control-core/package.json",
  "packages/source-control-cursor-origin/package.json",
  "packages/source-control-definitions/package.json",
  "packages/source-control-forgejo/package.json",
  "packages/source-control-gitcafe/package.json",
  "packages/source-control-github/package.json",
  "packages/source-control-gitlab/package.json",
  "packages/source-control-tanstack-source/package.json",
  "packages/source-control-testing/package.json",
  "packages/effect-acp/package.json",
  "packages/effect-codex-app-server/package.json",
  "scripts/package.json",
] as const;

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = NodePath.resolve(repoRoot, relativePath);
    const destinationPath = NodePath.resolve(targetRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.cpSync(sourcePath, destinationPath);
  }

  // Fork tarballs that file: dependencies install from.
  for (const forks of ["apps/mobile/deps", "apps/web/deps"]) {
    const source = NodePath.resolve(repoRoot, forks);
    if (NodeFS.existsSync(source)) {
      NodeFS.cpSync(source, NodePath.resolve(targetRoot, forks), { recursive: true });
    }
  }

  const patchesDirectory = NodePath.resolve(repoRoot, "patches");
  if (NodeFS.existsSync(patchesDirectory)) {
    NodeFS.cpSync(patchesDirectory, NodePath.resolve(targetRoot, "patches"), { recursive: true });
  }
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertPackageVersion(path: string, version: string): void {
  const packageJson = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    readonly version?: unknown;
  };

  if (packageJson.version !== version) {
    throw new Error(`Expected ${path} to have version ${version}.`);
  }
}

const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-smoke-"));

try {
  copyWorkspaceManifestFixture(tempRoot);

  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  NodeChildProcess.execFileSync("vp", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = NodeFS.readFileSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), "utf8");
  assertContains(lockfile, "lockfileVersion:", "Expected pnpm-lock.yaml to be regenerated.");

  for (const relativePath of [
    "apps/server/package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "apps/mobile/package.json",
    "packages/contracts/package.json",
  ]) {
    assertPackageVersion(NodePath.resolve(tempRoot, relativePath), "9.9.9-smoke.0");
  }

  const manifestDir = NodePath.resolve(tempRoot, "release-assets");
  NodeFS.mkdirSync(manifestDir, { recursive: true });
  for (const fileName of [
    "AgentVela-9.9.9-arm64.dmg",
    "AgentVela-9.9.9-x64.AppImage",
    "AgentVela-9.9.9-x64.deb",
    "AgentVela-9.9.9-arm64.AppImage",
    "AgentVela-9.9.9-arm64.deb",
    "AgentVela-9.9.9-x64.exe",
    "t3-9.9.9-darwin-arm64.tar.gz",
    "t3-9.9.9-linux-x64.tar.gz",
    "t3-9.9.9-linux-arm64.tar.gz",
    "t3-9.9.9-win32-x64.zip",
    "AgentVela-9.9.9-android-arm64-v8a.apk",
  ]) {
    NodeFS.writeFileSync(NodePath.join(manifestDir, fileName), `fixture:${fileName}\n`);
  }

  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/generate-release-manifest.ts"),
      "--dir",
      manifestDir,
      "--version",
      "9.9.9",
      "--require-all",
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const manifestJson = NodeFS.readFileSync(
    NodePath.join(manifestDir, "release-manifest.json"),
    "utf8",
  );
  assertContains(manifestJson, "AgentVela-9.9.9-arm64.dmg", "Manifest missing macOS DMG.");
  assertContains(
    manifestJson,
    "AgentVela-9.9.9-android-arm64-v8a.apk",
    "Manifest missing Android APK.",
  );
  const checksums = NodeFS.readFileSync(NodePath.join(manifestDir, "SHA256SUMS"), "utf8");
  assertContains(checksums, "t3-9.9.9-linux-x64.tar.gz", "SHA256SUMS missing Linux CLI.");

  Effect.runSync(Console.log("Release smoke checks passed."));
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}
