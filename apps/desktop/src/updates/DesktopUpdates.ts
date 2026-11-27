import {
  DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE,
  DESKTOP_UPDATE_IN_PROGRESS_TTL_MS,
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  type DesktopInstallMode,
  type DesktopUpdateActionResult,
  type DesktopUpdateCheckResult,
  type DesktopUpdateMechanism,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";
import {
  type DesktopReleaseAssetKey,
  type ReleaseManifestAsset,
  desktopInstallModeFromAssetKey,
  isNewerStableVersion,
  resolveDesktopUpdateMechanism,
  resolveEffectiveReleaseBaseUrl,
  resolveReleaseAssetUrl,
  selectDesktopReleaseAssetKey,
} from "@t3tools/shared/releaseManifest";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveMirrorUrlOverride } from "@t3tools/shared/url";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopReleaseClient from "./DesktopReleaseClient.ts";
import * as DesktopReleaseInstaller from "./DesktopReleaseInstaller.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadLost,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
  resolveNotAppliedInstallVersion,
} from "./updateMachine.ts";

const MIRROR_CHANGE_RETRY_DELAY = Duration.seconds(1);
const MIRROR_CHANGE_RETRIES = 30;
const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 hours";
const UPDATE_CHECK_WAIT = Duration.seconds(90);

type UpdateAction = "check" | "download" | "install" | "install-recovery" | "mirror";

