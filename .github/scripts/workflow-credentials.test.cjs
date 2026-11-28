const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const { RELEASE_PACKAGE_FILES, setReleaseVersion } = require("./set-release-version.cjs");

const read = (path) => readFileSync(join(__dirname, "..", path), "utf8");

function jobs(path) {
  const body = read(path).split(/^jobs:\n/m)[1];
  const found = {};
  for (const block of body.split(/^(?=  [\w-]+:\n)/m)) {
    const name = /^  ([\w-]+):\n/.exec(block)?.[1];
    if (name) found[name] = block;
  }
  return found;
}

const steps = (block) => block.split(/^ {4,6}- /m).slice(1);
const runsProjectCode = (block) =>
  /setup-vp@|setup-ci-deps|eas-local-build|expo-github-action|\b(?:vp|pnpm|npm|npx|eas) /.test(
    block,
  );

test("the web preview gives the Vercel token to the deploy step only, after an install without lifecycle scripts", () => {
  const deploy = jobs("workflows/web-preview.yml").deploy;
  assert.doesNotMatch(deploy.split(/^ {4}steps:\n/m)[0], /secrets\./);
  const withSecrets = steps(deploy).filter((step) => step.includes("secrets."));
  assert.equal(withSecrets.length, 1);
  assert.match(withSecrets[0], /name: Deploy preview/);
  assert.match(deploy, /run-install: \|\n {12}args:\n {14}- --ignore-scripts\n/);
});

const recordScript = read("actions/record-build-tag/action.yml")
  .split(/^ {6}run: \|\n/m)[1]
  .replace(/^ {8}/gm, "")
  .replace(/^remote=.*$/m, 'remote="$TEST_REMOTE"');

