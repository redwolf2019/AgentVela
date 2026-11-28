import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BootService from "../cloud/bootService.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { resolveHostCliCommand } from "./invocation.ts";
import { runRelayCommand } from "./relay.ts";
import * as CliService from "./service.ts";
import {
  formatNextSteps,
  formatSetup,
  setupJson,
  type UpRoute,
  type UpRoutes,
  type UpSetup,
} from "./upFormat.ts";
import { hasAnyUpRelayFlag, readUpRelaySetup, reconcileUpRelayBeforeService } from "./upRelay.ts";

const readSetup = Effect.fn("cli.up.read_setup")(function* () {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const service = yield* (yield* BootService.BootService).status;
  const { entries } = yield* CliService.readServiceEnv(baseDir);
  const lan = yield* Config.Boolean("T3CODE_LAN")
    .pipe(Config.option)
    .parse(ConfigProvider.fromEnv({ env: entries }));
  const relay = yield* readUpRelaySetup();
  const servesThisHome = service.installed && service.otherBaseDir === undefined;
  return {
    service,
    relay,
    lan: Option.getOrElse(lan, () => servesThisHome),
    lanFromOldDefault: Option.isNone(lan) && servesThisHome && entries.T3CODE_HOST === undefined,
    host: entries.T3CODE_HOST,
  } satisfies UpSetup;
});

/**
 * The routes `t3 up` starts from. With no route flag it asks about LAN access;
 * any route flag skips the prompt and leaves unnamed routes unchanged.
 */
export const planRoutes = (
  setup: { readonly lan: boolean },
  flags: {
    readonly lan: Option.Option<boolean>;
    readonly relay?: Option.Option<boolean>;
    readonly relayUrl?: Option.Option<string>;
    readonly relayToken?: Option.Option<string>;
  },
) => {
  const ask = Option.isNone(flags.lan) && !hasAnyUpRelayFlag(flags);
  return {
    routes: {
      lan: Option.getOrElse(flags.lan, () => setup.lan),
    } satisfies UpRoutes,
    ask: ask ? (["lan"] as const) : [],
  };
};

const needsRestart = (before: UpRoutes, after: UpRoutes, relayChanged: boolean) =>
  after.lan !== before.lan || relayChanged;

const CHOICES = {
  lan: { title: "Local network", description: "LAN and tailnet. Pairing code required." },
} satisfies Record<UpRoute, { readonly title: string; readonly description: string }>;

const resolveHints = Effect.fn("cli.up.resolve_hints")(function* (baseDir: Option.Option<string>) {
  const baseDirArgs = Option.match(baseDir, {
    onNone: () => [],
    onSome: (dir) => ["--base-dir", dir],
  });
  const command = (subcommand: string, args: ReadonlyArray<string> = []) =>
    Effect.map(resolveHostCliCommand(subcommand, [...baseDirArgs, ...args]), (r) => r.command);
  return {
    run: yield* command(""),
    pair: yield* command("pair"),
    up: yield* command("up"),
    upNoLan: yield* command("up", ["--no-lan"]),
  };
});

const interactiveTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const setUp = Effect.fn("cli.up")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly lan: Option.Option<boolean>;
  readonly relay: Option.Option<boolean>;
  readonly relayUrl: Option.Option<string>;
  readonly relayToken: Option.Option<string>;
  readonly yes: boolean;
}) {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const service = yield* BootService.BootService;
  const baseDirArgs = Option.match(flags.baseDir, {
    onNone: () => [],
    onSome: (dir) => ["--base-dir", dir],
  });
  const hints = yield* resolveHints(flags.baseDir);
  const before = yield* readSetup();
  if (before.service.otherBaseDir !== undefined) {
    return yield* new BootService.BootServiceOtherBaseDirError({
      installedBaseDir: before.service.otherBaseDir,
      baseDir,
    });
  }

  const current = { lan: before.lan };
  const plan = planRoutes({ lan: before.lan }, flags);
  const interactive = !flags.yes && interactiveTerminal();
  let routes = plan.routes;
  if (plan.ask.length > 0 && interactive) {
    if (before.service.installed) {
      yield* Console.log(`Current setup\n${formatSetup(before, hints)}\n`);
    }
    const picked = yield* Prompt.run(
      Prompt.MultiSelect({
        message: "Allow connections through:",
        selectAll: "Select all",
        selectNone: "Clear all",
        inverseSelection: "Invert selection",
        choices: plan.ask.map((route) => ({
          ...CHOICES[route],
          value: route,
          selected: plan.routes[route],
        })),
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(null) }));
    if (picked === null) return yield* Console.log("Nothing changed.");
    routes = { lan: picked.includes("lan") };
  } else if (plan.ask.length > 0 && !flags.yes && !before.service.installed) {
    return yield* new CliError.UserError({
      cause: "routes",
      userMessage:
        "No terminal. Choose access with --lan or --relay, or use --yes for the default. See `agentvela up --help`.",
    });
  }
  if (routes.lan && !current.lan) {
    const policy = yield* ManagedPolicy.ManagedPolicy;
    if (!ManagedLimits.allowsRemoteClients(policy)) {
      return yield* ManagedLimits.refuseRemoteClients(policy);
    }
  }

  const relayState = yield* reconcileUpRelayBeforeService(flags, before.relay.linked);

  if (!before.service.installed && !routes.lan && !relayState.targetEnabled) {
    if (current.lan) yield* CliService.writeServiceEnv(baseDir, { T3CODE_LAN: "false" });
    return yield* Console.log(formatNextSteps(routes, false, false, hints));
  }

  const { installedVersion } = before.service;
  const newer =
    installedVersion !== undefined &&
    compareExactServiceVersions(installedVersion, packageJson.version) > 0;
  const stopped = before.service.problems?.includes("service-stopped") === true;
  const restart =
    before.service.installed &&
    (before.service.current || newer) &&
    (needsRestart(current, routes, relayState.changed) || stopped);
  const update = before.service.installed && !before.service.current && !newer && !stopped;
  if ((restart || update) && interactive && !stopped) {
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({
        message: update
          ? "Update and restart AgentVela? Running agent turns will stop."
          : "Apply changes and restart? Running agent turns will stop.",
        initial: true,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) return yield* Console.log("Nothing changed.");
  }

  const previousLan = (yield* CliService.readServiceEnv(baseDir)).entries.T3CODE_LAN;
  yield* CliService.writeServiceEnv(baseDir, { T3CODE_LAN: String(routes.lan) });
  const restoreServiceEnv = before.service.installed
    ? CliService.writeServiceEnv(baseDir, { T3CODE_LAN: previousLan })
    : Effect.void;
  const rollBack = before.service.installed
    ? restoreServiceEnv.pipe(Effect.andThen(service.restart.pipe(Effect.ignore)))
    : Effect.void;
  if (before.host !== undefined) {
    yield* Console.warn(
      `T3CODE_HOST=${before.host} in service.env overrides the network choice. Remove it to apply it.`,
    );
  }

  const printServeCommand = Effect.fn(function* (reason: string) {
    const { command } = yield* resolveHostCliCommand("serve", [
      ...baseDirArgs,
      routes.lan ? "--lan" : "--no-lan",
    ]);
    yield* Console.log(`${reason} Keep this command running:\n  ${command}`);
    const shellHost = (yield* HostProcess.Environment).T3CODE_HOST;
    if (shellHost !== undefined) {
      yield* Console.warn(
        `T3CODE_HOST=${shellHost} in this shell overrides that choice. Unset it before you run the command.`,
      );
    }
  });
  if (!before.service.supported) {
    yield* printServeCommand("Background service unavailable.");
  } else {
    if (newer) {
      yield* Console.log(`Keeping installed service version agentvela@${installedVersion}.`);
    }
    if (update && !interactive) {
      yield* Console.log("Updating AgentVela. Running agent turns will stop.");
    }
    const result = newer
      ? ({ changed: false } as const)
      : yield* CliService.reconcileService().pipe(
          Effect.catchTags({
            BootServicePrerequisiteError: (error) => Effect.succeed({ failed: error.message }),
            BootServiceUnsupportedError: (error) => Effect.succeed({ failed: error.message }),
          }),
          Effect.tapError(() => rollBack),
        );
    if ("failed" in result && before.service.installed) {
      yield* restoreServiceEnv;
      yield* Console.log(
        `Service setup failed: ${result.failed} Fix that, then run \`${hints.up}\` again.`,
      );
    } else if ("failed" in result) {
      yield* printServeCommand(`Service setup failed: ${result.failed}`);
    } else if (result.changed) {
      yield* Console.log(CliService.formatServiceChange(result));
    } else if (restart) {
      if (!interactive && !stopped) {
        yield* Console.log("Restarting AgentVela. Running agent turns will stop.");
      }
      const outcome = yield* service.restart.pipe(Effect.tapError(() => rollBack));
      if (outcome === "queued") yield* Console.log("Restart queued. This session will disconnect.");
      if (outcome === "skipped") {
        yield* Console.log(
          "The installed service was not restarted. Run `agentvela service status` to see why.",
        );
      }
    }
  }

  const after = yield* readSetup();
  yield* Console.log(
    `\nThis machine\n${formatSetup(after, hints)}\n\n${formatNextSteps(
      { lan: after.lan },
      after.relay.linked,
      after.service.installed,
      hints,
    )}`,
  );
});

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  relay: Flag.Boolean("relay").pipe(
    Flag.withDescription(
      "Connect this host to a self-hosted agent-vela-relay. Turn off with --no-relay.",
    ),
    Flag.optional,
  ),
  relayUrl: Flag.String("relay-url").pipe(
    Flag.withDescription("Self-hosted relay URL when setting up `--relay`."),
    Flag.optional,
  ),
  relayToken: Flag.String("relay-token").pipe(
    Flag.withDescription("One-time enrollment token for headless `--relay` setup."),
    Flag.optional,
  ),
  lan: Flag.Boolean("lan").pipe(
    Flag.withDescription(
      "Allow LAN and tailnet connections. Anyone there can reach the port; a pairing code is the only lock. Turn off with --no-lan.",
    ),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription(
      "Ask nothing. Keep the current access settings. A restart stops running agent turns.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withShortDescription("Set up remote access and the AgentVela background service."),
  Command.withDescription(
    "Set up remote access and the AgentVela background service. Access flags skip the question, and routes not named keep their settings. Without a terminal, a needed restart runs without asking and stops running agent turns.",
  ),
  Command.withExamples([
    { command: "agentvela up", description: "Choose remote access." },
    {
      command: "agentvela up --relay --relay-url https://relay.example.com",
      description: "Connect via self-hosted relay.",
    },
    { command: "agentvela up --lan", description: "Allow LAN access with pairing codes." },
    { command: "agentvela up --no-lan", description: "Stop LAN access." },
    { command: "agentvela up --yes", description: "Take the defaults with no questions." },
    { command: "agentvela status --json", description: "Read the settings from a script." },
  ]),
  Command.withHandler((flags) => runRelayCommand(flags, setUp(flags), { quietLogs: true })),
);

export const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the settings as JSON. Does not test connections."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show service setup and remote access settings."),
  Command.withExamples([
    { command: "agentvela status", description: "Show the settings." },
    { command: "agentvela status --json", description: "Print them for scripts and agents." },
  ]),
  Command.withHandler(
    Effect.fn("cli.status")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: flags.json,
      });
      const setup = yield* readSetup().pipe(
        Effect.provide(
          Layer.merge(CliService.layer(config), ServerSecretStore.layer).pipe(
            Layer.provideMerge(ServerConfig.layer(config)),
          ),
        ),
      );
      if (flags.json) return yield* Console.log(setupJson(setup));
      const hints = yield* resolveHints(flags.baseDir);
      yield* Console.log(
        setup.service.otherBaseDir !== undefined
          ? `This machine\n${formatSetup(setup, hints)}`
          : `This machine\n${formatSetup(setup, hints)}\n\nChange access: \`${hints.up}\`.`,
      );
    }),
  ),
);
