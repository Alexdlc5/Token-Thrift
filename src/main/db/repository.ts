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
  ModelOverrides,
  ProviderId,
  SessionDocument,
  SessionSummary,
  TaskKind,
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
  kind: TaskKind
  command: string | null
  stdout: string | null
  stderr: string | null
  exit_code: number | null
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
    systemPrompt: row.system_prompt,
    kind: row.kind,
    command: row.command,
    stdout: row.stdout,
    stderr: row.stderr,
    exitCode: row.exit_code
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

/** Per-session model overrides (temperature, agentFileAccess, etc.) — null until the user has
 * ever changed one for this session, in which case the renderer falls back to its own
 * defaults rather than treating null as "all overrides off". */
export function getSessionOverrides(sessionId: string): ModelOverrides | null {
  const row = conn().prepare(`SELECT overrides_json FROM sessions WHERE id = ?`).get(sessionId) as
    | { overrides_json: string | null }
    | undefined
  if (!row?.overrides_json) return null
  try {
    return JSON.parse(row.overrides_json) as ModelOverrides
  } catch {
    return null
  }
}

export function setSessionOverrides(sessionId: string, overrides: ModelOverrides): void {
  conn().prepare(`UPDATE sessions SET overrides_json = ? WHERE id = ?`).run(JSON.stringify(overrides), sessionId)
}

/** The chat input's unsent text for this session — saved only at a couple of specific
 * moments (opening Settings, closing the window), not on every keystroke, so switching away
 * and back (including across an app restart) doesn't lose what was half-typed. Empty string,
 * not null, once anything has ever been saved — null only means "never saved here". */
export function getSessionDraft(sessionId: string): string | null {
  const row = conn().prepare(`SELECT draft_text FROM sessions WHERE id = ?`).get(sessionId) as
    | { draft_text: string | null }
    | undefined
  return row?.draft_text ?? null
}

export function setSessionDraft(sessionId: string, text: string): void {
  conn().prepare(`UPDATE sessions SET draft_text = ? WHERE id = ?`).run(text, sessionId)
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
  /** Defaults to 'chat'. Pass 'execution' for a real command run via <run_command> (see
   * main/code-execution.ts) — command/stdout/stderr/exitCode are set via updateTask instead
   * of at creation, since the task is created in 'queued' status before the command runs. */
  kind?: TaskKind
  command?: string | null
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
    systemPrompt: input.systemPrompt ?? null,
    kind: input.kind ?? 'chat',
    command: input.command ?? null,
    stdout: null,
    stderr: null,
    exitCode: null
  }
  conn()
    .prepare(
      `INSERT INTO tasks
         (id, parent_task_id, session_id, provider_id, model_id, status, prompt_tokens, completion_tokens, cost_usd, started_at, ended_at, error, system_prompt, kind, command, stdout, stderr, exit_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      task.systemPrompt,
      task.kind,
      task.command,
      task.stdout,
      task.stderr,
      task.exitCode
    )
  return task
}

type TaskPatch = Partial<
  Pick<
    TaskRow,
    'status' | 'promptTokens' | 'completionTokens' | 'costUsd' | 'endedAt' | 'error' | 'stdout' | 'stderr' | 'exitCode'
  >
>

const TASK_PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  status: 'status',
  promptTokens: 'prompt_tokens',
  completionTokens: 'completion_tokens',
  costUsd: 'cost_usd',
  endedAt: 'ended_at',
  error: 'error',
  stdout: 'stdout',
  stderr: 'stderr',
  exitCode: 'exit_code'
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
  item_kind: string
}

function mapLibraryItem(row: LibraryItemRow): LibraryItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.item_kind === 'link' ? 'link' : 'file',
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
  /** 'file' (default): bytes already copied into userData/library/. 'link': filePath points
   * somewhere else on disk entirely — see the LibraryItem doc comment in @shared/models. */
  kind?: 'file' | 'link'
}): LibraryItem {
  const id = randomUUID()
  const createdAt = Date.now()
  const kind = input.kind ?? 'file'
  conn()
    .prepare(
      `INSERT INTO library_items (id, session_id, file_name, file_path, mime_type, size_bytes, description, created_at, item_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.sessionId,
      input.fileName,
      input.filePath,
      input.mimeType,
      input.sizeBytes,
      input.description,
      createdAt,
      kind
    )
  return {
    id,
    sessionId: input.sessionId,
    kind,
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

/** Finds an existing link item by session + exact name — so a follow-up "now add sound to the
 * pong game" writes into the same project folder instead of creating a second one. */
export function findLibraryLinkByName(sessionId: string, fileName: string): LibraryItem | undefined {
  const row = conn()
    .prepare(`SELECT * FROM library_items WHERE session_id = ? AND item_kind = 'link' AND file_name = ?`)
    .get(sessionId, fileName) as unknown as LibraryItemRow | undefined
  return row ? mapLibraryItem(row) : undefined
}

/** Re-points a link item at a new path (drag-and-drop recovery when the old one goes missing),
 * refreshing its size to match. */
export function relinkLibraryItem(id: string, filePath: string, sizeBytes: number): LibraryItem {
  conn().prepare(`UPDATE library_items SET file_path = ?, size_bytes = ? WHERE id = ?`).run(filePath, sizeBytes, id)
  const row = conn().prepare(`SELECT * FROM library_items WHERE id = ?`).get(id) as unknown as
    | LibraryItemRow
    | undefined
  if (!row) throw new Error(`No library item with id "${id}"`)
  return mapLibraryItem(row)
}

/** Internal-only (file_path never leaves main) — used to resolve what to hand shell.openPath(). */
export function getLibraryItemPath(id: string): string | undefined {
  const row = conn().prepare(`SELECT file_path FROM library_items WHERE id = ?`).get(id) as
    | { file_path: string }
    | undefined
  return row?.file_path
}
