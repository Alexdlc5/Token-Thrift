// Session-level rolling context: each conversation can carry up to SESSION_TOKEN_CAP tokens
// of history (shared across whichever provider/model the session switches to). Once
// estimated usage crosses COMPRESSION_TRIGGER_RATIO of that cap, the oldest portion gets
// summarized by one LLM call and archived (never deleted) rather than hard-truncated, so a
// long conversation keeps its long-range context instead of just losing it.

import assert from 'node:assert'
import type { ChatMessage, ProviderId } from '@shared/models'
import { addMessage, listMessagesForModel, markMessagesCompressed } from './db/repository'
import { getProvider } from './providers'
import { getApiKey } from './secure-store'
import { estimateTokens, estimateHistoryTokens } from './context-window'

export const SESSION_TOKEN_CAP = 500_000
const COMPRESSION_TRIGGER_RATIO = 0.97
// Keep roughly this fraction of the cap as raw, most-recent history; summarize the rest.
const KEEP_RAW_RATIO = 0.2

// Preferred summarizer: OpenRouter's free auto-router, since it's the one provider this app
// consistently has a working free key for. Falls back to whatever model is actually running
// the conversation if OpenRouter isn't configured — per-user decision, since a dedicated
// fixed summarizer is nicer but not worth blocking compression on.
const FIXED_SUMMARIZER_PROVIDER_ID: ProviderId = 'openrouter'
const FIXED_SUMMARIZER_MODEL_ID = 'openrouter/free'

function pickSummarizer(fallbackProviderId: ProviderId, fallbackModelId: string): { providerId: ProviderId; modelId: string } {
  if (getApiKey(FIXED_SUMMARIZER_PROVIDER_ID) && getProvider(FIXED_SUMMARIZER_PROVIDER_ID)) {
    return { providerId: FIXED_SUMMARIZER_PROVIDER_ID, modelId: FIXED_SUMMARIZER_MODEL_ID }
  }
  return { providerId: fallbackProviderId, modelId: fallbackModelId }
}

/** Everything from the start up to (not including) the first message worth keeping raw. */
function splitForCompression(messages: ChatMessage[]): ChatMessage[] {
  const keepBudget = SESSION_TOKEN_CAP * KEEP_RAW_RATIO
  let running = 0
  let splitIndex = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    running += estimateTokens(messages[i].content) + estimateTokens(messages[i].reasoning ?? '')
    if (running > keepBudget) break
    splitIndex = i
  }
  return messages.slice(0, splitIndex)
}

/**
 * Checks a session's estimated history size and compresses the oldest portion if it's
 * crossed the trigger threshold. Best-effort: any failure (no summarizer available, the
 * summarizer call itself fails) just skips this round — the per-request budget fit in
 * context-window.ts is the real safety net regardless of whether compression ever runs.
 */
export async function maybeCompressSession(
  sessionId: string,
  fallbackProviderId: ProviderId,
  fallbackModelId: string
): Promise<void> {
  const messages = listMessagesForModel(sessionId)
  if (estimateHistoryTokens(messages) < SESSION_TOKEN_CAP * COMPRESSION_TRIGGER_RATIO) return

  const toCompress = splitForCompression(messages)
  if (toCompress.length === 0) return

  const { providerId, modelId } = pickSummarizer(fallbackProviderId, fallbackModelId)
  const provider = getProvider(providerId)
  if (!provider) return

  const transcript = toCompress.map((m) => `${m.role}: ${m.content}`).join('\n\n')
  const prompt =
    'Summarize the following conversation so far. Preserve key facts, decisions, and ' +
    'context a continuing assistant would need to keep helping — be concise, but do not ' +
    "drop specifics that matter.\n\n" +
    transcript

  let summary = ''
  try {
    for await (const part of provider.streamChat([{ role: 'user', content: prompt }], { modelId })) {
      if (part.type === 'answer') summary += part.delta
    }
  } catch {
    return
  }
  if (!summary.trim()) return

  markMessagesCompressed(toCompress.map((m) => m.id))
  addMessage(sessionId, 'system', `[Earlier conversation summary]\n${summary.trim()}`)
}

// --- self-check ---------------------------------------------------------------------
// Only exercises splitForCompression (pure, no Electron/network call) — the rest of this
// module needs a real app + provider key to run, which this environment doesn't have.
if (require.main === module) {
  function fixture(id: string, chars: number): ChatMessage {
    return { id, sessionId: 's1', role: 'user', content: 'x'.repeat(chars), createdAt: 0, compressed: false }
  }

  // Each message ~25k tokens (100k chars / 4). KEEP_RAW_RATIO=0.2 of 500k cap = 100k token
  // budget to keep raw, i.e. the last 4 messages (4 * 25k = 100k); everything older is
  // eligible for compression.
  const messages = Array.from({ length: 10 }, (_, i) => fixture(`m${i}`, 100_000))
  const toCompress = splitForCompression(messages)
  assert.strictEqual(toCompress.length, 6, 'oldest 6 of 10 messages should be eligible for compression')
  assert.deepStrictEqual(
    toCompress.map((m) => m.id),
    messages.slice(0, 6).map((m) => m.id)
  )

  assert.deepStrictEqual(splitForCompression([]), [])

  console.log('context-compression self-check passed')
}