function recordTag(commitOf, failedFetches = 0) {
  const directory = mkdtempSync(join(tmpdir(), "t3-record-tag-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const remote = join(directory, "remote.git");
    const work = join(directory, "work");
    git(directory, "init", "--quiet", "--bare", remote);
    git(directory, "init", "--quiet", "--initial-branch=main", work);
    const commit = (message) => {
      git(
        work,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        message,
      );
      return git(work, "rev-parse", "HEAD");
    };
    const shas = { first: commit("first") };
    shas.head = commit("second");
    git(work, "push", "--quiet", remote, "main");
    git(work, "checkout", "--quiet", "--detach");
    shas.elsewhere = commit("not on main");
    git(work, "push", "--quiet", remote, "HEAD:refs/heads/other");
    git(work, "checkout", "--quiet", "main");
    // The first fetches fail, and the waits between attempts are skipped.
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/bash\nif [ "$1" = fetch ] && [ "$(wc -l < "$FETCHES")" -lt "$FAILED_FETCHES" ]; then echo x >> "$FETCHES"; exit 1; fi\nexec "$REAL_GIT" "$@"\n`,
    );
    writeFileSync(join(bin, "sleep"), "#!/bin/bash\n");
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    writeFileSync(join(directory, "fetches"), "");
    const result = spawnSync("bash", ["-c", recordScript], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        REAL_GIT: execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
        FETCHES: join(directory, "fetches"),
        FAILED_FETCHES: String(failedFetches),
        HOME: directory,
        TEST_REMOTE: remote,
        GITHUB_REF: "refs/heads/main",
        TAG: "build/1",
        MESSAGE: "",
        REPLACE: "false",
        COMMIT: commitOf(shas),
      },
    });
    const tagged = git(directory, "ls-remote", remote, "refs/tags/build/1").split(/\s/)[0];
    return { status: result.status, tagged, shas };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the build record tags the named commit only when it is on the workflow's ref", () => {
  const onRef = recordTag((shas) => shas.first);
  assert.deepEqual([onRef.status, onRef.tagged], [0, onRef.shas.first]);
  const retried = recordTag((shas) => shas.first, 2);
  assert.deepEqual([retried.status, retried.tagged], [0, retried.shas.first]);
  assert.equal(recordTag((shas) => shas.first, 3).status, 1);
  const head = recordTag(() => "");
  assert.deepEqual([head.status, head.tagged], [0, head.shas.head]);
  for (const commitOf of [(shas) => shas.elsewhere, () => "main", () => "0".repeat(40)]) {
    const refused = recordTag(commitOf);
    assert.deepEqual([refused.status, refused.tagged], [1, ""]);
  }
});

test("release workflows use standard GitHub runners, target redwolf2019/AgentVela, and keep Android signing scoped", () => {
  for (const file of ["workflows/release.yml", "workflows/release-desktop.yml"]) {
    const contents = read(file);
    assert.doesNotMatch(contents, /blacksmith-/);
    assert.doesNotMatch(contents, /setup-apt-mirrors/);
    assert.doesNotMatch(contents, /pingdotgg\/t3code/);
  }
  const releaseJobs = jobs("workflows/release.yml");
  assert.match(releaseJobs.preflight, /redwolf2019\/AgentVela/);
  assert.match(releaseJobs.build_android_arm64, /^ {6}contents: read$/m);
  assert.doesNotMatch(releaseJobs.build_android_arm64, /^ {6}contents: write$/m);
  const androidSecretSteps = steps(releaseJobs.build_android_arm64).filter((step) =>
    step.includes("secrets.ANDROID_KEYSTORE"),
  );
  assert.equal(androidSecretSteps.length, 1);
  assert.match(releaseJobs.release, /scripts\/generate-release-manifest\.ts[\s\S]*--require-all/);
  assert.match(releaseJobs.desktop_mac_arm64, /^\s+runner:\s*macos-26$/m);
  assert.equal(releaseJobs.desktop_linux_x64, undefined);
  assert.equal(releaseJobs.desktop_linux_arm64, undefined);
  assert.match(
    releaseJobs.build_android_arm64,
    /gradle\/actions\/setup-gradle@0723195856401067f7a2779048b490ace7a47d7c/,
  );
  assert.doesNotMatch(releaseJobs.release, /release-assets\/\*\.AppImage|release-assets\/\*\.deb/);
  const desktopWorkflow = read("workflows/release-desktop.yml");
  assert.doesNotMatch(desktopWorkflow, /Wait for Linux CLI archive/);
  assert.match(desktopWorkflow, /Build Linux CLI archive for WSL/);
  assert.doesNotMatch(desktopWorkflow, /wsl-runtime\/t3-\*-linux-/);
  assert.match(desktopWorkflow, /wsl-runtime\/AgentVela-\*-linux-/);
});

test("the release version bump is pushed by a job that installs nothing, with a token for this repository only", () => {
  const { finalize } = jobs("workflows/release.yml");
  const mint = steps(finalize).find((step) => step.includes("create-github-app-token"));
  assert.doesNotMatch(mint, /^\s+(?:owner|repositories):/m);
  assert.match(mint, /^\s+permission-contents: write$/m);
  assert.ok(!runsProjectCode(finalize), "finalize holds a write token and runs code");
  assert.match(finalize, /run: node \.github\/scripts\/set-release-version\.cjs /);
});

test("the Vite+ toolchain is cached before the job installs or runs project code", () => {
  const names = Array.from(
    read("actions/setup-ci-deps/action.yml").matchAll(
      /^ {4}- name: (.+)\n(?: {6}.*\n)*? {6}uses: (\S+)|^ {4}- name: (.+)$/gm,
    ),
    (match) => ({ name: match[1] ?? match[3], uses: match[2] ?? "" }),
  );
  const index = (name) => names.findIndex((step) => step.name === name);
  assert.match(names[index("Restore Vite+")].uses, /^actions\/cache\/restore@/);
  assert.match(names[index("Save Vite+")].uses, /^actions\/cache\/save@/);
  assert.ok(index("Save Vite+") < index("Resolve pnpm store"));
  assert.ok(index("Save Vite+") < index("Install dependencies"));
  // The combined action saves at the end of the job, after everything ran.
  assert.ok(names.every((step) => !step.uses.startsWith("actions/cache@")));
});

test("a release version bump rewrites only the version of each release manifest including mobile", () => {
  const listed = /releasePackageFiles = \[\n([^\]]+)\]/.exec(
    read("../scripts/lib/tagged-source-version.ts"),
  )[1];
  assert.deepEqual(
    RELEASE_PACKAGE_FILES,
    Array.from(listed.matchAll(/"([^"]+)"/g), (m) => m[1]),
  );
  assert.ok(RELEASE_PACKAGE_FILES.includes("apps/mobile/package.json"));
  for (const file of RELEASE_PACKAGE_FILES) {
    const manifest = read(`../${file}`);
    const next = setReleaseVersion(manifest, "98.7.6");
    assert.equal(JSON.parse(next).version, "98.7.6");
    assert.deepEqual(
      { ...JSON.parse(next), version: "" },
      { ...JSON.parse(manifest), version: "" },
    );
    assert.equal(setReleaseVersion(next, "98.7.6"), next);
    assert.deepEqual(
      next.split("\n").filter((line, index) => line !== manifest.split("\n")[index]).length,
      1,
    );
  }
  for (const version of ["", "1", "1.2", "v1.2.3", '1.2.3", "x": "y']) {
    assert.throws(() => setReleaseVersion('{\n  "version": "1.0.0"\n}\n', version), /Invalid/);
  }
  assert.equal(
    setReleaseVersion('{\n  "version": "1.0.0"\n}\n', "1.2.3-rc.1"),
    '{\n  "version": "1.2.3-rc.1"\n}\n',
  );
  assert.throws(() => setReleaseVersion('{\n  "name": "x"\n}\n', "1.2.3"), /exactly one/);
});
