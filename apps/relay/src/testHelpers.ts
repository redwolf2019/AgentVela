// @effect-diagnostics nodeBuiltinImport:off -- Shared test harness utilities run Node http/ws/crypto clients.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { EnvironmentId } from "@t3tools/contracts";
import {
  RELAY_PRESENCE_EVENTS_PATH,
  RELAY_TUNNEL_CONNECT_PATH,
} from "@t3tools/contracts/agentVelaRelay";
import { computeDpopAccessTokenHash, type DpopPublicJwk } from "@t3tools/shared/dpop";
import { RELAY_TUNNEL_LOGIN_TYP } from "@t3tools/shared/relayJwt";
import type { RelayTunnelFrame } from "@t3tools/shared/relayTunnelProtocol";
import { WebSocket, type RawData } from "ws";

import { RELAY_SERVICE_VERSION, type ResolvedRelayConfig } from "./config.ts";
import { decodeFrameSync, encodeFrameSync } from "./tunnel/codec.ts";

export function signEd25519Jwt(input: {
  readonly typ: string;
  readonly payload: Record<string, unknown>;
  readonly privateKeyPem: string;
}): string {
  const header = Buffer.from(JSON.stringify({ typ: input.typ, alg: "EdDSA" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(input.payload)).toString("base64url");
  const sig = NodeCrypto.sign(null, Buffer.from(`${header}.${body}`), input.privateKeyPem).toString(
    "base64url",
  );
  return `${header}.${body}.${sig}`;
}

export function decodeJwtPayloadNoVerify(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

export function signDpop(input: {
  readonly method: string;
  readonly url: string;
  readonly jti: string;
  readonly iat: number;
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk;
  readonly accessToken?: string;
}): string {
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti,
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const sig = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

export function rawToBytes(raw: RawData): Uint8Array {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Buffer.concat(raw);
}

export async function rawHttp(input: {
  readonly baseUrl: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: Buffer | string;
}): Promise<{
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
}> {
  const target = new URL(input.baseUrl);
  const bodyBuf = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
  return await new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: input.method,
        path: input.path,
        headers: {
          ...(bodyBuf ? { "content-length": String(bodyBuf.byteLength) } : {}),
          ...input.headers,
        },
      },
      (res) => {
        const chunks: Array<Buffer> = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    if (bodyBuf) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

export function connectSseEvents(baseUrl: string, token: string) {
  const target = new URL(baseUrl);
  const queue: Array<Record<string, unknown>> = [];
  let waiter: (() => void) | null = null;
  let buffer = "";
  const req = NodeHttp.request(
    {
      hostname: target.hostname,
      port: target.port,
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
            if (line.startsWith("data: ")) {
              queue.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
              waiter?.();
              waiter = null;
            }
          }
        }
      });
    },
  );
  req.end();
  return {
    nextEvent: async () => {
      while (queue.length === 0) {
        await new Promise<void>((r) => {
          waiter = r;
        });
      }
      return queue.shift()!;
    },
    close: () => req.destroy(),
  };
}

export function makeRelayTestConfig(input: {
  readonly dataDir: string;
  readonly webUiDir?: string;
  readonly maxFrameBytes?: number;
  readonly initialStreamWindowBytes?: number;
}): ResolvedRelayConfig {
  return {
    bind: { host: "127.0.0.1", port: 0 },
    publicUrl: "http://127.0.0.1:8787",
    dataDir: input.dataDir,
    sqlitePath: NodePath.join(input.dataDir, "relay.sqlite"),
    serveWebUi: Boolean(input.webUiDir),
    ...(input.webUiDir ? { webUiDir: input.webUiDir } : {}),
    trustProxy: false,
    auth: {
      allowPublicRegistration: false,
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
      enrollmentTokenTtlMinutes: 15,
      deviceCodeTtlMinutes: 10,
      bootstrapAdminUsername: "admin",
      bootstrapAdminPassword: "e2e-relay-admin-passphrase",
    },
    tunnel: {
      maxFrameBytes: input.maxFrameBytes ?? 262_144,
      heartbeatIntervalMs: 20_000,
      heartbeatTimeoutMs: 60_000,
      compression: true,
      initialStreamWindowBytes: input.initialStreamWindowBytes ?? 524_288,
      proxyTimeoutMs: 10_000,
    },
    rateLimit: {
      loginMaxAttempts: 50,
      loginWindowSeconds: 60,
      dpopMaxAttempts: 100,
      proxyMaxRequests: 1000,
    },
    version: RELAY_SERVICE_VERSION,
  };
}

export async function openMockTunnel(input: {
  readonly wsUrl: string;
  readonly issuer: string;
  readonly environmentId: string;
  readonly credential: string;
  readonly privateKeyPem: string;
  readonly iat: number;
  readonly maxFrameBytes?: number;
  readonly initialStreamWindowBytes?: number;
  readonly onStreamFrame?: (
    frame: RelayTunnelFrame,
    send: (frame: RelayTunnelFrame) => void,
  ) => void;
}) {
  const maxFrameBytes = input.maxFrameBytes ?? 262_144;
  const initialStreamWindowBytes = input.initialStreamWindowBytes ?? 524_288;
  const ws = new WebSocket(`${input.wsUrl}${RELAY_TUNNEL_CONNECT_PATH}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const ctrlQueue: Array<RelayTunnelFrame> = [];
  let ctrlWaiter: (() => void) | null = null;
  let goAwayResolve!: (frame: Extract<RelayTunnelFrame, { readonly type: "goaway" }>) => void;
  const goAwayPromise = new Promise<Extract<RelayTunnelFrame, { readonly type: "goaway" }>>((r) => {
    goAwayResolve = r;
  });
  const send = (frame: RelayTunnelFrame) => ws.send(encodeFrameSync(frame, maxFrameBytes));

  ws.on("message", (raw: RawData) => {
    const decoded = decodeFrameSync(rawToBytes(raw), maxFrameBytes);
    if (decoded.streamId > 0 && input.onStreamFrame) {
      input.onStreamFrame(decoded, send);
      return;
    }
    if (decoded.type === "goaway") {
      goAwayResolve(decoded);
      return;
    }
    if (decoded.type === "ping") {
      send({ type: "pong", streamId: 0, payload: decoded.payload });
      return;
    }
    ctrlQueue.push(decoded);
    ctrlWaiter?.();
    ctrlWaiter = null;
  });

  const nextCtrl = async () => {
    while (ctrlQueue.length === 0) {
      await new Promise<void>((r) => {
        ctrlWaiter = r;
      });
    }
    return ctrlQueue.shift()!;
  };

  send({
    type: "login",
    streamId: 0,
    payload: {
      environmentId: EnvironmentId.make(input.environmentId),
      credential: input.credential,
      proof: signEd25519Jwt({
        typ: RELAY_TUNNEL_LOGIN_TYP,
        privateKeyPem: input.privateKeyPem,
        payload: {
          iss: `t3-env:${input.environmentId}`,
          aud: input.issuer,
          sub: input.environmentId,
          jti: NodeCrypto.randomUUID(),
          iat: input.iat,
          exp: input.iat + 120,
          environmentId: input.environmentId,
          nonce: NodeCrypto.randomUUID(),
        },
      }),
      capabilities: {
        protocolVersion: 1,
        maxFrameBytes,
        heartbeatIntervalMs: 20_000,
        heartbeatTimeoutMs: 60_000,
        initialStreamWindowBytes,
        compression: true,
      },
    },
  });
  const loginResp = await nextCtrl();
  if (loginResp.type !== "login_resp" || !loginResp.payload.ok) {
    throw new Error(`Unexpected login_resp: ${JSON.stringify(loginResp)}`);
  }

  send({
    type: "register_proxy",
    streamId: 0,
    payload: { environmentId: EnvironmentId.make(input.environmentId), label: "Workstation" },
  });
  const regResp = await nextCtrl();
  if (regResp.type !== "register_proxy_resp" || !regResp.payload.ok) {
    throw new Error(`Unexpected register_proxy_resp: ${JSON.stringify(regResp)}`);
  }

  return {
    runId: loginResp.payload.runId,
    endpoint: regResp.payload.endpoint,
    goAwayPromise,
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === ws.CLOSED) {
          resolve();
          return;
        }
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}
