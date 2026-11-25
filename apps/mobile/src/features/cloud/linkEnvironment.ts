import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

export class CloudEnvironmentLinkError extends Schema.TaggedError<CloudEnvironmentLinkError>()(
  "CloudEnvironmentLinkError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    traceId: Schema.optional(Schema.String),
    relayLinkCommitted: Schema.optionalKey(Schema.Literal(true)),
  },
) {}

export const updateLinkedEnvironmentLiveActivityPreference = Effect.fn(
  "linkEnvironment.updateLinkedEnvironmentLiveActivityPreference",
)(function* (_liveActivitiesEnabled: boolean) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  if (Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))) {
    return "disconnected" as const;
  }
  return "unsupported" as const;
});

/** Extension seam for linking an environment for Live Activity updates. */
export const linkEnvironmentToCloudWithPreference = Effect.fn(
  "linkEnvironment.linkEnvironmentToCloudWithPreference",
)(function* (_input: { readonly clerkToken: string; readonly liveActivitiesEnabled: boolean }) {
  return yield* new CloudEnvironmentLinkError({
    message: m(msg("Live Activities are not supported with a self-hosted relay.")),
  });
});
