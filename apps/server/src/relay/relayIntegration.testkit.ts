// @effect-diagnostics nodeBuiltinImport:off -- End-to-end relay integration fixtures manage real processes and localhost HTTP/WS sockets.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, ScheduledTaskWebhookDeliveryId } from "@t3tools/contracts";
import { RELAY_PRESENCE_EVENTS_PATH } from "@t3tools/contracts/agentVelaRelay";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { expect } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import { type RawData, WebSocket, WebSocketServer } from "ws";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as EnvironmentKeys from "../cloud/environmentKeys.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RelayDeliveryProof from "../scheduledTasks/RelayDeliveryProof.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as WebhookRoute from "../scheduledTasks/webhookRoute.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Workflows from "../workflows/Workflows.ts";
import * as RelayBrokerHttp from "./brokerHttp.ts";
import * as RelayHttp from "./http.ts";
import * as RelayBrokerService from "./RelayBrokerService.ts";
import * as RelayLinkService from "./RelayLinkService.ts";
import * as RelayTunnelClient from "./RelayTunnelClient.ts";

class RelayIntegrationHostApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.connect)
  .add(EnvironmentHttpApi.groups.relay)
  .add(EnvironmentHttpApi.groups.webhooks) {}

const RELAY_BIN_PATH = NodePath.resolve(import.meta.dirname, "../../../relay/src/bin.ts");
export const RELAY_ADMIN_PASS = "IntegrationAdminPassword123!";
export type WebRequestFn = (req: Request) => Promise<Response>;

export async function reserveFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = NodeNet.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        addr && typeof addr !== "string" ? resolve(addr.port) : reject(new Error("Missing port")),
      );
    });
  });
}

async function readNodeBody(req: NodeHttp.IncomingMessage): Promise<Buffer> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function httpJson<T = unknown>(input: {
  readonly baseUrl: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly rawBody?: string;
}): Promise<{ readonly status: number; readonly data: T }> {
  const url = new URL(input.path, input.baseUrl);
  const bodyStr =
    input.rawBody ?? (input.body !== undefined ? JSON.stringify(input.body) : undefined);
  const payload = bodyStr !== undefined ? Buffer.from(bodyStr, "utf8") : undefined;
  return await new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      {
        hostname: url.hostname,
        port: url.port,
        method: input.method,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(payload ? { "content-length": String(payload.byteLength) } : {}),
          ...input.headers,
        },
      },
      (res) => {
        void readNodeBody(res).then((buf) => {
          const text = buf.toString("utf8");
          resolve({ status: res.statusCode ?? 0, data: (text ? JSON.parse(text) : null) as T });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function makeDpopSigner(iat: number) {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const thumbprint = computeDpopJwkThumbprint(publicJwk);
  let seq = 0;
  return {
    thumbprint,
    sign: (method: string, url: string, accessToken?: string) => {
      const hdr = Buffer.from(
        JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }),
      ).toString("base64url");
      const body = Buffer.from(
        JSON.stringify({
          htm: method,
          htu: url,
          jti: `int-dpop-${++seq}`,
          iat,
          ...(accessToken ? { ath: computeDpopAccessTokenHash(accessToken) } : {}),
        }),
      ).toString("base64url");
      const sig = NodeCrypto.sign("sha256", Buffer.from(`${hdr}.${body}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${hdr}.${body}.${sig}`;
    },
  };
}

export function connectRelaySse(baseUrl: string, token: string) {
  const url = new URL(baseUrl);
  const queue: Array<{ readonly type: string }> = [];
  let wake: (() => void) | null = null;
  let buffer = "";
  const req = NodeHttp.request(
    {
      hostname: url.hostname,
      port: url.port,
      method: "GET",
      path: RELAY_PRESENCE_EVENTS_PATH,
      headers: { authorization: `Bearer ${token}` },
    },
    (res) => {
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n\n")) {
          const idx = buffer.indexOf("\n\n");
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            queue.push(JSON.parse(line.slice(6)) as { readonly type: string });
            wake?.();
            wake = null;
          }
        }
      });
    },
  );
  req.end();
  return {
    nextOfType: async (expected: string) => {
      while (true) {
        while (queue.length === 0) {
          await new Promise<void>((r) => {
            wake = r;
          });
        }
        const ev = queue.shift()!;
        if (ev.type === expected) return ev;
      }
    },
    close: () => req.destroy(),
  };
}

