import { describe, expect, it, vi } from "vite-plus/test";

import {
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
  resolveDefaultRelayUrl,
} from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("accepts self-hosted http and https relay URLs and rejects invalid ones", () => {
    expect(resolveDefaultRelayUrl({ relay: { url: "https://relay.example.test/" } })).toBe(
      "https://relay.example.test",
    );
    expect(resolveDefaultRelayUrl({ relay: { url: "http://192.168.1.50:8787/" } })).toBe(
      "http://192.168.1.50:8787",
    );
    expect(resolveCloudPublicConfig({ relay: { url: "ftp://relay.example.test" } })).toEqual({
      relay: { url: null },
    });
    expect(hasCloudPublicConfig()).toBe(true);
  });
});
