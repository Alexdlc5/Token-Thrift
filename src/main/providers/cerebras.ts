// Cerebras Inference's REST API is OpenAI-compatible chat completions plus SSE streaming
// (confirmed against https://inference-docs.cerebras.ai), so — like openrouter.ts — this is
// global fetch + a hand-rolled SSE reader, no SDK dependency.
//
// Cerebras has no paid/free model split on the public API: signing up gives a single
// rate-limited "Free" tier (RPM/TPM/daily-token caps) that the entire public Model Catalog
// is served from ("every model on the public Model Catalog is available on the Free Trial
// tier" per Cerebras's own rate-limits docs). Paid (Developer/Enterprise) tiers only raise
// the rate limits and add Dedicated Endpoints for extra model families we never call here —
// so isFree() is unconditionally true rather than resolved from pricing data that doesn't
// exist for this provider.

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

const MODELS_URL = 'https://api.cerebras.ai/v1/models'
const CHAT_URL = 'https://api.cerebras.ai/v1/chat/completions'
const CACHE_TTL_MS = 30 * 60 * 1000

interface CerebrasModelEntry {
  id: string
  object?: string
  created?: number
  owned_by?: string
}

// /v1/models reports no context-length field at all, and Cerebras caps the free tier's
// context below the model's own native max (a hardware/inference-architecture limit, not
// something derivable from the model card) — confirmed against
// inference-docs.cerebras.ai/models/overview (as of 2026-09-17): gpt-oss-120b is 65k on
// Free vs 131k on paid, qwen-3.8-27b is 64k on Free vs 128k on paid. Static lookup, so
// flagged approximate; falls back to the more conservative of the two if Cerebras adds a
// model this table doesn't know about yet.
const FREE_TIER_CONTEXT_LENGTH: Record<string, number> = {
  'gpt-oss-120b': 65536,
  'qwen-3.8-27b': 64000
}
const DEFAULT_FREE_TIER_CONTEXT_LENGTH = 64000

// Module-level cache (not a class field): there's only ever one Cerebras provider instance.
let cache: { models: ModelInfo[]; fetchedAt: number } | undefined

function toModelInfo(entry: CerebrasModelEntry): ModelInfo {
  return {
    providerId: 'cerebras',
    modelId: entry.id,
    label: entry.id,
    isFree: true,
    // ponytail: the /v1/models response carries no per-model reasoning flag. The two
    // current free-tier models (gpt-oss-120b, qwen-3.8-27b) both stream a reasoning trace
    // by default, so true is accurate today; a future non-reasoning model just never sends
    // a delta.reasoning chunk and this flag becomes a harmless no-op for it (same
    // simplification openrouter.ts makes).
    supportsReasoningTrace: true,
    contextLength: FREE_TIER_CONTEXT_LENGTH[entry.id] ?? DEFAULT_FREE_TIER_CONTEXT_LENGTH,
    contextLengthApprox: true
  }
}

async function fetchModels(): Promise<ModelInfo[]> {
  const apiKey = getApiKey('cerebras')
  if (!apiKey) throw new Error('Cerebras API key is not configured')

  const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`Cerebras model list failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { data: CerebrasModelEntry[] }
  return body.data.map(toModelInfo)
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
  const usage = json.usage
  if (usage?.prompt_tokens !== undefined && usage?.completion_tokens !== undefined) {
    parts.push({
      type: 'usage',
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens
    })
  }
  return { done: false, parts }
}

class CerebrasProvider implements LLMProvider {
  readonly id = 'cerebras' as const
  readonly supportsReasoningTrace = true

  async listModels(opts?: { forceRefresh?: boolean }): Promise<ModelInfo[]> {
    return getCachedModels(opts?.forceRefresh)
  }

  isFree(_modelId: string): boolean {
    // No paid/free split on Cerebras's public API — see file header.
    return true
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const apiKey = getApiKey('cerebras')
    if (!apiKey) throw new Error('Cerebras API key is not configured')

    const body: Record<string, unknown> = { model: opts.modelId, messages, stream: true }
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.topP !== undefined) body.top_p = opts.topP
    if (opts.maxTokens !== undefined) body.max_completion_tokens = opts.maxTokens
    if (opts.reasoningEffort !== undefined) body.reasoning_effort = opts.reasoningEffort

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
      throw new Error(`Cerebras chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader(), parseEvent)
  }
}

registerProvider(new CerebrasProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data through the one
// branchy bit (SSE chunk parsing, including the reasoning-delta channel) directly, plus
// the always-free resolution. Plain assert, throws on failure, no test framework.
if (require.main === module) {
  void (async () => {
    const provider = new CerebrasProvider()
    assert.strictEqual(provider.isFree('gpt-oss-120b'), true, 'cerebras has no paid models')
    assert.strictEqual(provider.isFree('anything-unknown'), true, 'cerebras has no paid models')

    assert.strictEqual(toModelInfo({ id: 'gpt-oss-120b' }).contextLength, 65536, 'known free-tier context cap')
    assert.strictEqual(toModelInfo({ id: 'qwen-3.8-27b' }).contextLength, 64000, 'known free-tier context cap')
    assert.strictEqual(
      toModelInfo({ id: 'some-future-model' }).contextLength,
      DEFAULT_FREE_TIER_CONTEXT_LENGTH,
      'unknown model falls back to the default approximation'
    )
    assert.strictEqual(toModelInfo({ id: 'gpt-oss-120b' }).contextLengthApprox, true)

    const sseText =
      'data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      ': keep-alive, no data line\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n' +
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
      { type: 'reasoning', delta: 'thinking...' },
      { type: 'answer', delta: 'Hel' },
      { type: 'answer', delta: 'lo' },
      { type: 'usage', promptTokens: 10, completionTokens: 2 }
    ])

    console.log('cerebras provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
