// @effect-diagnostics nodeBuiltinImport:off -- Relay HTTP/WS server bridges Node http and ws transports with Effect services.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentVelaRelayApi,
  RELAY_PRESENCE_EVENTS_PATH,
  type RelayPresenceEvent,
} from "@t3tools/contracts/agentVelaRelay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import { WebSocketServer } from "ws";

import { AuthService, layerRelayAuth, type AuthenticatedRelayClient } from "./auth/AuthService.ts";
import { layerRelayConfigFromValues, type ResolvedRelayConfig } from "./config.ts";
import { BrokerService, layerBrokerService } from "./environments/BrokerService.ts";
import { EnvironmentService, layerEnvironmentService } from "./environments/EnvironmentService.ts";
import { layerPresenceHub, PresenceHub } from "./environments/PresenceHub.ts";
import { INTERNAL_CLIENT_IP_HEADER, layerAgentVelaRelayHttpApi } from "./http/apiHandlers.ts";
import {
  applyRelayApiCorsHeaders,
  isRelayBrowserApiPath,
  writeRelayApiCorsPreflight,
} from "./http/cors.ts";
import { handleHookHttpForward } from "./http/hookHandler.ts";
import {
  handleEndpointHttpProxy,
  handleRelayUpgrade,
  type RelayProxyDeps,
} from "./http/proxyHandler.ts";
import { extractClientIp, layerRelayRateLimiter, RelayRateLimiter } from "./http/rateLimit.ts";
import { resolveDefaultWebUiDir, tryServeStaticWebUi } from "./http/staticWebUi.ts";
import { layerRelaySqliteLive, RelayDatabase } from "./persistence/database.ts";
import { layerTunnelHub, TunnelHub } from "./tunnel/TunnelHub.ts";

const MAX_API_BODY_BYTES = 2 * 1024 * 1024;

export interface RelayServerHandle {
  readonly port: number;
  readonly bindAddress: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly close: () => Promise<void>;
}

function buildCoreRelayLayer(config: ResolvedRelayConfig) {
  const platformLayer = Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer);
  const cfgLayer = layerRelayConfigFromValues(config);
  const dbLayer = layerRelaySqliteLive.pipe(Layer.provideMerge(cfgLayer));
  const authAndPresenceLayer = Layer.mergeAll(layerRelayAuth, layerPresenceHub).pipe(
    Layer.provideMerge(dbLayer),
    Layer.provideMerge(platformLayer),
  );
  const envLayer = layerEnvironmentService.pipe(Layer.provideMerge(authAndPresenceLayer));
  const tunnelLayer = layerTunnelHub.pipe(Layer.provideMerge(envLayer));
  const brokerLayer = layerBrokerService.pipe(Layer.provideMerge(tunnelLayer));
  return Layer.mergeAll(brokerLayer, layerRelayRateLimiter.pipe(Layer.provide(cfgLayer)));
}

function formatSseFrame(event: RelayPresenceEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isDpopRateLimitedPath(pathname: string): boolean {
  if (pathname === "/v1/auth/dpop-token") {
    return true;
  }
  return (
    pathname.startsWith("/v1/environments/") &&
    (pathname.endsWith("/connect") || pathname.endsWith("/status"))
  );
}

async function readApiRequestBody(req: NodeHttp.IncomingMessage): Promise<Uint8Array> {
  const chunks: Array<Buffer> = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_API_BODY_BYTES) {
      throw new Error("payload_too_large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function toNodeHeaders(webHeaders: Headers): Record<string, string | Array<string>> {
  const out: Record<string, string | Array<string>> = {};
  webHeaders.forEach((value, key) => {
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  });
  return out;
}

async function forwardToWebApiHandler(
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  config: ResolvedRelayConfig,
  webHandler: (request: Request, context: Context.Context<never>) => Promise<Response>,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const host = req.headers.host ?? `${config.bind.host}:${config.bind.port}`;
  const proto =
    config.trustProxy && new URL(config.publicUrl).protocol === "https:" ? "https" : "http";
  const url = `${proto}://${host}${req.url ?? "/"}`;

  let bodyBytes: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    try {
      bodyBytes = await readApiRequestBody(req);
    } catch {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "bad_request", reason: "payload_too_large" }));
      return;
    }
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === INTERNAL_CLIENT_IP_HEADER || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }
  headers.set(INTERNAL_CLIENT_IP_HEADER, extractClientIp(req, config.trustProxy));

  const request = new Request(url, {
    method,
    headers,
    ...(bodyBytes && bodyBytes.byteLength > 0 ? { body: Buffer.from(bodyBytes) } : {}),
  });

  const webRes = await webHandler(request, Context.empty());
  res.writeHead(webRes.status, toNodeHeaders(webRes.headers));
  if (method === "HEAD" || !webRes.body) {
    res.end();
    return;
  }
  res.end(new Uint8Array(await webRes.arrayBuffer()));
}

