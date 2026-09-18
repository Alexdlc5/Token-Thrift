// Groq's REST API is OpenAI-compatible chat completions plus SSE streaming (base URL
// https://api.groq.com/openai/v1), so this follows the same global-fetch + hand-rolled-SSE
// pattern as openrouter.ts — no SDK dependency needed for a shape this simple.
//
// Unlike OpenRouter, Groq has no per-model price field on its /models listing: the
// platform is free-tier-first by design (every model is reachable on a $0, no-card
// "Free" plan, gated only by rate limits — see console.groq.com/docs/rate-limits).
// The one real exception, confirmed on console.groq.com/docs/models as of 2026-09-17:
// llama-3.1-8b-instant, llama-3.3-70b-versatile, and minimaxai/minimax-m2.7 have moved to
// Enterprise "Contact Sales" pricing and are not reachable on a normal API key at all.
// Since the API doesn't expose that tier as a field, it's hardcoded below — ponytail:
// static denylist, re-check console.groq.com/docs/models if Groq adds/removes gated
// models and this list goes stale.
//
// Reasoning-capable models (Qwen3.x, etc.) stream their reasoning trace in a separate
// `delta.reasoning` field — same key OpenRouter uses — when the request sets
// `reasoning_format: "parsed"`; without it, reasoning is inlined as <think> tags in the
// answer text instead, so this adapter always asks for "parsed".

import assert from 'node:assert'
import type { ModelInfo } from '@shared/models'
import type {
  ChatStreamPart,
  LLMProvider,
  ProviderChatMessage,
  StreamChatOptions
} from './LLMProvider'
import { getAllowPaid, getApiKey } from '../secure-store'
import { registerProvider } from './registry'
import { parseSseStream, type ByteReader } from './sse'

const MODELS_URL = 'https://api.groq.com/openai/v1/models'
const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
const CACHE_TTL_MS = 30 * 60 * 1000

// Enterprise-only, contact-sales models that a free/hobbyist key can't actually use.
// See file header comment for source and date.
const ENTERPRISE_ONLY_MODELS = new Set([
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'minimaxai/minimax-m2.7'
])

interface GroqModelEntry {
  id: string
  object?: string
  created?: number
  owned_by?: string
  active?: boolean
  context_window?: number
}

// Module-level cache (not a class field): there's only ever one Groq provider instance,
// and a plain timestamp check is enough — no setInterval/background refresh.
let cache: { models: ModelInfo[]; fetchedAt: number } | undefined

function toModelInfo(entry: GroqModelEntry): ModelInfo {
  return {
    providerId: 'groq',
    modelId: entry.id,
    label: entry.id,
    isFree: !ENTERPRISE_ONLY_MODELS.has(entry.id),
    supportsReasoningTrace: true,
    contextLength: entry.context_window
  }
}

