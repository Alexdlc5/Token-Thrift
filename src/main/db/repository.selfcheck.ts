// Standalone end-to-end check for repository.ts. No Electron runtime needed: it opens a
// throwaway in-memory DatabaseSync and applies the exported SCHEMA directly.
//
// Run with:  npx tsx src/main/db/repository.selfcheck.ts

import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA } from './schema'
import {
  _setDbForTesting,
  addMessage,
  createSession,
  createTask,
  deleteSession,
  getSessionDocument,
  getTask,
  isDocumentModeEnabled,
  listMessages,
  listMessagesForModel,
  listSessions,
  listTasks,
  markMessagesCompressed,
  renameSession,
  setDocumentMode,
  setSessionArchived,
  setSessionDocument,
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

// --- delete ---

deleteSession(session.id)
assert.strictEqual(listSessions().find((s) => s.id === session.id), undefined, 'session gone')
assert.strictEqual(listMessages(session.id).length, 0, 'messages gone')
assert.strictEqual(listTasks().filter((t) => t.sessionId === session.id).length, 0, 'tasks gone')

_setDbForTesting(undefined)
memoryDb.close()

console.log('repository.selfcheck: all assertions passed')
