import { IsoDateTime } from "@t3tools/contracts";
import type { RelayPresenceEvent, RelayUserId } from "@t3tools/contracts/agentVelaRelay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

interface UserPresenceMessage {
  readonly userId: RelayUserId;
  readonly event: RelayPresenceEvent;
}

export class PresenceHub extends Context.Service<
  PresenceHub,
  {
    readonly publish: (userId: RelayUserId, event: RelayPresenceEvent) => Effect.Effect<void>;
    readonly subscribe: (input: {
      readonly userId: RelayUserId;
      readonly loadSnapshot: () => Effect.Effect<
        Extract<RelayPresenceEvent, { readonly type: "snapshot" }>
      >;
    }) => Stream.Stream<RelayPresenceEvent>;
  }
>()("agent-vela-relay/environments/PresenceHub") {}

export const layerPresenceHub = Layer.effect(
  PresenceHub,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<UserPresenceMessage>();

    const publish = Effect.fn("PresenceHub.publish")(function* (
      userId: RelayUserId,
      event: RelayPresenceEvent,
    ) {
      yield* PubSub.publish(pubsub, { userId, event });
    });

    const subscribe = (input: {
      readonly userId: RelayUserId;
      readonly loadSnapshot: () => Effect.Effect<
        Extract<RelayPresenceEvent, { readonly type: "snapshot" }>
      >;
    }): Stream.Stream<RelayPresenceEvent> => {
      const updates = Stream.fromPubSub(pubsub).pipe(
        Stream.filter((msg) => msg.userId === input.userId),
        Stream.map((msg) => msg.event),
      );
      const heartbeats = Stream.tick("15 seconds").pipe(
        Stream.drop(1),
        Stream.mapEffect(() =>
          DateTime.now.pipe(
            Effect.map((now): RelayPresenceEvent => ({
              type: "heartbeat",
              serverTime: IsoDateTime.make(DateTime.formatIso(now)),
            })),
          ),
        ),
      );
      const initial = Stream.fromEffect(input.loadSnapshot());
      return Stream.concat(initial, Stream.merge(updates, heartbeats));
    };

    return PresenceHub.of({ publish, subscribe });
  }),
);
