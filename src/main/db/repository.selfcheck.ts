// Standalone end-to-end check for repository.ts. No Electron runtime needed: it opens a
// throwaway in-memory DatabaseSync and applies the exported SCHEMA directly.
//
// Run with:  npx tsx src/main/db/repository.selfcheck.ts

import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA } from './schema'
import {
  _setDbForTesting,
  addLibraryItem,
  addMessage,
  createSession,
  createTask,
  deleteSession,
  findLibraryLinkByName,
  getSessionDocument,
  getSessionDraft,
  getSessionOverrides,
  getTask,
  isDocumentModeEnabled,
  listLibraryItems,
  listMessages,
  listMessagesForModel,
  listSessions,
  listTasks,
  markMessagesCompressed,
  relinkLibraryItem,
  renameSession,
  reorderLibraryItems,
  setDocumentMode,
  setSessionArchived,
  setSessionDocument,
  setSessionDraft,
  setSessionOverrides,
  updateSessionModel,
  updateTask
} from './repository'

const memoryDb = new DatabaseSync(':memory:')
memoryDb.exec(SCHEMA)
_setDbForTesting(memoryDb)

// --- sessions ---

const session = createSession('groq', 'llama-3.1-70b', 'Test chat')
assert.strictEqual(typeof session.id, 'string')
assert.strictEqual(session.title, 'Test chat')
assert.strictEqual(session.archived, false)

assert.deepStrictEqual(listSessions(), [session])

renameSession(session.id, 'Renamed chat')
assert.strictEqual(listSessions()[0].title, 'Renamed chat')

// --- messages ---

const userMsg = addMessage(session.id, 'user', 'Hello there')
const assistantMsg = addMessage(session.id, 'assistant', 'Hi!', 'thought about it briefly')

const messages = listMessages(session.id)
assert.strictEqual(messages.length, 2)
assert.deepStrictEqual(
  messages.map((m) => m.id),
  [userMsg.id, assistantMsg.id]
) // created_at ASC
assert.strictEqual(messages[0].reasoning, undefined)
assert.strictEqual(messages[1].reasoning, 'thought about it briefly')
assert.strictEqual(messages[0].compressed, false)

// compression: mark the user message compressed, add a summary in its place
markMessagesCompressed([userMsg.id])
assert.deepStrictEqual(
  listMessagesForModel(session.id).map((m) => m.id),
  [assistantMsg.id] // compressed one excluded
)
assert.strictEqual(
  listMessages(session.id).length,
  2 // still shown in full history for the UI
)
const summaryMsg = addMessage(session.id, 'system', '[summary]')
assert.deepStrictEqual(
  listMessagesForModel(session.id).map((m) => m.id),
  [assistantMsg.id, summaryMsg.id]
)

// --- tasks ---

const parentTask = createTask({
  parentTaskId: null,
  sessionId: session.id,
  providerId: 'groq',
  modelId: 'llama-3.1-70b'
})
assert.strictEqual(parentTask.status, 'queued')
assert.strictEqual(parentTask.promptTokens, null)
assert.strictEqual(parentTask.completionTokens, null)
assert.strictEqual(parentTask.costUsd, 0)
assert.strictEqual(parentTask.endedAt, null)
assert.strictEqual(parentTask.error, null)

const childTask = createTask({
  parentTaskId: parentTask.id,
  sessionId: session.id,
  providerId: 'groq',
  modelId: 'llama-3.1-70b'
})
assert.strictEqual(childTask.parentTaskId, parentTask.id)

const updated = updateTask(parentTask.id, {
  status: 'done',
  promptTokens: 120,
  completionTokens: 45,
  costUsd: 0.002,
  endedAt: Date.now()
})
assert.strictEqual(updated.id, parentTask.id)
assert.strictEqual(updated.status, 'done')
assert.strictEqual(updated.promptTokens, 120)
assert.strictEqual(updated.completionTokens, 45)
assert.strictEqual(updated.costUsd, 0.002)
assert.strictEqual(typeof updated.endedAt, 'number')
// unpatched fields survive a partial update untouched
assert.strictEqual(updated.providerId, 'groq')
assert.strictEqual(updated.sessionId, session.id)

assert.strictEqual(getTask(parentTask.id)?.status, 'done')
assert.strictEqual(getTask('does-not-exist'), undefined)
assert.throws(() => updateTask('does-not-exist', { status: 'error' }))

const allTasks = listTasks()
assert.strictEqual(allTasks.length, 2)
assert.deepStrictEqual(
  allTasks.map((t) => t.id).sort(),
  [parentTask.id, childTask.id].sort()
)
// ordered by started_at DESC (non-increasing; ties are fine since both ran within the same tick)
for (let i = 0; i + 1 < allTasks.length; i++) {
  assert.ok(allTasks[i].startedAt >= allTasks[i + 1].startedAt)
}

// 'chat' is the default kind, unset until asked for — an execution task carries its command
// up front and gets stdout/stderr/exitCode patched in once the command finishes.
assert.strictEqual(parentTask.kind, 'chat')
const execTask = createTask({
  parentTaskId: null,
  sessionId: session.id,
  providerId: 'groq',
  modelId: 'llama-3.1-70b',
  kind: 'execution',
  command: 'npm test'
})
assert.strictEqual(execTask.kind, 'execution')
assert.strictEqual(execTask.command, 'npm test')
assert.strictEqual(execTask.stdout, null)

