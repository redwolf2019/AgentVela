import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
  resolveDefaultRelayUrl,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("publicConfig (self-hosted relay)", () => {
  it("always allows runtime self-hosted relay configuration", () => {
    expect(hasCloudPublicConfig()).toBe(true);
    expect(resolveCloudPublicConfig()).toEqual({ relayUrl: null });
  });

  it("reads validated VITE_T3CODE_RELAY_URL when provided", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test/");

    expect(resolveDefaultRelayUrl()).toBe("https://relay.example.test");
  });

  it("ignores invalid public plain HTTP VITE_T3CODE_RELAY_URL values", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(resolveDefaultRelayUrl()).toBeNull();
  });

  it("allows loopback and Tailscale HTTP defaults", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://127.0.0.1:8787");
    expect(resolveDefaultRelayUrl()).toBe("http://127.0.0.1:8787");

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://100.64.0.12:8787");
    expect(resolveDefaultRelayUrl()).toBe("http://100.64.0.12:8787");
  });

  it("auto-detects window.location.origin when served from agent-vela-relay static Web UI", () => {
    vi.stubGlobal("document", {
      querySelector: (selector: string) =>
        selector === 'meta[name="agent-vela-relay-hosted"]'
          ? { getAttribute: (name: string) => (name === "content" ? "1" : null) }
          : null,
    });
    vi.stubGlobal("window", { location: new URL("https://relay.selfhosted.test/settings/relay") });

    expect(resolveDefaultRelayUrl()).toBe("https://relay.selfhosted.test");
  });
});
