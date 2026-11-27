import {
  ServerCheckForUpdateError,
  type ServerCheckForUpdateInput,
  type ServerConfigStreamUpdateStateUpdatedEvent,
  type ServerUpdateState,
  managedUpdatesMessage,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CLI_RELEASE_BASE_URL_ENV, CLI_RELEASES_PAGE_URL } from "@t3tools/shared/cliRelease";
import {
  isNewerStableVersion,
  parseReleaseManifestJson,
  resolveEffectiveReleaseBaseUrl,
  resolveReleaseManifestUrls,
  type ReleaseManifest,
} from "@t3tools/shared/releaseManifest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { managedUpdateMirror } from "../policy/managedUpdates.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";

const STARTUP_CHECK_DELAY = Duration.seconds(15);
const POLL_CHECK_INTERVAL = Duration.hours(4);
const MANIFEST_REQUEST_TIMEOUT = Duration.seconds(15);
const AUTO_UPDATE_DISABLE_ENV = "T3CODE_DISABLE_AUTO_UPDATE";

export interface ServerReleaseMonitorOptions {
  readonly currentVersion?: string;
  readonly isDevBuild?: boolean;
  readonly startupDelay?: Duration.Input;
  readonly pollInterval?: Duration.Input;
}

export class ServerReleaseMonitor extends Context.Service<
  ServerReleaseMonitor,
  {
    readonly getState: Effect.Effect<ServerUpdateState>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerUpdateState>, never, Scope.Scope>;
    readonly checkNow: (
      input?: ServerCheckForUpdateInput,
    ) => Effect.Effect<ServerUpdateState, ServerCheckForUpdateError>;
  }
>()("t3/cloud/serverReleaseMonitor") {}

