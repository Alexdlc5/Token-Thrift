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
  getTask,
  listMessages,
  listSessions,
  listTasks,
  renameSession,
  setSessionArchived,
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

_setDbForTesting(undefined)
memoryDb.close()

console.log('repository.selfcheck: all assertions passed')
