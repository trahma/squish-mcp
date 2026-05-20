import { logger } from "./logger.js";

// Obtain node:sqlite via getBuiltinModule rather than a static `import`.
// `node:sqlite` is exposed only under the `node:` prefix (no bare alias), which
// trips up bundlers/test runners (Vite/vite-node strip the prefix and fail to
// resolve "sqlite"). getBuiltinModule is a plain runtime call, so nothing tries
// to resolve it at transform time, while staying fully typed.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

/**
 * The full schema. Idempotent (IF NOT EXISTS) so it doubles as the migration:
 * we run it on every startup. There is exactly one schema version right now;
 * if/when columns change, add ALTER statements behind a user_version check.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  registered_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT,            -- NULL = broadcast
  subject TEXT,
  body TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER           -- NULL until mark_read (direct messages only)
);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, read_at, id);
CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(to_agent, id) WHERE to_agent IS NULL;

CREATE TABLE IF NOT EXISTS message_reads (
  message_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','in_progress','blocked','completed','failed')),
  assignee TEXT,
  depends_on TEXT,          -- JSON array of task IDs
  metadata TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at);
`;

/** We use Node's built-in SQLite (node:sqlite) — no native addon to compile. */
export type DB = InstanceType<typeof DatabaseSync>;

export interface OpenDbOptions {
  /** Path to the SQLite file. ":memory:" for ephemeral DBs (tests). */
  path?: string;
  /** Suppress the startup log line (used by tests). */
  quiet?: boolean;
}

/**
 * Open (or create) the SQLite database, enable WAL, and run migrations.
 * Returns the database handle; statement preparation lives with the tools that
 * use them so SQL stays near its caller.
 */
export function openDb(options: OpenDbOptions = {}): DB {
  const path =
    options.path ?? process.env.AGENT_BUS_DB_PATH ?? "./agent-bus.db";

  const db = new DatabaseSync(path);

  // WAL: concurrent readers + a single serialized writer, no extra infra.
  // synchronous=NORMAL is the recommended durability tradeoff under WAL.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Wait up to 5s for a write lock instead of failing immediately.
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec(SCHEMA);

  if (!options.quiet) {
    const { journal_mode } = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    logger.info(
      { path, journal_mode },
      "sqlite ready (WAL %s)",
      journal_mode === "wal" ? "enabled" : `MODE=${journal_mode}`,
    );
  }

  return db;
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on
 * error. node:sqlite has no transaction() helper (unlike better-sqlite3), so we
 * wrap BEGIN/COMMIT ourselves. Statements run synchronously, so this is safe.
 */
export function inTransaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
