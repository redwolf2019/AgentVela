// @effect-diagnostics nodeBuiltinImport:off -- Relay configuration resolves local filesystem paths via Node fs/path.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DEFAULT_TUNNEL_HEARTBEAT_INTERVAL_MS,
  DEFAULT_TUNNEL_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_TUNNEL_INITIAL_STREAM_WINDOW_BYTES,
  DEFAULT_TUNNEL_MAX_FRAME_BYTES,
  MAX_TUNNEL_HEARTBEAT_INTERVAL_MS,
  MAX_TUNNEL_MAX_FRAME_BYTES,
  MAX_TUNNEL_STREAM_WINDOW_BYTES,
  MIN_TUNNEL_HEARTBEAT_INTERVAL_MS,
  MIN_TUNNEL_MAX_FRAME_BYTES,
} from "@t3tools/contracts/agentVelaRelay";
import { normalizeRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  parseBindAddress,
  parseRelayToml,
  RelayConfigError,
  type ParsedTomlConfig,
  type RelayBindAddress,
} from "./tomlParser.ts";

export { parseBindAddress, parseRelayToml, RelayConfigError, type RelayBindAddress };

const isRelayConfigError = Schema.is(RelayConfigError);

export const RELAY_SERVICE_VERSION = "0.1.0";

export interface ResolvedRelayConfig {
  readonly bind: RelayBindAddress;
  readonly publicUrl: string;
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly serveWebUi: boolean;
  readonly webUiDir?: string;
  readonly trustProxy: boolean;
  readonly auth: {
    readonly allowPublicRegistration: boolean;
    readonly accessTokenTtlSeconds: number;
    readonly refreshTokenTtlDays: number;
    readonly enrollmentTokenTtlMinutes: number;
    readonly deviceCodeTtlMinutes: number;
    readonly bootstrapAdminUsername?: string;
    readonly bootstrapAdminPassword?: string;
  };
  readonly tunnel: {
    readonly maxFrameBytes: number;
    readonly heartbeatIntervalMs: number;
    readonly heartbeatTimeoutMs: number;
    readonly compression: boolean;
    readonly initialStreamWindowBytes: number;
    readonly proxyTimeoutMs: number;
  };
  readonly rateLimit: {
    readonly loginMaxAttempts: number;
    readonly loginWindowSeconds: number;
    readonly dpopMaxAttempts: number;
    readonly proxyMaxRequests: number;
  };
  readonly version: string;
}

export class RelayConfig extends Context.Service<RelayConfig, ResolvedRelayConfig>()(
  "agent-vela-relay/config/RelayConfig",
) {}

function readStringOption(
  tomlValue: string | number | boolean | undefined,
  envValue: string | undefined,
  fallback: string,
  name: string,
): string {
  if (envValue !== undefined && envValue.trim().length > 0) {
    return envValue.trim();
  }
  if (tomlValue !== undefined) {
    if (typeof tomlValue !== "string") {
      throw new RelayConfigError({ message: `Expected string for ${name}` });
    }
    return tomlValue.trim();
  }
  return fallback;
}

