import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  isHostedStaticApp,
  isRelayHostedWebUi,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.t3.codes/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("returns null for hosted pairing URL when VITE_HOSTED_APP_URL is unset", () => {
    expect(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
      }),
    ).toBeNull();
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    const pairingUrl = buildHostedPairingUrl({
      host: "https://backend.example.com:3773",
      token: "pairing-token",
      label: "Workstation",
    });
    expect(pairingUrl).not.toBeNull();
    const url = new URL(pairingUrl!);

    expect(url.origin).toBe("https://preview.t3.codes");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("treats relay-served static web UI meta tag as hosted static app", () => {
    vi.stubGlobal("document", {
      querySelector: (selector: string) =>
        selector === 'meta[name="agent-vela-relay-hosted"]'
          ? { getAttribute: (name: string) => (name === "content" ? "1" : null) }
          : null,
    });

    expect(isRelayHostedWebUi()).toBe(true);
    expect(isHostedStaticApp(new URL("https://relay.example.com/"))).toBe(true);
  });
});
