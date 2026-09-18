// Cohere's own v2 Chat API (not OpenAI-compatible — different request/response/SSE event
// shape from every other adapter here) — confirmed against docs.cohere.com/reference/chat,
// docs.cohere.com/reference/chat-stream, and docs.cohere.com/reference/list-models as of
// 2026-09-17:
// - POST https://api.cohere.com/v2/chat, Bearer auth, body: {model, messages, stream,
//   temperature, p (NOT top_p), max_tokens}. messages support role "system"/"user"/
//   "assistant" (also "tool", unused here) with plain-string `content`, same shape
//   ProviderChatMessage already uses — no translation needed.
// - Streaming is SSE but with Cohere's own named event types, not OpenAI's `choices[].delta`
//   shape: "content-delta" carries text at delta.message.content.text, "message-end" carries
//   token counts at delta.usage.tokens.{input,output}_tokens and marks the end of the
//   response (no `data: [DONE]` sentinel — message-end IS the sentinel here).
// - GET https://api.cohere.com/v1/models lists {name, context_length, endpoints[],
//   is_deprecated} — filtered to endpoints.includes('chat') && !is_deprecated, same pattern
//   as mistral.ts filtering out its embed/OCR/moderation models.
//
// FREE TIER ***************************************************************************
// Cohere issues "trial" API keys (dashboard.cohere.com/api-keys) with no credit card:
// 20 req/min and 1,000 calls/month across chat models (docs.cohere.com/docs/rate-limits,
// "Trial keys ... are limited to 1,000 API calls a month" / "20 req / min" for Chat).
// That page also says trial keys get access to "all Chat API models listed" — a blanket
// per-account statement, not a per-model flag in the API — so isFree() is unconditionally
// true for chat-capable models, same reasoning as mistral.ts/cerebras.ts. One honest caveat
// from that same page, not resolved further: "Some newer model variants require contacting
// sales for production deployment; trial access may have different limitations than
// indicated" — if a specific model ever rejects a trial key, that surfaces as a normal
// failed request, same as any other unconfigured-access case.

import assert from 'node:assert'
import type { ModelInfo } from '@shared/models'
import type {
  ChatStreamPart,
  LLMProvider,
  ProviderChatMessage,
  StreamChatOptions
} from './LLMProvider'
import { getApiKey } from '../secure-store'
import { registerProvider } from './registry'
import { parseSseStream, type ByteReader } from './sse'

const MODELS_URL = 'https://api.cohere.com/v1/models'
const CHAT_URL = 'https://api.cohere.com/v2/chat'
const CACHE_TTL_MS = 30 * 60 * 1000

interface CohereModelEntry {
  name: string
  context_length?: number
  endpoints?: string[]
  is_deprecated?: boolean
}

// Module-level cache (not a class field): there's only ever one Cohere provider instance.
let cache: { models: ModelInfo[]; fetchedAt: number } | undefined

function toModelInfo(entry: CohereModelEntry): ModelInfo {
  return {
    providerId: 'cohere',
    modelId: entry.name,
    label: entry.name,
    isFree: true,
    // No documented reasoning-delta event type for streaming chat (message-start/
    // content-start/content-delta/content-end/message-end covers plain text only).
    supportsReasoningTrace: false,
    contextLength: entry.context_length
  }
}