async function handlePresenceSse(
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  deps: {
    readonly auth: typeof AuthService.Service;
    readonly presence: typeof PresenceHub.Service;
    readonly tunnelHub: typeof TunnelHub.Service;
    readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
    readonly runFork: (effect: Effect.Effect<void>) => Fiber.Fiber<void, unknown>;
  },
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || authHeader.trim().length === 0) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "auth_invalid", reason: "missing_credentials" }));
    return;
  }

  let principal: AuthenticatedRelayClient;
  try {
    principal = await deps.runPromise(deps.auth.authenticateBearerToken(authHeader));
  } catch {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "auth_invalid", reason: "invalid_token" }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const eventStream = deps.presence.subscribe({
    userId: principal.userId,
    loadSnapshot: () =>
      deps.tunnelHub.listEnvironmentsForUser(principal.userId).pipe(
        Effect.map((list) => ({
          type: "snapshot" as const,
          environments: list.environments,
        })),
        Effect.orElseSucceed(() => ({
          type: "snapshot" as const,
          environments: [],
        })),
      ),
  });

  const fiber = deps.runFork(
    Stream.runForEach(eventStream, (event) =>
      Effect.sync(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(formatSseFrame(event));
        }
      }),
    ).pipe(Effect.ignore),
  );

  const stopStream = () => {
    void deps.runPromise(Fiber.interrupt(fiber)).catch(() => undefined);
  };
  req.once("close", stopStream);
  res.once("close", stopStream);
}

export async function startRelayServer(config: ResolvedRelayConfig): Promise<RelayServerHandle> {
  const runtime = ManagedRuntime.make(buildCoreRelayLayer(config));
  const services = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        auth: yield* AuthService,
        environments: yield* EnvironmentService,
        tunnelHub: yield* TunnelHub,
        broker: yield* BrokerService,
        presence: yield* PresenceHub,
        db: yield* RelayDatabase,
        rateLimiter: yield* RelayRateLimiter,
      };
    }),
  );

  const sharedServiceLayer = Layer.mergeAll(
    layerRelayConfigFromValues(config),
    Layer.succeed(RelayDatabase, services.db),
    Layer.succeed(AuthService, services.auth),
    Layer.succeed(PresenceHub, services.presence),
    Layer.succeed(EnvironmentService, services.environments),
    Layer.succeed(TunnelHub, services.tunnelHub),
    Layer.succeed(BrokerService, services.broker),
    Layer.succeed(RelayRateLimiter, services.rateLimiter),
  );

  const webApp = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(AgentVelaRelayApi).pipe(
      Layer.provide(layerAgentVelaRelayHttpApi),
      Layer.provide(sharedServiceLayer),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );

  const tunnelWss = new WebSocketServer({ noServer: true });
  const proxyWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });

  const proxyDeps: RelayProxyDeps = {
    config,
    auth: services.auth,
    environments: services.environments,
    tunnelHub: services.tunnelHub,
    rateLimiter: services.rateLimiter,
    proxyWss,
    tunnelWss,
    runPromise: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
  };

  const webUiDir = config.webUiDir ?? resolveDefaultWebUiDir();
  const httpServer = NodeHttp.createServer(async (req, res) => {
    try {
      const pathname = (req.url ?? "/").split("?", 1)[0] ?? "/";
      const method = (req.method ?? "GET").toUpperCase();
      if (isRelayBrowserApiPath(pathname)) {
        if (method === "OPTIONS") {
          writeRelayApiCorsPreflight(req, res);
          return;
        }
        applyRelayApiCorsHeaders(res);
      }
      if (pathname === RELAY_PRESENCE_EVENTS_PATH && method === "GET") {
        await handlePresenceSse(req, res, {
          auth: services.auth,
          presence: services.presence,
          tunnelHub: services.tunnelHub,
          runPromise: (effect) => runtime.runPromise(effect),
          runFork: (effect) => runtime.runFork(effect),
        });
        return;
      }
      if (await handleHookHttpForward(req, res, proxyDeps)) {
        return;
      }
      if (await handleEndpointHttpProxy(req, res, proxyDeps)) {
        return;
      }
      if (isDpopRateLimitedPath(pathname)) {
        const ip = extractClientIp(req, config.trustProxy);
        const rate = services.rateLimiter.allowDpop(`${pathname}:${ip}`);
        if (!rate.allowed) {
          res.writeHead(429, {
            "content-type": "application/json",
            "retry-after": String(rate.retryAfterSeconds),
          });
          res.end(
            JSON.stringify({
              code: "rate_limited",
              retryAfterSeconds: rate.retryAfterSeconds,
              traceId: NodeCrypto.randomUUID(),
            }),
          );
          return;
        }
      }
      if (
        config.serveWebUi &&
        !pathname.startsWith("/v1/") &&
        !pathname.startsWith("/api/") &&
        pathname !== "/health" &&
        pathname !== "/e" &&
        !pathname.startsWith("/e/")
      ) {
        if (await tryServeStaticWebUi(req, res, webUiDir)) {
          return;
        }
      }
      await forwardToWebApiHandler(req, res, config, webApp.handler);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "internal_error" }));
      } else {
        res.end();
      }
    }
  });

  httpServer.on("upgrade", (req, socket, head) => {
    void handleRelayUpgrade(req, socket, head, proxyDeps);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.bind.port, config.bind.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address() as NodeNet.AddressInfo;
  const boundHost = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  const displayHost = addr.address === "0.0.0.0" || addr.address === "::" ? "127.0.0.1" : boundHost;

  return {
    port: addr.port,
    bindAddress: `${boundHost}:${addr.port}`,
    localHttpUrl: `http://${displayHost}:${addr.port}`,
    localWsUrl: `ws://${displayHost}:${addr.port}`,
    close: async () => {
      services.tunnelHub.closeAllForShutdown();
      for (const client of tunnelWss.clients) {
        client.close(1001, "Server shutdown");
      }
      for (const client of proxyWss.clients) {
        client.close(1001, "Server shutdown");
      }
      await new Promise<void>((resolve) => {
        tunnelWss.close(() => proxyWss.close(() => httpServer.close(() => resolve())));
      });
      await webApp.dispose();
      await runtime.dispose();
    },
  };
}
