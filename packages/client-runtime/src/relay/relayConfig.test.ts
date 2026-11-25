import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  RelayUrlConfig,
  layerInMemoryRelayConfigStorage,
  layerRelayUrlConfig,
  validateRelayUrlInput,
} from "./relayConfig.ts";

describe("relayConfig", () => {
  it.effect("validates https, loopback, LAN, and Tailscale URLs and rejects invalid inputs", () =>
    Effect.gen(function* () {
      const publicHttps = yield* validateRelayUrlInput("https://relay.example.com///");
      expect(publicHttps.origin).toBe("https://relay.example.com");
      expect(publicHttps.insecure).toBe(false);

      for (const localHttp of [
        "http://127.0.0.1:8787/",
        "http://localhost:8787",
        "http://[::1]:8787",
        "http://192.168.1.42:8787",
        "http://10.0.0.5:8787",
        "http://100.88.10.20:8787",
      ]) {
        const parsed = yield* validateRelayUrlInput(localHttp);
        expect(parsed.insecure).toBe(true);
      }

      const publicHttpFailure = yield* validateRelayUrlInput("http://relay.example.com:8787").pipe(
        Effect.flip,
      );
      expect(publicHttpFailure._tag).toBe("RelayUrlInvalidError");
      expect(publicHttpFailure.reason).toBe("public_http_disallowed");

      for (const invalidInput of [
        "not-a-url",
        "ftp://relay.example.com",
        "https://relay.example.com/custom-path",
        "https://relay.example.com?foo=bar",
        "https://relay.example.com#section",
        "https://user:pass@relay.example.com",
      ]) {
        const failure = yield* validateRelayUrlInput(invalidInput).pipe(Effect.flip);
        expect(failure._tag).toBe("RelayUrlInvalidError");
        expect(failure.reason).toBe("invalid_format");
      }
    }),
  );

  it.effect(
    "persists relay URL changes, falls back to default, and deduplicates change emissions",
    () =>
      Effect.gen(function* () {
        const config = yield* RelayUrlConfig;
        const recorded = yield* Queue.unbounded<string | null>();
        const secondChangeReady = yield* Deferred.make<void>();
        let count = 0;

        const watcher = yield* config.changes.pipe(
          Stream.runForEach((next) =>
            Effect.gen(function* () {
              yield* Queue.offer(recorded, Option.getOrNull(next)?.origin ?? null);
              count += 1;
              if (count >= 3) {
                yield* Deferred.succeed(secondChangeReady, undefined);
              }
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );

        const initial = yield* config.requireCurrent;
        expect(initial.origin).toBe("https://default-relay.example.com");

        // Normalizes to same origin -> should not emit duplicate change
        yield* config.setRelayUrl("https://default-relay.example.com/");
        yield* config.setRelayUrl("https://custom-relay.example.com/");
        yield* config.setRelayUrl("https://custom-relay.example.com");
        yield* config.setRelayUrl(null);

        const unsetFailure = yield* config.requireCurrent.pipe(Effect.flip);
        expect(unsetFailure._tag).toBe("RelayNotConfiguredError");

        const restored = yield* config.resetToDefault;
        expect(restored.source).toBe("default");
        expect(restored.relayUrl).toBe("https://default-relay.example.com");

        yield* Deferred.await(secondChangeReady);
        yield* Fiber.interrupt(watcher);

        const emitted = yield* Queue.takeAll(recorded);
        expect(Array.from(emitted)).toEqual([
          "https://custom-relay.example.com",
          null,
          "https://default-relay.example.com",
        ]);
      }).pipe(
        Effect.provide(
          layerRelayUrlConfig({ defaultRelayUrl: "https://default-relay.example.com" }).pipe(
            Layer.provide(layerInMemoryRelayConfigStorage()),
          ),
        ),
      ),
  );

  it.effect(
    "prefers stored relay URL over default on startup and handles unset configuration",
    () =>
      Effect.gen(function* () {
        const config = yield* RelayUrlConfig;
        const current = yield* config.requireCurrent;
        expect(current.origin).toBe("http://127.0.0.1:8787");
        const snapshot = yield* SubscriptionRef.get(config.state);
        expect(snapshot.source).toBe("stored");
      }).pipe(
        Effect.provide(
          layerRelayUrlConfig({ defaultRelayUrl: "https://default-relay.example.com" }).pipe(
            Layer.provide(layerInMemoryRelayConfigStorage("http://127.0.0.1:8787")),
          ),
        ),
      ),
  );

  it.effect("starts unset when neither stored nor default URL is configured", () =>
    Effect.gen(function* () {
      const config = yield* RelayUrlConfig;
      const missing = yield* config.requireCurrent.pipe(Effect.flip);
      expect(missing._tag).toBe("RelayNotConfiguredError");
      expect(Option.isNone(yield* config.current)).toBe(true);
    }).pipe(
      Effect.provide(layerRelayUrlConfig().pipe(Layer.provide(layerInMemoryRelayConfigStorage()))),
    ),
  );
});
