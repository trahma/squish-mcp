import Database from "better-sqlite3";
import { logger } from "./logger.js";

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

export type DB = Database.Database;

export interface OpenDbOptions {
  /** Path to the SQLite file. ":memory:" for ephemeral DBs (tests). */
  path?: string;
  /** Suppress the startup log line (used by tests). */
  quiet?: boolean;
}

/**
 * Open (or create) the SQLite database, enable WAL, and run migrations.
 * Returns the raw better-sqlite3 handle; statement preparation lives with the
 * tools that use them so SQL stays near its caller.
 */
export function openDb(options: OpenDbOptions = {}): DB {
  const path =
    options.path ?? process.env.AGENT_BUS_DB_PATH ?? "./agent-bus.db";

  const db = new Database(path);

  // WAL: concurrent readers + a single serialized writer, no extra infra.
  // synchronous=NORMAL is the recommended durability tradeoff under WAL.
  const journalMode = db.pragma("journal_mode = WAL", { simple: true });
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // Wait up to 5s for a write lock instead of throwing SQLITE_BUSY immediately.
  db.pragma("busy_timeout = 5000");

  db.exec(SCHEMA);

  if (!options.quiet) {
    logger.info(
      { path, journal_mode: journalMode },
      "sqlite ready (WAL %s)",
      journalMode === "wal" ? "enabled" : `MODE=${String(journalMode)}`,
    );
  }

  return db;
}
