export interface RelayMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

export const RELAY_SQLITE_MIGRATIONS: ReadonlyArray<RelayMigration> = [
  {
    version: 1,
    name: "initial_relay_schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        device_label TEXT,
        client_surface TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS invites (
        invite_id TEXT PRIMARY KEY,
        code_prefix TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        max_uses INTEGER NOT NULL,
        uses_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        revoked_at TEXT,
        created_by_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS device_codes (
        device_code_hash TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        device_label TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
        approved_user_id TEXT REFERENCES users(user_id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS environments (
        environment_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        endpoint_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        environment_public_key TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        linked_at TEXT NOT NULL,
        last_seen_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_environments_user_id ON environments(user_id)`,
      `CREATE TABLE IF NOT EXISTS enrollment_tokens (
        token_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label_hint TEXT,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS relay_challenges (
        challenge_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('link', 'enroll')),
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        enrollment_token_id TEXT REFERENCES enrollment_tokens(token_id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS relay_signing_keys (
        key_id TEXT PRIMARY KEY,
        public_key_spki_b64u TEXT NOT NULL,
        private_key_pkcs8_b64u TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tunnel_runs (
        counter_name TEXT PRIMARY KEY,
        last_run_id INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS used_proof_jtis (
        jti_scope TEXT NOT NULL,
        jti TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (jti_scope, jti)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_used_proof_jtis_expires_at ON used_proof_jtis(expires_at)`,
    ],
  },
];
