import { RelayConfig, RelaySession } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const WEB_RELAY_URL_STORAGE_KEY = "agentvela.relay.url";
export const WEB_RELAY_SESSION_STORAGE_KEY = "agentvela.relay.session";

const decodeStoredSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelaySession.StoredRelaySession),
);
const encodeStoredSession = Schema.encodeEffect(
  Schema.fromJsonString(RelaySession.StoredRelaySession),
);

function getWebStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStorageItem(key: string): string | null {
  const storage = getWebStorage();
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  const storage = getWebStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore quota / private-browsing storage errors.
  }
}

function removeStorageItem(key: string): void {
  const storage = getWebStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage access errors.
  }
}

export const layerWebRelayConfigStorage: Layer.Layer<RelayConfig.RelayConfigStorage> =
  Layer.succeed(
    RelayConfig.RelayConfigStorage,
    RelayConfig.RelayConfigStorage.of({
      load: Effect.sync(() => Option.fromNullishOr(readStorageItem(WEB_RELAY_URL_STORAGE_KEY))),
      save: Effect.fn("web.relayConfigStorage.save")((relayUrl) =>
        Effect.sync(() => {
          writeStorageItem(WEB_RELAY_URL_STORAGE_KEY, relayUrl);
        }),
      ),
      clear: Effect.sync(() => {
        removeStorageItem(WEB_RELAY_URL_STORAGE_KEY);
      }),
    }),
  );

export const layerWebRelaySessionStore: Layer.Layer<RelaySession.RelaySessionStore> = Layer.succeed(
  RelaySession.RelaySessionStore,
  RelaySession.RelaySessionStore.of({
    load: Effect.sync(() => readStorageItem(WEB_RELAY_SESSION_STORAGE_KEY)).pipe(
      Effect.flatMap((raw) =>
        raw === null
          ? Effect.succeed(Option.none<RelaySession.StoredRelaySession>())
          : decodeStoredSession(raw).pipe(
              Effect.asSome,
              Effect.catch(() =>
                Effect.sync(() => {
                  removeStorageItem(WEB_RELAY_SESSION_STORAGE_KEY);
                  return Option.none<RelaySession.StoredRelaySession>();
                }),
              ),
            ),
      ),
    ),
    save: Effect.fn("web.relaySessionStore.save")((session) =>
      encodeStoredSession(session).pipe(
        Effect.map((encoded) => {
          writeStorageItem(WEB_RELAY_SESSION_STORAGE_KEY, encoded);
        }),
        Effect.ignore,
      ),
    ),
    clear: Effect.sync(() => {
      removeStorageItem(WEB_RELAY_SESSION_STORAGE_KEY);
    }),
  }),
);
