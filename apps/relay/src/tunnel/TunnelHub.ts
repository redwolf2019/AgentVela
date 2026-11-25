// @effect-diagnostics nodeBuiltinImport:off -- TunnelHub generates cryptographic traceIds via node:crypto.
import * as NodeCrypto from "node:crypto";

import { IsoDateTime, type EnvironmentId } from "@t3tools/contracts";
import {
  RelayEndpointTimedOutError,
  RelayNotFoundError,
  RelayTunnelOfflineError,
  type AgentVelaRelayListEnvironmentsResponse,
  type RelayAdminListTunnelsResponse,
  type RelayEndpointKey,
  type RelayInternalError,
  type RelayUserId,
} from "@t3tools/contracts/agentVelaRelay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { WebSocket } from "ws";

import { RelayConfig } from "../config.ts";
import { EnvironmentService } from "../environments/EnvironmentService.ts";
import { PresenceHub } from "../environments/PresenceHub.ts";
import { RelayDatabase } from "../persistence/database.ts";
import {
  type TunnelHttpStreamResponse,
  type TunnelOpenHttpInput,
  type TunnelOpenWsInput,
  TunnelStreamError,
} from "./codec.ts";
import { type TunnelLoginAuthResult, TunnelSession } from "./TunnelSession.ts";
import type { AcceptedWsStream } from "./wsStream.ts";

const isTunnelStreamError = Schema.is(TunnelStreamError);
const newTraceId = (): string => NodeCrypto.randomUUID();

function mapTunnelError(cause: unknown): RelayTunnelOfflineError | RelayEndpointTimedOutError {
  if (isTunnelStreamError(cause)) {
    if (cause.reason === "timed_out") {
      return new RelayEndpointTimedOutError({ code: "endpoint_timed_out", traceId: newTraceId() });
    }
    return new RelayTunnelOfflineError({
      code: "tunnel_offline",
      reason: cause.reason === "offline" ? "tunnel_disconnected" : "origin_unreachable",
      ...(cause.httpStatus !== undefined ? { endpointStatus: cause.httpStatus } : {}),
      traceId: newTraceId(),
    });
  }
  return new RelayTunnelOfflineError({
    code: "tunnel_offline",
    reason: "origin_unreachable",
    traceId: newTraceId(),
  });
}

export class TunnelHub extends Context.Service<
  TunnelHub,
  {
    readonly acceptSocket: (ws: WebSocket) => void;
    readonly isOnline: (environmentId: EnvironmentId) => boolean;
    readonly getRttMs: (environmentId: EnvironmentId) => number | null;
    readonly listEnvironmentsForUser: (
      userId: RelayUserId,
    ) => Effect.Effect<AgentVelaRelayListEnvironmentsResponse, RelayInternalError>;
    readonly listTunnels: () => RelayAdminListTunnelsResponse;
    readonly kickTunnel: (input: {
      readonly environmentId: EnvironmentId;
      readonly reason?: string;
    }) => Effect.Effect<{ readonly ok: true }, RelayNotFoundError>;
    readonly disconnectIfActive: (environmentId: EnvironmentId, reason?: string) => void;
    readonly closeAllForShutdown: () => void;
    readonly openHttpByEnvironmentId: (
      environmentId: EnvironmentId,
      input: TunnelOpenHttpInput,
    ) => Effect.Effect<
      TunnelHttpStreamResponse,
      RelayTunnelOfflineError | RelayEndpointTimedOutError
    >;
    readonly openHttpByEndpointKey: (
      endpointKey: RelayEndpointKey,
      input: TunnelOpenHttpInput,
    ) => Effect.Effect<
      TunnelHttpStreamResponse,
      RelayNotFoundError | RelayTunnelOfflineError | RelayEndpointTimedOutError
    >;
    readonly openWsByEndpointKey: (
      endpointKey: RelayEndpointKey,
      input: TunnelOpenWsInput,
    ) => Effect.Effect<
      AcceptedWsStream,
      RelayNotFoundError | RelayTunnelOfflineError | RelayEndpointTimedOutError
    >;
  }
>()("agent-vela-relay/tunnel/TunnelHub") {}

