// @effect-diagnostics globalFetch:off -- SSE streaming reads incremental Response.body chunks directly with Effect-managed AbortSignal.
import {
  RELAY_PRESENCE_EVENTS_PATH,
  RelayPresenceEvent,
  type RelayPresenceEvent as RelayPresenceEventType,
} from "@t3tools/contracts/agentVelaRelay";
import { joinEndpointUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

export class RelayPresenceUnauthorizedError extends Schema.TaggedError<RelayPresenceUnauthorizedError>()(
  "RelayPresenceUnauthorizedError",
  {},
) {}

export class RelayPresenceHttpError extends Schema.TaggedError<RelayPresenceHttpError>()(
  "RelayPresenceHttpError",
  {
    status: Schema.Number,
  },
) {}

export class RelayPresenceTransportError extends Schema.TaggedError<RelayPresenceTransportError>()(
  "RelayPresenceTransportError",
  {
    reason: Schema.Literals(["network", "stalled", "unsupported"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type RelayPresenceStreamError =
  | RelayPresenceUnauthorizedError
  | RelayPresenceHttpError
  | RelayPresenceTransportError;

export class RelayPresenceFetch extends Context.Reference<typeof globalThis.fetch>(
  "@t3tools/client-runtime/relay/presenceStream/RelayPresenceFetch",
  {
    defaultValue: () => (input, init) => globalThis.fetch(input, init),
  },
) {}

const decodePresenceEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RelayPresenceEvent));

export function createSseEventParser(onEvent: (event: RelayPresenceEventType) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: Array<string> = [];

  const dispatch = () => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    const parsed = decodePresenceEvent(payload);
    if (Option.isSome(parsed)) onEvent(parsed.value);
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  };

  return {
    push(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        processLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush(): void {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        processLine(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

const readSseEventLoop = Effect.fn("RelayPresenceStream.readSseEventLoop")(function* (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  heartbeatTimeoutMs: number,
  pending: Array<RelayPresenceEventType>,
  parser: ReturnType<typeof createSseEventParser>,
): Effect.fn.Return<
  readonly [RelayPresenceEventType, undefined] | undefined,
  RelayPresenceStreamError
> {
  while (pending.length === 0) {
    const chunk = yield* Effect.tryPromise({
      try: () => reader.read(),
      catch: (cause) => new RelayPresenceTransportError({ reason: "network", cause }),
    }).pipe(Effect.timeoutOption(Duration.millis(heartbeatTimeoutMs)));

    if (Option.isNone(chunk)) {
      return yield* new RelayPresenceTransportError({ reason: "stalled" });
    }
    if (chunk.value.done) {
      parser.flush();
      break;
    }
    parser.push(chunk.value.value);
  }
  const next = pending.shift();
  return next === undefined ? undefined : ([next, undefined] as const);
});

function cancelBodyBestEffort(body: ReadableStream<Uint8Array> | null): Effect.Effect<void> {
  if (body === null) return Effect.void;
  return Effect.tryPromise({
    try: () => body.cancel(),
    catch: () => undefined,
  }).pipe(Effect.ignore);
}

export function openRelayPresenceStream(input: {
  readonly relayUrl: string;
  readonly accessToken: string;
  readonly heartbeatTimeoutMs?: number;
}): Stream.Stream<RelayPresenceEventType, RelayPresenceStreamError> {
  const heartbeatTimeoutMs = input.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const eventsUrl = joinEndpointUrl(input.relayUrl, RELAY_PRESENCE_EVENTS_PATH);

  return Stream.unwrap(
    Effect.gen(function* () {
      const fetchFn = yield* RelayPresenceFetch;
      const signal = yield* Effect.abortSignal;

      const response = yield* Effect.tryPromise({
        try: () =>
          fetchFn(eventsUrl, {
            method: "GET",
            headers: {
              authorization: `Bearer ${input.accessToken}`,
              accept: "text/event-stream",
              "cache-control": "no-cache",
            },
            cache: "no-store",
            signal,
          }),
        catch: (cause) => new RelayPresenceTransportError({ reason: "network", cause }),
      });

      if (response.status === 401) {
        yield* cancelBodyBestEffort(response.body);
        return yield* new RelayPresenceUnauthorizedError({});
      }
      if (!response.ok) {
        yield* cancelBodyBestEffort(response.body);
        return yield* new RelayPresenceHttpError({ status: response.status });
      }
      if (!response.body) {
        return yield* new RelayPresenceTransportError({ reason: "unsupported" });
      }

      const reader = response.body.getReader();
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({
          try: () => reader.cancel(),
          catch: () => undefined,
        }).pipe(Effect.ignore),
      );

      const pending: Array<RelayPresenceEventType> = [];
      const parser = createSseEventParser((event) => {
        pending.push(event);
      });

      return Stream.unfold(undefined, () =>
        readSseEventLoop(reader, heartbeatTimeoutMs, pending, parser),
      );
    }),
  );
}
