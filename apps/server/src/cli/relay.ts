import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag, type Prompt } from "effect/cli";
import { FetchHttpClient, type HttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BootService from "../cloud/bootService.ts";
import * as EnvironmentKeys from "../cloud/environmentKeys.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import type { FileSystem, Path } from "effect";
import type { SecureRandom } from "effect/crypto";
import type { ChildProcessSpawner } from "effect/process";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  formatRelayStatusJson,
  formatRelayStatusReport,
  readRelayCliStatusReport,
  runRelayLink,
  runRelayLogin,
  runRelayLogout,
  runRelayUnlink,
} from "./relayActions.ts";
import * as CliService from "./service.ts";

export type RelayCommandEnv =
  | ServerSecretStore.ServerSecretStore
  | EnvironmentAuth.EnvironmentAuth
  | BootService.BootService
  | EnvironmentKeys.EnvironmentSigningKey
  | ServerEnvironment.ServerEnvironment
  | ServerEnvironment.ServerEnvironmentIdentity
  | ManagedPolicy.ManagedPolicy
  | SecureRandom.SecureRandom
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | Prompt.Environment
  | ServerConfig.ServerConfig;

export const runRelayCommand = Effect.fn("cli.relay.runCommand")(function* <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<A, E, RelayCommandEnv>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  const layerSecrets = ServerSecretStore.layer;
  const layerBase = Layer.mergeAll(
    layerSecrets,
    ServerEnvironment.layer.pipe(Layer.provide(layerSecrets)),
    EnvironmentKeys.layer.pipe(Layer.provide(layerSecrets)),
    EnvironmentAuth.layerRuntime,
    CliService.layer(config),
  ).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );
  return yield* run.pipe(Effect.provide(layerBase));
});

const relayUrlFlag = Flag.String("url").pipe(
  Flag.withDescription("Self-hosted relay URL (e.g. https://relay.example.com)."),
  Flag.optional,
);

const relayLoginCommand = Command.make("login", {
  ...projectLocationFlags,
  url: relayUrlFlag,
  username: Flag.String("username").pipe(
    Flag.withDescription("Relay account username."),
    Flag.optional,
  ),
  password: Flag.String("password").pipe(
    Flag.withDescription("Relay account password."),
    Flag.optional,
  ),
  device: Flag.Boolean("device").pipe(
    Flag.withDescription("Sign in using device authorization code in your browser."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Sign in to a self-hosted agent-vela-relay instance."),
  Command.withHandler((flags) => runRelayCommand(flags, runRelayLogin(flags))),
);

const relayLogoutCommand = Command.make("logout", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Sign out from the stored self-hosted relay CLI session."),
  Command.withHandler((flags) => runRelayCommand(flags, runRelayLogout())),
);

const relayLinkCommand = Command.make("link", {
  ...projectLocationFlags,
  url: relayUrlFlag,
  token: Flag.String("token").pipe(
    Flag.withDescription("One-time enrollment token for headless linking."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Link this environment to a self-hosted agent-vela-relay instance."),
  Command.withHandler((flags) => runRelayCommand(flags, runRelayLink(flags))),
);

const relayUnlinkCommand = Command.make("unlink", {
  ...projectLocationFlags,
  keepRemote: Flag.Boolean("keep-remote").pipe(
    Flag.withDescription("Keep the environment record on the relay instead of revoking it."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Unlink this environment from the self-hosted relay."),
  Command.withHandler((flags) => runRelayCommand(flags, runRelayUnlink(flags))),
);

const relayStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of human-readable status."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show self-hosted relay link and tunnel status."),
  Command.withHandler((flags) =>
    runRelayCommand(
      flags,
      Effect.gen(function* () {
        const report = yield* readRelayCliStatusReport();
        yield* Console.log(
          flags.json ? formatRelayStatusJson(report) : formatRelayStatusReport(report),
        );
      }),
      { quietLogs: flags.json },
    ),
  ),
);

export const relayCommand = Command.make("relay").pipe(
  Command.withDescription("Manage connection to a self-hosted agent-vela-relay server."),
  Command.withSubcommands([
    relayLoginCommand,
    relayLogoutCommand,
    relayLinkCommand,
    relayUnlinkCommand,
    relayStatusCommand,
  ]),
);
