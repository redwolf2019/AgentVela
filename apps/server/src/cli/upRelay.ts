import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentKeys from "../cloud/environmentKeys.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RelayState from "../relay/RelayState.ts";
import { runRelayLink, runRelayUnlink } from "./relayActions.ts";

export interface UpRelayFlags {
  readonly baseDir: Option.Option<string>;
  readonly relay: Option.Option<boolean>;
  readonly relayUrl: Option.Option<string>;
  readonly relayToken: Option.Option<string>;
}

export function hasAnyUpRelayFlag(flags: {
  readonly relay?: Option.Option<boolean>;
  readonly relayUrl?: Option.Option<string>;
  readonly relayToken?: Option.Option<string>;
}): boolean {
  return (
    (flags.relay !== undefined && Option.isSome(flags.relay)) ||
    (flags.relayUrl !== undefined && Option.isSome(flags.relayUrl)) ||
    (flags.relayToken !== undefined && Option.isSome(flags.relayToken))
  );
}

const spawnerLayer = Layer.mergeAll(NodeChildProcessSpawner.layer, NodeCrypto.layer);

export const reconcileUpRelayBeforeService = Effect.fn("cli.up.reconcileRelay")(function* (
  flags: UpRelayFlags,
  alreadyLinked: boolean,
) {
  const explicitRelay = Option.getOrUndefined(flags.relay);
  const wantsEnable =
    explicitRelay === true || Option.isSome(flags.relayUrl) || Option.isSome(flags.relayToken);
  const wantsDisable = explicitRelay === false;

  if (wantsDisable) {
    if (alreadyLinked) {
      yield* runRelayUnlink({ keepRemote: false }).pipe(
        Effect.provide(ServerEnvironment.layerIdentity.pipe(Layer.provideMerge(spawnerLayer))),
      );
    }
    return { targetEnabled: false, changed: alreadyLinked };
  }

  if (!wantsEnable) {
    return { targetEnabled: alreadyLinked, changed: false };
  }

  const shouldRelink =
    !alreadyLinked || Option.isSome(flags.relayUrl) || Option.isSome(flags.relayToken);
  if (!shouldRelink) {
    yield* Console.log("Self-hosted relay link already configured.");
    return { targetEnabled: true, changed: false };
  }

  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const layerSecrets = Layer.succeed(ServerSecretStore.ServerSecretStore, secrets);
  const relayDeps = Layer.mergeAll(
    ServerEnvironment.layer.pipe(Layer.provide(layerSecrets), Layer.provide(ProcessRunner.layer)),
    EnvironmentKeys.layer.pipe(Layer.provide(layerSecrets)),
  ).pipe(Layer.provideMerge(spawnerLayer));

  yield* runRelayLink({
    baseDir: flags.baseDir,
    url: flags.relayUrl,
    token: flags.relayToken,
  }).pipe(Effect.provide(relayDeps));
  return { targetEnabled: true, changed: true };
});

export const readUpRelaySetup = Effect.fn("cli.up.readRelaySetup")(function* () {
  const link = yield* RelayState.readRelayLinkConfig();
  return Option.match(link, {
    onNone: () => ({ linked: false, relayUrl: null, endpointUrl: null }),
    onSome: (value) => ({
      linked: true,
      relayUrl: value.relayUrl,
      endpointUrl: value.endpoint.httpBaseUrl,
    }),
  });
});
