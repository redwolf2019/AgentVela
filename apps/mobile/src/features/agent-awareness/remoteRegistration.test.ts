import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  agentAwarenessNotificationsReady,
  armAgentAwarenessLiveActivityForLocalWork,
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
  updateAgentAwarenessRegistrationPreferences,
} from "./remoteRegistration";

describe("remoteRegistration self-hosted extension seam", () => {
  it("reports push registration inactive and returns an unsubscribe handle", () => {
    expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
    expect(agentAwarenessNotificationsReady()).toBe(false);
    const unsubscribe = subscribeAgentAwarenessRegistrationStatus(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  it("treats local Live Activity arming as a safe no-op", () => {
    expect(() =>
      armAgentAwarenessLiveActivityForLocalWork({
        environmentId: EnvironmentId.make("environment-1"),
        threadTitle: "Thread",
        projectTitle: "Project",
      }),
    ).not.toThrow();
  });

  it.effect("completes refresh and preference updates without remote relay push calls", () =>
    Effect.gen(function* () {
      yield* refreshAgentAwarenessRegistration();
      yield* updateAgentAwarenessRegistrationPreferences({ liveActivitiesEnabled: false });
      expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
    }),
  );
});
