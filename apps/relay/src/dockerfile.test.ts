// @effect-diagnostics nodeBuiltinImport:off -- Dockerfile guard inspects workspace manifests and ignore rules on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");

interface WorkspaceManifest {
  readonly dir: string;
  readonly name: string;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
}

function readWorkspaceManifests(): Map<string, WorkspaceManifest> {
  const result = new Map<string, WorkspaceManifest>();
  for (const parent of ["apps", "packages"]) {
    for (const entry of NodeFS.readdirSync(NodePath.join(REPO_ROOT, parent))) {
      const dir = `${parent}/${entry}`;
      const manifestPath = NodePath.join(REPO_ROOT, dir, "package.json");
      if (!NodeFS.existsSync(manifestPath)) continue;
      const pkg = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
        readonly name: string;
        readonly dependencies?: Record<string, string>;
        readonly devDependencies?: Record<string, string>;
      };
      result.set(pkg.name, {
        dir,
        name: pkg.name,
        dependencies: pkg.dependencies ?? {},
        devDependencies: pkg.devDependencies ?? {},
      });
    }
  }
  return result;
}

function workspaceClosure(
  manifests: Map<string, WorkspaceManifest>,
  entryName: string,
  includeDev: boolean,
): Array<string> {
  const seen = new Set<string>([entryName]);
  const queue = [entryName];
  while (queue.length > 0) {
    const manifest = manifests.get(queue.shift()!);
    if (!manifest) continue;
    const deps = includeDev
      ? { ...manifest.dependencies, ...manifest.devDependencies }
      : manifest.dependencies;
    for (const [dep, spec] of Object.entries(deps)) {
      if (spec.startsWith("workspace:") && !seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...seen].map((name) => manifests.get(name)!.dir).sort();
}

function parseStages(dockerfile: string): Map<string, string> {
  const stages = new Map<string, string>();
  const matches = [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)\s*$/gm)];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index ?? 0;
    const end = matches[i + 1]?.index ?? dockerfile.length;
    stages.set(matches[i]![1]!, dockerfile.slice(start, end));
  }
  return stages;
}

function beforeRun(stageText: string, commandPattern: RegExp): string {
  const match = commandPattern.exec(stageText);
  expect(match, `Missing expected RUN command matching ${commandPattern}`).not.toBeNull();
  return stageText.slice(0, match!.index);
}

describe("apps/relay/Dockerfile build closure", () => {
  const dockerfile = NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/relay/Dockerfile"), "utf8");
  const dockerignore = NodeFS.readFileSync(NodePath.join(REPO_ROOT, ".dockerignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const stages = parseStages(dockerfile);
  const manifests = readWorkspaceManifests();

  it("keeps production relay dependencies isolated from web devDependencies", () => {
    const relayDeps = stages.get("relay-deps") ?? "";
    const webBuilder = stages.get("web-builder") ?? "";
    const runtime = stages.get("runtime") ?? "";

    expect(relayDeps).toContain(
      "RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter agent-vela-relay...",
    );
    expect(webBuilder).toContain(
      "RUN pnpm install --frozen-lockfile --ignore-scripts --filter @t3tools/web...",
    );
    expect(webBuilder).toContain("ENV VP_GIT_HOOKS=0");
    expect(webBuilder).toContain("ENV T3CODE_WEB_SOURCEMAP=0");
    expect(runtime).toContain("ENV NODE_ENV=production");
    expect(runtime).not.toContain("--from=web-builder --chown=node:node /repo/node_modules");
    expect(runtime).not.toContain("--from=web-builder /repo/node_modules");
  });

  it("copies all workspace dependencies of agent-vela-relay into relay-deps and runtime", () => {
    const relayDeps = stages.get("relay-deps") ?? "";
    const runtime = stages.get("runtime") ?? "";
    const preInstall = beforeRun(relayDeps, /^RUN pnpm install\b/m);
    for (const shared of [".pnpmfile.cjs", "patches"]) {
      expect(preInstall).toContain(shared);
    }
    for (const dir of workspaceClosure(manifests, "agent-vela-relay", false)) {
      expect(preInstall).toContain(`${dir}/package.json`);
      expect(relayDeps).toContain(`COPY ${dir} ./${dir}`);
      expect(runtime).toContain(`COPY --from=relay-deps --chown=node:node /repo/${dir} ./${dir}`);
    }
  });

  it("copies all workspace dependencies, patches, tarballs, and build inputs for @t3tools/web", () => {
    const webBuilder = stages.get("web-builder") ?? "";
    const preInstall = beforeRun(webBuilder, /^RUN pnpm install\b/m);
    const preBuild = beforeRun(webBuilder, /^RUN pnpm --filter @t3tools\/web build\b/m);

    for (const shared of [".pnpmfile.cjs", "patches", "apps/web/deps"]) {
      expect(preInstall).toContain(shared);
    }
    for (const dir of workspaceClosure(manifests, "@t3tools/web", true)) {
      expect(preInstall).toContain(`${dir}/package.json`);
    }

    const webBuildInputs = [
      "tsconfig.base.json",
      "tsconfig.effect.json",
      "third-party-licenses.config.json",
      "third-party-licenses",
      "scripts/lib",
      "assets",
      "native/libghostty-vt/LICENSE",
      "apps/server/package.json",
      "apps/server/src/device/deviceToolVersions.json",
      "apps/desktop/package.json",
    ];
    for (const requiredPath of webBuildInputs) {
      expect(NodeFS.existsSync(NodePath.join(REPO_ROOT, requiredPath))).toBe(true);
      expect(preBuild).toContain(requiredPath);
    }
  });

  it("does not exclude required Dockerfile inputs in .dockerignore", () => {
    expect(dockerignore).toContain("**/node_modules");
    expect(dockerignore).toContain("native/**/target");
    expect(dockerignore).not.toContain("native");
    expect(dockerignore).not.toContain("apps/web/deps");
    expect(dockerignore).not.toContain("*.tgz");
    expect(dockerignore).not.toContain("apps/server");
    expect(dockerignore).not.toContain("apps/desktop");
    expect(dockerignore).not.toContain("third-party-licenses");
  });
});
