import type { SqlStorage } from "@cloudflare/workers-types";

export interface SessionMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const SESSION_SCHEMA_MIGRATIONS: readonly SessionMigration[] = [
  {
    version: 1,
    name: "session-domains",
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        owner_principal TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('new', 'running', 'waiting', 'failed', 'completed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        runtime_version TEXT NOT NULL,
        agent_bundle_version TEXT NOT NULL,
        manifest_version TEXT NOT NULL,
        protocol_version TEXT NOT NULL,
        schema_version INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_meta(session_id),
        status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'failed')),
        accepted_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
        error_id TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS steps (
        step_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_meta(session_id),
        turn_id TEXT NOT NULL REFERENCES turns(turn_id),
        logical_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('model-tool', 'final-response')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'retryable', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        result_ref TEXT,
        error_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (session_id, turn_id, logical_key)
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        stream_index INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES session_meta(session_id),
        turn_id TEXT,
        step_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        CHECK (length(CAST(payload_json AS BLOB)) <= 131072)
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_meta(session_id),
        turn_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS projections (
        session_id TEXT NOT NULL REFERENCES session_meta(session_id),
        projection_key TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, projection_key)
      )`,
      `CREATE TABLE IF NOT EXISTS effects (
        effect_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_meta(session_id),
        turn_id TEXT NOT NULL REFERENCES turns(turn_id),
        step_id TEXT NOT NULL REFERENCES steps(step_id),
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('requested', 'running', 'completed', 'failed')),
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_meta(session_id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'retryable', 'dead')),
        due_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        recovery_action TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS errors (
        error_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_meta(session_id),
        turn_id TEXT,
        step_id TEXT,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS stream_chunks (
        chunk_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_meta(session_id),
        stream_index INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, stream_index),
        CHECK (
          byte_length >= 0 AND
          byte_length <= 131072 AND
          length(CAST(payload_json AS BLOB)) <= 131072
        )
      )`,
    ],
  },
  {
    version: 2,
    name: "session-domain-indexes",
    statements: [
      "CREATE INDEX IF NOT EXISTS turns_by_session ON turns (session_id, accepted_at)",
      "CREATE INDEX IF NOT EXISTS steps_by_turn ON steps (session_id, turn_id, logical_key)",
      "CREATE INDEX IF NOT EXISTS events_by_session_cursor ON events (session_id, stream_index)",
      "CREATE INDEX IF NOT EXISTS messages_by_session_time ON messages (session_id, created_at)",
      "CREATE INDEX IF NOT EXISTS effects_by_step ON effects (session_id, step_id)",
      "CREATE INDEX IF NOT EXISTS jobs_due ON jobs (session_id, status, due_at)",
      "CREATE INDEX IF NOT EXISTS errors_by_session_time ON errors (session_id, created_at)",
      "CREATE INDEX IF NOT EXISTS stream_chunks_by_session_cursor ON stream_chunks (session_id, stream_index)",
    ],
  },
] as const;

export const SESSION_SCHEMA_VERSION =
  SESSION_SCHEMA_MIGRATIONS[SESSION_SCHEMA_MIGRATIONS.length - 1]?.version ?? 0;

export const SESSION_SCHEMA_TABLES = [
  "schema_migrations",
  "session_meta",
  "turns",
  "steps",
  "events",
  "messages",
  "projections",
  "effects",
  "jobs",
  "errors",
  "stream_chunks",
] as const;

function readAppliedMigrations(
  sql: SqlStorage,
): Map<number, { readonly name: string }> {
  const rows = sql
    .exec<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version ASC",
    )
    .toArray();
  return new Map(
    rows.map((row) => [row.version, { name: row.name }] as const),
  );
}

function hasMigrationLedger(sql: SqlStorage): boolean {
  const rows = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "schema_migrations",
    )
    .toArray();
  return rows.length > 0;
}

function assertCompleteSchema(sql: SqlStorage): void {
  const expectedTables = new Set<string>(SESSION_SCHEMA_TABLES);
  const rows = sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${SESSION_SCHEMA_TABLES.map(() => "?").join(", ")})`,
      ...SESSION_SCHEMA_TABLES,
    )
    .toArray();

  for (const row of rows) {
    expectedTables.delete(row.name);
  }

  if (expectedTables.size > 0) {
    throw new Error(
      `Session schema is incomplete: missing ${Array.from(expectedTables).join(", ")}`,
    );
  }
}

interface SessionStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

export function applySessionMigrations(
  storage: SessionStorage,
  migrations: readonly SessionMigration[] = SESSION_SCHEMA_MIGRATIONS,
): void {
  const sql = storage.sql;
  const applied = hasMigrationLedger(sql)
    ? readAppliedMigrations(sql)
    : new Map<number, { readonly name: string }>();

  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name) {
        throw new Error(
          `Session migration ${migration.version} is recorded as ${existing.name}, expected ${migration.name}`,
        );
      }
      continue;
    }

    const applyMigration = (): void => {
      for (const statement of migration.statements) {
        sql.exec(statement);
      }
      sql.exec(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      assertCompleteSchema(sql);
    };

    storage.transactionSync(applyMigration);
    applied.set(migration.version, { name: migration.name });
  }

  assertCompleteSchema(sql);
}
