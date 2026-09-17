// Hugging Face's inference offering has moved through several distinct shapes over the
// years (legacy per-model `api-inference.huggingface.co/models/{id}` with an `inputs`/
// `generated_text` body was the original one). As of this writing (2026-09-17) that's
// superseded by "Inference Providers": a single router that proxies to third-party
// backends (Together, Fireworks, Novita, Groq, Cerebras, DeepInfra, ...) and exposes an
// OpenAI-compatible chat-completions endpoint at https://router.huggingface.co/v1 — so,
// same global-fetch + hand-rolled-SSE pattern as openrouter.ts/groq.ts, confirmed against
// https://huggingface.co/docs/inference-providers/index and .../tasks/chat-completion.
//
// Auth: `Authorization: Bearer hf_***` with a fine-grained token granted the
// "Make calls to Inference Providers" permission — same bearer shape as the others.
//
// Model listing: GET https://router.huggingface.co/v1/models is real, live, and (per a
// direct curl during research) doesn't even require a key — confirmed structure is
// `{ data: [{ id, providers: [{ provider, status, context_length?, pricing?: {input,
// output}, is_free? }] }] }`. Not one flat model catalog like OpenRouter's — each base
// model can be served by several providers at different prices, so this adapter treats
// each (model, provider) pair as its own ModelInfo, with modelId encoded as
// "<hf-model-id>:<provider>" — that's not an invented format, it's the router's own
// documented provider-pinning syntax (e.g. "openai/gpt-oss-120b:groq").
//
// Free tier reality (this is the part that's genuinely different from every other
// provider here, so spelling it out rather than guessing): Hugging Face's "free tier" is
// NOT a permanent $0 model tier like OpenRouter's `:free` models. Every account gets a
// small monthly credit ($0.10 for free accounts, per huggingface.co/docs/inference-
// providers/pricing) that's spent on whatever paid inference it runs, plus providers
// occasionally flag a specific (model, provider) pair as free "as a temporary promo" —
// that's exactly what the live listing's `is_free` field means, and what `isFree()`
// below keys off (or zero-priced `pricing`, when a provider reports one). There is no
// reading of this data that means "unlimited free forever" the way OpenRouter's free
// router model does — it means "not currently metered on this specific provider", and it
// can flip at any time, hence the same 30-min cache TTL as the others rather than
// anything longer.
//
// Reasoning trace: the generic API spec doesn't document a reasoning field, but
// provider-proxied responses for reasoning models (DeepSeek-R1 and similar) do carry one
// in practice — DeepSeek's own naming, `delta.reasoning_content` while streaming (and a
// non-streamed `message.reasoning`), per DeepSeek's API docs and corroborated by several
// third-party integration reports against this exact router. Since some backends behind
// this proxy use the OpenRouter/vLLM-style `delta.reasoning` key instead, both are
// checked below — cheap to support both, and untested with a real reasoning-capable
// model/provider combo since there's no live key in this environment. Flagging this as
// the least-certain part of this adapter.

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

const MODELS_URL = 'https://router.huggingface.co/v1/models'
const CHAT_URL = 'https://router.huggingface.co/v1/chat/completions'
const CACHE_TTL_MS = 30 * 60 * 1000

interface HFProviderEntry {
  provider: string
  status: string // 'live' | 'staging' | 'error'
  context_length?: number
  pricing?: { input?: number; output?: number } // USD per million tokens
  is_free?: boolean // "currently free of charge on this provider (temporary promo)"
}

interface HFModelEntry {
  id: string
  providers: HFProviderEntry[]
}

// Module-level cache (not a class field): there's only ever one Hugging Face provider
// instance, and a plain timestamp check is enough — no setInterval/background refresh.
let cache: { models: ModelInfo[]; fetchedAt: number } | undefined

function isFreeProviderEntry(provider: HFProviderEntry): boolean {
  if (provider.is_free === true) return true
  return provider.pricing?.input === 0 && provider.pricing?.output === 0
}

function toModelInfo(model: HFModelEntry, provider: HFProviderEntry): ModelInfo {
  return {
    providerId: 'huggingface',
    modelId: `${model.id}:${provider.provider}`,
    label: `${model.id} (${provider.provider})`,
    isFree: isFreeProviderEntry(provider),
    supportsReasoningTrace: true,
    contextLength: provider.context_length
  }
}

