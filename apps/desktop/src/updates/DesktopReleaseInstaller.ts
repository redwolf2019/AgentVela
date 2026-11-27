// @effect-diagnostics nodeBuiltinImport:off - Installer launches detached platform installers and elevation helpers natively.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { DesktopInstallMode, DesktopUpdateMechanism } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopReleaseClient from "./DesktopReleaseClient.ts";

/** Closes inherited FDs (> 2) before execing the updated AppImage so Electron/Chromium FDs do not leak. */
export const CLOSE_INHERITED_FDS_THEN_EXEC =
  'for fd in /proc/self/fd/*; do fd=${fd##*/}; case $fd in *[!0-9]*|[012]) ;; *) eval "exec $fd>&-" ;; esac; done; exec "$@"';

export class DesktopReleaseInstallError extends Schema.TaggedError<DesktopReleaseInstallError>()(
  "DesktopReleaseInstallError",
  {
    mode: Schema.Literals(["appimage", "deb", "nsis", "dmg"]),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface InstallDesktopReleaseInput {
  readonly mode: DesktopInstallMode;
  readonly filePath: string;
  readonly expectedSha256: string;
  readonly expectedSize: number;
}

export interface InstallDesktopReleaseResult {
  readonly mechanism: DesktopUpdateMechanism;
}

export class DesktopReleaseInstaller extends Context.Service<
  DesktopReleaseInstaller,
  {
    readonly installAndRelaunch: (
      input: InstallDesktopReleaseInput,
    ) => Effect.Effect<InstallDesktopReleaseResult, DesktopReleaseInstallError>;
  }
>()("@t3tools/desktop/updates/DesktopReleaseInstaller") {}

export interface DesktopInstallerPlatformOps {
  readonly chmodFile: (filePath: string, mode: number) => Promise<void>;
  readonly replaceFile: (sourcePath: string, targetPath: string) => Promise<void>;
  readonly spawnDetached: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv },
  ) => Promise<void>;
  readonly runCommand: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Promise<{ readonly code: number | null; readonly stderr: string }>;
}

async function replaceFileAtomically(sourcePath: string, targetPath: string): Promise<void> {
  const targetDir = NodePath.dirname(targetPath);
  const stagingPath = NodePath.join(
    targetDir,
    `.${NodePath.basename(targetPath)}.update-${process.pid}`,
  );
  await NodeFS.promises.copyFile(sourcePath, stagingPath);
  await NodeFS.promises.chmod(stagingPath, 0o755);
  try {
    await NodeFS.promises.rename(stagingPath, targetPath);
  } catch (error) {
    await NodeFS.promises.rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function spawnDetachedProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function runForegroundCommand(
  command: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stderr: Buffer.concat(stderrChunks).toString("utf8").trim() });
    });
  });
}

export const defaultDesktopInstallerPlatformOps: DesktopInstallerPlatformOps = {
  chmodFile: (filePath, mode) => NodeFS.promises.chmod(filePath, mode),
  replaceFile: replaceFileAtomically,
  spawnDetached: spawnDetachedProcess,
  runCommand: runForegroundCommand,
};

const installAppImage = Effect.fn("DesktopReleaseInstaller.installAppImage")(function* (
  filePath: string,
  targetAppImagePath: string,
  ops: DesktopInstallerPlatformOps,
  electronApp: ElectronApp.ElectronApp["Service"],
): Effect.fn.Return<InstallDesktopReleaseResult, DesktopReleaseInstallError> {
  yield* Effect.tryPromise({
    try: async () => {
      await ops.chmodFile(filePath, 0o755);
      await ops.replaceFile(filePath, targetAppImagePath);
      await ops.spawnDetached(
        "bash",
        ["-p", "-c", CLOSE_INHERITED_FDS_THEN_EXEC, "bash", targetAppImagePath],
        {
          env: {
            ...process.env,
            APPIMAGE_SILENT_INSTALL: "true",
          },
        },
      );
    },
    catch: (cause) =>
      new DesktopReleaseInstallError({
        mode: "appimage",
        reason: `Failed to replace and relaunch AppImage at ${targetAppImagePath}.`,
        cause,
      }),
  });
  yield* electronApp.exit(0);
  return { mechanism: "self-update" as const };
});

