// @effect-diagnostics nodeBuiltinImport:off -- CLI entry point parses Node argv, env, stdin, and TTY streams.
import * as NodeProcess from "node:process";
import * as NodeReadline from "node:readline";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayAdminListTunnelsResponse,
  RelayInviteId,
  RelayUserId,
  type RelayUserRole,
} from "@t3tools/contracts/agentVelaRelay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { AuthService, layerRelayAuth } from "./auth/AuthService.ts";
import { loadRelayConfig, layerRelayConfigFromValues, type ResolvedRelayConfig } from "./config.ts";
import { layerRelaySqliteLive } from "./persistence/database.ts";
import { startRelayServer } from "./server.ts";

const decodeTunnelList = Schema.decodeUnknownEffect(RelayAdminListTunnelsResponse);

function formatJsonLine(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function encodeBodyString(value: unknown): string {
  return JSON.stringify(value);
}

function parseArgs(argv: ReadonlyArray<string>): {
  readonly positionals: Array<string>;
  readonly flags: Map<string, string | boolean>;
} {
  const positionals: Array<string> = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "-h" || token === "--help") {
      flags.set("help", true);
      continue;
    }
    const stripped = token.replace(/^--?/, "");
    const eqIndex = stripped.indexOf("=");
    if (eqIndex > 0) {
      flags.set(stripped.slice(0, eqIndex), stripped.slice(eqIndex + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("-")) {
      flags.set(stripped, next);
      index++;
    } else {
      flags.set(stripped, true);
    }
  }
  return { positionals, flags };
}

function stringFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const val = flags.get(key);
  return typeof val === "string" ? val : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function printHelp(): void {
  NodeProcess.stdout.write(
    [
      "Usage:",
      "  agent-vela-relay serve [--config <path>]",
      "  agent-vela-relay admin init [--config <path>] [--username <u>] [--password <p>]",
      "  agent-vela-relay admin user list [--config <path>] [--json]",
      "  agent-vela-relay admin user create [--config <path>] --username <u> --password <p> [--role admin|member]",
      "  agent-vela-relay admin user <enable|disable> [--config <path>] <userId|username>",
      "  agent-vela-relay admin invite list [--config <path>] [--json]",
      "  agent-vela-relay admin invite create [--config <path>] [--role admin|member] [--uses <n>] [--ttl-hours <h>]",
      "  agent-vela-relay admin invite revoke [--config <path>] <inviteId>",
      "  agent-vela-relay admin tunnels list [--config <path>] [--url <url>] --token <bearer> [--json]",
      "  agent-vela-relay admin tunnels kick [--config <path>] <environmentId> [--url <url>] --token <bearer> [--reason <text>]",
      "",
    ].join("\n"),
  );
}

async function readSecretPrompt(promptText: string): Promise<string> {
  if (!NodeProcess.stdin.isTTY) {
    throw new Error(
      "Missing --password or AGENT_VELA_RELAY_ADMIN_PASSWORD in non-interactive mode",
    );
  }
  NodeProcess.stdout.write(promptText);
  return await new Promise<string>((resolve, reject) => {
    const rl = NodeReadline.createInterface({
      input: NodeProcess.stdin,
      output: NodeProcess.stdout,
    });
    const stdin = NodeProcess.stdin as NodeJS.ReadStream;
    const prevRaw = stdin.isRaw;
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(Boolean(prevRaw));
      }
      rl.close();
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\r" || text === "\n") {
        cleanup();
        NodeProcess.stdout.write("\n");
        resolve(value);
      } else if (text === "\u0003") {
        cleanup();
        reject(new Error("Aborted"));
      } else if (text === "\u007f" || text === "\b") {
        value = value.slice(0, -1);
      } else {
        value += text;
      }
    };
    stdin.on("data", onData);
  });
}

function stripBootstrapAdminConfig(config: ResolvedRelayConfig): ResolvedRelayConfig {
  const { bootstrapAdminUsername: _u, bootstrapAdminPassword: _p, ...authRest } = config.auth;
  return { ...config, auth: authRest };
}

function makeAdminLayer(config: ResolvedRelayConfig) {
  // Admin CLI subcommands manage users explicitly and must not auto-bootstrap default "admin".
  const cfgLayer = layerRelayConfigFromValues(stripBootstrapAdminConfig(config));
  const dbLayer = layerRelaySqliteLive.pipe(Layer.provideMerge(cfgLayer));
  return layerRelayAuth.pipe(
    Layer.provideMerge(dbLayer),
    Layer.provideMerge(NodeCryptoLayer.layer),
  );
}

