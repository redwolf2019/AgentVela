import {
  AuthRelayConfigureScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  ClientSurface,
  type HostRelayConfigRequest,
  type HostRelayStatus,
  type HostRelayTunnelSnapshot,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import type { AgentVelaRelayLinkProofPayload } from "@t3tools/contracts/agentVelaRelay";
import { normalizeRelayIssuer, RELAY_LINK_PROOF_TYP } from "@t3tools/shared/relayJwt";
import { parseRelayUrl } from "@t3tools/shared/relayUrl";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  createRelayEnrollmentChallenge,
  createRelayLinkChallenge,
  ensureFreshRelaySession,
  enrollRelayEnvironment,
  linkRelayEnvironment,
  loginToRelay,
  logoutFromRelay,
  pollRelayDeviceAuth,
  startRelayDeviceAuth,
  toStoredCliSession,
  unlinkRelayEnvironment,
} from "../relay/RelayApiClient.ts";
import * as RelayState from "../relay/RelayState.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { resolveHostCliHint } from "./invocation.ts";
import * as RunningServer from "./runningServer.ts";

const LINK_PROOF_TTL_SECONDS = 300;
const LIVE_STATUS_TIMEOUT = Duration.seconds(5);
const ZERO = NonNegativeInt.make(0);

const OFFLINE_TUNNEL_SNAPSHOT: HostRelayTunnelSnapshot = {
  state: "disconnected",
  runId: null,
  rttMs: null,
  activeStreams: ZERO,
  connectedAt: null,
  lastError: null,
  compression: false,
};

const envRelayUrlConfig = Config.String("T3CODE_RELAY_URL").pipe(Config.option);

function userError(cause: string, message: string): CliError.UserError {
  return new CliError.UserError({ cause, userMessage: message });
}

const requireSelfHostedRelayAllowed = Effect.gen(function* () {
  const policy = yield* ManagedPolicy.ManagedPolicy;
  if (!ManagedLimits.allowsConnect(policy)) {
    return yield* ManagedLimits.refuseConnect(policy);
  }
});

function offlineRelayStatus(link: RelayState.StoredSelfHostedRelayLink | null): HostRelayStatus {
  if (link === null) {
    return {
      linked: false,
      relayUrl: null,
      relayIssuer: null,
      userId: null,
      endpoint: null,
      tunnel: OFFLINE_TUNNEL_SNAPSHOT,
    };
  }
  return {
    linked: true,
    relayUrl: link.relayUrl,
    relayIssuer: link.relayIssuer,
    userId: link.userId,
    endpoint: link.endpoint,
    tunnel: OFFLINE_TUNNEL_SNAPSHOT,
  };
}

const resolveRelayUrlInput = Effect.fn("cli.relay.resolveUrl")(function* (
  explicitUrl: Option.Option<string>,
  savedUrl?: string | null,
) {
  let candidate = Option.getOrUndefined(explicitUrl)?.trim();
  if (!candidate) {
    const envVal = yield* envRelayUrlConfig;
    candidate = Option.getOrUndefined(envVal)?.trim();
  }
  if (!candidate && savedUrl) {
    candidate = savedUrl;
  }
  if (!candidate && process.stdin.isTTY && process.stdout.isTTY) {
    candidate = yield* Prompt.run(
      Prompt.String({ message: "Self-hosted relay URL (e.g. https://relay.example.com):" }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed("") }));
  }
  if (!candidate) {
    return yield* userError(
      "relay-url",
      "Relay URL is required. Pass --url <relayUrl> or set T3CODE_RELAY_URL.",
    );
  }
  const parsed = parseRelayUrl(candidate);
  if (parsed === null) {
    return yield* userError(
      "relay-url",
      "Invalid relay URL. Use https:// for public hosts, or http:// only for loopback, LAN (RFC1918), or Tailscale.",
    );
  }
  if (parsed.insecure) {
    yield* Console.warn(
      `Warning: ${parsed.origin} uses plaintext HTTP (${parsed.transport}). Use HTTPS in production.`,
    );
  }
  return parsed.origin;
});