async function fetchModels(): Promise<ModelInfo[]> {
  // No key required for this GET (confirmed live, unauthenticated, during research), but
  // send one when we have it — likely better rate limits, and no reason not to.
  const apiKey = getApiKey('huggingface')
  const res = await fetch(MODELS_URL, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
  })
  if (!res.ok) throw new Error(`Hugging Face model list failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { data: HFModelEntry[] }
  return body.data.flatMap((model) =>
    model.providers
      .filter((provider) => provider.status === 'live')
      .map((provider) => toModelInfo(model, provider))
  )
}

async function getCachedModels(forceRefresh = false): Promise<ModelInfo[]> {
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models
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
    choices?: [{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }]
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
  // DeepSeek-style key is what's documented/observed for this router; `reasoning` is the
  // OpenRouter/vLLM-style fallback some backend providers may use instead. See file header.
  const reasoning = delta?.reasoning_content ?? delta?.reasoning
  if (reasoning) parts.push({ type: 'reasoning', delta: reasoning })
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

class HuggingFaceProvider implements LLMProvider {
  readonly id = 'huggingface' as const
  readonly supportsReasoningTrace = true

  async listModels(opts?: { forceRefresh?: boolean }): Promise<ModelInfo[]> {
    return getCachedModels(opts?.forceRefresh)
  }

  isFree(modelId: string): boolean {
    // Fail closed on an unknown/uncached modelId — HF is pay-as-you-go by default (unlike
    // Groq's free-tier-first model), so "free" must be a positive signal from the live
    // listing, never the default.
    return cache?.models.find((m) => m.modelId === modelId)?.isFree ?? false
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const apiKey = getApiKey('huggingface')
    if (!apiKey) throw new Error('Hugging Face API key is not configured')

    // Hard guard before any network call — don't rely on Hugging Face to reject paid usage.
    if (!this.isFree(opts.modelId) && !getAllowPaid('huggingface')) {
      throw new Error(`Hugging Face model "${opts.modelId}" is paid and paid usage is not enabled`)
    }

    const body: Record<string, unknown> = { model: opts.modelId, messages, stream: true }
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.topP !== undefined) body.top_p = opts.topP
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
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
      throw new Error(`Hugging Face chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader())
  }
}

registerProvider(new HuggingFaceProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data — shaped exactly
// like a real (unauthenticated, verified during research) GET /v1/models response —
// through the two branchy bits (free/paid detection across (model, provider) pairs, SSE
// chunk parsing incl. the DeepSeek-style reasoning key). Plain assert, throws on
// failure, no test framework.
if (require.main === module) {
  void (async () => {
    const fixtureEntries: HFModelEntry[] = [
      {
        id: 'deepseek-ai/DeepSeek-R1',
        providers: [
          { provider: 'novita', status: 'live', context_length: 65536, is_free: true },
          {
            provider: 'together',
            status: 'live',
            context_length: 65536,
            pricing: { input: 3, output: 7 }
          },
          {
            provider: 'featherless-ai',
            status: 'staging', // not yet callable — must be filtered out
            pricing: { input: 0, output: 0 }
          }
        ]
      },
      {
        id: 'google/gemma-2-2b-it',
        providers: [
          {
            provider: 'hf-inference',
            status: 'live',
            context_length: 8192,
            pricing: { input: 0, output: 0 }
          }
        ]
      }
    ]
    cache = {
      models: fixtureEntries.flatMap((model) =>
        model.providers
          .filter((provider) => provider.status === 'live')
          .map((provider) => toModelInfo(model, provider))
      ),
      fetchedAt: Date.now()
    }

    assert.strictEqual(cache.models.length, 3, 'staging (not-yet-live) provider must be filtered out')

    const provider = new HuggingFaceProvider()
    assert.strictEqual(
      provider.isFree('deepseek-ai/DeepSeek-R1:novita'),
      true,
      'provider-flagged is_free:true must resolve free'
    )
    assert.strictEqual(
      provider.isFree('deepseek-ai/DeepSeek-R1:together'),
      false,
      'priced provider must not be free'
    )
    assert.strictEqual(
      provider.isFree('google/gemma-2-2b-it:hf-inference'),
      true,
      'zero-priced provider must resolve free even without an explicit is_free flag'
    )
    assert.strictEqual(
      provider.isFree('deepseek-ai/DeepSeek-R1:featherless-ai'),
      false,
      'filtered-out staging entry must not be resolvable as free (fails closed, not cached)'
    )
    assert.strictEqual(
      provider.isFree('unknown/model:unknown-provider'),
      false,
      'unknown model:provider pair defaults to paid (fail closed)'
    )

    const sseText =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n' +
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

    console.log('huggingface provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
