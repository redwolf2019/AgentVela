import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { RelayUserId, RelayUsername } from "@t3tools/contracts/agentVelaRelay";
import { RelayConfig, RelaySession } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const storeMap = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => storeMap.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    storeMap.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    storeMap.delete(key);
  }),
}));

import {
  MOBILE_RELAY_CONFIG_STORAGE_KEY,
  MOBILE_RELAY_SESSION_STORAGE_KEY,
  layerMobileRelayConfigStorage,
  layerMobileRelaySessionStore,
} from "./relayStorage";

const SAMPLE_SESSION: RelaySession.StoredRelaySession = {
  relayUrl: "https://relay.example.com",
  user: {
    userId: RelayUserId.make("user-1"),
    username: RelayUsername.make("alice"),
    role: "admin",
    disabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  accessToken: TrimmedNonEmptyString.make("access-1"),
  accessTokenExpiresAt: "2026-01-01T01:00:00.000Z",
  refreshToken: TrimmedNonEmptyString.make("refresh-1"),
  refreshTokenExpiresAt: "2026-01-02T00:00:00.000Z",
};

beforeEach(() => {
  storeMap.clear();
});

describe("mobile relayStorage", () => {
  it("persists and clears relay URL in SecureStore", async () => {
    await Effect.gen(function* () {
      const storage = yield* RelayConfig.RelayConfigStorage;
      expect(Option.isNone(yield* storage.load)).toBe(true);

      yield* storage.save("https://relay.example.com");
      expect(storeMap.get(MOBILE_RELAY_CONFIG_STORAGE_KEY)).toBe("https://relay.example.com");
      expect(Option.getOrNull(yield* storage.load)).toBe("https://relay.example.com");

      yield* storage.clear;
      expect(Option.isNone(yield* storage.load)).toBe(true);
    }).pipe(Effect.provide(layerMobileRelayConfigStorage), Effect.runPromise);
  });

  it("round-trips and resets corrupted relay session JSON in SecureStore", async () => {
    await Effect.gen(function* () {
      const store = yield* RelaySession.RelaySessionStore;
      expect(Option.isNone(yield* store.load)).toBe(true);

      yield* store.save(SAMPLE_SESSION);
      expect(Option.getOrNull(yield* store.load)).toEqual(SAMPLE_SESSION);

      storeMap.set(MOBILE_RELAY_SESSION_STORAGE_KEY, "{not-valid-json");
      expect(Option.isNone(yield* store.load)).toBe(true);
      expect(storeMap.has(MOBILE_RELAY_SESSION_STORAGE_KEY)).toBe(false);
    }).pipe(Effect.provide(layerMobileRelaySessionStore), Effect.runPromise);
  });
});