const createLocalLinkProof = Effect.fn("cli.relay.createLinkProof")(function* (
  relayUrl: string,
  challenge: string,
) {
  const identity = yield* ServerEnvironment.ServerEnvironment;
  const signingKey = yield* EnvironmentSigningKey;
  const random = yield* SecureRandom.SecureRandom;
  const [environmentId, descriptor, now, jti] = yield* Effect.all([
    identity.getEnvironmentId,
    identity.getDescriptor,
    DateTime.now,
    random.uuidV4().pipe(Effect.orDie),
  ]);
  const iat = Math.floor(now.epochMilliseconds / 1_000);
  const payload: AgentVelaRelayLinkProofPayload = {
    iss: TrimmedNonEmptyString.make(`t3-env:${environmentId}`),
    aud: TrimmedNonEmptyString.make(normalizeRelayIssuer(relayUrl)),
    sub: TrimmedNonEmptyString.make(environmentId),
    jti: TrimmedNonEmptyString.make(jti),
    iat,
    exp: iat + LINK_PROOF_TTL_SECONDS,
    challenge: TrimmedNonEmptyString.make(challenge.trim()),
    environmentId,
    environmentPublicKey: TrimmedNonEmptyString.make(signingKey.publicKey),
    descriptor,
  };
  return yield* signingKey.sign({
    typ: RELAY_LINK_PROOF_TYP,
    payload: payload as unknown as Record<string, unknown>,
  });
});

const applyHostRelayConfig = Effect.fn("cli.relay.applyConfig")(function* (
  payload: HostRelayConfigRequest,
) {
  return yield* RunningServer.changeState({
    scopes: [AuthRelayConfigureScope],
    viaServer: (client) => client.relay.config({ headers: {}, payload }),
    locally: RelayState.saveRelayLinkConfig(payload).pipe(Effect.map(offlineRelayStatus)),
  });
});

const loginWithDeviceFlow = Effect.fn("cli.relay.deviceLogin")(function* (relayUrl: string) {
  const started = yield* startRelayDeviceAuth(relayUrl, "t3 cli");
  const verifyUrl = `${started.normalizedUrl}${started.verificationPath}`;
  yield* Console.log(
    [
      "Authorize this CLI in your relay web UI:",
      `  ${verifyUrl}`,
      `User code: ${started.userCode}`,
      "Waiting for approval...",
    ].join("\n"),
  );
  const expiresMs = Date.parse(started.expiresAt);
  const fallbackDeadline = (yield* Clock.currentTimeMillis) + 600_000;
  const deadline = Number.isFinite(expiresMs) ? expiresMs : fallbackDeadline;
  while (true) {
    yield* Effect.sleep(Duration.seconds(started.intervalSeconds));
    const poll = yield* pollRelayDeviceAuth(started.normalizedUrl, started.deviceCode);
    if (poll.status === "approved") {
      return toStoredCliSession(started.normalizedUrl, poll.session);
    }
    if (poll.status === "expired" || (yield* Clock.currentTimeMillis) >= deadline) {
      return yield* userError(
        "device-auth",
        "Device authorization code expired. Retry `t3 relay login`.",
      );
    }
  }
});

export const runRelayLogin = Effect.fn("cli.relay.login")(function* (flags: {
  readonly url: Option.Option<string>;
  readonly username: Option.Option<string>;
  readonly password: Option.Option<string>;
  readonly device: boolean;
}) {
  yield* requireSelfHostedRelayAllowed;
  const existing = yield* RelayState.readRelayCliSession();
  const relayUrl = yield* resolveRelayUrlInput(
    flags.url,
    Option.isSome(existing) ? existing.value.relayUrl : null,
  );
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const hasPasswordInputs = Option.isSome(flags.username) || Option.isSome(flags.password);
  const stored =
    flags.device || (!hasPasswordInputs && !interactive)
      ? yield* loginWithDeviceFlow(relayUrl)
      : yield* Effect.gen(function* () {
          const usernameRaw =
            Option.getOrUndefined(flags.username) ??
            (yield* Prompt.run(Prompt.String({ message: "Relay username:" })).pipe(
              Effect.catchTags({ QuitError: () => Effect.succeed("") }),
            ));
          const passwordRaw =
            Option.getOrUndefined(flags.password) ??
            (yield* Prompt.run(Prompt.Password({ message: "Relay password:" })).pipe(
              Effect.map((secret) => Redacted.value(secret)),
              Effect.catchTags({ QuitError: () => Effect.succeed("") }),
            ));
          if (!usernameRaw.trim() || !passwordRaw.trim()) {
            return yield* userError("credentials", "Username and password are required.");
          }
          const res = yield* loginToRelay(relayUrl, {
            username: TrimmedNonEmptyString.make(usernameRaw.trim()),
            password: TrimmedNonEmptyString.make(passwordRaw.trim()),
            clientSurface: ClientSurface.make("cli"),
            deviceLabel: TrimmedNonEmptyString.make("t3 cli"),
          });
          return toStoredCliSession(res.normalizedUrl, res.session);
        });
  yield* RelayState.saveRelayCliSession(stored);
  yield* Console.log(`Signed in to ${stored.relayUrl} as ${stored.username} (${stored.role}).`);
  return stored;
});

