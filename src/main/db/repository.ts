// Query/repository layer over the schema in ./schema.ts. Maps snake_case SQLite rows to the
// camelCase DTOs in @shared/models. Real callers only ever get a DB handle via getDb() — the
// _setDbForTesting seam below exists solely so repository.selfcheck.ts can inject a throwaway
// in-memory DatabaseSync without pulling in Electron.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDb } from './schema'
import type {
  ChatMessage,
  ChatRole,
  DocumentKind,
  LibraryItem,
  ProviderId,
  SessionDocument,
  SessionSummary,
  TaskRow,
  TaskStatus
} from '@shared/models'

let dbOverride: DatabaseSync | undefined

/** Test-only seam. Real code paths never call this — they always resolve through getDb(). */
export function _setDbForTesting(db: DatabaseSync | undefined): void {
  dbOverride = db
}

function conn(): DatabaseSync {
  return dbOverride ?? getDb()
}

// ---- row shapes, as they come back from node:sqlite (snake_case) ----

interface SessionRow {
  id: string
  provider_id: ProviderId
  model_id: string
  title: string
  created_at: number
  archived: number
}

function mapSession(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    title: row.title,
    createdAt: row.created_at,
    archived: row.archived === 1
  }
}

interface MessageRow {
  id: string
  session_id: string
  role: ChatRole
  content: string
  reasoning: string | null
  created_at: number
  compressed: number
}

function mapMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning ?? undefined,
    createdAt: row.created_at,
    compressed: row.compressed === 1
  }
}

interface TaskDbRow {
  id: string
  parent_task_id: string | null
  session_id: string | null
  provider_id: ProviderId
  model_id: string
  status: TaskStatus
  prompt_tokens: number | null
  completion_tokens: number | null
  cost_usd: number
  started_at: number
  ended_at: number | null
  error: string | null
  system_prompt: string | null
}

function mapTask(row: TaskDbRow): TaskRow {
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    sessionId: row.session_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    status: row.status,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: row.error,
    systemPrompt: row.system_prompt
  }
}

// ---- sessions ----

export function createSession(providerId: ProviderId, modelId: string, title = 'New chat'): SessionSummary {
  const session: SessionSummary = {
    id: randomUUID(),
    providerId,
    modelId,
    title,
    createdAt: Date.now(),
    archived: false
  }
  conn()
    .prepare(
      `INSERT INTO sessions (id, provider_id, model_id, title, created_at, archived) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(session.id, session.providerId, session.modelId, session.title, session.createdAt, 0)
  return session
}

export function listSessions(): SessionSummary[] {
  const rows = conn().prepare(`SELECT * FROM sessions ORDER BY created_at DESC`).all() as unknown as SessionRow[]
  return rows.map(mapSession)
}

export function getSession(id: string): SessionSummary | undefined {
  const row = conn().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as unknown as SessionRow | undefined
  return row ? mapSession(row) : undefined
}

export function renameSession(id: string, title: string): void {
  conn().prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id)
}

export function setSessionArchived(id: string, archived: boolean): void {
  conn().prepare(`UPDATE sessions SET archived = ? WHERE id = ?`).run(archived ? 1 : 0, id)
}

/** Switches a session to a different provider/model without touching its message history. */
export function updateSessionModel(id: string, providerId: ProviderId, modelId: string): void {
  conn().prepare(`UPDATE sessions SET provider_id = ?, model_id = ? WHERE id = ?`).run(providerId, modelId, id)
}

// ---- document (one working file per session, shown above the chat input) ----

interface DocumentRow {
  document_kind: DocumentKind | null
  document_content: string | null
  document_mime_type: string | null
  document_file_name: string | null
  document_updated_at: number | null
}

function mapDocument(row: DocumentRow): SessionDocument | null {
  if (!row.document_kind || row.document_content === null) return null
  return {
    kind: row.document_kind,
    content: row.document_content,
    mimeType: row.document_mime_type,
    fileName: row.document_file_name,
    updatedAt: row.document_updated_at ?? 0
  }
}

export function getSessionDocument(sessionId: string): SessionDocument | null {
  const row = conn()
    .prepare(
      `SELECT document_kind, document_content, document_mime_type, document_file_name, document_updated_at
       FROM sessions WHERE id = ?`
    )
    .get(sessionId) as unknown as DocumentRow | undefined
  return row ? mapDocument(row) : null
}

export function setSessionDocument(
  sessionId: string,
  doc: { kind: DocumentKind; content: string; mimeType: string | null; fileName: string | null }
): SessionDocument {
  const updatedAt = Date.now()
  conn()
    .prepare(
      `UPDATE sessions
       SET document_kind = ?, document_content = ?, document_mime_type = ?, document_file_name = ?, document_updated_at = ?
       WHERE id = ?`
    )
    .run(doc.kind, doc.content, doc.mimeType, doc.fileName, updatedAt, sessionId)
  return { ...doc, updatedAt }
}

export function isDocumentModeEnabled(sessionId: string): boolean {
  const row = conn().prepare(`SELECT document_mode FROM sessions WHERE id = ?`).get(sessionId) as
    | { document_mode: number }
    | undefined
  return row?.document_mode === 1
}

export function setDocumentMode(sessionId: string, enabled: boolean): void {
  conn().prepare(`UPDATE sessions SET document_mode = ? WHERE id = ?`).run(enabled ? 1 : 0, sessionId)
}

/** Permanently removes a session and everything under it — irreversible, unlike archiving. */
export function deleteSession(id: string): void {
  const db = conn()
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM tasks WHERE session_id = ?`).run(id)
    // library_items also references sessions(id) — leaving these behind either orphans the
    // rows or fails the delete outright under FK enforcement.
    db.prepare(`DELETE FROM library_items WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// ---- messages ----

export function listMessages(sessionId: string): ChatMessage[] {
  const rows = conn()
    .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as unknown as MessageRow[]
  return rows.map(mapMessage)
}

/** Non-compressed messages only, in order — what actually gets sent to a provider. */
export function listMessagesForModel(sessionId: string): ChatMessage[] {
  const rows = conn()
    .prepare(`SELECT * FROM messages WHERE session_id = ? AND compressed = 0 ORDER BY created_at ASC`)
    .all(sessionId) as unknown as MessageRow[]
  return rows.map(mapMessage)
}

export function markMessagesCompressed(ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(', ')
  conn().prepare(`UPDATE messages SET compressed = 1 WHERE id IN (${placeholders})`).run(...ids)
}

export function addMessage(
  sessionId: string,
  role: ChatRole,
  content: string,
  reasoning?: string
): ChatMessage {
  const message: ChatMessage = {
    id: randomUUID(),
    sessionId,
    role,
    content,
    reasoning,
    createdAt: Date.now(),
    compressed: false
  }
  conn()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, reasoning, created_at, compressed) VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
    .run(message.id, message.sessionId, message.role, message.content, reasoning ?? null, message.createdAt)
  return message
}

// ---- tasks ----

export interface CreateTaskInput {
  parentTaskId: string | null
  sessionId: string | null
  providerId: ProviderId
  modelId: string
  systemPrompt?: string | null
}

export function createTask(input: CreateTaskInput): TaskRow {
  const task: TaskRow = {
    id: randomUUID(),
    parentTaskId: input.parentTaskId,
    sessionId: input.sessionId,
    providerId: input.providerId,
    modelId: input.modelId,
    status: 'queued',
    promptTokens: null,
    completionTokens: null,
    costUsd: 0,
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    systemPrompt: input.systemPrompt ?? null
  }
  conn()
    .prepare(
      `INSERT INTO tasks
         (id, parent_task_id, session_id, provider_id, model_id, status, prompt_tokens, completion_tokens, cost_usd, started_at, ended_at, error, system_prompt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      task.id,
      task.parentTaskId,
      task.sessionId,
      task.providerId,
      task.modelId,
      task.status,
      task.promptTokens,
      task.completionTokens,
      task.costUsd,
      task.startedAt,
      task.endedAt,
      task.error,
      task.systemPrompt
    )
  return task
}

type TaskPatch = Partial<Pick<TaskRow, 'status' | 'promptTokens' | 'completionTokens' | 'costUsd' | 'endedAt' | 'error'>>

const TASK_PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  status: 'status',
  promptTokens: 'prompt_tokens',
  completionTokens: 'completion_tokens',
  costUsd: 'cost_usd',
  endedAt: 'ended_at',
  error: 'error'
}

