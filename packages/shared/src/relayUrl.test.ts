import { describe, expect, it } from "vite-plus/test";

import {
  deriveRelayEnvironmentEndpoints,
  isSecureRelayUrl,
  joinEndpointUrl,
  normalizeRelayUrl,
  normalizeSecureRelayUrl,
  parseRelayUrl,
} from "./relayUrl.ts";

describe("normalizeSecureRelayUrl", () => {
  it("normalizes secure relay origins", () => {
    expect(normalizeSecureRelayUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeSecureRelayUrl("https://relay.example.test:8443/")).toBe(
      "https://relay.example.test:8443",
    );
  });

  it.each([
    "http://relay.example.test",
    "http://localhost:8787",
    "https://user:password@relay.example.test",
    "https://relay.example.test/path",
  ])("rejects unsafe relay URL %s", (value) => {
    expect(normalizeSecureRelayUrl(value)).toBeNull();
    expect(isSecureRelayUrl(value)).toBe(false);
  });
});

describe("parseRelayUrl & normalizeRelayUrl", () => {
  it("accepts public HTTPS URLs with ports and trailing slashes", () => {
    expect(parseRelayUrl(" https://relay.example.com:8443/// ")).toEqual({
      origin: "https://relay.example.com:8443",
      wsOrigin: "wss://relay.example.com:8443",
      transport: "https",
      insecure: false,
    });
    expect(normalizeRelayUrl("https://203.0.113.10:8787/")).toBe("https://203.0.113.10:8787");
  });

  it.each([
    ["http://localhost:8787/", "http://localhost:8787", "ws://localhost:8787", "http_loopback"],
    [
      "http://app.localhost:8787",
      "http://app.localhost:8787",
      "ws://app.localhost:8787",
      "http_loopback",
    ],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787", "ws://127.0.0.1:8787", "http_loopback"],
    ["http://[::1]:8787", "http://[::1]:8787", "ws://[::1]:8787", "http_loopback"],
    ["http://10.0.1.20:8787", "http://10.0.1.20:8787", "ws://10.0.1.20:8787", "http_lan"],
    ["http://172.16.0.5:8787", "http://172.16.0.5:8787", "ws://172.16.0.5:8787", "http_lan"],
    [
      "http://172.31.255.10:8787",
      "http://172.31.255.10:8787",
      "ws://172.31.255.10:8787",
      "http_lan",
    ],
    ["http://192.168.1.50:8787", "http://192.168.1.50:8787", "ws://192.168.1.50:8787", "http_lan"],
    ["http://100.64.0.1:8787", "http://100.64.0.1:8787", "ws://100.64.0.1:8787", "http_tailnet"],
    [
      "http://100.127.255.254:8787",
      "http://100.127.255.254:8787",
      "ws://100.127.255.254:8787",
      "http_tailnet",
    ],
    [
      "http://box.tail123.ts.net:8787",
      "http://box.tail123.ts.net:8787",
      "ws://box.tail123.ts.net:8787",
      "http_tailnet",
    ],
    [
      "http://[fd7a:115c:a1e0::1]:8787",
      "http://[fd7a:115c:a1e0::1]:8787",
      "ws://[fd7a:115c:a1e0::1]:8787",
      "http_tailnet",
    ],
    [
      "http://[::ffff:127.0.0.1]:8787",
      "http://[::ffff:7f00:1]:8787",
      "ws://[::ffff:7f00:1]:8787",
      "http_loopback",
    ],
    [
      "http://[::ffff:192.168.1.5]:8787",
      "http://[::ffff:c0a8:105]:8787",
      "ws://[::ffff:c0a8:105]:8787",
      "http_lan",
    ],
    [
      "http://[::ffff:100.64.0.1]:8787",
      "http://[::ffff:6440:1]:8787",
      "ws://[::ffff:6440:1]:8787",
      "http_tailnet",
    ],
  ] as const)(
    "allows insecure HTTP on local/private/tailnet origin %s",
    (input, origin, wsOrigin, transport) => {
      expect(parseRelayUrl(input)).toEqual({
        origin,
        wsOrigin,
        transport,
        insecure: true,
      });
    },
  );

  it.each([
    "http://relay.example.com",
    "http://relay.example.test:8787",
    "http://relay.invalid",
    "http://8.8.8.8:8787",
    "http://172.15.0.1:8787",
    "http://172.32.0.1:8787",
    "http://100.63.255.254:8787",
    "http://100.128.0.1:8787",
    "http://0.0.0.0:8787",
    "http://[::]:8787",
    "http://169.254.1.1:8787",
    "http://[fe80::1]:8787",
    "http://[2606:4700::1]:8787",
    "http://[::ffff:8.8.8.8]:8787",
    "http://myserver:8787",
    "ws://localhost:8787",
    "https://user:pass@relay.example.com",
    "https://relay.example.com?foo=bar",
    "https://relay.example.com#frag",
    "https://relay.example.com/subpath",
  ])("rejects disallowed or malformed relay URL %s", (value) => {
    expect(parseRelayUrl(value)).toBeNull();
    expect(normalizeRelayUrl(value)).toBeNull();
  });
});

