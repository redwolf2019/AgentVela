import { AppState, Platform } from "react-native";

import { loadPreferences } from "../../persistence/imperative";

const STARTUP_CHECK_DELAY_MS = 15_000;
const FOREGROUND_RECHECK_AFTER_MS = 4 * 60 * 60 * 1000;

export function isAppUpdateCheckAvailable(platform: string = Platform.OS): boolean {
  return platform === "android" && !(typeof __DEV__ !== "undefined" && __DEV__);
}

async function readUserMirrorUrl(): Promise<string | null> {
  try {
    const prefs = await loadPreferences();
    return prefs.updateMirrorUrl ?? null;
  } catch {
    return null;
  }
}

export interface InstallAppUpdateChecksOptions {
  readonly isAvailable?: () => boolean;
  readonly now?: () => number;
  readonly runCheck?: () => Promise<unknown>;
  readonly startupDelayMs?: number;
  readonly foregroundRecheckAfterMs?: number;
}

export function installAppUpdateChecks(options: InstallAppUpdateChecksOptions = {}): () => void {
  const isAvailable = options.isAvailable ?? (() => isAppUpdateCheckAvailable());
  if (!isAvailable()) {
    return () => undefined;
  }

  const now = options.now ?? Date.now;
  const startupDelayMs = options.startupDelayMs ?? STARTUP_CHECK_DELAY_MS;
  const foregroundRecheckAfterMs = options.foregroundRecheckAfterMs ?? FOREGROUND_RECHECK_AFTER_MS;
  const runCheck =
    options.runCheck ??
    (async () => {
      const [{ defaultAndroidReleaseUpdater }, userMirrorUrl] = await Promise.all([
        import("./android-release-updater"),
        readUserMirrorUrl(),
      ]);
      await defaultAndroidReleaseUpdater.checkForUpdate({ userMirrorUrl });
    });

  let disposed = false;
  let backgroundedAtMs: number | null = null;
  const startupTimer = setTimeout(() => {
    if (!disposed) void runCheck();
  }, startupDelayMs);

  const subscription = AppState.addEventListener("change", (nextState) => {
    if (nextState === "background") {
      backgroundedAtMs = now();
      return;
    }
    if (nextState !== "active") return;
    const elapsed = backgroundedAtMs === null ? 0 : now() - backgroundedAtMs;
    backgroundedAtMs = null;
    if (elapsed >= foregroundRecheckAfterMs) {
      void runCheck();
    }
  });

  return () => {
    disposed = true;
    clearTimeout(startupTimer);
    subscription.remove();
  };
}