const installDebPackage = Effect.fn("DesktopReleaseInstaller.installDebPackage")(function* (
  filePath: string,
  ops: DesktopInstallerPlatformOps,
  electronApp: ElectronApp.ElectronApp["Service"],
): Effect.fn.Return<InstallDesktopReleaseResult, DesktopReleaseInstallError> {
  const installScript = 'dpkg -i "$1" || (apt-get install -f -y && dpkg -i "$1")';
  const attempts: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["pkexec", ["sh", "-c", installScript, "sh", filePath]],
    ["kdesudo", ["--", "sh", "-c", installScript, "sh", filePath]],
    ["sudo", ["-n", "sh", "-c", installScript, "sh", filePath]],
  ];

  let lastFailure = "No elevation helper (pkexec, kdesudo, or passwordless sudo) succeeded.";
  let installed = false;
  for (const [command, args] of attempts) {
    const outcome = yield* Effect.tryPromise({
      try: () => ops.runCommand(command, args),
      catch: (cause) =>
        new DesktopReleaseInstallError({
          mode: "deb",
          reason: `Failed to launch ${command}.`,
          cause,
        }),
    }).pipe(Effect.option);
    if (outcome._tag === "Some" && outcome.value.code === 0) {
      installed = true;
      break;
    }
    if (outcome._tag === "Some") {
      lastFailure = outcome.value.stderr || `${command} exited with code ${outcome.value.code}.`;
      if (command === "pkexec" && (outcome.value.code === 126 || outcome.value.code === 127)) {
        break;
      }
    }
  }

  if (!installed) {
    return yield* new DesktopReleaseInstallError({
      mode: "deb",
      reason: `Failed to install .deb update package: ${lastFailure}`,
    });
  }
  yield* electronApp.relaunch({});
  yield* electronApp.quit;
  return { mechanism: "self-update" as const };
});

const installNsisPackage = Effect.fn("DesktopReleaseInstaller.installNsisPackage")(function* (
  filePath: string,
  ops: DesktopInstallerPlatformOps,
  electronApp: ElectronApp.ElectronApp["Service"],
  electronShell: ElectronShell.ElectronShell["Service"],
): Effect.fn.Return<InstallDesktopReleaseResult, DesktopReleaseInstallError> {
  const spawnExit = yield* Effect.tryPromise({
    try: () => ops.spawnDetached(filePath, ["--updated", "/S", "--force-run"], {}),
    catch: (cause) =>
      new DesktopReleaseInstallError({
        mode: "nsis",
        reason: "Failed to launch Windows update installer.",
        cause,
      }),
  }).pipe(Effect.result);

  if (spawnExit._tag === "Failure") {
    const cause = spawnExit.failure.cause as { readonly code?: string } | undefined;
    if (cause?.code === "EACCES") {
      const openError = yield* electronShell.openPath(filePath);
      if (openError !== "") {
        return yield* new DesktopReleaseInstallError({
          mode: "nsis",
          reason: `Windows installer elevation failed: ${openError}`,
        });
      }
    } else {
      return yield* spawnExit.failure;
    }
  }

  yield* electronApp.quit;
  return { mechanism: "self-update" as const };
});

function openDmgInstaller(
  filePath: string,
  electronShell: ElectronShell.ElectronShell["Service"],
): Effect.Effect<InstallDesktopReleaseResult, DesktopReleaseInstallError> {
  return electronShell.openPath(filePath).pipe(
    Effect.flatMap((openError) =>
      openError === ""
        ? Effect.succeed({ mechanism: "manual-installer" as const })
        : Effect.fail(
            new DesktopReleaseInstallError({
              mode: "dmg",
              reason: `Could not open macOS disk image: ${openError}`,
            }),
          ),
    ),
  );
}

export const makeWithOps = Effect.fn("desktop.releaseInstaller.make")(function* (
  ops: DesktopInstallerPlatformOps = defaultDesktopInstallerPlatformOps,
) {
  const config = yield* DesktopConfig.DesktopConfig;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronShell = yield* ElectronShell.ElectronShell;
  const releaseClient = yield* DesktopReleaseClient.DesktopReleaseClient;

  return DesktopReleaseInstaller.of({
    installAndRelaunch: Effect.fn("desktop.releaseInstaller.installAndRelaunch")(function* (input) {
      const verified = yield* releaseClient.verifyFileSha256(
        input.filePath,
        input.expectedSha256,
        input.expectedSize,
      );
      if (!verified) {
        return yield* new DesktopReleaseInstallError({
          mode: input.mode,
          reason: "Downloaded installer is missing or failed SHA-256 verification.",
        });
      }

      switch (input.mode) {
        case "dmg":
          return yield* openDmgInstaller(input.filePath, electronShell);
        case "appimage": {
          const appImagePath = Option.getOrUndefined(config.appImagePath);
          if (!appImagePath) {
            return yield* new DesktopReleaseInstallError({
              mode: "appimage",
              reason: "APPIMAGE path is not set for AppImage self-update.",
            });
          }
          return yield* installAppImage(input.filePath, appImagePath, ops, electronApp);
        }
        case "deb":
          return yield* installDebPackage(input.filePath, ops, electronApp);
        case "nsis":
          return yield* installNsisPackage(input.filePath, ops, electronApp, electronShell);
      }
    }),
  });
});

export const layer = Layer.effect(DesktopReleaseInstaller, makeWithOps());

export const layerTest = (
  service: DesktopReleaseInstaller["Service"],
): Layer.Layer<DesktopReleaseInstaller> => Layer.succeed(DesktopReleaseInstaller, service);