async function fetchModels(): Promise<ModelInfo[]> {
  const apiKey = getApiKey('cohere')
  if (!apiKey) throw new Error('Cohere API key is not configured')

  const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`Cohere model list failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { models: CohereModelEntry[] }
  // The catalog mixes chat, embed, classify, summarize, rerank, and generate-only models
  // together — filter to what this adapter can actually call.
  return body.models.filter((m) => m.endpoints?.includes('chat') && !m.is_deprecated).map(toModelInfo)
}

async function getCachedModels(forceRefresh = false): Promise<ModelInfo[]> {
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models
  const models = await fetchModels()
  cache = { models, fetchedAt: Date.now() }
  return models
}

/** One `data: {...}` line, parsed into zero or more stream parts, plus the done sentinel —
 * Cohere's "message-end" event type IS the sentinel here, there's no `[DONE]` marker. */
function parseEvent(eventBlock: string): { done: boolean; parts: ChatStreamPart[] } {
  const dataLine = eventBlock.split('\n').find((line) => line.startsWith('data:'))
  if (!dataLine) return { done: false, parts: [] } // keep-alive comment lines, blank blocks

  const payload = dataLine.slice(5).trim()
  if (!payload) return { done: false, parts: [] }

  let json: {
    type?: string
    delta?: {
      message?: { content?: { text?: string } }
      usage?: { tokens?: { input_tokens?: number; output_tokens?: number } }
    }
  }
  try {
    json = JSON.parse(payload)
  } catch {
    return { done: false, parts: [] } // ponytail: malformed chunk skipped, not fatal
  }

  if (json.type === 'content-delta') {
    const text = json.delta?.message?.content?.text
    return { done: false, parts: text ? [{ type: 'answer', delta: text }] : [] }
  }

  if (json.type === 'message-end') {
    const tokens = json.delta?.usage?.tokens
    const parts: ChatStreamPart[] =
      tokens?.input_tokens !== undefined && tokens?.output_tokens !== undefined
        ? [{ type: 'usage', promptTokens: tokens.input_tokens, completionTokens: tokens.output_tokens }]
        : []
    return { done: true, parts }
  }

  return { done: false, parts: [] } // message-start / content-start / content-end: no-ops
}

class CohereProvider implements LLMProvider {
  readonly id = 'cohere' as const
  readonly supportsReasoningTrace = false

  async listModels(opts?: { forceRefresh?: boolean }): Promise<ModelInfo[]> {
    return getCachedModels(opts?.forceRefresh)
  }

  isFree(_modelId: string): boolean {
    // Trial-key access is account-level, not a per-model pricing split — see file header.
    return true
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const apiKey = getApiKey('cohere')
    if (!apiKey) throw new Error('Cohere API key is not configured')

    const body: Record<string, unknown> = { model: opts.modelId, messages, stream: true }
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.topP !== undefined) body.p = opts.topP
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens

    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: opts.signal
    })

    if (!res.ok || !res.body) {
      throw new Error(`Cohere chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader(), parseEvent)
  }
}

registerProvider(new CohereProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data through the branchy
// bits (model-list filtering/mapping, always-free resolution, SSE event parsing including
// Cohere's own event-type shape) directly. Plain assert, throws on failure, no test
// framework.
if (require.main === module) {
  void (async () => {
    const fixtureEntries: CohereModelEntry[] = [
      { name: 'command-r7b-12-2024', context_length: 128000, endpoints: ['chat'] },
      { name: 'embed-english-v3.0', context_length: 512, endpoints: ['embed'] },
      { name: 'command-old', context_length: 4096, endpoints: ['chat'], is_deprecated: true }
    ]
    const chatModels = fixtureEntries
      .filter((m) => m.endpoints?.includes('chat') && !m.is_deprecated)
      .map(toModelInfo)
    assert.deepStrictEqual(chatModels, [
      {
        providerId: 'cohere',
        modelId: 'command-r7b-12-2024',
        label: 'command-r7b-12-2024',
        isFree: true,
        supportsReasoningTrace: false,
        contextLength: 128000
      }
    ])

    const provider = new CohereProvider()
    assert.strictEqual(provider.isFree('command-a-03-2025'), true, 'no per-model pricing split')
    assert.strictEqual(provider.isFree('unknown-model'), true, 'no per-model pricing split')

    const sseText =
      'data: {"type":"message-start","delta":{}}\n\n' +
      'data: {"type":"content-start","delta":{}}\n\n' +
      'data: {"type":"content-delta","delta":{"message":{"content":{"text":"Hel"}}}}\n\n' +
      ': keep-alive, no data line\n\n' +
      'data: {"type":"content-delta","delta":{"message":{"content":{"text":"lo"}}}}\n\n' +
      'data: {"type":"content-end","delta":{}}\n\n' +
      'data: {"type":"message-end","delta":{"usage":{"tokens":{"input_tokens":10,"output_tokens":2}}}}\n\n' +
      'data: {"type":"content-delta","delta":{"message":{"content":{"text":"must never arrive"}}}}\n\n'

    const bytes = new TextEncoder().encode(sseText)
    let offset = 0
    const fakeReader: ByteReader = {
      async read() {
        if (offset >= bytes.length) return { done: true }
        // Chunk arbitrarily so a `\n\n` boundary can straddle two reads, exercising buffering.
        const end = Math.min(offset + 40, bytes.length)
        const value = bytes.slice(offset, end)
        offset = end
        return { done: false, value }
      }
    }

    const parts: ChatStreamPart[] = []
    for await (const part of parseSseStream(fakeReader, parseEvent)) parts.push(part)

    assert.deepStrictEqual(parts, [
      { type: 'answer', delta: 'Hel' },
      { type: 'answer', delta: 'lo' },
      { type: 'usage', promptTokens: 10, completionTokens: 2 }
    ])

    console.log('cohere provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