async function runServe(config: ResolvedRelayConfig): Promise<void> {
  const handle = await startRelayServer(config);
  NodeProcess.stdout.write(
    `agent-vela-relay v${config.version} listening on ${handle.bindAddress} (public: ${config.publicUrl})\n`,
  );
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void handle.close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function runAdminTunnelCommand(
  sub: string,
  rest: ReadonlyArray<string>,
  flags: Map<string, string | boolean>,
  config: ResolvedRelayConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const baseUrl = (nonEmpty(stringFlag(flags, "url")) ?? config.publicUrl).replace(/\/$/, "");
  const token = nonEmpty(stringFlag(flags, "token")) ?? nonEmpty(env.AGENT_VELA_RELAY_ADMIN_TOKEN);
  if (!token) {
    throw new Error("Missing --token or AGENT_VELA_RELAY_ADMIN_TOKEN for live tunnel admin query");
  }
  const program = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    if (sub === "list") {
      const json = yield* client
        .execute(
          HttpClientRequest.get(`${baseUrl}/v1/admin/tunnels`).pipe(
            HttpClientRequest.bearerToken(token),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((res) => res.json),
        );
      const data = yield* decodeTunnelList(json);
      if (flags.get("json")) {
        NodeProcess.stdout.write(formatJsonLine(data));
      } else {
        for (const t of data.tunnels) {
          NodeProcess.stdout.write(
            `${t.environmentId} (${t.endpointKey}) user=${t.username} run=${t.runId} rtt=${t.rttMs ?? "-"}ms streams=${t.activeStreams} in=${t.bytesIn} out=${t.bytesOut}\n`,
          );
        }
      }
      return;
    }
    if (sub === "kick") {
      const envId = rest[0];
      if (!envId) {
        return yield* Effect.die("Usage: agent-vela-relay admin tunnels kick <environmentId>");
      }
      const reason = stringFlag(flags, "reason");
      const req = HttpClientRequest.post(
        `${baseUrl}/v1/admin/tunnels/${encodeURIComponent(envId)}/kick`,
      ).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyText(encodeBodyString(reason ? { reason } : {}), "application/json"),
      );
      yield* client.execute(req).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      NodeProcess.stdout.write(`Disconnected tunnel ${EnvironmentId.make(envId)}\n`);
      return;
    }
    return yield* Effect.die(`Unknown admin tunnels subcommand: ${sub}`);
  }).pipe(Effect.provide(FetchHttpClient.layer));

  await Effect.runPromise(program);
}

async function runAdminUserCommand(
  sub: string | undefined,
  arg0: string | undefined,
  flags: Map<string, string | boolean>,
  config: ResolvedRelayConfig,
): Promise<void> {
  const adminLayer = makeAdminLayer(config);
  const jsonOutput = Boolean(flags.get("json"));
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthService;
      if (sub === "list") {
        const res = yield* auth.listUsers();
        if (jsonOutput) {
          NodeProcess.stdout.write(formatJsonLine(res));
        } else {
          for (const user of res.users) {
            NodeProcess.stdout.write(
              `${user.userId}\t${user.username}\trole=${user.role}\tdisabled=${user.disabled}\n`,
            );
          }
        }
        return;
      }
      if (sub === "create") {
        const username = stringFlag(flags, "username");
        const password = stringFlag(flags, "password");
        const role = (stringFlag(flags, "role") ?? "member") as RelayUserRole;
        if (!username || !password) {
          return yield* Effect.die("Missing --username or --password");
        }
        const created = yield* auth.createUser({ username, password, role });
        NodeProcess.stdout.write(`Created user '${created.username}' (${created.userId})\n`);
        return;
      }
      if ((sub === "disable" || sub === "enable") && arg0) {
        const all = yield* auth.listUsers();
        const match = all.users.find((u) => u.userId === arg0 || u.username === arg0);
        const targetId = match ? match.userId : RelayUserId.make(arg0);
        const updated = yield* auth.updateUser({
          userId: targetId,
          patch: { disabled: sub === "disable" },
        });
        NodeProcess.stdout.write(
          `User '${updated.username}' (${updated.userId}) disabled=${updated.disabled}\n`,
        );
        return;
      }
      return yield* Effect.die(`Unknown admin user command: ${sub ?? "(missing)"}`);
    }).pipe(Effect.provide(adminLayer)),
  );
}

