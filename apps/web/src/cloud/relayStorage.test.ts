import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { RelayUserId, RelayUsername } from "@t3tools/contracts/agentVelaRelay";
import { RelayConfig, RelaySession } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  WEB_RELAY_SESSION_STORAGE_KEY,
  layerWebRelayConfigStorage,
  layerWebRelaySessionStore,
} from "./relayStorage";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key) => map.get(key) ?? null,
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, String(value));
    },
  };
}

beforeEach(() => {
  const storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("relayStorage", () => {
  it("persists and clears relay URL in localStorage", async () => {
    await Effect.gen(function* () {
      const storage = yield* RelayConfig.RelayConfigStorage;
      expect(Option.isNone(yield* storage.load)).toBe(true);

      yield* storage.save("https://relay.example.com");
      expect(Option.getOrNull(yield* storage.load)).toBe("https://relay.example.com");

      yield* storage.clear;
      expect(Option.isNone(yield* storage.load)).toBe(true);
    }).pipe(Effect.provide(layerWebRelayConfigStorage), Effect.runPromise);
  });

  it("round-trips and resets corrupted relay session JSON in localStorage", async () => {
    await Effect.gen(function* () {
      const store = yield* RelaySession.RelaySessionStore;
      expect(Option.isNone(yield* store.load)).toBe(true);

      yield* store.save(SAMPLE_SESSION);
      expect(Option.getOrNull(yield* store.load)).toEqual(SAMPLE_SESSION);

      localStorage.setItem(WEB_RELAY_SESSION_STORAGE_KEY, "{not-valid");
      expect(Option.isNone(yield* store.load)).toBe(true);
      expect(localStorage.getItem(WEB_RELAY_SESSION_STORAGE_KEY)).toBeNull();
    }).pipe(Effect.provide(layerWebRelaySessionStore), Effect.runPromise);
  });
});