export const runRelayLogout = Effect.fn("cli.relay.logout")(function* () {
  const existing = yield* RelayState.readRelayCliSession();
  if (Option.isSome(existing)) {
    yield* logoutFromRelay(
      existing.value.relayUrl,
      existing.value.accessToken,
      existing.value.refreshToken,
    ).pipe(Effect.ignore);
    yield* RelayState.clearRelayCliSession();
    yield* Console.log(`Signed out from ${existing.value.relayUrl}.`);
  } else {
    yield* Console.log("Not signed in to a self-hosted relay.");
  }
});

export const runRelayLink = Effect.fn("cli.relay.link")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly url: Option.Option<string>;
  readonly token: Option.Option<string>;
}) {
  yield* requireSelfHostedRelayAllowed;
  const savedSession = yield* RelayState.readRelayCliSession();
  const savedLink = yield* RelayState.readRelayLinkConfig();
  const tokenOpt = Option.map(flags.token, (v) => v.trim()).pipe(
    Option.filter((v) => v.length > 0),
  );
  const relayUrl = yield* resolveRelayUrlInput(
    flags.url,
    Option.isSome(savedSession)
      ? savedSession.value.relayUrl
      : Option.isSome(savedLink)
        ? savedLink.value.relayUrl
        : null,
  );

  const linkResp = Option.isSome(tokenOpt)
    ? yield* Effect.gen(function* () {
        const { challenge } = yield* createRelayEnrollmentChallenge(relayUrl, tokenOpt.value);
        const proof = yield* createLocalLinkProof(relayUrl, challenge);
        return yield* enrollRelayEnvironment(relayUrl, tokenOpt.value, proof);
      })
    : yield* Effect.gen(function* () {
        if (Option.isNone(savedSession) || savedSession.value.relayUrl !== relayUrl) {
          const hint = yield* resolveHostCliHint(`relay login --url ${relayUrl}`, flags.baseDir);
          return yield* userError(
            "not-signed-in",
            `Not signed in to ${relayUrl}. Run \`${hint}\` or pass \`--token <enrollmentToken>\`.`,
          );
        }
        const fresh = yield* ensureFreshRelaySession(savedSession.value);
        const { challenge } = yield* createRelayLinkChallenge(relayUrl, fresh.accessToken);
        const proof = yield* createLocalLinkProof(relayUrl, challenge);
        return yield* linkRelayEnvironment(relayUrl, fresh.accessToken, proof);
      });

  const status = yield* applyHostRelayConfig({
    relayUrl: TrimmedNonEmptyString.make(relayUrl),
    relayIssuer: linkResp.relayIssuer,
    userId: linkResp.userId,
    endpoint: linkResp.endpoint,
    environmentCredential: linkResp.environmentCredential,
    relayMintPublicKey: linkResp.relayMintPublicKey,
  });
  yield* Console.log(
    [
      `Linked environment ${linkResp.environmentId}`,
      `  Relay: ${relayUrl}`,
      `  Endpoint: ${linkResp.endpoint.httpBaseUrl}`,
      `  Tunnel: ${status.tunnel.state}`,
    ].join("\n"),
  );
  return status;
});

