import { describe, expect, it } from "vite-plus/test";

import {
  deriveWsBaseUrl,
  environmentEndpointRelativeUrl,
  environmentEndpointUrl,
  environmentRpcSocketUrl,
  extractRelayEndpointPathPrefix,
  normalizeHttpBaseUrl,
  stripEndpointPathSuffix,
} from "./endpoint.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("preserves /e/:endpointKey path prefixes when joining HTTP, WS, and relative URLs", () => {
    const httpBase = "https://relay.example.com/e/env-1234567890abcdef";
    const wsBase = "wss://relay.example.com/e/env-1234567890abcdef";

    expect(extractRelayEndpointPathPrefix("/e/env-1234567890abcdef/oauth/token")).toBe(
      "/e/env-1234567890abcdef",
    );
    expect(extractRelayEndpointPathPrefix("/e/bad/oauth/token")).toBeNull();
    expect(environmentEndpointUrl(httpBase, "/oauth/token")).toBe(
      "https://relay.example.com/e/env-1234567890abcdef/oauth/token",
    );
    expect(environmentEndpointUrl(`${httpBase}/`, "/.well-known/t3/environment")).toBe(
      "https://relay.example.com/e/env-1234567890abcdef/.well-known/t3/environment",
    );
    expect(environmentEndpointRelativeUrl(httpBase, "/api/assets/tok/img.png?v=1#top")).toBe(
      "https://relay.example.com/e/env-1234567890abcdef/api/assets/tok/img.png?v=1#top",
    );
    expect(
      environmentEndpointRelativeUrl(httpBase, "/e/env-1234567890abcdef/api/assets/tok/img.png"),
    ).toBe("https://relay.example.com/e/env-1234567890abcdef/api/assets/tok/img.png");
    expect(environmentEndpointRelativeUrl(httpBase, "assets/img.png")).toBe(
      "https://relay.example.com/e/env-1234567890abcdef/assets/img.png",
    );
    expect(environmentRpcSocketUrl(wsBase).toString()).toBe(
      "wss://relay.example.com/e/env-1234567890abcdef/ws",
    );
    expect(environmentRpcSocketUrl(`${wsBase}/ws`).toString()).toBe(
      "wss://relay.example.com/e/env-1234567890abcdef/ws",
    );
    expect(
      stripEndpointPathSuffix(
        "https://relay.example.com/e/env-1234567890abcdef/api/auth/websocket-ticket/media",
        "/api/auth/websocket-ticket/media",
      ),
    ).toBe("https://relay.example.com/e/env-1234567890abcdef");
  });
});