export function updateTask(id: string, patch: TaskPatch): TaskRow {
  const keys = Object.keys(patch) as (keyof TaskPatch)[]
  if (keys.length > 0) {
    const setClause = keys.map((key) => `${TASK_PATCH_COLUMNS[key]} = ?`).join(', ')
    const values = keys.map((key) => patch[key] as string | number | null)
    conn()
      .prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`)
      .run(...values, id)
  }
  const updated = getTask(id)
  if (!updated) throw new Error(`updateTask: no task with id "${id}"`)
  return updated
}

export function listTasks(): TaskRow[] {
  const rows = conn().prepare(`SELECT * FROM tasks ORDER BY started_at DESC`).all() as unknown as TaskDbRow[]
  return rows.map(mapTask)
}

export function getTask(id: string): TaskRow | undefined {
  const row = conn().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as unknown as TaskDbRow | undefined
  return row ? mapTask(row) : undefined
}

// ---- library (session-scoped saved files: uploads + generated images) ----

interface LibraryItemRow {
  id: string
  session_id: string
  file_name: string
  file_path: string
  mime_type: string
  size_bytes: number
  description: string | null
  created_at: number
  sort_order: number
}

function mapLibraryItem(row: LibraryItemRow): LibraryItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    description: row.description,
    createdAt: row.created_at
  }
}

export function addLibraryItem(input: {
  sessionId: string
  fileName: string
  filePath: string
  mimeType: string
  sizeBytes: number
  description: string | null
}): LibraryItem {
  const id = randomUUID()
  const createdAt = Date.now()
  conn()
    .prepare(
      `INSERT INTO library_items (id, session_id, file_name, file_path, mime_type, size_bytes, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.sessionId, input.fileName, input.filePath, input.mimeType, input.sizeBytes, input.description, createdAt)
  return {
    id,
    sessionId: input.sessionId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    description: input.description,
    createdAt
  }
}

export function listLibraryItems(sessionId: string): LibraryItem[] {
  // sort_order defaults to 0 for every item until the user drags one — ties then fall back to
  // created_at DESC, so an untouched library looks exactly like it did before this existed.
  const rows = conn()
    .prepare(`SELECT * FROM library_items WHERE session_id = ? ORDER BY sort_order ASC, created_at DESC`)
    .all(sessionId) as unknown as LibraryItemRow[]
  return rows.map(mapLibraryItem)
}

/** Persists a manual drag-and-drop order — `orderedIds` is the item ids in their new visual order. */
export function reorderLibraryItems(orderedIds: string[]): void {
  const stmt = conn().prepare(`UPDATE library_items SET sort_order = ? WHERE id = ?`)
  orderedIds.forEach((id, index) => stmt.run(index, id))
}

/** Internal-only (file_path never leaves main) — used to resolve what to hand shell.openPath(). */
export function getLibraryItemPath(id: string): string | undefined {
  const row = conn().prepare(`SELECT file_path FROM library_items WHERE id = ?`).get(id) as
    | { file_path: string }
    | undefined
  return row?.file_path
}
