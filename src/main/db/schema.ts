// SQLite via Node's built-in node:sqlite (Node 22.5+ / Electron's bundled runtime) — no
// native module compilation required, unlike better-sqlite3. Query/repository functions on
// top of this schema live in separate files; this module only owns the connection + DDL.

import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { join } from 'node:path'

/** Exported so tests/scripts can apply it to a throwaway DatabaseSync without Electron's app object. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT REFERENCES tasks(id),
  session_id TEXT REFERENCES sessions(id),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
`

let db: DatabaseSync | undefined

/** Lazily-opened singleton connection, WAL mode, schema applied idempotently. */
export function getDb(): DatabaseSync {
  if (db) return db
  const dbPath = join(app.getPath('userData'), 'token-thrift.db')
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}
