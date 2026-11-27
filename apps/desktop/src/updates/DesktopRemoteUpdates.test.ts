import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopTelemetryCancelDesktopUpdate,
  DesktopTelemetryCommitDesktopUpdate,
  DesktopTelemetryRequestDesktopUpdate,
  DesktopUpdateStatusReport,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopReleaseInstaller from "./DesktopReleaseInstaller.ts";
import * as DesktopRemoteUpdates from "./DesktopRemoteUpdates.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness, makeSampleManifest } from "./updatesTestHarness.ts";

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i += 1) {
    yield* Effect.yieldNow;
    yield* Effect.promise(() => Promise.resolve());
  }
});

const request = (
  requestId: string,
  targetVersion?: string,
): DesktopTelemetryRequestDesktopUpdate => ({
  version: 1,
  type: "requestDesktopUpdate",
  requestId,
  ...(targetVersion === undefined ? {} : { targetVersion }),
});

function runRemoteUpdatesTest(
  harness: ReturnType<typeof makeHarness>,
  body: (context: {
    readonly reports: DesktopUpdateStatusReport[];
    readonly requests: Queue.Queue<DesktopTelemetryRequestDesktopUpdate>;
    readonly commits: Queue.Queue<DesktopTelemetryCommitDesktopUpdate>;
    readonly cancellations: Queue.Queue<DesktopTelemetryCancelDesktopUpdate>;
  }) => Effect.Effect<void, never, DesktopUpdates.DesktopUpdates | DesktopState.DesktopState>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<DesktopTelemetryRequestDesktopUpdate>();
      const commits = yield* Queue.unbounded<DesktopTelemetryCommitDesktopUpdate>();
      const cancellations = yield* Queue.unbounded<DesktopTelemetryCancelDesktopUpdate>();
      const reports: DesktopUpdateStatusReport[] = [];
      const publisher = DesktopTelemetryPublisher.DesktopTelemetryPublisher.of({
        latest: Effect.succeedNone,
        changes: Stream.empty,
        encoded: Stream.empty,
        handleControlForSource: () => Effect.void,
        removeControlSource: () => Effect.void,
        publishUpdateReport: (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
        updateRequests: Stream.fromQueue(requests),
        updateCommits: Stream.fromQueue(commits),
        updateCancellations: Stream.fromQueue(cancellations),
      });

      yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* DesktopRemoteUpdates.listen.pipe(Effect.forkScoped);
        yield* settle;
        yield* body({ reports, requests, commits, cancellations });
      }).pipe(
        Effect.provide(
          Layer.merge(
            harness.layer,
            Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, publisher),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(TestClock.layer()));
}

const terminalReports = (reports: readonly DesktopUpdateStatusReport[]) =>
  reports.filter((report) => report.outcome !== undefined);

describe("DesktopRemoteUpdates", () => {
  it.effect("drives check, download, prepare, and commit for self-update platforms", () => {
    const harness = makeHarness({ env: { APPIMAGE: "/opt/AgentVela.AppImage" } });
    return runRemoteUpdatesTest(harness, ({ reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-1", "1.2.4"));
        yield* settle;
        assert.deepEqual(
          terminalReports(reports).map((r) => [r.requestId, r.outcome]),
          [["req-1", "ready-to-install"]],
        );
        assert.equal(harness.installCount(), 0);

        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-1",
        });
        yield* settle;
        assert.equal(harness.installCount(), 1);
      }),
    );
  });

  it.effect("expires stale prepared update after TTL and refuses expired commit", () => {
    const harness = makeHarness({ env: { APPIMAGE: "/opt/AgentVela.AppImage" } });
    return runRemoteUpdatesTest(harness, ({ reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-original", "1.2.4"));
        yield* settle;
        yield* TestClock.adjust(Duration.minutes(4));
        yield* Queue.offer(requests, request("req-retry", "1.2.4"));
        yield* settle;
        assert.equal(terminalReports(reports)[1]?.preparedRequestId, "req-original");

        yield* TestClock.adjust(Duration.minutes(2));
        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-original",
        });
        yield* settle;
        assert.equal(
          terminalReports(reports)[2]?.reason,
          "This desktop update is no longer prepared.",
        );
        assert.equal(harness.installCount(), 0);
      }),
    );
  });

  it.effect(
    "rejects remote commit on macOS manual-installer with drag-to-Applications explanation",
    () => {
      const harness = makeHarness({ platform: "darwin", processArch: "arm64" });
      return runRemoteUpdatesTest(harness, ({ reports, requests, commits }) =>
        Effect.gen(function* () {
          yield* Queue.offer(requests, request("req-mac", "1.2.4"));
          yield* settle;
          assert.equal(terminalReports(reports)[0]?.outcome, "ready-to-install");

          yield* Queue.offer(commits, {
            version: 1,
            type: "commitDesktopUpdate",
            requestId: "req-mac",
          });
          yield* settle;
          const failed = terminalReports(reports)[1];
          assert.equal(failed?.outcome, "failed");
          assert.include(failed?.reason ?? "", "disk image");
          assert.equal(harness.installCount(), 0);
        }),
      );
    },
  );

  it.effect("reports failed outcome when installAndRelaunch fails during commit", () => {
    const harness = makeHarness({
      env: { APPIMAGE: "/opt/AgentVela.AppImage" },
      installAndRelaunch: () =>
        Effect.fail(
          new DesktopReleaseInstaller.DesktopReleaseInstallError({
            mode: "appimage",
            reason: "installer refused",
          }),
        ),
    });
    return runRemoteUpdatesTest(harness, ({ reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-fail", "1.2.4"));
        yield* settle;
        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-fail",
        });
        yield* settle;
        assert.equal(terminalReports(reports).at(-1)?.outcome, "failed");
        assert.equal(terminalReports(reports).at(-1)?.reason, "installer refused");
      }),
    );
  });

  it.effect("cancels an active preparation and blocks commit after cancellation", () => {
    const fetchStarted = Deferred.makeUnsafe<void>();
    const releaseFetch = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      env: { APPIMAGE: "/opt/AgentVela.AppImage" },
      fetchManifest: (baseUrl) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(fetchStarted, undefined);
          yield* Deferred.await(releaseFetch);
          return {
            manifest: makeSampleManifest("1.2.4"),
            matchedManifestUrl: `${baseUrl}/latest/download/release-manifest.json`,
          };
        }),
    });
    return runRemoteUpdatesTest(harness, ({ reports, requests, commits, cancellations }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-cancel", "1.2.4"));
        yield* Deferred.await(fetchStarted);
        yield* Queue.offer(cancellations, {
          version: 1,
          type: "cancelDesktopUpdate",
          requestId: "req-cancel",
        });
        yield* settle;
        yield* Deferred.succeed(releaseFetch, undefined);
        yield* settle;

        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-cancel",
        });
        yield* settle;
        assert.equal(harness.installCount(), 0);
        assert.isUndefined(terminalReports(reports).find((r) => r.outcome === "ready-to-install"));
      }),
    );
  });

  it.effect("reports up-to-date when no newer build is published", () => {
    const harness = makeHarness({
      env: { APPIMAGE: "/opt/AgentVela.AppImage" },
      appVersion: "1.2.4",
    });
    return runRemoteUpdatesTest(harness, ({ reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-current"));
        yield* settle;
        assert.deepEqual(
          terminalReports(reports).map((r) => r.outcome),
          ["up-to-date"],
        );
        assert.equal(harness.installCount(), 0);
      }),
    );
  });
});
