// SQLite via Node's built-in node:sqlite (Node 22.5+ / Electron's bundled runtime) — no
// native module compilation required, unlike better-sqlite3. Query/repository functions on
// top of this schema live in separate files; this module only owns the connection + DDL.

import assert from 'node:assert'
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
  archived INTEGER NOT NULL DEFAULT 0,
  document_kind TEXT,
  document_content TEXT,
  document_mime_type TEXT,
  document_file_name TEXT,
  document_updated_at INTEGER,
  document_mode INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  created_at INTEGER NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 0
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
  error TEXT,
  system_prompt TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_library_session ON library_items(session_id);
`

// CREATE TABLE IF NOT EXISTS only helps on a brand-new database — it's a no-op against an
// existing table, so a column added here later never reaches a database that already has
// that table (this bit a real user once: "compressed" landed in SCHEMA above, but existing
// installs kept the old table shape and every message:send call failed). Each column added
// after the table's initial release needs one line here; ALTER TABLE errors only on a
// column that already exists, which this treats as "already migrated," not a failure.
const COLUMN_MIGRATIONS: string[] = [
  'ALTER TABLE tasks ADD COLUMN system_prompt TEXT',
  'ALTER TABLE messages ADD COLUMN compressed INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sessions ADD COLUMN document_kind TEXT',
  'ALTER TABLE sessions ADD COLUMN document_content TEXT',
  'ALTER TABLE sessions ADD COLUMN document_mime_type TEXT',
  'ALTER TABLE sessions ADD COLUMN document_file_name TEXT',
  'ALTER TABLE sessions ADD COLUMN document_updated_at INTEGER',
  'ALTER TABLE sessions ADD COLUMN document_mode INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE library_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'
]

export function applyColumnMigrations(database: DatabaseSync): void {
  for (const sql of COLUMN_MIGRATIONS) {
    try {
      database.exec(sql)
    } catch (err) {
      const alreadyExists = err instanceof Error && /duplicate column name/i.test(err.message)
      if (!alreadyExists) throw err
    }
  }
}

let db: DatabaseSync | undefined

/** Lazily-opened singleton connection, WAL mode, schema applied idempotently. */
export function getDb(): DatabaseSync {
  if (db) return db
  const dbPath = join(app.getPath('userData'), 'token-thrift.db')
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  applyColumnMigrations(db)
  return db
}

// --- self-check ---------------------------------------------------------------------
// Reproduces the exact real-world failure this migration exists to fix: a database whose
// tables predate a column that later landed in SCHEMA above. No Electron needed — pure
// DatabaseSync + the exported functions.
if (require.main === module) {
  const oldShapeDb = new DatabaseSync(':memory:')
  oldShapeDb.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, provider_id TEXT, model_id TEXT, title TEXT, created_at INTEGER, archived INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, reasoning TEXT, created_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, started_at INTEGER);
    CREATE TABLE library_items (id TEXT PRIMARY KEY, session_id TEXT, file_name TEXT, file_path TEXT, mime_type TEXT, size_bytes INTEGER, description TEXT, created_at INTEGER);
  `)
  oldShapeDb.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'm1', 's1', 'user', 'hello', 0
  )

  applyColumnMigrations(oldShapeDb)
  const messageCols = oldShapeDb.prepare('PRAGMA table_info(messages)').all().map((c) => (c as { name: string }).name)
  const taskCols = oldShapeDb.prepare('PRAGMA table_info(tasks)').all().map((c) => (c as { name: string }).name)
  const sessionCols = oldShapeDb.prepare('PRAGMA table_info(sessions)').all().map((c) => (c as { name: string }).name)
  const libraryCols = oldShapeDb.prepare('PRAGMA table_info(library_items)').all().map((c) => (c as { name: string }).name)
  assert.ok(messageCols.includes('compressed'), 'compressed column added to an old-shape table')
  assert.ok(taskCols.includes('system_prompt'), 'system_prompt column added to an old-shape table')
  assert.ok(sessionCols.includes('document_content'), 'document columns added to an old-shape sessions table')
  assert.ok(sessionCols.includes('document_mode'), 'document_mode column added to an old-shape sessions table')
  assert.ok(libraryCols.includes('sort_order'), 'sort_order column added to an old-shape library_items table')
  assert.strictEqual(
    oldShapeDb.prepare('SELECT content FROM messages WHERE id = ?').get('m1')?.content,
    'hello',
    'existing row survives the migration'
  )

  // Idempotent: running it again against an already-migrated table must not throw.
  applyColumnMigrations(oldShapeDb)

  // A brand-new database (SCHEMA already includes both columns) must also not throw.
  const freshDb = new DatabaseSync(':memory:')
  freshDb.exec(SCHEMA)
  applyColumnMigrations(freshDb)

  console.log('schema self-check passed')
}
