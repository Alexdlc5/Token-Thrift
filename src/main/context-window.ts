// No single tokenizer is accurate across six providers with six different tokenizers (a
// tiktoken-style dependency would only be correct for OpenAI-shaped models). Approximate
// with the standard chars/4 heuristic instead — same "honest approximation" posture as
// ModelInfo.contextLengthApprox elsewhere in this app. Each real request still reports its
// own exact token count via TaskRow, which is what the usage tracker displays; this
// estimate is only for deciding what to send *before* that number exists.

import assert from 'node:assert'
import type { ChatMessage } from '@shared/models'
import type { ProviderChatMessage } from './providers/LLMProvider'

const CHARS_PER_TOKEN_ESTIMATE = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}

function messageTokens(m: Pick<ChatMessage, 'content' | 'reasoning'>): number {
  return estimateTokens(m.content) + estimateTokens(m.reasoning ?? '')
}

export function estimateHistoryTokens(messages: Pick<ChatMessage, 'content' | 'reasoning'>[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0)
}

/**
 * Fits history into a token budget for one request: always keeps the most recent messages,
 * dropping the oldest first once over budget. Never drops the single most recent message
 * even if it alone exceeds budget (better to attempt an over-long request than send nothing).
 */
export function fitHistoryToBudget(
  messages: ChatMessage[],
  budgetTokens: number
): ProviderChatMessage[] {
  const kept: ChatMessage[] = []
  let running = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = messageTokens(messages[i])
    if (running + cost > budgetTokens && kept.length > 0) break
    running += cost
    kept.unshift(messages[i])
  }
  return kept.map((m) => ({ role: m.role, content: m.content }))
}

// --- self-check ---------------------------------------------------------------------
// Pure functions, no Electron dependency — runnable directly with plain node/tsx.
if (require.main === module) {
  function fixture(id: string, chars: number): ChatMessage {
    return {
      id,
      sessionId: 's1',
      role: 'user',
      content: 'x'.repeat(chars),
      createdAt: 0,
      compressed: false
    }
  }

  // 3 messages, ~25 tokens each (100 chars / 4). Budget fits all three.
  const three = [fixture('a', 100), fixture('b', 100), fixture('c', 100)]
  assert.deepStrictEqual(
    fitHistoryToBudget(three, 100).map((m) => m.content.length),
    [100, 100, 100]
  )

  // Budget only fits the most recent two — oldest dropped first.
  assert.deepStrictEqual(
    fitHistoryToBudget(three, 60).map((m) => m.content.length),
    [100, 100]
  )

  // Budget smaller than even one message — still keeps the single most recent, never empty.
  assert.deepStrictEqual(
    fitHistoryToBudget(three, 5).map((m) => m.content.length),
    [100]
  )

  assert.deepStrictEqual(fitHistoryToBudget([], 1000), [])

  assert.strictEqual(estimateHistoryTokens(three), 75) // 3 * ceil(100/4)

  console.log('context-window self-check passed')
}