describe("deriveRelayEnvironmentEndpoints", () => {
  it("derives path-prefixed HTTP and WS endpoints", () => {
    expect(deriveRelayEnvironmentEndpoints("https://relay.example.com/", "host-alpha")).toEqual({
      endpointKey: "host-alpha",
      pathPrefix: "/e/host-alpha",
      httpBaseUrl: "https://relay.example.com/e/host-alpha",
      wsBaseUrl: "wss://relay.example.com/e/host-alpha",
    });

    expect(deriveRelayEnvironmentEndpoints("http://192.168.1.50:8787", "lab_01")).toEqual({
      endpointKey: "lab_01",
      pathPrefix: "/e/lab_01",
      httpBaseUrl: "http://192.168.1.50:8787/e/lab_01",
      wsBaseUrl: "ws://192.168.1.50:8787/e/lab_01",
    });
  });

  it("rejects invalid relay URLs or unsafe endpoint keys", () => {
    expect(deriveRelayEnvironmentEndpoints("http://relay.example.com", "host-alpha")).toBeNull();
    expect(deriveRelayEnvironmentEndpoints("https://relay.example.com", "../bad")).toBeNull();
    expect(deriveRelayEnvironmentEndpoints("https://relay.example.com", "BadKey")).toBeNull();
  });
});

describe("joinEndpointUrl", () => {
  it("preserves path prefixes for both root and subpath endpoints", () => {
    expect(joinEndpointUrl("https://relay.example.com/e/env1/", "/oauth/token")).toBe(
      "https://relay.example.com/e/env1/oauth/token",
    );
    expect(joinEndpointUrl("https://relay.example.com/e/env1", "/")).toBe(
      "https://relay.example.com/e/env1/",
    );
    expect(
      joinEndpointUrl("http://127.0.0.1:3773/?ignored=1#hash", "/.well-known/t3/environment"),
    ).toBe("http://127.0.0.1:3773/.well-known/t3/environment");
    expect(joinEndpointUrl("wss://relay.example.com/e/env1", "/ws")).toBe(
      "wss://relay.example.com/e/env1/ws",
    );
  });

  it.each([
    "oauth/token",
    "//evil.example/token",
    "/a/../b",
    "/a/%2e%2e/b",
    "/a/%2e%2e%2fb",
    "/a/%5cb",
    "/a/./b",
    "/a\\b",
    "/a?x=1",
    "/a#b",
  ])("rejects unsafe endpoint pathname %s", (pathname) => {
    expect(() => joinEndpointUrl("https://relay.example.com/e/env1", pathname)).toThrow();
  });
});