export async function exerciseWsEcho(wsUrl: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const seen: Array<string> = [];
    ws.on("error", reject);
    ws.on("open", () => ws.send("hello-tunnel"));
    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (!isBinary) {
        seen.push(raw.toString());
        ws.send(new Uint8Array([9, 8, 7]), { binary: true });
        return;
      }
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      seen.push(`bin:${bytes.join(",")}`);
      ws.close(1000, "ws-e2e-done");
    });
    ws.on("close", (code) => {
      expect(seen).toEqual(["echo:hello-tunnel", "bin:9,8,7"]);
      resolve(code);
    });
  });
}

function awaitRelayReady(child: NodeChildProcess.ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let out = "";
    let err = "";
    const cleanup = () => {
      child.stdout?.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("exit", onExit);
      child.off("error", onErrObj);
    };
    const onOut = (c: Buffer) => {
      out += c.toString("utf8");
      if (out.includes("listening on")) {
        cleanup();
        resolve();
      }
    };
    const onErr = (c: Buffer) => {
      err += c.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Relay exited early (${code}): ${err}`));
    };
    const onErrObj = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.once("exit", onExit);
    child.once("error", onErrObj);
  });
}

export function spawnRealRelay(port: number, tempDir: string) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const tomlPath = NodePath.join(tempDir, "relay.toml");
      await NodeFSP.writeFile(
        tomlPath,
        [
          "[server]",
          `bind = "127.0.0.1:${port}"`,
          `public_url = "http://127.0.0.1:${port}"`,
          `data_dir = "${NodePath.join(tempDir, "relay-data")}"`,
          "serve_web_ui = false",
        ].join("\n"),
      );
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["--experimental-strip-types", RELAY_BIN_PATH, "serve", "--config", tomlPath],
        {
          env: {
            ...process.env,
            AGENT_VELA_RELAY_ADMIN_USERNAME: "admin",
            AGENT_VELA_RELAY_ADMIN_PASSWORD: RELAY_ADMIN_PASS,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await awaitRelayReady(child);
      return { child, baseUrl: `http://127.0.0.1:${port}` };
    }),
    ({ child }) =>
      Effect.promise(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
        });
      }),
  );
}

export function makeHostServiceLayer(
  tempDir: string,
  hostPort: number,
  webhookCalls: Array<ScheduledTaskService.WebhookTriggerRequest>,
) {
  const platform = Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer);
  const config = ServerConfig.layerTest(tempDir, { prefix: "t3-int-host-" }).pipe(
    Layer.provide(platform),
  );
  const secrets = ServerSecretStore.layer.pipe(
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  );
  const policy = ManagedPolicy.layerTest();
  const env = ServerEnvironment.layer.pipe(
    Layer.provideMerge(secrets),
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(policy),
    Layer.provideMerge(platform),
  );
  const keys = EnvironmentKeys.layer.pipe(
    Layer.provideMerge(secrets),
    Layer.provideMerge(platform),
  );
  const settings = ServerSettings.ServerSettingsService.layerTest({
    requireConnectDeviceApproval: false,
  });
  const auth = EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(env),
    Layer.provideMerge(secrets),
    Layer.provideMerge(policy),
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  );
  const stubs = Layer.mergeAll(
    Layer.mock(HttpServer.HttpServer)({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", hostPort),
    }),
    Layer.mock(Workflows.Workflows)({ deliver: () => Effect.succeedNone }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      triggerWebhook: (req) =>
        Effect.sync(() => {
          webhookCalls.push(req);
          return {
            _tag: "accepted" as const,
            deliveryId: ScheduledTaskWebhookDeliveryId.make("deliv-int-1"),
            outcome: "accepted" as const,
          };
        }),
    }),
  );
  const baseDeps = Layer.mergeAll(keys, env, secrets, policy, config, platform);
  const broker = RelayBrokerService.layer.pipe(
    Layer.provideMerge(settings),
    Layer.provideMerge(auth),
    Layer.provideMerge(baseDeps),
  );
  const tunnel = RelayTunnelClient.layer.pipe(Layer.provideMerge(baseDeps));
  const relayLinks = RelayLinkService.layer.pipe(
    Layer.provideMerge(tunnel),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(baseDeps),
  );
  const deliveryProof = RelayDeliveryProof.layer.pipe(Layer.provideMerge(baseDeps));
  return Layer.mergeAll(broker, relayLinks, tunnel, auth, deliveryProof, stubs, baseDeps);
}

