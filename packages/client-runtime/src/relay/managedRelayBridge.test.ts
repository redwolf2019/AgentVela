import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  type AgentVelaRelayEnvironmentRecord,
  RelayEndpointKey,
} from "@t3tools/contracts/agentVelaRelay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { RelayEnvironmentDiscovery } from "./discovery.ts";
import { layerRelayEnvironmentDiscoveryFromSelfHosted } from "./managedRelayBridge.ts";
import {
  EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE,
  SelfHostedRelayDiscovery,
  type SelfHostedRelayDiscoveryState,
} from "./presence.ts";

const ENDPOINT_KEY = RelayEndpointKey.make("ep-1");

const ENV_RECORD: AgentVelaRelayEnvironmentRecord = {
  environmentId: EnvironmentId.make("env-bridge-1"),
  label: TrimmedNonEmptyString.make("Build Box"),
  endpoint: {
    endpointKey: ENDPOINT_KEY,
    pathPrefix: TrimmedNonEmptyString.make("/e/ep-1"),
    httpBaseUrl: TrimmedNonEmptyString.make("https://relay.example.com/e/ep-1"),
    wsBaseUrl: TrimmedNonEmptyString.make("wss://relay.example.com/e/ep-1"),
  },
  status: "online",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  linkedAt: "2026-01-01T00:00:00.000Z",
};

describe("layerRelayEnvironmentDiscoveryFromSelfHosted", () => {
  it.effect("projects self-hosted SSE discovery updates into RelayEnvironmentDiscovery", () =>
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<SelfHostedRelayDiscoveryState>(
        EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE,
      );
      let refreshCount = 0;

      const testLayer = layerRelayEnvironmentDiscoveryFromSelfHosted.pipe(
        Layer.provide(
          Layer.succeed(
            SelfHostedRelayDiscovery,
            SelfHostedRelayDiscovery.of({
              state: ref,
              onlineTransitions: undefined as never,
              refresh: Effect.sync(() => {
                refreshCount += 1;
              }),
              checkEnvironmentStatus: () => Effect.die(new Error("unused")),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery;
        yield* SubscriptionRef.set(ref, {
          ...EMPTY_SELF_HOSTED_RELAY_DISCOVERY_STATE,
          listed: true,
          connectionState: "connected",
          environments: new Map([
            [
              ENV_RECORD.environmentId,
              {
                environment: ENV_RECORD,
                availability: "online" as const,
                lastStatus: Option.none(),
              },
            ],
          ]),
        });
        yield* Effect.yieldNow;
        const projected = yield* SubscriptionRef.get(discovery.state);
        expect(projected.listed).toBe(true);
        expect(projected.offline).toBe(false);
        expect(projected.environments.get(ENV_RECORD.environmentId)?.availability).toBe("online");
        expect(
          projected.environments.get(ENV_RECORD.environmentId)?.environment.endpoint.providerKind,
        ).toBe("t3_relay");

        yield* discovery.refresh;
        expect(refreshCount).toBe(1);
      }).pipe(Effect.provide(testLayer));
    }),
  );
});