export const runRelayUnlink = Effect.fn("cli.relay.unlink")(function* (flags: {
  readonly keepRemote: boolean;
}) {
  const existingLink = yield* RelayState.readRelayLinkConfig();
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;

  yield* RunningServer.changeState({
    scopes: [AuthRelayWriteScope],
    viaServer: (client) => client.relay.unlink({ headers: {} }),
    locally: RelayState.clearRelayLinkConfig().pipe(Effect.as({ ok: true as const })),
  });
  yield* Console.log("Removed self-hosted relay link locally.");

  if (!flags.keepRemote && Option.isSome(existingLink)) {
    const session = yield* RelayState.readRelayCliSession();
    if (Option.isSome(session) && session.value.relayUrl === existingLink.value.relayUrl) {
      const revoked = yield* ensureFreshRelaySession(session.value).pipe(
        Effect.flatMap((fresh) =>
          unlinkRelayEnvironment(existingLink.value.relayUrl, fresh.accessToken, environmentId),
        ),
        Effect.as(true),
        Effect.catch((err) =>
          Console.warn(`Warning: could not revoke remote relay link (${err.message}).`).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (revoked) {
        yield* Console.log("Revoked environment record on relay.");
      }
    }
  }
});

export const readRelayCliStatusReport = Effect.fn("cli.relay.status")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const [linkOpt, sessionOpt, liveServer] = yield* Effect.all([
    RelayState.readRelayLinkConfig(),
    RelayState.readRelayCliSession(),
    readLiveServerRuntimeState(config.serverRuntimeStatePath),
  ]);
  const liveStatus = Option.isSome(liveServer)
    ? yield* RunningServer.serverClient(liveServer.value.origin, [AuthRelayReadScope]).pipe(
        Effect.flatMap((client) => client.relay.status({ headers: {} })),
        Effect.timeout(LIVE_STATUS_TIMEOUT),
        Effect.scoped,
        Effect.option,
      )
    : Option.none<HostRelayStatus>();

  const status = Option.getOrElse(liveStatus, () =>
    offlineRelayStatus(Option.getOrUndefined(linkOpt) ?? null),
  );
  const cliSession = Option.isSome(sessionOpt)
    ? {
        relayUrl: sessionOpt.value.relayUrl,
        username: sessionOpt.value.username,
        role: sessionOpt.value.role,
      }
    : null;
  return { serverRunning: Option.isSome(liveStatus), status, cliSession };
});

export function formatRelayStatusJson(report: {
  readonly serverRunning: boolean;
  readonly status: HostRelayStatus;
  readonly cliSession: {
    readonly relayUrl: string;
    readonly username: string;
    readonly role: string;
  } | null;
}): string {
  return JSON.stringify(report, null, 2);
}

export function formatRelayStatusReport(report: {
  readonly serverRunning: boolean;
  readonly status: HostRelayStatus;
  readonly cliSession: {
    readonly relayUrl: string;
    readonly username: string;
    readonly role: string;
  } | null;
}): string {
  const { status, cliSession, serverRunning } = report;
  return [
    "Self-hosted Relay",
    `  Linked: ${status.linked ? "yes" : "no"}`,
    `  Relay URL: ${status.relayUrl ?? "none"}`,
    `  CLI sign-in: ${cliSession ? `${cliSession.username} (${cliSession.role}) @ ${cliSession.relayUrl}` : "not signed in"}`,
    `  Endpoint: ${status.endpoint ? status.endpoint.httpBaseUrl : "none"}`,
    `  Tunnel: ${serverRunning ? status.tunnel.state : `${status.tunnel.state} (server stopped)`}`,
    ...(status.tunnel.runId !== null ? [`  Run ID: ${status.tunnel.runId}`] : []),
    ...(status.tunnel.rttMs !== null ? [`  RTT: ${status.tunnel.rttMs} ms`] : []),
    ...(status.tunnel.activeStreams > 0
      ? [`  Active streams: ${status.tunnel.activeStreams}`]
      : []),
    ...(status.tunnel.lastError ? [`  Last error: ${status.tunnel.lastError}`] : []),
  ].join("\n");
}
