import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentVelaRelayApi,
  RelayAdminTunnelTelemetry,
  RelayEndpointKey,
  RelayInviteRecord,
  RelayLoginRequest,
  RelayPresenceEvent,
  RelayUsername,
  TunnelHttpResponsePayload,
  TunnelOpenHttpPayload,
  TunnelStreamEndPayload,
} from "./agentVelaRelay.ts";

const decodeEndpointKey = Schema.decodeUnknownExit(RelayEndpointKey);
const decodeUsername = Schema.decodeUnknownExit(RelayUsername);
const decodeLoginRequest = Schema.decodeUnknownExit(RelayLoginRequest);
const decodeInviteRecord = Schema.decodeUnknownExit(RelayInviteRecord);
const decodePresenceEvent = Schema.decodeUnknownExit(RelayPresenceEvent);
const decodeTunnelTelemetry = Schema.decodeUnknownExit(RelayAdminTunnelTelemetry);
const decodeOpenHttp = Schema.decodeUnknownExit(TunnelOpenHttpPayload);
const decodeHttpResponse = Schema.decodeUnknownExit(TunnelHttpResponsePayload);
const decodeStreamEnd = Schema.decodeUnknownExit(TunnelStreamEndPayload);

describe("agentVelaRelay contracts", () => {
  it.each(["host-01", "dev_box_99", "a123"])("accepts valid endpointKey %s", (value) => {
    expect(decodeEndpointKey(value)._tag).toBe("Success");
  });

  it.each(["../escape", "HostUpper", "abc", "a/b", "-leading", "with space"])(
    "rejects invalid endpointKey %s",
    (value) => {
      expect(decodeEndpointKey(value)._tag).toBe("Failure");
    },
  );

  it.each(["admin", "alice.dev-1"])("accepts valid username %s", (value) => {
    expect(decodeUsername(value)._tag).toBe("Success");
  });

  it.each(["a", ".dotstart", "bad user", "user/name"])("rejects invalid username %s", (value) => {
    expect(decodeUsername(value)._tag).toBe("Failure");
  });

  it("validates login requests and strips whitespace on usernames", () => {
    const result = decodeLoginRequest({
      username: "  alice-1  ",
      password: "correct-horse-battery",
      clientSurface: "desktop",
    });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value.username).toBe("alice-1");
    }
    expect(decodeLoginRequest({ username: "alice-1", password: "   " })._tag).toBe("Failure");
  });

  it("decodes invite read records without exposing a raw code field", () => {
    const result = decodeInviteRecord({
      inviteId: "inv-1",
      codePrefix: "AV-9F2K",
      role: "member",
      maxUses: 5,
      usesCount: 1,
      expiresAt: null,
      revokedAt: null,
      createdByUserId: "usr-1",
      createdAt: "2026-11-25T00:00:00.000Z",
    });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect("code" in result.value).toBe(false);
    }
  });

  it("decodes presence events and admin tunnel telemetry", () => {
    const endpoint = {
      endpointKey: "host-alpha",
      pathPrefix: "/e/host-alpha",
      httpBaseUrl: "https://relay.example.com/e/host-alpha",
      wsBaseUrl: "wss://relay.example.com/e/host-alpha",
    };

    expect(
      decodePresenceEvent({
        type: "snapshot",
        environments: [
          {
            environmentId: "env-1",
            label: "Workstation",
            endpoint,
            status: "online",
            linkedAt: "2026-11-25T00:00:00.000Z",
            lastSeenAt: "2026-11-25T00:01:00.000Z",
          },
        ],
      })._tag,
    ).toBe("Success");

    expect(
      decodePresenceEvent({
        type: "environment.offline",
        environmentId: "env-1",
        checkedAt: "2026-11-25T00:02:00.000Z",
      })._tag,
    ).toBe("Success");

    expect(
      decodeTunnelTelemetry({
        environmentId: "env-1",
        endpointKey: "host-alpha",
        label: "Workstation",
        userId: "usr-1",
        username: "admin",
        runId: 3,
        connectedAt: "2026-11-25T00:00:00.000Z",
        lastHeartbeatAt: "2026-11-25T00:01:00.000Z",
        rttMs: 14,
        activeStreams: 2,
        bytesIn: 1024,
        bytesOut: 4096,
        compression: true,
      })._tag,
    ).toBe("Success");
  });

  it("preserves duplicate HTTP headers and enforces HTTP status and WS close code bounds", () => {
    const open = decodeOpenHttp({
      method: "POST",
      path: "/oauth/token",
      headers: [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
      hasBody: true,
      externalHost: "relay.example.com",
      externalProto: "https",
      pathPrefix: "/e/host-alpha",
    });
    expect(open._tag).toBe("Success");
    if (open._tag === "Success") {
      expect(open.value.headers).toHaveLength(2);
    }

    expect(decodeHttpResponse({ status: 200, headers: [], hasBody: false })._tag).toBe("Success");
    expect(decodeHttpResponse({ status: 99, headers: [], hasBody: false })._tag).toBe("Failure");
    expect(decodeHttpResponse({ status: 600, headers: [], hasBody: false })._tag).toBe("Failure");

    expect(decodeStreamEnd({ closeCode: 1000, closeReason: "normal" })._tag).toBe("Success");
    expect(decodeStreamEnd({ closeCode: 999 })._tag).toBe("Failure");
    expect(decodeStreamEnd({ closeCode: 5000 })._tag).toBe("Failure");
  });

  it("registers all expected HttpApi groups on AgentVelaRelayApi", () => {
    const groupNames = Object.keys(AgentVelaRelayApi.groups).sort();
    expect(groupNames).toEqual([
      "admin",
      "authPublic",
      "authSession",
      "connect",
      "environments",
      "health",
      "hooks",
    ]);
  });
});
