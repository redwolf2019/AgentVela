import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AppState } from "react-native";

vi.mock("../../persistence/imperative", () => ({
  loadPreferences: vi.fn(async () => ({})),
}));

import { installAppUpdateChecks, isAppUpdateCheckAvailable } from "./app-updates";

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    currentState: "active",
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

describe("app-updates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("enables update checks on Android release builds only", () => {
    expect(isAppUpdateCheckAvailable("android")).toBe(true);
    expect(isAppUpdateCheckAvailable("ios")).toBe(false);
  });

  it("runs a delayed startup check and re-checks after 4 hours in the background", async () => {
    let listener: ((state: string) => void) | undefined;
    const remove = vi.fn();
    vi.mocked(AppState.addEventListener).mockImplementation((_type, fn) => {
      listener = fn as (state: string) => void;
      return { remove };
    });

    let currentMs = 1_000_000;
    const runCheck = vi.fn(async () => {});
    const dispose = installAppUpdateChecks({
      isAvailable: () => true,
      now: () => currentMs,
      runCheck,
      startupDelayMs: 15_000,
      foregroundRecheckAfterMs: 4 * 60 * 60 * 1000,
    });

    expect(runCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runCheck).toHaveBeenCalledTimes(1);

    listener?.("background");
    currentMs += 60 * 60 * 1000;
    listener?.("active");
    expect(runCheck).toHaveBeenCalledTimes(1);

    listener?.("background");
    currentMs += 4 * 60 * 60 * 1000;
    listener?.("active");
    expect(runCheck).toHaveBeenCalledTimes(2);

    dispose();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("returns a no-op disposer when unavailable", () => {
    const runCheck = vi.fn(async () => {});
    const dispose = installAppUpdateChecks({
      isAvailable: () => false,
      runCheck,
    });
    vi.advanceTimersByTime(60_000);
    dispose();
    expect(runCheck).not.toHaveBeenCalled();
  });
});