function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function sanitizeReleaseTagUrl(baseUrl: string, tag: string): string {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return CLI_RELEASES_PAGE_URL;
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${cleanPath}/tag/${encodeURIComponent(tag)}`;
  } catch {
    return CLI_RELEASES_PAGE_URL;
  }
}

function redactRequestHost(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function describeFetchError(error: HttpClientError.HttpClientError, url: string): string {
  const host = redactRequestHost(url) ?? "the release server";
  if (error.reason._tag === "StatusCodeError") {
    return `Could not read release manifest from ${host} (HTTP ${error.reason.response.status}).`;
  }
  return `Could not reach ${host} to check for server updates.`;
}

function resolveAutoCheckEnabled(input: {
  readonly mode: ServerConfig.RuntimeMode;
  readonly isDevBuild: boolean;
  readonly currentVersion: string;
  readonly disabledByEnv: boolean;
  readonly managedUpdatesMode: "auto" | "off" | undefined;
  readonly releaseSourceDisabled: boolean;
}): boolean {
  if (input.mode === "desktop") return false;
  if (input.isDevBuild || input.currentVersion === "0.0.0") return false;
  if (input.disabledByEnv) return false;
  if (input.managedUpdatesMode === "off" || input.releaseSourceDisabled) return false;
  return true;
}

function formatBaseUrlError(
  resolved: Extract<ReturnType<typeof resolveEffectiveReleaseBaseUrl>, { readonly ok: false }>,
  organization: string | undefined,
): string {
  if (resolved.reason === "disabled") {
    return resolved.source === "policy" && organization !== undefined
      ? managedUpdatesMessage(organization)
      : "Release update checks are turned off by configuration.";
  }
  return resolved.source === "user"
    ? "The configured update mirror URL is invalid."
    : `The ${resolved.source} release mirror URL is invalid.`;
}

function stateEquals(a: ServerUpdateState, b: ServerUpdateState): boolean {
  return (
    a.enabled === b.enabled &&
    a.status === b.status &&
    a.currentVersion === b.currentVersion &&
    a.latestVersion === b.latestVersion &&
    a.releaseNotes === b.releaseNotes &&
    a.releaseUrl === b.releaseUrl &&
    a.checkedAt === b.checkedAt &&
    a.errorMessage === b.errorMessage &&
    a.canSelfUpdate === b.canSelfUpdate
  );
}

const fetchManifestFromCandidateUrls = Effect.fn("ServerReleaseMonitor.fetchManifest")(function* (
  httpClient: HttpClient.HttpClient,
  urls: ReadonlyArray<string>,
): Effect.fn.Return<
  { readonly manifest: ReleaseManifest; readonly matchedUrl: string },
  ServerCheckForUpdateError
> {
  let lastErrorMessage = "Could not read a valid release manifest.";
  for (const url of urls) {
    const responseResult = yield* httpClient
      .get(url)
      .pipe(Effect.timeout(MANIFEST_REQUEST_TIMEOUT), Effect.result);
    if (responseResult._tag === "Failure") {
      const error = responseResult.failure;
      lastErrorMessage =
        error._tag === "TimeoutError"
          ? `Timed out checking ${redactRequestHost(url) ?? "the release server"} for updates.`
          : describeFetchError(error, url);
      continue;
    }
    const response = responseResult.success;
    if (response.status === 404) {
      lastErrorMessage = `No release manifest was found at ${redactRequestHost(url) ?? "the release server"}.`;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      lastErrorMessage = `Could not read release manifest from ${redactRequestHost(url) ?? "the release server"} (HTTP ${response.status}).`;
      continue;
    }
    const textResult = yield* response.text.pipe(
      Effect.timeout(MANIFEST_REQUEST_TIMEOUT),
      Effect.result,
    );
    if (textResult._tag === "Failure") {
      lastErrorMessage = `Could not read release manifest body from ${redactRequestHost(url) ?? "the release server"}.`;
      continue;
    }
    const parsed = parseReleaseManifestJson(textResult.success);
    if (!parsed.ok) {
      lastErrorMessage = `Release manifest from ${redactRequestHost(url) ?? "the release server"} was malformed.`;
      continue;
    }
    return { manifest: parsed.manifest, matchedUrl: url };
  }
  return yield* new ServerCheckForUpdateError({ reason: lastErrorMessage });
});

export function toUpdateStateUpdatedEvent(
  updateState: ServerUpdateState,
): ServerConfigStreamUpdateStateUpdatedEvent {
  return {
    version: 1,
    type: "updateStateUpdated",
    payload: { updateState },
  };
}

export const make = Effect.fn("ServerReleaseMonitor.make")(function* (
  options: ServerReleaseMonitorOptions = {},
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;

  const currentVersion = options.currentVersion ?? packageJson.version;
  const isDevBuild =
    options.isDevBuild ??
    (ServerConfig.telemetryChannel === "dev" || serverConfig.devUrl !== undefined);
  const mirror = managedUpdateMirror(policy.document);
  const envReleaseBaseUrl = environment[CLI_RELEASE_BASE_URL_ENV];
  const disabledByEnv = isTruthyEnvFlag(environment[AUTO_UPDATE_DISABLE_ENV]);
  const managedUpdatesMode = policy.document?.limits?.updates?.mode;
  const canSelfUpdate = serverConfig.mode !== "desktop" && launcher.managed;

  const resolveReleaseBase = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ updateMirrorUrl: null as string | null })),
    );
    return resolveEffectiveReleaseBaseUrl({
      managedFeedUrl: mirror?.feedUrl,
      envReleaseBaseUrl,
      userMirrorUrl: settings.updateMirrorUrl,
    });
  });

  const initialBase = yield* resolveReleaseBase;
  const initialEnabled = resolveAutoCheckEnabled({
    mode: serverConfig.mode,
    isDevBuild,
    currentVersion,
    disabledByEnv,
    managedUpdatesMode,
    releaseSourceDisabled: !initialBase.ok && initialBase.reason === "disabled",
  });

  const stateRef = yield* Ref.make<ServerUpdateState>({
    enabled: initialEnabled,
    status: "idle",
    currentVersion,
    latestVersion: null,
    checkedAt: null,
    canSelfUpdate,
  });
  const changesPubSub = yield* PubSub.unbounded<ServerUpdateState>();
  const checkSemaphore = yield* Semaphore.make(1);

  const publishState = Effect.fn("ServerReleaseMonitor.publishState")(function* (
    next: ServerUpdateState,
  ) {
    const changed = yield* Ref.modify(stateRef, (prev) =>
      stateEquals(prev, next) ? [false, prev] : [true, next],
    );
    if (changed) {
      yield* PubSub.publish(changesPubSub, next);
    }
    return next;
  });

  const runCheck = Effect.fn("ServerReleaseMonitor.runCheck")(function* () {
    const resolvedBase = yield* resolveReleaseBase;
    const enabled = resolveAutoCheckEnabled({
      mode: serverConfig.mode,
      isDevBuild,
      currentVersion,
      disabledByEnv,
      managedUpdatesMode,
      releaseSourceDisabled: !resolvedBase.ok && resolvedBase.reason === "disabled",
    });

    if (managedUpdatesMode === "off" && policy.document !== undefined) {
      return yield* new ServerCheckForUpdateError({
        reason: managedUpdatesMessage(policy.document.organization),
      });
    }
    if (!resolvedBase.ok) {
      return yield* new ServerCheckForUpdateError({
        reason: formatBaseUrlError(resolvedBase, policy.document?.organization),
      });
    }

    const previous = yield* Ref.get(stateRef);
    yield* publishState({
      enabled,
      status: "checking",
      currentVersion,
      latestVersion: previous.latestVersion,
      ...(previous.releaseNotes === undefined ? {} : { releaseNotes: previous.releaseNotes }),
      ...(previous.releaseUrl === undefined ? {} : { releaseUrl: previous.releaseUrl }),
      checkedAt: previous.checkedAt,
      canSelfUpdate,
    });

    const manifestUrls = resolveReleaseManifestUrls(resolvedBase.url);
    const result = yield* fetchManifestFromCandidateUrls(httpClient, manifestUrls).pipe(
      Effect.result,
    );
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (result._tag === "Failure") {
      const reason = result.failure.reason.trim().slice(0, 500) || "Release update check failed.";
      yield* publishState({
        enabled,
        status: "error",
        currentVersion,
        latestVersion: previous.latestVersion,
        ...(previous.releaseNotes === undefined ? {} : { releaseNotes: previous.releaseNotes }),
        ...(previous.releaseUrl === undefined ? {} : { releaseUrl: previous.releaseUrl }),
        checkedAt,
        errorMessage: reason,
        canSelfUpdate,
      });
      return yield* result.failure;
    }

    const { manifest } = result.success;
    const isAvailable = isNewerStableVersion(manifest.version, currentVersion);
    const releaseUrl = sanitizeReleaseTagUrl(resolvedBase.url, manifest.tag);
    const releaseNotes = manifest.notes && manifest.notes.length > 0 ? manifest.notes : undefined;

    return yield* publishState({
      enabled,
      status: isAvailable ? "available" : "up-to-date",
      currentVersion,
      latestVersion: manifest.version,
      ...(releaseNotes === undefined ? {} : { releaseNotes }),
      releaseUrl,
      checkedAt,
      canSelfUpdate,
    });
  });

  const checkNow: ServerReleaseMonitor["Service"]["checkNow"] = Effect.fn(
    "ServerReleaseMonitor.checkNow",
  )(function* (_input) {
    return yield* checkSemaphore.withPermits(1)(runCheck());
  });

  if (initialEnabled) {
    const startupDelay = options.startupDelay ?? STARTUP_CHECK_DELAY;
    const pollInterval = options.pollInterval ?? POLL_CHECK_INTERVAL;
    const backgroundCheck = checkSemaphore
      .withPermits(1)(runCheck())
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("Background server update check failed", { cause }),
        ),
      );
    yield* Effect.sleep(startupDelay).pipe(
      Effect.andThen(backgroundCheck),
      Effect.andThen(
        Effect.forever(Effect.sleep(pollInterval).pipe(Effect.andThen(backgroundCheck))),
      ),
      Effect.forkScoped,
    );
  }

  return ServerReleaseMonitor.of({
    getState: Ref.get(stateRef),
    subscribeChanges: PubSub.subscribe(changesPubSub).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
    checkNow,
  });
});

export const layer = Layer.effect(ServerReleaseMonitor, make());

export const layerTest = (overrides: Partial<ServerReleaseMonitor["Service"]> = {}) =>
  Layer.succeed(
    ServerReleaseMonitor,
    ServerReleaseMonitor.of({
      getState: Effect.succeed({
        enabled: false,
        status: "idle",
        currentVersion: packageJson.version,
        latestVersion: null,
        checkedAt: null,
        canSelfUpdate: false,
      }),
      subscribeChanges: Effect.succeed(Stream.empty),
      checkNow: Effect.fn("ServerReleaseMonitor.checkNow")(() =>
        Effect.fail(
          new ServerCheckForUpdateError({
            reason: "Release checks are unavailable in test mode.",
          }),
        ),
      ),
      ...overrides,
    }),
  );
