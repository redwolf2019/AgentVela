// @effect-diagnostics nodeBuiltinImport:off -- Relay database manages its local SQLite directory via Node fs/path.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import { RelayConfig } from "../config.ts";
import { RELAY_SQLITE_MIGRATIONS } from "./migrations.ts";

const MigrationVersionRow = Schema.Struct({
  version: Schema.Number,
});
const decodeMigrationRows = Schema.decodeUnknownEffect(Schema.Array(MigrationVersionRow));

const RunIdRow = Schema.Struct({
  last_run_id: Schema.Number,
});
const decodeRunIdRows = Schema.decodeUnknownEffect(Schema.Array(RunIdRow));

const JtiRow = Schema.Struct({
  jti: Schema.String,
});

function toMigrationError(operation: string, cause: unknown): SqlError.SqlError {
  return new SqlError.SqlError({
    reason: new SqlError.UnknownError({
      cause,
      message: `Relay SQLite ${operation} failed`,
    }),
  });
}

export class RelayDatabase extends Context.Service<
  RelayDatabase,
  {
    readonly sql: SqlClient.SqlClient;
    readonly transactionImmediate: <A, E>(
      body: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | SqlError.SqlError>;
    readonly nextRunId: () => Effect.Effect<number, SqlError.SqlError>;
    readonly consumeProofJtiInTransaction: (input: {
      readonly scope: string;
      readonly jti: string;
      readonly expiresAtIso: string;
      readonly nowIso: string;
    }) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly consumeProofJti: (input: {
      readonly scope: string;
      readonly jti: string;
      readonly expiresAtIso: string;
      readonly nowIso: string;
    }) => Effect.Effect<boolean, SqlError.SqlError>;
  }
>()("agent-vela-relay/persistence/database/RelayDatabase") {}

const runPragmaStatements = Effect.fn("RelayDatabase.configurePragmas")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe("PRAGMA busy_timeout = 5000;");
  yield* sql.unsafe("PRAGMA foreign_keys = ON;");
  yield* sql.unsafe("PRAGMA journal_mode = WAL;");
  yield* sql.unsafe("PRAGMA synchronous = NORMAL;");
  yield* sql.unsafe("PRAGMA temp_store = MEMORY;");
});

const applyRelayMigrations = Effect.fn("RelayDatabase.migrate")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(
    `CREATE TABLE IF NOT EXISTS _relay_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
  const rawRows = yield* sql.unsafe("SELECT version FROM _relay_migrations ORDER BY version ASC");
  const rows = yield* decodeMigrationRows(rawRows).pipe(
    Effect.mapError((cause) => toMigrationError("decode migrations", cause)),
  );
  const applied = new Set(rows.map((row) => row.version));

  for (const migration of RELAY_SQLITE_MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    const appliedAtIso = DateTime.formatIso(yield* DateTime.now);
    yield* sql.unsafe("BEGIN IMMEDIATE");
    const runStatements = Effect.gen(function* () {
      for (const statement of migration.statements) {
        yield* sql.unsafe(statement);
      }
      yield* sql`
        INSERT INTO _relay_migrations (version, name, applied_at)
        VALUES (${migration.version}, ${migration.name}, ${appliedAtIso})
      `;
    });
    const exit = yield* Effect.exit(runStatements);
    if (exit._tag === "Failure") {
      yield* sql.unsafe("ROLLBACK").pipe(Effect.ignore);
      return yield* Effect.failCause(exit.cause);
    }
    yield* sql.unsafe("COMMIT");
  }
});

export const layerRelayDatabase = Layer.effect(
  RelayDatabase,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runPragmaStatements(sql);
    yield* applyRelayMigrations(sql);

    const writeMutex = Semaphore.makeUnsafe(1);

    const transactionImmediate = <A, E>(body: Effect.Effect<A, E>) =>
      writeMutex.withPermit(
        Effect.gen(function* () {
          yield* sql.unsafe("BEGIN IMMEDIATE");
          const exit = yield* Effect.exit(body);
          if (exit._tag === "Failure") {
            yield* sql.unsafe("ROLLBACK").pipe(Effect.ignore);
            return yield* Effect.failCause(exit.cause);
          }
          yield* sql.unsafe("COMMIT");
          return exit.value;
        }),
      );

    const nextRunId = Effect.fn("RelayDatabase.nextRunId")(function* () {
      return yield* transactionImmediate(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe(
            `INSERT INTO tunnel_runs (counter_name, last_run_id)
             VALUES ('tunnel_run', 1)
             ON CONFLICT(counter_name) DO UPDATE SET last_run_id = last_run_id + 1
             RETURNING last_run_id`,
          );
          const decoded = yield* decodeRunIdRows(rows).pipe(
            Effect.mapError((cause) => toMigrationError("nextRunId", cause)),
          );
          const first = decoded[0];
          if (!first) {
            return yield* toMigrationError("nextRunId", "Missing runId row");
          }
          return first.last_run_id;
        }),
      );
    });

    const consumeProofJtiInTransaction = Effect.fn("RelayDatabase.consumeProofJtiInTransaction")(
      function* (input: {
        readonly scope: string;
        readonly jti: string;
        readonly expiresAtIso: string;
        readonly nowIso: string;
      }) {
        yield* sql`DELETE FROM used_proof_jtis WHERE expires_at <= ${input.nowIso}`;
        const inserted = yield* sql`
          INSERT INTO used_proof_jtis (jti_scope, jti, expires_at)
          VALUES (${input.scope}, ${input.jti}, ${input.expiresAtIso})
          ON CONFLICT(jti_scope, jti) DO NOTHING
          RETURNING jti
        `;
        return (inserted as ReadonlyArray<typeof JtiRow.Type>).length === 1;
      },
    );

    const consumeProofJti = Effect.fn("RelayDatabase.consumeProofJti")(function* (input: {
      readonly scope: string;
      readonly jti: string;
      readonly expiresAtIso: string;
      readonly nowIso: string;
    }) {
      return yield* transactionImmediate(consumeProofJtiInTransaction(input));
    });

    return RelayDatabase.of({
      sql,
      transactionImmediate,
      nextRunId,
      consumeProofJtiInTransaction,
      consumeProofJti,
    });
  }),
);

export const layerRelaySqliteLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* RelayConfig;
    if (config.sqlitePath !== ":memory:") {
      yield* Effect.tryPromise({
        try: () =>
          NodeFSP.mkdir(NodePath.dirname(config.sqlitePath), {
            recursive: true,
            mode: 0o700,
          }),
        catch: (cause) => toMigrationError("mkdir data_dir", cause),
      });
    }
    return layerRelayDatabase.pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: config.sqlitePath })),
    );
  }),
);