async function runAdminInviteCommand(
  sub: string | undefined,
  arg0: string | undefined,
  flags: Map<string, string | boolean>,
  config: ResolvedRelayConfig,
): Promise<void> {
  const adminLayer = makeAdminLayer(config);
  const jsonOutput = Boolean(flags.get("json"));
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthService;
      if (sub === "list") {
        const res = yield* auth.listInvites();
        if (jsonOutput) {
          NodeProcess.stdout.write(formatJsonLine(res));
        } else {
          for (const inv of res.invites) {
            NodeProcess.stdout.write(
              `${inv.inviteId}\t${inv.codePrefix}...\trole=${inv.role}\tuses=${inv.usesCount}/${inv.maxUses}\trevoked=${inv.revokedAt !== null}\n`,
            );
          }
        }
        return;
      }
      if (sub === "create") {
        const users = yield* auth.listUsers();
        const creator = users.users.find((u) => u.role === "admin" && !u.disabled);
        if (!creator) {
          return yield* Effect.die("No active admin exists; run 'admin init' first");
        }
        const role = (stringFlag(flags, "role") ?? "member") as RelayUserRole;
        const usesStr = stringFlag(flags, "uses");
        const ttlStr = stringFlag(flags, "ttl-hours");
        const created = yield* auth.createInvite({
          createdByUserId: creator.userId,
          request: {
            role,
            ...(usesStr ? { maxUses: Number.parseInt(usesStr, 10) } : {}),
            ...(ttlStr ? { ttlHours: Number.parseInt(ttlStr, 10) } : {}),
          },
        });
        NodeProcess.stdout.write(`${created.code}\n`);
        return;
      }
      if (sub === "revoke" && arg0) {
        yield* auth.revokeInvite(RelayInviteId.make(arg0));
        NodeProcess.stdout.write(`Revoked invite ${arg0}\n`);
        return;
      }
      return yield* Effect.die(`Unknown admin invite command: ${sub ?? "(missing)"}`);
    }).pipe(Effect.provide(adminLayer)),
  );
}

async function runAdminInitCommand(
  flags: Map<string, string | boolean>,
  config: ResolvedRelayConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const username =
    nonEmpty(stringFlag(flags, "username")) ??
    nonEmpty(env.AGENT_VELA_RELAY_ADMIN_USERNAME) ??
    nonEmpty(config.auth.bootstrapAdminUsername) ??
    "admin";
  const password =
    nonEmpty(stringFlag(flags, "password")) ??
    nonEmpty(env.AGENT_VELA_RELAY_ADMIN_PASSWORD) ??
    nonEmpty(config.auth.bootstrapAdminPassword) ??
    (await readSecretPrompt(`Admin password for '${username}': `));
  const user = await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthService;
      return yield* auth.bootstrapAdmin({ username, password });
    }).pipe(Effect.provide(makeAdminLayer(config))),
  );
  NodeProcess.stdout.write(`Initialized admin '${user.username}' (${user.userId})\n`);
}

export async function runRelayCli(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  if (flags.get("help") || positionals.length === 0) {
    printHelp();
    return;
  }
  const configPath = stringFlag(flags, "config");
  const config = await Effect.runPromise(
    loadRelayConfig({ ...(configPath ? { configPath } : {}), env, cwd }),
  );
  const command = positionals[0];
  if (command === "serve") {
    await runServe(config);
    return;
  }
  if (command === "admin") {
    const [, section, sub, arg0] = positionals;
    if (section === "tunnels") {
      await runAdminTunnelCommand(sub ?? "", positionals.slice(3), flags, config, env);
      return;
    }
    if (section === "init") {
      await runAdminInitCommand(flags, config, env);
      return;
    }
    if (section === "user") {
      await runAdminUserCommand(sub, arg0, flags, config);
      return;
    }
    if (section === "invite") {
      await runAdminInviteCommand(sub, arg0, flags, config);
      return;
    }
    throw new Error(`Unknown admin section: ${section ?? "(missing)"}`);
  }
  throw new Error(`Unknown command '${command}'. Run with --help for usage.`);
}
