import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServer } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ScheduledTaskWebhookOrigin } from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerActivation from "../serverActivation.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import * as RelayState from "./RelayState.ts";
import { RelayTunnelClient } from "./RelayTunnelClient.ts";

export const layerScheduledTaskWebhookOrigin = Layer.effect(
  ScheduledTaskWebhookOrigin,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const withSecrets = Effect.provideService(ServerSecretStore.ServerSecretStore, secrets);
    return Effect.gen(function* () {
      const selfHosted = yield* RelayState.readRelayLinkConfig().pipe(
        withSecrets,
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(selfHosted)) {
        const base = selfHosted.value.relayUrl.replace(/\/+$/u, "");
        return {
          relayHookBaseUrl: `${base}/v1/hooks/${selfHosted.value.endpoint.endpointKey}`,
        };
      }
      return { relayHookBaseUrl: null };
    });
  }),
);

export const makeLayerSelfHostedRelayTunnel = (parkedDeferred: Deferred.Deferred<void>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const tunnelClient = yield* RelayTunnelClient;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* Effect.addFinalizer(() =>
        tunnelClient.configure(null).pipe(Effect.timeout("5 seconds"), Effect.ignore),
      );
      yield* ServerActivation.forkParked(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) return;
          const localHost = loopbackUrlHostForAddress(address);
          yield* tunnelClient.setLocalOrigin({ host: localHost, port: address.port });
          const saved = yield* RelayState.readRelayLinkConfig().pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
            Effect.orElseSucceed(() => Option.none()),
          );
          if (Option.isSome(saved)) {
            yield* tunnelClient.configure(saved.value);
          }
        }),
      );
      yield* Deferred.succeed(parkedDeferred, undefined).pipe(Effect.orDie);
    }),
  );