export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";
const DesktopUpdateInstallRecord = Schema.fromJsonString(
  Schema.Struct({ fromVersion: Schema.String, targetVersion: Schema.String }),
);
const decodeInstallRecord = Schema.decodeUnknownEffect(DesktopUpdateInstallRecord);
const encodeInstallRecord = Schema.encodeEffect(DesktopUpdateInstallRecord);
const encodeUpdateMarker = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ startedAt: Schema.Number, expiresAt: Schema.Number })),
);
const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  { action: Schema.Literals(["check", "download", "install", "mirror"]) },
) {
  override get message(): string {
    return `Cannot update the mirror URL while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateMirrorInvalidError extends Schema.TaggedError<DesktopUpdateMirrorInvalidError>()(
  "DesktopUpdateMirrorInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class DesktopUpdateMirrorPersistenceError extends Schema.TaggedError<DesktopUpdateMirrorPersistenceError>()(
  "DesktopUpdateMirrorPersistenceError",
  { cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError) },
) {
  override get message(): string {
    return "Failed to persist the desktop update mirror URL.";
  }
}

export const DesktopUpdateSetMirrorError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateMirrorInvalidError,
  DesktopUpdateMirrorPersistenceError,
]);
export type DesktopUpdateSetMirrorError = typeof DesktopUpdateSetMirrorError.Type;

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  { poller: Schema.Literals(["startup", "poll"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly isActionActive: Effect.Effect<boolean>;
    readonly isInstallActive: Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<
      { readonly latest: DesktopUpdateState; readonly changes: Stream.Stream<DesktopUpdateState> },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly setMirrorUrl: (
      mirrorUrl: string | null,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetMirrorError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const { logWarning: logUpdaterWarning, logError: logUpdaterError } =
  DesktopObservability.makeComponentLogger("desktop-updater");

function redactMessage(message: string): string {
  return (message.split(/[\r\n]/, 1)[0] ?? "")
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted credential]")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*$/gi,
      "[redacted header]",
    )
    .replace(
      /\b[\w-]*(?:token|password|secret|credential|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[redacted credential]",
    )
    .slice(0, 512)
    .replace(/\p{Surrogate}$/u, "");
}

function summarizeCause(cause: unknown, depth: number): string {
  if (depth >= 3) return "[truncated cause]";
  if (Cause.isCause(cause)) {
    return cause.reasons
      .slice(0, 3)
      .map((reason) =>
        reason._tag === "Fail"
          ? summarizeCause(reason.error, depth + 1)
          : reason._tag === "Die"
            ? summarizeCause(reason.defect, depth + 1)
            : "Interrupted",
      )
      .join("; ");
  }
  if (typeof cause === "string") return redactMessage(cause);
  if (typeof cause !== "object" || cause === null) return errorTag(cause);
  const err = cause as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly cause?: unknown;
  };
  const code =
    typeof err.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(err.code)
      ? ` [${err.code}]`
      : "";
  const message = typeof err.message === "string" ? `: ${redactMessage(err.message)}` : "";
  const nested =
    err.cause === undefined ? "" : `; caused by ${summarizeCause(err.cause, depth + 1)}`;
  return `${errorTag(cause)}${code}${message}${nested}`;
}

export function describeUpdateErrorCause(cause: unknown): string {
  try {
    return summarizeCause(cause, 0)
      .slice(0, 1024)
      .replace(/\p{Surrogate}$/u, "");
  } catch {
    return "UnknownError";
  }
}

interface OfferedDesktopRelease {
  readonly version: string;
  readonly assetKey: DesktopReleaseAssetKey;
  readonly installMode: DesktopInstallMode;
  readonly mechanism: DesktopUpdateMechanism;
  readonly asset: ReleaseManifestAsset;
  readonly downloadUrl: string;
}

interface DownloadedDesktopArtifact {
  readonly version: string;
  readonly installMode: DesktopInstallMode;
  readonly mechanism: DesktopUpdateMechanism;
  readonly asset: ReleaseManifestAsset;
  readonly filePath: string;
}

function resolveDesktopDisabledReason(args: {
  readonly policy: DesktopUpdatePolicy.UpdatePolicy;
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly assetKey: DesktopReleaseAssetKey | null;
  readonly disabledByEnv: boolean;
  readonly baseUrlResolution: ReturnType<typeof resolveEffectiveReleaseBaseUrl>;
}): string | null {
  if (args.policy.mode === "off")
    return args.policy.message ?? "Updates are turned off on this machine.";
  if (args.isDevelopment || !args.isPackaged)
    return "Automatic updates are only available in packaged production builds.";
  if (args.disabledByEnv)
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  if (args.assetKey === null) {
    return args.platform === "linux"
      ? "Automatic updates on Linux require the AppImage or the .deb package."
      : "Automatic updates are not available for this platform architecture.";
  }
  if (!args.baseUrlResolution.ok) {
    return args.baseUrlResolution.reason === "disabled"
      ? "Automatic updates are disabled by update mirror configuration."
      : `Invalid update mirror URL (${args.baseUrlResolution.source}).`;
  }
  return null;
}

function shouldBroadcastDownloadProgress(
  current: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (current.status !== "downloading" || current.downloadPercent === null) return true;
  return (
    Math.floor(current.downloadPercent / 10) !== Math.floor(nextPercent / 10) || nextPercent === 100
  );
}

const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const releaseClient = yield* DesktopReleaseClient.DesktopReleaseClient;
  const releaseInstaller = yield* DesktopReleaseInstaller.DesktopReleaseInstaller;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;

  const mockUpdates = config.mockUpdates && policy.message === null;
  const isDebPackage =
    environment.platform === "linux" && environment.isPackaged
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.resourcesPath, "package-type"))
          .pipe(
            Effect.map((v) => v.trim() === "deb"),
            Effect.orElseSucceed(() => false),
          )
      : false;
  const assetKey = selectDesktopReleaseAssetKey({
    platform: environment.platform,
    arch: environment.runtimeInfo.hostArch,
    isAppImage: Option.isSome(config.appImagePath),
    linuxPackageFormat: isDebPackage ? "deb" : undefined,
  });
  const installMode = assetKey ? desktopInstallModeFromAssetKey(assetKey) : undefined;
  const mechanism = assetKey ? resolveDesktopUpdateMechanism(assetKey) : undefined;

  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const offeredReleaseRef = yield* Ref.make<Option.Option<OfferedDesktopRelease>>(Option.none());
  const downloadedArtifactRef = yield* Ref.make<Option.Option<DownloadedDesktopArtifact>>(
    Option.none(),
  );
  const installRunningBackendsRef = yield* Ref.make<
    ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>
  >([]);
  const notAppliedVersionRef = yield* Ref.make(Option.none<string>());
  const configuredRef = yield* Ref.make(false);
  const finishedActions = yield* PubSub.unbounded<UpdateAction>();
  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  const stateMutex = yield* Semaphore.make(1);
  const updateStateRef = yield* Ref.make<DesktopUpdateState>(
    createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, {
      installMode,
      mechanism,
      mirrorUrl: null,
      effectiveReleaseBaseUrl: null,
    }),
  );

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );
  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    stateMutex
      .withPermits(1)(
        Ref.set(updateStateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      )
      .pipe(Effect.andThen(emitState));
  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((s) => {
        const next = f(s);
        return setState(next).pipe(Effect.as(next));
      }),
    );

  const resolveBaseConfig = (mirrorUrl: string | null) => {
    const baseUrlResolution = resolveEffectiveReleaseBaseUrl({
      managedFeedUrl: policy.feedUrl,
      envReleaseBaseUrl: mockUpdates
        ? `http://127.0.0.1:${config.mockUpdateServerPort}`
        : Option.getOrUndefined(config.releaseBaseUrl),
      userMirrorUrl: mirrorUrl,
    });
    const disabledReason = Option.fromNullishOr(
      resolveDesktopDisabledReason({
        policy,
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        assetKey,
        disabledByEnv: config.disableAutoUpdate,
        baseUrlResolution,
      }),
    );
    return {
      disabledReason,
      effectiveReleaseBaseUrl: baseUrlResolution.ok ? baseUrlResolution.url : null,
      mirrorUrl,
    };
  };

  const makeBaseState = Effect.fn("desktop.updates.makeBaseState")(function* (
    mirrorUrl: string | null,
  ) {
    const resolved = resolveBaseConfig(mirrorUrl);
    const enabled = Option.isNone(resolved.disabledReason);
    const notApplied = yield* Ref.get(notAppliedVersionRef);
    return {
      ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, {
        installMode,
        mechanism,
        mirrorUrl,
        effectiveReleaseBaseUrl: resolved.effectiveReleaseBaseUrl,
      }),
      enabled,
      status: enabled ? ("idle" as const) : ("disabled" as const),
      message: Option.getOrNull(resolved.disabledReason),
      ...Option.match(notApplied, {
        onNone: () => ({}),
        onSome: (version) => ({ notAppliedVersion: version }),
      }),
    } satisfies DesktopUpdateState;
  });

  const markerDir = environment.path.join(environment.baseDir, "runtime");
  const restartMarkerPath = environment.path.join(markerDir, DESKTOP_UPDATE_RESTART_MARKER_FILE);
  const inProgressMarkerPath = environment.path.join(
    markerDir,
    DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE,
  );
  const installRecordPath = environment.path.join(markerDir, DESKTOP_UPDATE_INSTALL_RECORD_FILE);

  const writeSelfUpdateMarkers = Effect.fn("desktop.updates.writeMarkers")(function* (
    version: string,
  ) {
    yield* Effect.gen(function* () {
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const inProgress = yield* encodeUpdateMarker({
        startedAt,
        expiresAt: startedAt + DESKTOP_UPDATE_IN_PROGRESS_TTL_MS,
      });
      const record = yield* encodeInstallRecord({
        fromVersion: environment.appVersion,
        targetVersion: version,
      });
      yield* fileSystem.makeDirectory(markerDir, { recursive: true });
      yield* fileSystem.writeFileString(restartMarkerPath, "");
      yield* fileSystem.writeFileString(`${inProgressMarkerPath}.tmp`, inProgress);
      yield* fileSystem.rename(`${inProgressMarkerPath}.tmp`, inProgressMarkerPath);
      yield* fileSystem.writeFileString(installRecordPath, record);
    }).pipe(
      Effect.catch((error) =>
        logUpdaterWarning("Could not write update markers.", { errorTag: error._tag }),
      ),
    );
  });

  const clearSelfUpdateMarkers = Effect.all(
    [
      fileSystem.remove(restartMarkerPath, { force: true }).pipe(Effect.ignore),
      fileSystem.remove(inProgressMarkerPath, { force: true }).pipe(Effect.ignore),
      fileSystem.remove(installRecordPath, { force: true }).pipe(Effect.ignore),
    ],
    { discard: true },
  );

  const readNotAppliedInstallVersion = fileSystem.readFileString(installRecordPath).pipe(
    Effect.flatMap(decodeInstallRecord),
    Effect.option,
    Effect.map((r) =>
      Option.flatMap(r, (v) =>
        Option.fromNullishOr(resolveNotAppliedInstallVersion(v, environment.appVersion)),
      ),
    ),
    Effect.tap((v) =>
      Option.isNone(v)
        ? fileSystem.remove(installRecordPath, { force: true }).pipe(Effect.ignore)
        : Effect.void,
    ),
  );

  const tryStartUpdateAction = (action: UpdateAction) =>
    Ref.modify(activeUpdateActionRef, (active) =>
      Option.isSome(active) ? ([false, active] as const) : ([true, Option.some(action)] as const),
    );
  const finishUpdateAction = (action: UpdateAction) =>
    Ref.modify(activeUpdateActionRef, (active) => {
      const done = Option.isSome(active) && active.value === action;
      return [done, done ? Option.none() : active] as const;
    }).pipe(
      Effect.flatMap((done) =>
        done ? PubSub.publish(finishedActions, action).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const admitAfterCheck = Effect.fn("desktop.updates.admitAfterCheck")(function* (
    admit: Effect.Effect<"admitted" | "refused" | "wait-for-check">,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const completions = yield* PubSub.subscribe(finishedActions);
        let decision = yield* stateMutex.withPermits(1)(admit);
        while (decision === "wait-for-check") {
          const finished = yield* PubSub.take(completions).pipe(
            Effect.timeoutOption(UPDATE_CHECK_WAIT),
          );
          decision = Option.isNone(finished) ? "refused" : yield* stateMutex.withPermits(1)(admit);
        }
        return decision;
      }),
    );
  });

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (
    reason: string,
    reservation: "acquire" | "held" = "acquire",
  ) {
    if (
      (yield* Ref.get(desktopState.quitting)) ||
      !(yield* Ref.get(configuredRef)) ||
      !assetKey ||
      !installMode ||
      !mechanism
    ) {
      return false;
    }
    const current = yield* Ref.get(updateStateRef);
    if (current.status === "disabled" || current.status === "downloading") return false;
    const baseUrl = current.effectiveReleaseBaseUrl;
    if (!baseUrl) return false;
    if (reservation === "acquire" && !(yield* tryStartUpdateAction("check"))) return false;

    return yield* Effect.gen(function* () {
      if (current.status !== "available" && current.status !== "downloaded") {
        yield* setState(reduceDesktopUpdateStateOnCheckStart(current, yield* currentIsoTimestamp));
      }
      const fetched = yield* releaseClient.fetchLatestManifest(baseUrl);
      const checkedAt = yield* currentIsoTimestamp;
      const asset = fetched.manifest.desktop[assetKey];
      if (
        !isNewerStableVersion(fetched.manifest.version, environment.appVersion) ||
        asset === undefined
      ) {
        yield* Ref.set(offeredReleaseRef, Option.none());
        yield* updateState((s) => reduceDesktopUpdateStateOnNoUpdate(s, checkedAt));
        return true;
      }
      const downloadUrl = resolveReleaseAssetUrl(
        baseUrl,
        fetched.manifest.version,
        asset.fileName,
        fetched.matchedManifestUrl,
      );
      yield* Ref.set(
        offeredReleaseRef,
        Option.some({
          version: fetched.manifest.version,
          assetKey,
          installMode,
          mechanism,
          asset,
          downloadUrl,
        }),
      );
      const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
        fetched.manifest.notes,
        fetched.manifest.version,
        fetched.manifest.publishedAt,
      );
      yield* updateState((s) =>
        reduceDesktopUpdateStateOnUpdateAvailable(
          s,
          fetched.manifest.version,
          checkedAt,
          releaseNotes,
          omittedReleaseCount,
        ),
      );
      return true;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const failedAt = yield* currentIsoTimestamp;
          const reasonMessage =
            error instanceof Error ? redactMessage(error.message) : "Update check failed.";
          yield* updateState((s) =>
            reduceDesktopUpdateStateOnCheckFailure(s, reasonMessage, failedAt),
          );
          yield* logUpdaterError(reasonMessage, { reason, cause: describeUpdateErrorCause(error) });
          return true;
        }),
      ),
      Effect.ensuring(reservation === "acquire" ? finishUpdateAction("check") : Effect.void),
    );
  });

  const downloadAvailableUpdate = Effect.fn("desktop.updates.download")(function* (
    waitForCheck: boolean,
  ) {
    const admit = Effect.gen(function* () {
      const state = yield* Ref.get(updateStateRef);
      const active = yield* Ref.get(activeUpdateActionRef);
      if ((yield* Ref.get(desktopState.quitting)) || !(yield* Ref.get(configuredRef)))
        return "refused" as const;
      if (Option.isSome(active))
        return active.value === "check" ? ("wait-for-check" as const) : ("refused" as const);
      if (state.status !== "available" || Option.isNone(yield* Ref.get(offeredReleaseRef)))
        return "refused" as const;
      return (yield* tryStartUpdateAction("download"))
        ? ("admitted" as const)
        : ("refused" as const);
    });
    const decision = waitForCheck
      ? yield* admitAfterCheck(admit)
      : yield* stateMutex.withPermits(1)(admit);
    if (decision !== "admitted") return { accepted: false, completed: false };

    return yield* Effect.gen(function* () {
      const offered = Option.getOrThrow(yield* Ref.get(offeredReleaseRef));
      yield* updateState(reduceDesktopUpdateStateOnDownloadStart);
      const targetDir = environment.path.join(environment.stateDir, "updates", offered.version);
      const filePath = yield* releaseClient.downloadAsset({
        url: offered.downloadUrl,
        targetDir,
        asset: offered.asset,
        onProgress: (percent) =>
          Ref.get(updateStateRef).pipe(
            Effect.flatMap((s) =>
              shouldBroadcastDownloadProgress(s, percent)
                ? updateState((curr) =>
                    reduceDesktopUpdateStateOnDownloadProgress(curr, percent),
                  ).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
      });
      yield* Ref.set(
        downloadedArtifactRef,
        Option.some({
          version: offered.version,
          installMode: offered.installMode,
          mechanism: offered.mechanism,
          asset: offered.asset,
          filePath,
        }),
      );
      yield* updateState((s) => reduceDesktopUpdateStateOnDownloadComplete(s, offered.version));
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message =
            error instanceof Error ? redactMessage(error.message) : "Failed to download update.";
          yield* updateState((s) => reduceDesktopUpdateStateOnDownloadFailure(s, message));
          yield* logUpdaterError(message, { cause: describeUpdateErrorCause(error) });
          return { accepted: true, completed: false };
        }),
      ),
      Effect.ensuring(finishUpdateAction("download")),
    );
  });

  const recoverFailedInstall = Effect.fn("desktop.updates.recoverFailedInstall")(function* (
    message: string,
  ) {
    yield* Ref.set(desktopState.quitting, false);
    yield* clearSelfUpdateMarkers;
    const running = yield* Ref.getAndSet(installRunningBackendsRef, []);
    const instances = (yield* pool.list).filter((i) => running.includes(i));
    yield* Effect.forEach(instances, (i) => i.start, {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.ignore);
    yield* updateState((s) => reduceDesktopUpdateStateOnInstallFailure(s, message));
  });

  const executeInstall = Effect.fn("desktop.updates.executeInstall")(function* (
    expectedVersion?: string,
  ) {
    const decision = yield* admitAfterCheck(
      Effect.gen(function* () {
        const state = yield* Ref.get(updateStateRef);
        const active = yield* Ref.get(activeUpdateActionRef);
        if ((yield* Ref.get(desktopState.quitting)) || !(yield* Ref.get(configuredRef)))
          return "refused" as const;
        if (
          state.downloadedVersion === null ||
          (expectedVersion !== undefined && state.downloadedVersion !== expectedVersion)
        ) {
          return "refused" as const;
        }
        if (Option.isSome(active))
          return active.value === "check" ? ("wait-for-check" as const) : ("refused" as const);
        if (state.status !== "downloaded") return "refused" as const;
        return (yield* tryStartUpdateAction("install"))
          ? ("admitted" as const)
          : ("refused" as const);
      }),
    );
    if (decision !== "admitted") return { accepted: false, completed: false, failed: false };

    const artifactOpt = yield* Ref.get(downloadedArtifactRef);
    if (Option.isNone(artifactOpt)) {
      yield* finishUpdateAction("install");
      return { accepted: false, completed: false, failed: false };
    }
    const artifact = artifactOpt.value;

    if (artifact.mechanism === "manual-installer") {
      return yield* releaseInstaller
        .installAndRelaunch({
          mode: artifact.installMode,
          filePath: artifact.filePath,
          expectedSha256: artifact.asset.sha256,
          expectedSize: artifact.asset.size,
        })
        .pipe(
          Effect.as({ accepted: true, completed: false, failed: false }),
          Effect.catch((error) =>
            updateState((s) =>
              reduceDesktopUpdateStateOnInstallFailure(s, redactMessage(error.message)),
            ).pipe(Effect.as({ accepted: true, completed: false, failed: true })),
          ),
          Effect.ensuring(finishUpdateAction("install")),
        );
    }

    yield* Ref.set(desktopState.quitting, true);
    yield* writeSelfUpdateMarkers(artifact.version);
    const instances = yield* pool.list;
    const running = yield* Effect.filter(instances, (i) =>
      i.snapshot.pipe(Effect.map((s) => s.desiredRunning)),
    );
    yield* Ref.set(installRunningBackendsRef, running);
    yield* Effect.all(
      [
        Effect.forEach(
          instances,
          (i) => i.stop({ timeout: DesktopBackendManager.BACKEND_QUIT_STOP_TIMEOUT }),
          {
            concurrency: "unbounded",
          },
        ),
        sshEnvironment.closeAllTunnels,
      ],
      { concurrency: "unbounded" },
    );

    return yield* releaseInstaller
      .installAndRelaunch({
        mode: artifact.installMode,
        filePath: artifact.filePath,
        expectedSha256: artifact.asset.sha256,
        expectedSize: artifact.asset.size,
      })
      .pipe(
        Effect.as({ accepted: true, completed: true, failed: false }),
        Effect.catch((error) =>
          recoverFailedInstall(redactMessage(error.message)).pipe(
            Effect.as({ accepted: true, completed: false, failed: true }),
          ),
        ),
        Effect.ensuring(finishUpdateAction("install")),
      );
  });

  const installWithExpectedVersion = Effect.fn("desktop.updates.install")(function* (
    expectedVersion?: string,
  ) {
    if (yield* Ref.get(desktopState.quitting)) {
      return {
        accepted: false,
        completed: false,
        failed: false,
        state: yield* Ref.get(updateStateRef),
      };
    }
    const retained = yield* Ref.get(updateStateRef);
    const artifactOpt = yield* Ref.get(downloadedArtifactRef);
    let targetVersion = expectedVersion;

    if (
      retained.downloadedVersion !== null &&
      Option.isSome(artifactOpt) &&
      !(yield* releaseClient.verifyFileSha256(
        artifactOpt.value.filePath,
        artifactOpt.value.asset.sha256,
        artifactOpt.value.asset.size,
      ))
    ) {
      yield* Ref.set(downloadedArtifactRef, Option.none());
      yield* updateState(reduceDesktopUpdateStateOnDownloadLost);
      const download = yield* downloadAvailableUpdate(true);
      if (!download.completed) {
        return {
          accepted: download.accepted,
          completed: false,
          failed: download.accepted,
          state: yield* Ref.get(updateStateRef),
        };
      }
      if (expectedVersion !== undefined) {
        targetVersion = (yield* Ref.get(updateStateRef)).downloadedVersion ?? expectedVersion;
      }
    } else if (
      retained.downloadedVersion !== null &&
      (expectedVersion === undefined || retained.downloadedVersion === expectedVersion) &&
      (yield* checkForUpdates("install", "acquire")) &&
      (yield* Ref.get(updateStateRef)).status === "available"
    ) {
      const refreshed = yield* Ref.get(updateStateRef);
      if (
        refreshed.availableVersion === null ||
        compareSemverVersions(refreshed.availableVersion, retained.downloadedVersion) <= 0
      ) {
        yield* setState(retained);
      } else {
        const download = yield* downloadAvailableUpdate(false);
        if (!download.completed) {
          return {
            accepted: download.accepted,
            completed: false,
            failed: download.accepted,
            state: yield* Ref.get(updateStateRef),
          };
        }
        if (expectedVersion !== undefined) {
          targetVersion = (yield* Ref.get(updateStateRef)).downloadedVersion ?? expectedVersion;
        }
      }
    }
    const result = yield* executeInstall(targetVersion);
    return { ...result, state: yield* Ref.get(updateStateRef) };
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    isActionActive: Ref.get(activeUpdateActionRef).pipe(Effect.map(Option.isSome)),
    isInstallActive: Ref.get(activeUpdateActionRef).pipe(
      Effect.map((a) => Option.isSome(a) && a.value === "install"),
    ),
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        return {
          latest: yield* Ref.get(updateStateRef),
          changes: Stream.fromSubscription(yield* PubSub.subscribe(stateChanges)),
        };
      }),
    ),
    emitState,
    disabledReason: Ref.get(updateStateRef).pipe(
      Effect.map((s) => resolveBaseConfig(s.mirrorUrl ?? null).disabledReason),
    ),
    configure: Effect.gen(function* () {
      yield* Ref.set(notAppliedVersionRef, yield* readNotAppliedInstallVersion);
      const settings = yield* desktopSettings.get;
      const base = yield* makeBaseState(settings.updateMirrorUrl);
      yield* Ref.set(desktopState.canInstallUpdates, base.enabled);
      yield* setState(base);
      yield* Ref.set(configuredRef, true);
      if (!base.enabled) return;

      yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
        Effect.andThen(checkForUpdates("startup")),
        Effect.catchCause((c) =>
          Cause.hasInterruptsOnly(c)
            ? Effect.void
            : logUpdaterError("Startup update check failed."),
        ),
        Effect.forkScoped,
      );
      yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
        Effect.andThen(checkForUpdates("poll")),
        Effect.forever,
        Effect.catchCause((c) =>
          Cause.hasInterruptsOnly(c)
            ? Effect.void
            : logUpdaterError("Periodic update poll failed."),
        ),
        Effect.forkScoped,
      );
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setMirrorUrl: Effect.fn("desktop.updates.setMirrorUrl")(function* (mirrorUrl) {
      if (policy.mode === "off" || policy.feedUrl !== undefined) {
        return yield* new DesktopUpdateMirrorInvalidError({
          reason: policy.message ?? "Updates are managed by your administrator.",
        });
      }
      const trimmed = mirrorUrl?.trim() || null;
      if (trimmed !== null) {
        const validated = resolveMirrorUrlOverride(trimmed);
        if (validated._tag !== "url") {
          return yield* new DesktopUpdateMirrorInvalidError({
            reason: "Mirror URL must be a valid https:// URL (or http://localhost).",
          });
        }
      }
      const busy = yield* Ref.modify(activeUpdateActionRef, (active) =>
        Option.isSome(active)
          ? ([active, active] as const)
          : ([Option.none<UpdateAction>(), Option.some<UpdateAction>("mirror")] as const),
      ).pipe(
        Effect.repeat({
          while: (active) => Option.isSome(active) && active.value === "check",
          schedule: Schedule.spaced(MIRROR_CHANGE_RETRY_DELAY),
          times: MIRROR_CHANGE_RETRIES,
        }),
      );
      if (Option.isSome(busy)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: busy.value === "install-recovery" ? "install" : busy.value,
        });
      }
      return yield* Effect.gen(function* () {
        const persisted = yield* desktopSettings
          .setUpdateMirrorUrl(trimmed)
          .pipe(Effect.mapError((cause) => new DesktopUpdateMirrorPersistenceError({ cause })));
        yield* Ref.set(offeredReleaseRef, Option.none());
        yield* Ref.set(downloadedArtifactRef, Option.none());
        const nextBase = yield* makeBaseState(persisted.settings.updateMirrorUrl);
        yield* Ref.set(desktopState.canInstallUpdates, nextBase.enabled);
        yield* setState(nextBase);
        if (nextBase.enabled) {
          yield* checkForUpdates("mirror-change", "held");
        }
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("mirror")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason) {
      const checked = yield* checkForUpdates(reason, "acquire");
      return { checked, state: yield* Ref.get(updateStateRef) };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate(true);
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: installWithExpectedVersion().pipe(
      Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
    ),
    installPrepared: Effect.fn("DesktopUpdates.installPrepared")((expectedVersion) =>
      installWithExpectedVersion(expectedVersion),
    ),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