async function fetchModels(): Promise<ModelInfo[]> {
  const apiKey = getApiKey('groq')
  if (!apiKey) throw new Error('Groq API key is not configured')

  const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`Groq model list failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { data: GroqModelEntry[] }
  // Drop deactivated/deprecated entries — Groq keeps them listed with active: false.
  return body.data.filter((entry) => entry.active !== false).map(toModelInfo)
}

async function getCachedModels(forceRefresh = false): Promise<ModelInfo[]> {
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models
  const models = await fetchModels()
  cache = { models, fetchedAt: Date.now() }
  return models
}

/** One `data: {...}` line, parsed into zero or more stream parts, plus the DONE sentinel. */
function parseEvent(eventBlock: string): { done: boolean; parts: ChatStreamPart[] } {
  const dataLine = eventBlock.split('\n').find((line) => line.startsWith('data:'))
  if (!dataLine) return { done: false, parts: [] } // keep-alive comment lines, blank blocks

  const payload = dataLine.slice(5).trim()
  if (payload === '[DONE]') return { done: true, parts: [] }

  let json: {
    choices?: [{ delta?: { content?: string; reasoning?: string } }]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    // Some Groq responses nest usage under x_groq instead of top-level `usage` — check both.
    x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } }
  }
  try {
    json = JSON.parse(payload)
  } catch {
    return { done: false, parts: [] } // ponytail: malformed chunk skipped, not fatal
  }

  const parts: ChatStreamPart[] = []
  const delta = json.choices?.[0]?.delta
  if (delta?.content) parts.push({ type: 'answer', delta: delta.content })
  if (delta?.reasoning) parts.push({ type: 'reasoning', delta: delta.reasoning })
  const usage = json.usage ?? json.x_groq?.usage
  if (usage?.prompt_tokens !== undefined && usage?.completion_tokens !== undefined) {
    parts.push({
      type: 'usage',
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens
    })
  }
  return { done: false, parts }
}

class GroqProvider implements LLMProvider {
  readonly id = 'groq' as const
  readonly supportsReasoningTrace = true

  async listModels(opts?: { forceRefresh?: boolean }): Promise<ModelInfo[]> {
    return getCachedModels(opts?.forceRefresh)
  }

  isFree(modelId: string): boolean {
    // Static denylist, not a cache lookup — must hold even before listModels() has ever
    // run (Groq's /models needs an API key, unlike OpenRouter's public listing).
    return !ENTERPRISE_ONLY_MODELS.has(modelId)
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const apiKey = getApiKey('groq')
    if (!apiKey) throw new Error('Groq API key is not configured')

    // Hard guard before any network call — don't rely on Groq to reject paid usage.
    if (!this.isFree(opts.modelId) && !getAllowPaid('groq')) {
      throw new Error(`Groq model "${opts.modelId}" is paid and paid usage is not enabled`)
    }

    const body: Record<string, unknown> = {
      model: opts.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_format: 'parsed'
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.topP !== undefined) body.top_p = opts.topP
    // Groq's OpenAI-compatible field is `max_completion_tokens`, not `max_tokens`.
    if (opts.maxTokens !== undefined) body.max_completion_tokens = opts.maxTokens

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
      throw new Error(`Groq chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader(), parseEvent)
  }
}

registerProvider(new GroqProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data through the two
// branchy bits (enterprise/free detection, SSE chunk parsing) directly. Plain assert,
// throws on failure, no test framework.
if (require.main === module) {
  void (async () => {
    const fixtureEntries: GroqModelEntry[] = [
      {
        id: 'openai/gpt-oss-120b',
        owned_by: 'OpenAI',
        active: true,
        context_window: 131072
      },
      {
        id: 'llama-3.3-70b-versatile',
        owned_by: 'Meta',
        active: true,
        context_window: 131072
      },
      {
        id: 'llama-3.1-8b-instant',
        owned_by: 'Meta',
        active: false,
        context_window: 131072
      }
    ]
    const activeEntries = fixtureEntries.filter((entry) => entry.active !== false)
    cache = { models: activeEntries.map(toModelInfo), fetchedAt: Date.now() }

    assert.strictEqual(cache.models.length, 2, 'deactivated model must be filtered out of the list')

    const provider = new GroqProvider()
    assert.strictEqual(provider.isFree('openai/gpt-oss-120b'), true, 'standard model must be free')
    assert.strictEqual(
      provider.isFree('llama-3.3-70b-versatile'),
      false,
      'enterprise contact-sales model must not be free'
    )
    assert.strictEqual(
      provider.isFree('llama-3.1-8b-instant'),
      false,
      'enterprise model stays gated even when filtered out of the active model list'
    )
    assert.strictEqual(
      provider.isFree('some/unknown-model'),
      true,
      'unknown model defaults to free — Groq is free-tier-first, unlike OpenRouter'
    )

    const sseText =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n' +
      ': keep-alive, no data line\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      'data: {"choices":[],"x_groq":{"usage":{"prompt_tokens":10,"completion_tokens":2}}}\n\n' +
      'data: [DONE]\n\n' +
      'data: {"choices":[{"delta":{"content":"must never arrive"}}]}\n\n'

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
      { type: 'reasoning', delta: 'thinking...' },
      { type: 'answer', delta: 'lo' },
      { type: 'usage', promptTokens: 10, completionTokens: 2 }
    ])

    console.log('groq provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
