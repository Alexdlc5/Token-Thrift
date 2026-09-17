// OpenRouter's REST API is OpenAI-compatible chat completions plus SSE streaming, so this
// adapter is global fetch + a hand-rolled SSE reader — no SDK dependency needed for a shape
// this simple.

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

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const CACHE_TTL_MS = 30 * 60 * 1000

// Pinned regardless of what the live listing returns, so there's always a default free
// router even if OpenRouter's catalog changes shape or the fetch fails after a stale cache.
const FREE_ROUTER_MODEL: ModelInfo = {
  providerId: 'openrouter',
  modelId: 'openrouter/free',
  label: 'Auto (free)',
  isFree: true,
  supportsReasoningTrace: true
}

interface OpenRouterModelEntry {
  id: string
  name?: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
}

// Module-level cache (not a class field): there's only ever one OpenRouter provider
// instance, and a plain timestamp check is enough — no setInterval/background refresh.
let cache: { models: ModelInfo[]; fetchedAt: number } | undefined

function toModelInfo(entry: OpenRouterModelEntry): ModelInfo {
  return {
    providerId: 'openrouter',
    modelId: entry.id,
    label: entry.name ?? entry.id,
    isFree: entry.pricing?.prompt === '0' && entry.pricing?.completion === '0',
    supportsReasoningTrace: true,
    contextLength: entry.context_length
  }
}

async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch(MODELS_URL)
  if (!res.ok) throw new Error(`OpenRouter model list failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { data: OpenRouterModelEntry[] }
  return [FREE_ROUTER_MODEL, ...body.data.map(toModelInfo)]
}

async function getCachedModels(): Promise<ModelInfo[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models
  const models = await fetchModels()
  cache = { models, fetchedAt: Date.now() }
  return models
}

// Minimal shape of the reader we need, so the SSE parser can be fed either a real
// `response.body.getReader()` or a fixture reader in the self-check below.
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
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

async function* parseSseStream(reader: ByteReader): AsyncGenerator<ChatStreamPart> {
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const { done: isDone, parts } = parseEvent(block)
      for (const part of parts) yield part
      if (isDone) return
    }
  }
}

class OpenRouterProvider implements LLMProvider {
  readonly id = 'openrouter' as const
  readonly supportsReasoningTrace = true

  async listModels(): Promise<ModelInfo[]> {
    return getCachedModels()
  }

  isFree(modelId: string): boolean {
    if (modelId === FREE_ROUTER_MODEL.modelId) return true
    return cache?.models.find((m) => m.modelId === modelId)?.isFree ?? false
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const apiKey = getApiKey('openrouter')
    if (!apiKey) throw new Error('OpenRouter API key is not configured')

    // Hard guard before any network call — don't rely on OpenRouter to reject paid usage.
    if (!this.isFree(opts.modelId) && !getAllowPaid('openrouter')) {
      throw new Error(`OpenRouter model "${opts.modelId}" is paid and paid usage is not enabled`)
    }

    const body: Record<string, unknown> = { model: opts.modelId, messages, stream: true }
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.topP !== undefined) body.top_p = opts.topP
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens

    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/token-thrift',
        'X-Title': 'Token Thrift'
      },
      body: JSON.stringify(body),
      signal: opts.signal
    })

    if (!res.ok || !res.body) {
      throw new Error(`OpenRouter chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader())
  }
}

registerProvider(new OpenRouterProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data through the two
// branchy bits (free/paid detection, SSE chunk parsing) directly. Plain assert, throws
// on failure, no test framework.
if (require.main === module) {
  void (async () => {
    const fixtureEntries: OpenRouterModelEntry[] = [
      {
        id: 'meta-llama/llama-3-8b-instruct:free',
        name: 'Llama 3 8B (free)',
        pricing: { prompt: '0', completion: '0' },
        context_length: 8192
      },
      {
        id: 'openai/gpt-4o',
        name: 'GPT-4o',
        pricing: { prompt: '0.000005', completion: '0.000015' },
        context_length: 128000
      }
    ]
    cache = { models: [FREE_ROUTER_MODEL, ...fixtureEntries.map(toModelInfo)], fetchedAt: Date.now() }

    const provider = new OpenRouterProvider()
    assert.strictEqual(provider.isFree('openrouter/free'), true, 'pinned free router must be free')
    assert.strictEqual(
      provider.isFree('meta-llama/llama-3-8b-instruct:free'),
      true,
      'zero-priced model must be free'
    )
    assert.strictEqual(provider.isFree('openai/gpt-4o'), false, 'priced model must not be free')
    assert.strictEqual(
      provider.isFree('unknown/model'),
      false,
      'unknown model defaults to paid (fail closed)'
    )

    const sseText =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n' +
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
    for await (const part of parseSseStream(fakeReader)) parts.push(part)

    assert.deepStrictEqual(parts, [
      { type: 'answer', delta: 'Hel' },
      { type: 'reasoning', delta: 'thinking...' },
      { type: 'answer', delta: 'lo' },
      { type: 'usage', promptTokens: 10, completionTokens: 2 }
    ])

    console.log('openrouter provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
