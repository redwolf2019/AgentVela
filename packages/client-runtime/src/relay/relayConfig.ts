import { parseRelayUrl, type ParsedRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { RelayNotConfiguredError, RelayUrlInvalidError } from "./relayErrors.ts";

export interface RelayUrlConfigState {
  readonly relayUrl: string | null;
  readonly parsed: ParsedRelayUrl | null;
  readonly source: "stored" | "default" | "unset";
}

export class RelayConfigStorage extends Context.Service<
  RelayConfigStorage,
  {
    readonly load: Effect.Effect<Option.Option<string>>;
    readonly save: (relayUrl: string) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/relay/relayConfig/RelayConfigStorage") {}

export function layerInMemoryRelayConfigStorage(
  initial: string | null = null,
): Layer.Layer<RelayConfigStorage> {
  return Layer.effect(
    RelayConfigStorage,
    Ref.make<Option.Option<string>>(Option.fromNullishOr(initial)).pipe(
      Effect.map((stored) =>
        RelayConfigStorage.of({
          load: Ref.get(stored),
          save: Effect.fn("RelayConfigStorage.save")((relayUrl) =>
            Ref.set(stored, Option.some(relayUrl)),
          ),
          clear: Ref.set(stored, Option.none()),
        }),
      ),
    ),
  );
}

function classifyInvalidRelayUrl(rawValue: string): "invalid_format" | "public_http_disallowed" {
  try {
    const url = new URL(rawValue.trim());
    const hasPlainHttpOrigin =
      url.protocol === "http:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      /^\/+$/u.test(url.pathname);
    return hasPlainHttpOrigin ? "public_http_disallowed" : "invalid_format";
  } catch {
    return "invalid_format";
  }
}

export const validateRelayUrlInput = Effect.fn("clientRuntime.relayConfig.validateRelayUrlInput")(
  function* (rawValue: string): Effect.fn.Return<ParsedRelayUrl, RelayUrlInvalidError> {
    const parsed = parseRelayUrl(rawValue);
    if (parsed !== null) {
      return parsed;
    }
    return yield* new RelayUrlInvalidError({
      relayUrl: rawValue,
      reason: classifyInvalidRelayUrl(rawValue),
    });
  },
);

export class RelayUrlConfig extends Context.Service<
  RelayUrlConfig,
  {
    readonly state: SubscriptionRef.SubscriptionRef<RelayUrlConfigState>;
    readonly current: Effect.Effect<Option.Option<ParsedRelayUrl>>;
    readonly requireCurrent: Effect.Effect<ParsedRelayUrl, RelayNotConfiguredError>;
    readonly setRelayUrl: (
      rawUrl: string | null,
    ) => Effect.Effect<RelayUrlConfigState, RelayUrlInvalidError>;
    readonly resetToDefault: Effect.Effect<RelayUrlConfigState>;
    readonly changes: Stream.Stream<Option.Option<ParsedRelayUrl>>;
  }
>()("@t3tools/client-runtime/relay/relayConfig/RelayUrlConfig") {}

export interface RelayUrlConfigLayerOptions {
  readonly defaultRelayUrl?: string | null;
}

const UNSET_RELAY_CONFIG_STATE: RelayUrlConfigState = {
  relayUrl: null,
  parsed: null,
  source: "unset",
};

function resolveInitialConfigState(
  stored: Option.Option<string>,
  defaultRelayUrl: string | null | undefined,
): RelayUrlConfigState {
  if (Option.isSome(stored)) {
    const parsedStored = parseRelayUrl(stored.value);
    if (parsedStored !== null) {
      return { relayUrl: parsedStored.origin, parsed: parsedStored, source: "stored" };
    }
  }
  if (defaultRelayUrl) {
    const parsedDefault = parseRelayUrl(defaultRelayUrl);
    if (parsedDefault !== null) {
      return { relayUrl: parsedDefault.origin, parsed: parsedDefault, source: "default" };
    }
  }
  return UNSET_RELAY_CONFIG_STATE;
}

const makeRelayUrlConfig = Effect.fn("RelayUrlConfig.make")(function* (
  options?: RelayUrlConfigLayerOptions,
) {
  const storage = yield* RelayConfigStorage;
  const initialStored = yield* storage.load;
  const initialState = resolveInitialConfigState(initialStored, options?.defaultRelayUrl);
  const state = yield* SubscriptionRef.make<RelayUrlConfigState>(initialState);

  const current = SubscriptionRef.get(state).pipe(
    Effect.map((currentState) => Option.fromNullishOr(currentState.parsed)),
  );

  const requireCurrent = current.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RelayNotConfiguredError({})),
        onSome: Effect.succeed,
      }),
    ),
  );

  const setRelayUrl = Effect.fn("RelayUrlConfig.setRelayUrl")(function* (rawUrl: string | null) {
    if (rawUrl === null || rawUrl.trim().length === 0) {
      yield* storage.clear;
      yield* SubscriptionRef.set(state, UNSET_RELAY_CONFIG_STATE);
      return UNSET_RELAY_CONFIG_STATE;
    }
    const parsed = yield* validateRelayUrlInput(rawUrl);
    const next: RelayUrlConfigState = {
      relayUrl: parsed.origin,
      parsed,
      source: "stored",
    };
    yield* storage.save(parsed.origin);
    yield* SubscriptionRef.set(state, next);
    return next;
  });

  const resetToDefault = Effect.gen(function* () {
    yield* storage.clear;
    const next = resolveInitialConfigState(Option.none(), options?.defaultRelayUrl);
    yield* SubscriptionRef.set(state, next);
    return next;
  }).pipe(Effect.withSpan("RelayUrlConfig.resetToDefault"));

  const changes = SubscriptionRef.changes(state).pipe(
    Stream.map((currentState) => Option.fromNullishOr(currentState.parsed)),
    Stream.changesWith((a, b) => Option.getOrNull(a)?.origin === Option.getOrNull(b)?.origin),
    Stream.drop(1),
  );

  return RelayUrlConfig.of({
    state,
    current,
    requireCurrent,
    setRelayUrl,
    resetToDefault,
    changes,
  });
});

export const layerRelayUrlConfig = (options?: RelayUrlConfigLayerOptions) =>
  Layer.effect(RelayUrlConfig, makeRelayUrlConfig(options));
