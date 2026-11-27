import { assert, describe, it } from "@effect/vitest";
import { DESKTOP_UPDATE_RESTART_MARKER_FILE, DesktopUpdateStateSchema } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopReleaseClient from "./DesktopReleaseClient.ts";
import * as DesktopReleaseInstaller from "./DesktopReleaseInstaller.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness, makeSampleManifest } from "./updatesTestHarness.ts";

const encodeUpdateState = Schema.encodeEffect(DesktopUpdateStateSchema);

describe("DesktopUpdates", () => {
  it.effect("updates Linux .deb and AppImage installs and disables other Linux packages", () =>
    Effect.gen(function* () {
      const checkPlatform = (opts: { packageType?: string; env?: Record<string, string> }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            const desktopState = yield* DesktopState.DesktopState;
            yield* updates.configure;
            return {
              state: yield* updates.getState,
              canInstall: yield* Ref.get(desktopState.canInstallUpdates),
            };
          }),
        ).pipe(
          Effect.provide(
            Layer.merge(TestClock.layer(), makeHarness({ platform: "linux", ...opts }).layer),
          ),
        );

      const deb = yield* checkPlatform({ packageType: "deb" });
      assert.equal(deb.state.status, "idle");
      assert.equal(deb.state.installMode, "deb");
      assert.equal(deb.state.mechanism, "self-update");
      assert.isTrue(deb.canInstall);

      const appImage = yield* checkPlatform({ env: { APPIMAGE: "/opt/AgentVela.AppImage" } });
      assert.equal(appImage.state.status, "idle");
      assert.equal(appImage.state.installMode, "appimage");
      assert.equal(appImage.state.mechanism, "self-update");
      assert.isTrue(appImage.canInstall);

      const tarLinux = yield* checkPlatform({});
      assert.equal(tarLinux.state.status, "disabled");
      assert.include(tarLinux.state.message ?? "", "AppImage or the .deb");
      assert.isFalse(tarLinux.canInstall);
    }),
  );

  it.effect("checks after startup delay and then every four hours", () => {
    const harness = makeHarness({ env: { APPIMAGE: "/opt/AgentVela.AppImage" } });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* flushCallbacks;
        assert.equal(harness.checkCount(), 0);

        yield* TestClock.adjust(Duration.seconds(15));
        yield* flushCallbacks;
        assert.equal(harness.checkCount(), 1);
        assert.equal((yield* updates.getState).status, "available");
        assert.equal((yield* updates.getState).availableVersion, "1.2.4");

        yield* TestClock.adjust(Duration.hours(4));
        yield* flushCallbacks;
        assert.equal(harness.checkCount(), 2);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "downloads update with progress and executes self-update install with backend stop",
    () => {
      const harness = makeHarness({ env: { APPIMAGE: "/opt/AgentVela.AppImage" } });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.check("manual");
          const download = yield* updates.download;
          assert.isTrue(download.accepted);
          assert.isTrue(download.completed);
          assert.equal(download.state.status, "downloaded");
          assert.equal(download.state.downloadedVersion, "1.2.4");
          assert.isNotEmpty(harness.sentStates.filter((s) => s.status === "downloading"));

          const encoded = yield* encodeUpdateState(download.state);
          assert.equal(encoded.installMode, "appimage");
          assert.equal(encoded.mechanism, "self-update");

          const install = yield* updates.install;
          assert.isTrue(install.accepted);
          assert.isTrue(install.completed);
          assert.equal(harness.updateRestartMarkers.size, 1);
          assert.isTrue(
            [...harness.updateRestartMarkers][0]?.endsWith(DESKTOP_UPDATE_RESTART_MARKER_FILE),
          );
          assert.isDefined(harness.updateInProgressMarker());
          assert.equal(harness.installRecords.size, 1);
          assert.deepEqual(harness.installSteps, [
            "stopBackend",
            "closeSshTunnels",
            "install:appimage",
          ]);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect("handles macOS dmg as manual-installer without quitting or stopping backends", () => {
    const harness = makeHarness({ platform: "darwin", processArch: "arm64" });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const desktopState = yield* DesktopState.DesktopState;
        yield* updates.configure;
        assert.equal((yield* updates.getState).installMode, "dmg");
        assert.equal((yield* updates.getState).mechanism, "manual-installer");

        yield* updates.check("manual");
        yield* updates.download;
        const install = yield* updates.install;

        assert.isTrue(install.accepted);
        assert.isFalse(install.completed);
        assert.equal(install.state.status, "downloaded");
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.equal(harness.updateRestartMarkers.size, 0);
        assert.equal(harness.installRecords.size, 0);
        assert.deepEqual(harness.installSteps, ["install:dmg"]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("re-downloads when cached update file was removed before install", () => {
    const harness = makeHarness({ env: { APPIMAGE: "/opt/AgentVela.AppImage" } });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("manual");
        yield* updates.download;
        assert.equal(harness.downloadCount(), 1);

        const env = yield* DesktopEnvironment.DesktopEnvironment;
        harness.deletedFiles.add(`${env.stateDir}/updates/1.2.4/AgentVela-1.2.4-x86_64.AppImage`);
        const install = yield* updates.install;
        assert.isTrue(install.accepted);
        assert.equal(harness.downloadCount(), 2);
        assert.equal(harness.installCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "replaces downloaded build when a newer stable release is published before install",
    () => {
      let manifestVersion = "1.2.4";
      const harness = makeHarness({
        env: { APPIMAGE: "/opt/AgentVela.AppImage" },
        fetchManifest: (baseUrl) =>
          Effect.succeed({
            manifest: makeSampleManifest(manifestVersion),
            matchedManifestUrl: `${baseUrl}/latest/download/release-manifest.json`,
          }),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.check("manual");
          yield* updates.download;
          assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");

          manifestVersion = "1.2.5";
          const install = yield* updates.install;
          assert.isTrue(install.accepted);
          assert.equal(install.state.downloadedVersion, "1.2.5");
          assert.equal(harness.downloadCount(), 2);
          assert.equal(harness.installCount(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect("recovers only desiredRunning backends and clears markers on failed install", () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const makeInstance = (id: DesktopBackendPool.BackendInstanceId, initiallyRunning: boolean) => {
      let desiredRunning = initiallyRunning;
      return {
        id,
        label: Effect.succeed(id),
        currentConfig: Effect.succeedNone,
        start: Effect.sync(() => {
          starts.push(id);
          desiredRunning = true;
        }),
        stop: () =>
          Effect.sync(() => {
            stops.push(id);
            desiredRunning = false;
          }),
        snapshot: Effect.sync(() => ({
          desiredRunning,
          ready: false,
          activePid: Option.none(),
          restartAttempt: 0,
          restartScheduled: false,
        })),
        waitForReady: () => Effect.succeed(true),
      } satisfies DesktopBackendPool.DesktopBackendInstance;
    };
    const primary = makeInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, false);
    const wsl = makeInstance(DesktopBackendPool.BackendInstanceId("wsl:default"), true);
    const harness = makeHarness({
      env: { APPIMAGE: "/opt/AgentVela.AppImage" },
      backendInstances: [primary, wsl],
      installAndRelaunch: () =>
        Effect.fail(
          new DesktopReleaseInstaller.DesktopReleaseInstallError({
            mode: "appimage",
            reason: "installer refused",
          }),
        ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const desktopState = yield* DesktopState.DesktopState;
        yield* updates.configure;
        yield* updates.check("manual");
        yield* updates.download;
        const install = yield* updates.install;

        assert.isTrue(install.accepted);
        assert.isFalse(install.completed);
        assert.equal(install.state.errorContext, "install");
        assert.equal(install.state.message, "installer refused");
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.equal(harness.updateRestartMarkers.size, 0);
        assert.isUndefined(harness.updateInProgressMarker());
        assert.sameMembers(stops, [primary.id, wsl.id]);
        assert.deepEqual(starts, [wsl.id]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("flags installs that relaunch onto the same version and clears once applied", () =>
    Effect.gen(function* () {
      const record = JSON.stringify({ fromVersion: "1.2.3", targetVersion: "1.2.4" });
      const staleHarness = makeHarness({
        env: { APPIMAGE: "/opt/AgentVela.AppImage" },
        appVersion: "1.2.3",
        installRecord: record,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.equal((yield* updates.getState).notAppliedVersion, "1.2.4");
          const checked = yield* updates.check("manual");
          assert.equal(checked.state.notAppliedVersion, "1.2.4");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), staleHarness.layer)));

      const appliedHarness = makeHarness({
        env: { APPIMAGE: "/opt/AgentVela.AppImage" },
        appVersion: "1.2.4",
        installRecord: record,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.isUndefined((yield* updates.getState).notAppliedVersion);
          assert.isUndefined(appliedHarness.previousInstallRecord());
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), appliedHarness.layer)));
    }),
  );

  it.effect(
    "persists valid update mirror URLs, rejects invalid URLs, and respects managed policy",
    () => {
      const harness = makeHarness({ env: { APPIMAGE: "/opt/AgentVela.AppImage" } });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const next = yield* updates.setMirrorUrl("https://mirror.example.com/releases");
          assert.equal(next.mirrorUrl, "https://mirror.example.com/releases");
          assert.equal(next.effectiveReleaseBaseUrl, "https://mirror.example.com/releases");
          assert.equal(
            harness.savedSettings().updateMirrorUrl,
            "https://mirror.example.com/releases",
          );
          assert.deepEqual(harness.fetchedBaseUrls(), ["https://mirror.example.com/releases"]);

          const invalid = yield* updates
            .setMirrorUrl("http://insecure.example.com/releases")
            .pipe(Effect.flip);
          assert.include(invalid.message, "https://");

          const reset = yield* updates.setMirrorUrl(null);
          assert.isNull(reset.mirrorUrl);
          assert.equal(
            reset.effectiveReleaseBaseUrl,
            "https://github.com/redwolf2019/AgentVela/releases",
          );
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect(
    "waits out an in-flight check before updating mirror URL and enforces managed policy",
    () => {
      const checkStarted = Deferred.makeUnsafe<void>();
      const releaseCheck = Deferred.makeUnsafe<void>();
      const harness = makeHarness({
        env: { APPIMAGE: "/opt/AgentVela.AppImage" },
        fetchManifest: (baseUrl) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(checkStarted, undefined);
            yield* Deferred.await(releaseCheck);
            return {
              manifest: makeSampleManifest(),
              matchedManifestUrl: `${baseUrl}/latest/download/release-manifest.json`,
            };
          }),
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const checkFiber = yield* updates.check("manual").pipe(Effect.forkChild);
          yield* Deferred.await(checkStarted);
          const mirrorFiber = yield* updates
            .setMirrorUrl("https://mirror.example.com/releases")
            .pipe(Effect.forkChild);
          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checkFiber);
          const state = yield* Fiber.join(mirrorFiber);
          assert.equal(state.effectiveReleaseBaseUrl, "https://mirror.example.com/releases");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect("redacts failure reasons from manifest checks", () => {
    const harness = makeHarness({
      env: { APPIMAGE: "/opt/AgentVela.AppImage" },
      fetchManifest: () =>
        Effect.fail(
          new DesktopReleaseClient.DesktopReleaseClientError({
            phase: "manifest",
            reason: "Failed GET https://user:secret@example.com/release-manifest.json?token=abc",
          }),
        ),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const checked = yield* updates.check("manual");
        assert.equal(checked.state.status, "error");
        assert.notInclude(checked.state.message ?? "", "secret");
        assert.notInclude(checked.state.message ?? "", "https://");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});

describe("describeUpdateErrorCause", () => {
  it("removes URLs, credentials, response bodies, and headers from summaries", () => {
    const messages = [
      "Cannot download https://user:url-secret@example.com/update?token=query-secret, status 403",
      "Request failed: Bearer bearer-secret",
      "Request failed: Basic basic-secret",
      "Request failed: Authorization: Bearer header-secret",
      "Request failed: Cookie=session-secret",
      "Request failed: api_key=\"key-secret\" password='password-secret' access_token=token-secret",
      '404 Not Found\n{"body":"body-secret"}\nHeaders: cookie=header-secret',
      "Request failed\rHeaders: cookie=header-secret",
    ];

    for (const message of messages) {
      const summary = DesktopUpdates.describeUpdateErrorCause(new Error(message));
      assert.include(summary, "Error:");
      assert.notInclude(summary, "secret");
      assert.notInclude(summary, "https://");
      assert.notInclude(summary, "Headers:");
    }
    assert.equal(
      DesktopUpdates.describeUpdateErrorCause("404 Not Found\nbody-secret"),
      "404 Not Found",
    );
  });

  it("bounds long messages, parallel failures, and cyclic causes", () => {
    const longError = new Error("x".repeat(10_000));
    const parallel = Cause.combine(Cause.fail(longError), Cause.die(longError));
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(parallel).length, 1024);

    const cyclic = new Error("retry failed");
    cyclic.cause = cyclic;
    assert.include(DesktopUpdates.describeUpdateErrorCause(cyclic), "[truncated cause]");
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(cyclic).length, 1024);
  });

  it("does not serialize arbitrary payloads or let unreadable errors break logging", () => {
    assert.equal(DesktopUpdates.describeUpdateErrorCause({ payload: "secret" }), "object");
    const unreadable = Object.defineProperty({}, "message", {
      get() {
        throw new Error("unreadable error");
      },
    });
    assert.equal(DesktopUpdates.describeUpdateErrorCause(unreadable), "UnknownError");
  });
});

describe("DesktopUpdates under a managed policy", () => {
  const message = "Example Corp manages T3 Code updates.";
  const managed = (
    policy: Partial<DesktopUpdatePolicy.UpdatePolicy>,
  ): DesktopUpdatePolicy.UpdatePolicy => ({
    ...DesktopUpdatePolicy.unmanagedUpdatePolicy,
    message,
    ...policy,
  });

  it.effect("never checks when updates are off and ignores user mirror edits", () => {
    const harness = makeHarness({
      env: { APPIMAGE: "/opt/AgentVela.AppImage" },
      policy: managed({ mode: "off" }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust("10 minutes");
        const state = yield* updates.getState;
        assert.equal(state.status, "disabled");
        assert.equal(state.message, message);
        assert.isFalse((yield* updates.check("menu")).checked);
        assert.deepEqual(yield* updates.disabledReason, Option.some(message));
        assert.equal(harness.checkCount(), 0);
        const err = yield* updates.setMirrorUrl("https://evil.example.com").pipe(Effect.flip);
        assert.include(err.message, message);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("prefers administrator feedUrl over mock/user mirror overrides", () => {
    const harness = makeHarness({
      env: {
        APPIMAGE: "/opt/AgentVela.AppImage",
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
      },
      savedMirrorUrl: "https://user-mirror.example.com/releases",
      policy: managed({ feedUrl: "https://updates.example.com/agentvela/releases" }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("manual");
        assert.deepEqual(harness.fetchedBaseUrls(), [
          "https://updates.example.com/agentvela/releases",
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
