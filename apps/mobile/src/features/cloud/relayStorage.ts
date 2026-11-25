import { RelayConfig, RelaySession } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";

export const MOBILE_RELAY_CONFIG_STORAGE_KEY = "agentvela.relay.config.v1";
export const MOBILE_RELAY_SESSION_STORAGE_KEY = "agentvela.relay.session.v1";

const decodeStoredSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelaySession.StoredRelaySession),
);
const encodeStoredSession = Schema.encodeEffect(
  Schema.fromJsonString(RelaySession.StoredRelaySession),
);

export class MobileRelayStorageError extends Schema.TaggedError<MobileRelayStorageError>()(
  "MobileRelayStorageError",
  {
    operation: Schema.Literals(["read", "write", "clear", "decode", "encode"]),
    storageKey: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile relay storage operation "${this.operation}" failed for key "${this.storageKey}".`;
  }
}

function logStorageFailure(error: MobileRelayStorageError) {
  return Effect.logWarning("Mobile relay SecureStore operation failed.", {
    errorTag: error._tag,
    operation: error.operation,
    storageKey: error.storageKey,
    cause: error,
  });
}

function secureRead(key: string): Effect.Effect<string | null> {
  return Effect.tryPromise({
    try: () => SecureStore.getItemAsync(key),
    catch: (cause) =>
      new MobileRelayStorageError({
        operation: "read",
        storageKey: key,
        cause,
      }),
  }).pipe(
    Effect.tapError(logStorageFailure),
    Effect.orElseSucceed(() => null),
  );
}

function secureWrite(key: string, value: string): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => SecureStore.setItemAsync(key, value),
    catch: (cause) =>
      new MobileRelayStorageError({
        operation: "write",
        storageKey: key,
        cause,
      }),
  }).pipe(Effect.tapError(logStorageFailure), Effect.ignore);
}

function secureDelete(key: string): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => SecureStore.deleteItemAsync(key),
    catch: (cause) =>
      new MobileRelayStorageError({
        operation: "clear",
        storageKey: key,
        cause,
      }),
  }).pipe(Effect.tapError(logStorageFailure), Effect.ignore);
}

export const layerMobileRelayConfigStorage: Layer.Layer<RelayConfig.RelayConfigStorage> =
  Layer.succeed(
    RelayConfig.RelayConfigStorage,
    RelayConfig.RelayConfigStorage.of({
      load: secureRead(MOBILE_RELAY_CONFIG_STORAGE_KEY).pipe(
        Effect.map((raw) => {
          const trimmed = raw?.trim();
          return trimmed ? Option.some(trimmed) : Option.none();
        }),
      ),
      save: Effect.fn("mobile.relayConfigStorage.save")((relayUrl) =>
        secureWrite(MOBILE_RELAY_CONFIG_STORAGE_KEY, relayUrl),
      ),
      clear: secureDelete(MOBILE_RELAY_CONFIG_STORAGE_KEY),
    }),
  );

export const layerMobileRelaySessionStore: Layer.Layer<RelaySession.RelaySessionStore> =
  Layer.succeed(
    RelaySession.RelaySessionStore,
    RelaySession.RelaySessionStore.of({
      load: secureRead(MOBILE_RELAY_SESSION_STORAGE_KEY).pipe(
        Effect.flatMap((raw) =>
          raw === null
            ? Effect.succeed(Option.none<RelaySession.StoredRelaySession>())
            : decodeStoredSession(raw).pipe(
                Effect.asSome,
                Effect.catch((cause) =>
                  logStorageFailure(
                    new MobileRelayStorageError({
                      operation: "decode",
                      storageKey: MOBILE_RELAY_SESSION_STORAGE_KEY,
                      cause,
                    }),
                  ).pipe(
                    Effect.andThen(secureDelete(MOBILE_RELAY_SESSION_STORAGE_KEY)),
                    Effect.as(Option.none<RelaySession.StoredRelaySession>()),
                  ),
                ),
              ),
        ),
      ),
      save: Effect.fn("mobile.relaySessionStore.save")((session) =>
        encodeStoredSession(session).pipe(
          Effect.flatMap((encoded) => secureWrite(MOBILE_RELAY_SESSION_STORAGE_KEY, encoded)),
          Effect.catch((cause) =>
            logStorageFailure(
              new MobileRelayStorageError({
                operation: "encode",
                storageKey: MOBILE_RELAY_SESSION_STORAGE_KEY,
                cause,
              }),
            ),
          ),
        ),
      ),
      clear: secureDelete(MOBILE_RELAY_SESSION_STORAGE_KEY),
    }),
  );