const updatedExecTask = updateTask(execTask.id, {
  status: 'done',
  stdout: 'all tests passed',
  stderr: '',
  exitCode: 0,
  endedAt: Date.now()
})
assert.strictEqual(updatedExecTask.stdout, 'all tests passed')
assert.strictEqual(updatedExecTask.stderr, '')
assert.strictEqual(updatedExecTask.exitCode, 0)
// command set at creation survives a patch that doesn't touch it
assert.strictEqual(updatedExecTask.command, 'npm test')

// --- archive ---

setSessionArchived(session.id, true)
const archived = listSessions().find((s) => s.id === session.id)
assert.strictEqual(archived?.archived, true)

// --- switch model ---

updateSessionModel(session.id, 'openrouter', 'openrouter/free')
const switched = listSessions().find((s) => s.id === session.id)
assert.strictEqual(switched?.providerId, 'openrouter')
assert.strictEqual(switched?.modelId, 'openrouter/free')

// --- document ---

assert.strictEqual(getSessionDocument(session.id), null, 'no document yet')
assert.strictEqual(isDocumentModeEnabled(session.id), false, 'document mode off by default')

setDocumentMode(session.id, true)
assert.strictEqual(isDocumentModeEnabled(session.id), true)

const savedDoc = setSessionDocument(session.id, {
  kind: 'text',
  content: 'Resume draft v1',
  mimeType: null,
  fileName: 'resume.md'
})
assert.strictEqual(savedDoc.content, 'Resume draft v1')
assert.strictEqual(getSessionDocument(session.id)?.content, 'Resume draft v1')

setSessionDocument(session.id, {
  kind: 'file',
  content: 'data:application/pdf;base64,AAAA',
  mimeType: 'application/pdf',
  fileName: 'resume.pdf'
})
const fileDoc = getSessionDocument(session.id)
assert.strictEqual(fileDoc?.kind, 'file')
assert.strictEqual(fileDoc?.mimeType, 'application/pdf')

// --- session overrides ---
// The exact bug this exists for: this used to be a pure no-op stub (nothing ever persisted),
// so a toggle like agentFileAccess would silently reset on every restart or session switch.

assert.strictEqual(getSessionOverrides(session.id), null, 'no overrides saved yet')
setSessionOverrides(session.id, { temperature: 0.9, agentFileAccess: true })
assert.deepStrictEqual(getSessionOverrides(session.id), { temperature: 0.9, agentFileAccess: true })
setSessionOverrides(session.id, { imageGeneration: false })
assert.deepStrictEqual(
  getSessionOverrides(session.id),
  { imageGeneration: false },
  'a later save fully replaces the previous overrides, same as the renderer sending its already-merged object'
)

// --- session draft (unsent chat input text) ---

assert.strictEqual(getSessionDraft(session.id), null, 'never saved here yet')
setSessionDraft(session.id, 'half-typed message')
assert.strictEqual(getSessionDraft(session.id), 'half-typed message')
setSessionDraft(session.id, '')
assert.strictEqual(getSessionDraft(session.id), '', "saving an empty draft (message was sent/cleared) isn't the same as never having saved one")

// --- library reorder ---

const itemA = addLibraryItem({
  sessionId: session.id,
  fileName: 'a.png',
  filePath: '/tmp/a.png',
  mimeType: 'image/png',
  sizeBytes: 100,
  description: null
})
const itemB = addLibraryItem({
  sessionId: session.id,
  fileName: 'b.png',
  filePath: '/tmp/b.png',
  mimeType: 'image/png',
  sizeBytes: 100,
  description: null
})
const itemC = addLibraryItem({
  sessionId: session.id,
  fileName: 'c.png',
  filePath: '/tmp/c.png',
  mimeType: 'image/png',
  sizeBytes: 100,
  description: null
})
reorderLibraryItems([itemA.id, itemC.id, itemB.id])
assert.deepStrictEqual(
  listLibraryItems(session.id).map((i) => i.id),
  [itemA.id, itemC.id, itemB.id],
  'explicit order persists and overrides the created_at fallback'
)
assert.strictEqual(itemA.kind, 'file', 'kind defaults to file when not specified')

// --- library links (agent-written projects) ---

const link = addLibraryItem({
  sessionId: session.id,
  fileName: 'pong-game',
  filePath: '/Users/x/Documents/Token Thrift Projects/pong-game',
  mimeType: 'inode/directory',
  sizeBytes: 500,
  description: null,
  kind: 'link'
})
assert.strictEqual(link.kind, 'link')
assert.strictEqual(
  findLibraryLinkByName(session.id, 'pong-game')?.id,
  link.id,
  'a link is found by session + exact name, for resuming a project across turns'
)
assert.strictEqual(findLibraryLinkByName(session.id, 'no-such-project'), undefined)
assert.strictEqual(findLibraryLinkByName(session.id, 'a.png'), undefined, 'a plain file is never returned as a link')

const relinked = relinkLibraryItem(link.id, '/Users/x/Documents/Token Thrift Projects/pong-game-2', 900)
assert.strictEqual(relinked.sizeBytes, 900, 'relink refreshes the stored size')
assert.strictEqual(listLibraryItems(session.id).find((i) => i.id === link.id)?.sizeBytes, 900, 'change is persisted')
assert.throws(() => relinkLibraryItem('does-not-exist', '/tmp/x', 0))

// --- delete ---

deleteSession(session.id)
assert.strictEqual(listSessions().find((s) => s.id === session.id), undefined, 'session gone')
assert.strictEqual(listMessages(session.id).length, 0, 'messages gone')
assert.strictEqual(listTasks().filter((t) => t.sessionId === session.id).length, 0, 'tasks gone')

_setDbForTesting(undefined)
memoryDb.close()

console.log('repository.selfcheck: all assertions passed')