export const layerTunnelHub = Layer.effect(
  TunnelHub,
  Effect.gen(function* () {
    const config = yield* RelayConfig;
    const db = yield* RelayDatabase;
    const environments = yield* EnvironmentService;
    const presence = yield* PresenceHub;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

    const sessionsByEnvId = new Map<EnvironmentId, TunnelSession>();
    const sessionsByEndpointKey = new Map<RelayEndpointKey, TunnelSession>();

    const serverCapabilities = {
      protocolVersion: 1 as const,
      maxFrameBytes: config.tunnel.maxFrameBytes,
      heartbeatIntervalMs: config.tunnel.heartbeatIntervalMs,
      heartbeatTimeoutMs: config.tunnel.heartbeatTimeoutMs,
      initialStreamWindowBytes: config.tunnel.initialStreamWindowBytes,
      compression: config.tunnel.compression,
    };

    const evictSessionFromMaps = (session: TunnelSession): boolean => {
      const reg = session.registration;
      if (!reg || session.runId === null) {
        return false;
      }
      const current = sessionsByEnvId.get(reg.environmentId);
      if (!current || current.runId !== session.runId) {
        return false;
      }
      sessionsByEnvId.delete(reg.environmentId);
      sessionsByEndpointKey.delete(reg.endpointKey);
      return true;
    };

    const authenticateLoginEffect = Effect.fn("TunnelHub.authenticateLogin")(
      function* (loginInput: {
        readonly environmentId: EnvironmentId;
        readonly credential: string;
        readonly proof: string;
      }): Effect.fn.Return<TunnelLoginAuthResult> {
        return yield* Effect.gen(function* () {
          const env = yield* environments.verifyTunnelLogin(loginInput);
          const runId = yield* db.nextRunId();
          return {
            ok: true,
            runId,
            registration: {
              environmentId: env.environmentId,
              endpointKey: env.endpointKey,
              endpoint: env.endpoint,
              label: env.label,
              userId: env.userId,
              username: env.username,
            },
          } satisfies TunnelLoginAuthResult;
        }).pipe(
          Effect.catch((error): Effect.Effect<TunnelLoginAuthResult> => {
            if (error._tag === "RelayNotFoundError") {
              return Effect.succeed({
                ok: false,
                code: "environment_not_linked",
                message: error.message,
              });
            }
            if (error._tag === "RelayAuthError") {
              return Effect.succeed({
                ok: false,
                code: "auth_invalid",
                message: error.message,
              });
            }
            return Effect.succeed({
              ok: false,
              code: "internal_error",
              message: "Tunnel login failed due to internal error",
            });
          }),
        );
      },
    );

    const acceptSocket = (ws: WebSocket): void => {
      TunnelSession.attach(ws, {
        serverCapabilities,
        authenticateLogin: (loginInput) => runPromise(authenticateLoginEffect(loginInput)),
        onRegistered: (session) =>
          runPromise(
            Effect.gen(function* () {
              const reg = session.registration;
              if (!reg || session.runId === null) {
                return;
              }
              const previous = sessionsByEnvId.get(reg.environmentId);
              if (previous && previous.runId !== session.runId) {
                evictSessionFromMaps(previous);
                previous.closeWithGoAway("superseded", "Superseded by newer tunnel session");
              }
              sessionsByEnvId.set(reg.environmentId, session);
              sessionsByEndpointKey.set(reg.endpointKey, session);
              const seenAtIso = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
              yield* environments.touchLastSeen(reg.environmentId, seenAtIso).pipe(Effect.ignore);
              yield* presence.publish(reg.userId, {
                type: "environment.online",
                environmentId: reg.environmentId,
                endpoint: reg.endpoint,
                lastSeenAt: seenAtIso,
              });
            }),
          ),
        onClosed: (session) => {
          const evicted = evictSessionFromMaps(session);
          if (!evicted || !session.registration) {
            return;
          }
          const reg = session.registration;
          void runPromise(
            Effect.gen(function* () {
              const checkedAt = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
              yield* environments.touchLastSeen(reg.environmentId, checkedAt).pipe(Effect.ignore);
              yield* presence.publish(reg.userId, {
                type: "environment.offline",
                environmentId: reg.environmentId,
                checkedAt,
              });
            }),
          );
        },
      });
    };

    const isOnline = (environmentId: EnvironmentId): boolean =>
      sessionsByEnvId.get(environmentId)?.phase === "active";

    const getRttMs = (environmentId: EnvironmentId): number | null =>
      sessionsByEnvId.get(environmentId)?.rttMs ?? null;

    const listEnvironmentsForUser = Effect.fn("TunnelHub.listEnvironmentsForUser")(function* (
      userId: RelayUserId,
    ) {
      const rows = yield* environments.listUserEnvironments(userId);
      return {
        environments: rows.map((row) =>
          environments.toRecord(row, isOnline(row.environmentId) ? "online" : "offline"),
        ),
      } satisfies AgentVelaRelayListEnvironmentsResponse;
    });

    const listTunnels = (): RelayAdminListTunnelsResponse => {
      const tunnels = [];
      for (const session of sessionsByEnvId.values()) {
        const telemetry = session.toTelemetry();
        if (telemetry) {
          tunnels.push(telemetry);
        }
      }
      return { tunnels };
    };

    const kickTunnel = Effect.fn("TunnelHub.kickTunnel")(function* (input: {
      readonly environmentId: EnvironmentId;
      readonly reason?: string;
    }) {
      const session = sessionsByEnvId.get(input.environmentId);
      if (!session) {
        return yield* new RelayNotFoundError({
          code: "not_found",
          resource: "tunnel",
          traceId: newTraceId(),
        });
      }
      session.closeWithGoAway("kicked", input.reason ?? "Disconnected by administrator");
      return { ok: true as const };
    });

    const disconnectIfActive = (environmentId: EnvironmentId, reason?: string): void => {
      const session = sessionsByEnvId.get(environmentId);
      if (session) {
        session.closeWithGoAway("kicked", reason ?? "Environment unlinked");
      }
    };

    const closeAllForShutdown = (): void => {
      for (const session of Array.from(sessionsByEnvId.values())) {
        session.closeWithGoAway("server_shutdown", "Relay shutting down");
      }
      sessionsByEnvId.clear();
      sessionsByEndpointKey.clear();
    };

    const resolveSessionByEndpointKey = Effect.fn("TunnelHub.resolveByEndpointKey")(function* (
      endpointKey: RelayEndpointKey,
    ) {
      const session = sessionsByEndpointKey.get(endpointKey);
      if (session && session.phase === "active") {
        return session;
      }
      const linked = yield* environments.findByEndpointKey(endpointKey).pipe(Effect.orDie);
      if (!linked) {
        return yield* new RelayNotFoundError({
          code: "not_found",
          resource: "environment",
          traceId: newTraceId(),
        });
      }
      return yield* new RelayTunnelOfflineError({
        code: "tunnel_offline",
        reason: "tunnel_disconnected",
        traceId: newTraceId(),
      });
    });

    const openHttpByEnvironmentId = Effect.fn("TunnelHub.openHttpByEnvironmentId")(function* (
      environmentId: EnvironmentId,
      input: TunnelOpenHttpInput,
    ) {
      const session = sessionsByEnvId.get(environmentId);
      if (!session || session.phase !== "active") {
        return yield* new RelayTunnelOfflineError({
          code: "tunnel_offline",
          reason: "tunnel_disconnected",
          traceId: newTraceId(),
        });
      }
      return yield* Effect.tryPromise({
        try: () => session.openHttp(input),
        catch: mapTunnelError,
      });
    });

    const openHttpByEndpointKey = Effect.fn("TunnelHub.openHttpByEndpointKey")(function* (
      endpointKey: RelayEndpointKey,
      input: TunnelOpenHttpInput,
    ) {
      const session = yield* resolveSessionByEndpointKey(endpointKey);
      return yield* Effect.tryPromise({
        try: () => session.openHttp(input),
        catch: mapTunnelError,
      });
    });

    const openWsByEndpointKey = Effect.fn("TunnelHub.openWsByEndpointKey")(function* (
      endpointKey: RelayEndpointKey,
      input: TunnelOpenWsInput,
    ) {
      const session = yield* resolveSessionByEndpointKey(endpointKey);
      return yield* Effect.tryPromise({
        try: () => session.openWs(input),
        catch: mapTunnelError,
      });
    });

    return TunnelHub.of({
      acceptSocket,
      isOnline,
      getRttMs,
      listEnvironmentsForUser,
      listTunnels,
      kickTunnel,
      disconnectIfActive,
      closeAllForShutdown,
      openHttpByEnvironmentId,
      openHttpByEndpointKey,
      openWsByEndpointKey,
    });
  }),
);
