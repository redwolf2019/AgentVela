import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentId } from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";

import {
  linkEnvironmentToCloudWithPreference,
  updateLinkedEnvironmentLiveActivityPreference,
} from "./linkEnvironment";

const savedConnection = {
  environmentId: EnvironmentId.make("env-1"),
  environmentLabel: "Desktop",
  httpBaseUrl: "https://desktop.example.test/",
  wsBaseUrl: "wss://desktop.example.test/ws",
};

const makeSupervisor = (preparedConnection: Option.Option<PreparedConnection>) =>
  Effect.gen(function* () {
    const target = new PrimaryConnectionTarget({
      environmentId: savedConnection.environmentId,
      label: savedConnection.environmentLabel,
      httpBaseUrl: savedConnection.httpBaseUrl,
      wsBaseUrl: savedConnection.wsBaseUrl,
    });
    return EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
      prepared: yield* SubscriptionRef.make(preparedConnection),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
  });

describe("mobile cloud link environment seam", () => {
  it.effect("returns disconnected when no prepared connection is present", () =>
    Effect.gen(function* () {
      const supervisor = yield* makeSupervisor(Option.none());
      const result = yield* updateLinkedEnvironmentLiveActivityPreference(true).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(result).toBe("disconnected");
    }),
  );

  it.effect("returns unsupported when connected without legacy Live Activity bridge", () =>
    Effect.gen(function* () {
      const supervisor = yield* makeSupervisor(
        Option.some<PreparedConnection>({
          environmentId: savedConnection.environmentId,
          label: savedConnection.environmentLabel,
          httpBaseUrl: savedConnection.httpBaseUrl,
          socketUrl: savedConnection.wsBaseUrl,
          httpAuthorization: { _tag: "Bearer", token: "local-bearer" },
          target: new PrimaryConnectionTarget({
            environmentId: savedConnection.environmentId,
            label: savedConnection.environmentLabel,
            httpBaseUrl: savedConnection.httpBaseUrl,
            wsBaseUrl: savedConnection.wsBaseUrl,
          }),
        }),
      );
      const result = yield* updateLinkedEnvironmentLiveActivityPreference(true).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(result).toBe("unsupported");
    }),
  );

  it.effect("reports unsupported error when attempting legacy Live Activity linking", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const error = yield* linkEnvironmentToCloudWithPreference({
        clerkToken: "unused",
        liveActivitiesEnabled: true,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("CloudEnvironmentLinkError");
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );
});