async function handleNodeAsWeb(
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  port: number,
  webFn: WebRequestFn,
) {
  const method = (req.method ?? "GET").toUpperCase();
  const rawBody = method === "GET" || method === "HEAD" ? undefined : await readNodeBody(req);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
  }
  const webReq = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
    method,
    headers,
    ...(rawBody && rawBody.byteLength > 0 ? { body: new Uint8Array(rawBody) } : {}),
  });
  Object.defineProperty(webReq, "socket", {
    value: { remoteAddress: req.socket.remoteAddress ?? "127.0.0.1" },
    configurable: true,
  });
  const webRes = await webFn(webReq);
  const outHeaders: Record<string, string> = {};
  webRes.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  res.writeHead(webRes.status, outHeaders);
  res.end(
    method === "HEAD" || !webRes.body ? undefined : new Uint8Array(await webRes.arrayBuffer()),
  );
}

export function acquireHostHttpServer() {
  let webFn: WebRequestFn = async () => new Response("Starting", { status: 503 });
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const wss = new WebSocketServer({ noServer: true });
      const server = NodeHttp.createServer((req, res) => {
        const port = (server.address() as NodeNet.AddressInfo).port;
        void handleNodeAsWeb(req, res, port, webFn);
      });
      server.on("upgrade", (req, socket, head) => {
        if (req.url !== "/ws-echo") return socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("message", (raw: RawData, isBinary: boolean) => {
            ws.send(isBinary ? raw : `echo:${raw.toString()}`, { binary: isBinary });
          });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as NodeNet.AddressInfo).port;
      return {
        server,
        wss,
        port,
        setHandler: (fn: WebRequestFn) => {
          webFn = fn;
        },
      };
    }),
    ({ server, wss }) =>
      Effect.promise(async () => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );
}

export const buildHostWebApp = Effect.fn("RelayIntegration.buildHostWebApp")(function* () {
  const s = yield* Effect.all({
    broker: RelayBrokerService.RelayBrokerService,
    relayLinks: RelayLinkService.RelayLinkService,
    tunnelClient: RelayTunnelClient.RelayTunnelClient,
    auth: EnvironmentAuth.EnvironmentAuth,
    sessions: SessionStore.SessionStore,
    secrets: ServerSecretStore.ServerSecretStore,
    identity: ServerEnvironment.ServerEnvironment,
    deliveryProof: RelayDeliveryProof.RelayDeliveryProof,
    workflows: Workflows.Workflows,
    tasks: ScheduledTaskService.ScheduledTaskService,
    policy: ManagedPolicy.ManagedPolicy,
  });
  const shared = Layer.mergeAll(
    Layer.succeed(RelayBrokerService.RelayBrokerService, s.broker),
    Layer.succeed(RelayLinkService.RelayLinkService, s.relayLinks),
    Layer.succeed(RelayTunnelClient.RelayTunnelClient, s.tunnelClient),
    Layer.succeed(EnvironmentAuth.EnvironmentAuth, s.auth),
    Layer.succeed(SessionStore.SessionStore, s.sessions),
    Layer.succeed(ServerSecretStore.ServerSecretStore, s.secrets),
    Layer.succeed(ServerEnvironment.ServerEnvironment, s.identity),
    Layer.succeed(RelayDeliveryProof.RelayDeliveryProof, s.deliveryProof),
    Layer.succeed(Workflows.Workflows, s.workflows),
    Layer.succeed(ScheduledTaskService.ScheduledTaskService, s.tasks),
    Layer.succeed(ManagedPolicy.ManagedPolicy, s.policy),
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
    HttpServer.layerServices,
    NodeServices.layer,
    NodePlatformCrypto.layer,
  );
  const handlerContext = yield* Effect.context<
    Digest.Digest | ServerSecretStore.ServerSecretStore
  >();
  const webApp = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(RelayIntegrationHostApi).pipe(
          Layer.provide(AuthHttp.layer),
          Layer.provide(RelayBrokerHttp.layer),
          Layer.provide(RelayHttp.layer),
          Layer.provide(WebhookRoute.layer),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
          Layer.provide(shared),
        ),
        { disableLogger: true },
      ),
    ),
    (app) => Effect.promise(() => app.dispose()),
  );
  return { handler: (req: Request) => webApp.handler(req, handlerContext), ...s };
});