function readOptionalStringOption(
  tomlValue: string | number | boolean | undefined,
  envValue: string | undefined,
  name: string,
): string | undefined {
  if (envValue !== undefined) {
    const trimmed = envValue.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (tomlValue !== undefined) {
    if (typeof tomlValue !== "string") {
      throw new RelayConfigError({ message: `Expected string for ${name}` });
    }
    const trimmed = tomlValue.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function readBooleanOption(
  tomlValue: string | number | boolean | undefined,
  envValue: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (envValue !== undefined && envValue.trim().length > 0) {
    const normalized = envValue.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
    throw new RelayConfigError({ message: `Invalid boolean env value for ${name}: ${envValue}` });
  }
  if (tomlValue !== undefined) {
    if (typeof tomlValue !== "boolean") {
      throw new RelayConfigError({ message: `Expected boolean for ${name}` });
    }
    return tomlValue;
  }
  return fallback;
}

function readIntegerOption(
  tomlValue: string | number | boolean | undefined,
  envValue: string | undefined,
  fallback: number,
  bounds: { readonly min: number; readonly max: number; readonly name: string },
): number {
  let value: number = fallback;
  if (envValue !== undefined && envValue.trim().length > 0) {
    if (!/^-?\d+$/.test(envValue.trim())) {
      throw new RelayConfigError({
        message: `Invalid integer env value for ${bounds.name}: ${envValue}`,
      });
    }
    value = Number.parseInt(envValue.trim(), 10);
  } else if (tomlValue !== undefined) {
    if (typeof tomlValue !== "number" || !Number.isInteger(tomlValue)) {
      throw new RelayConfigError({ message: `Expected integer for ${bounds.name}` });
    }
    value = tomlValue;
  }
  if (value < bounds.min || value > bounds.max) {
    throw new RelayConfigError({
      message: `${bounds.name} (${value}) must be between ${bounds.min} and ${bounds.max}`,
    });
  }
  return value;
}

function resolveAuthConfig(
  auth: Record<string, string | number | boolean>,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedRelayConfig["auth"] {
  const adminUser = readOptionalStringOption(
    undefined,
    env.AGENT_VELA_RELAY_ADMIN_USERNAME,
    "AGENT_VELA_RELAY_ADMIN_USERNAME",
  );
  const adminPassword = readOptionalStringOption(
    undefined,
    env.AGENT_VELA_RELAY_ADMIN_PASSWORD,
    "AGENT_VELA_RELAY_ADMIN_PASSWORD",
  );
  return {
    allowPublicRegistration: readBooleanOption(
      auth.allow_public_registration,
      env.AGENT_VELA_RELAY_ALLOW_PUBLIC_REGISTRATION,
      false,
      "auth.allow_public_registration",
    ),
    accessTokenTtlSeconds: readIntegerOption(
      auth.access_token_ttl_seconds,
      env.AGENT_VELA_RELAY_ACCESS_TOKEN_TTL_SECONDS,
      900,
      { min: 60, max: 86_400, name: "auth.access_token_ttl_seconds" },
    ),
    refreshTokenTtlDays: readIntegerOption(
      auth.refresh_token_ttl_days,
      env.AGENT_VELA_RELAY_REFRESH_TOKEN_TTL_DAYS,
      30,
      { min: 1, max: 365, name: "auth.refresh_token_ttl_days" },
    ),
    enrollmentTokenTtlMinutes: readIntegerOption(
      auth.enrollment_token_ttl_minutes,
      env.AGENT_VELA_RELAY_ENROLLMENT_TOKEN_TTL_MINUTES,
      15,
      { min: 1, max: 1_440, name: "auth.enrollment_token_ttl_minutes" },
    ),
    deviceCodeTtlMinutes: readIntegerOption(
      auth.device_code_ttl_minutes,
      env.AGENT_VELA_RELAY_DEVICE_CODE_TTL_MINUTES,
      10,
      { min: 1, max: 60, name: "auth.device_code_ttl_minutes" },
    ),
    ...(adminUser ? { bootstrapAdminUsername: adminUser } : {}),
    ...(adminPassword ? { bootstrapAdminPassword: adminPassword } : {}),
  };
}

function resolveTunnelAndRateConfig(
  tunnel: Record<string, string | number | boolean>,
  rateLimit: Record<string, string | number | boolean>,
  env: Readonly<Record<string, string | undefined>>,
): {
  readonly tunnel: ResolvedRelayConfig["tunnel"];
  readonly rateLimit: ResolvedRelayConfig["rateLimit"];
} {
  const heartbeatIntervalMs =
    readIntegerOption(
      tunnel.heartbeat_interval_seconds,
      env.AGENT_VELA_RELAY_TUNNEL_HEARTBEAT_INTERVAL_SECONDS,
      DEFAULT_TUNNEL_HEARTBEAT_INTERVAL_MS / 1_000,
      {
        min: MIN_TUNNEL_HEARTBEAT_INTERVAL_MS / 1_000,
        max: MAX_TUNNEL_HEARTBEAT_INTERVAL_MS / 1_000,
        name: "tunnel.heartbeat_interval_seconds",
      },
    ) * 1_000;
  const heartbeatTimeoutMs =
    readIntegerOption(
      tunnel.heartbeat_timeout_seconds,
      env.AGENT_VELA_RELAY_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS,
      DEFAULT_TUNNEL_HEARTBEAT_TIMEOUT_MS / 1_000,
      {
        min: (heartbeatIntervalMs * 2) / 1_000,
        max: (MAX_TUNNEL_HEARTBEAT_INTERVAL_MS * 3) / 1_000,
        name: "tunnel.heartbeat_timeout_seconds",
      },
    ) * 1_000;

  return {
    tunnel: {
      maxFrameBytes: readIntegerOption(
        tunnel.max_frame_bytes,
        env.AGENT_VELA_RELAY_TUNNEL_MAX_FRAME_BYTES,
        DEFAULT_TUNNEL_MAX_FRAME_BYTES,
        {
          min: MIN_TUNNEL_MAX_FRAME_BYTES,
          max: MAX_TUNNEL_MAX_FRAME_BYTES,
          name: "tunnel.max_frame_bytes",
        },
      ),
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      compression: readBooleanOption(
        tunnel.compression,
        env.AGENT_VELA_RELAY_TUNNEL_COMPRESSION,
        true,
        "tunnel.compression",
      ),
      initialStreamWindowBytes: readIntegerOption(
        tunnel.initial_stream_window_bytes,
        env.AGENT_VELA_RELAY_TUNNEL_INITIAL_STREAM_WINDOW_BYTES,
        DEFAULT_TUNNEL_INITIAL_STREAM_WINDOW_BYTES,
        {
          min: MIN_TUNNEL_MAX_FRAME_BYTES,
          max: MAX_TUNNEL_STREAM_WINDOW_BYTES,
          name: "tunnel.initial_stream_window_bytes",
        },
      ),
      proxyTimeoutMs: readIntegerOption(
        tunnel.proxy_timeout_ms,
        env.AGENT_VELA_RELAY_TUNNEL_PROXY_TIMEOUT_MS,
        30_000,
        { min: 1_000, max: 300_000, name: "tunnel.proxy_timeout_ms" },
      ),
    },
    rateLimit: {
      loginMaxAttempts: readIntegerOption(
        rateLimit.login_max_attempts,
        env.AGENT_VELA_RELAY_RATE_LIMIT_LOGIN_MAX_ATTEMPTS,
        10,
        { min: 1, max: 1_000, name: "rate_limit.login_max_attempts" },
      ),
      loginWindowSeconds: readIntegerOption(
        rateLimit.login_window_seconds,
        env.AGENT_VELA_RELAY_RATE_LIMIT_LOGIN_WINDOW_SECONDS,
        60,
        { min: 1, max: 3_600, name: "rate_limit.login_window_seconds" },
      ),
      dpopMaxAttempts: readIntegerOption(
        rateLimit.dpop_max_attempts,
        env.AGENT_VELA_RELAY_RATE_LIMIT_DPOP_MAX_ATTEMPTS,
        60,
        { min: 1, max: 10_000, name: "rate_limit.dpop_max_attempts" },
      ),
      proxyMaxRequests: readIntegerOption(
        rateLimit.proxy_max_requests,
        env.AGENT_VELA_RELAY_RATE_LIMIT_PROXY_MAX_REQUESTS,
        600,
        { min: 1, max: 100_000, name: "rate_limit.proxy_max_requests" },
      ),
    },
  };
}

function buildResolvedRelayConfig(
  toml: ParsedTomlConfig,
  env: Readonly<Record<string, string | undefined>>,
  baseDir: string,
): ResolvedRelayConfig {
  const server = toml.server ?? {};
  const bind = parseBindAddress(
    readStringOption(server.bind, env.AGENT_VELA_RELAY_BIND, "127.0.0.1:8787", "server.bind"),
  );
  const rawPublicUrl = readStringOption(
    server.public_url,
    env.AGENT_VELA_RELAY_PUBLIC_URL,
    `http://${bind.host === "0.0.0.0" ? "127.0.0.1" : bind.host}:${bind.port}`,
    "server.public_url",
  );
  const publicUrl = normalizeRelayUrl(rawPublicUrl);
  if (!publicUrl) {
    throw new RelayConfigError({
      message: `Invalid or insecure server.public_url: ${rawPublicUrl}`,
    });
  }
  const dataDir = NodePath.resolve(
    baseDir,
    readStringOption(
      server.data_dir,
      env.AGENT_VELA_RELAY_DATA_DIR,
      "./.agent-vela-relay",
      "server.data_dir",
    ),
  );
  const rawWebUiDir = readOptionalStringOption(
    server.web_ui_dir,
    env.AGENT_VELA_RELAY_WEB_UI_DIR,
    "server.web_ui_dir",
  );
  const { tunnel, rateLimit } = resolveTunnelAndRateConfig(
    toml.tunnel ?? {},
    toml.rate_limit ?? {},
    env,
  );
  return {
    bind,
    publicUrl,
    dataDir,
    sqlitePath: NodePath.join(dataDir, "relay.sqlite"),
    serveWebUi: readBooleanOption(
      server.serve_web_ui,
      env.AGENT_VELA_RELAY_SERVE_WEB_UI,
      false,
      "server.serve_web_ui",
    ),
    ...(rawWebUiDir ? { webUiDir: NodePath.resolve(baseDir, rawWebUiDir) } : {}),
    trustProxy: readBooleanOption(
      server.trust_proxy,
      env.AGENT_VELA_RELAY_TRUST_PROXY,
      false,
      "server.trust_proxy",
    ),
    auth: resolveAuthConfig(toml.auth ?? {}, env),
    tunnel,
    rateLimit,
    version: RELAY_SERVICE_VERSION,
  };
}

export const loadRelayConfig = Effect.fn("RelayConfig.load")(function* (input: {
  readonly configPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}) {
  const cwd = input.cwd ?? NodePath.resolve(".");
  const env = input.env ?? {};
  const tomlSource = input.configPath
    ? yield* Effect.tryPromise({
        try: () => NodeFSP.readFile(NodePath.resolve(cwd, input.configPath!), "utf8"),
        catch: (cause) =>
          new RelayConfigError({
            message: `Failed to read relay config file '${input.configPath}': ${String(cause)}`,
          }),
      })
    : "";
  const parsed = yield* Effect.try({
    try: () => parseRelayToml(tomlSource),
    catch: (cause) =>
      isRelayConfigError(cause) ? cause : new RelayConfigError({ message: String(cause) }),
  });
  const baseDir = input.configPath
    ? NodePath.dirname(NodePath.resolve(cwd, input.configPath))
    : cwd;
  return yield* Effect.try({
    try: () => buildResolvedRelayConfig(parsed, env, baseDir),
    catch: (cause) =>
      isRelayConfigError(cause) ? cause : new RelayConfigError({ message: String(cause) }),
  });
});

export function layerRelayConfigFromValues(config: ResolvedRelayConfig): Layer.Layer<RelayConfig> {
  return Layer.succeed(RelayConfig, config);
}
