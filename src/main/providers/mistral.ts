// Mistral AI's "La Plateforme" REST API is OpenAI-compatible chat completions plus SSE
// streaming (confirmed against https://docs.mistral.ai/api/ and the models/chat endpoint
// reference pages), so — like openrouter.ts — this is global fetch + a hand-rolled SSE
// reader, no SDK dependency.
//
// Free tier mechanics (confirmed against docs.mistral.ai as of 2026-09-17, not just the
// third-party blog aggregation the ~1B-tokens/month figure originally came from):
// - Mistral's own current docs no longer use the "Experiment" plan name anywhere — they call
//   the no-credit-card tier "Free mode" ("API access is enabled by default with no credit
//   card required", docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key).
//   "Experiment" still shows up in third-party posts and may be legacy/console-UI wording,
//   but isn't the name Mistral's docs use today.
// - The ~1B-tokens/month figure could NOT be confirmed from Mistral's own docs. Official
//   docs (docs.mistral.ai/admin/user-management-finops/tier and .../subscriptions) only say
//   included monthly usage is plan-specific and shown per-account in the Admin Panel's
//   Limits page — there's no fixed published number for Free mode. Treat "~1B tokens/month"
//   as an unverified third-party estimate, not a documented guarantee.
// - Data-training opt-in/opt-out (help.mistral.ai/en/articles/455207) is an account-level
//   Admin Panel → Privacy → "Anonymous improvement data" toggle, not a per-request API
//   parameter — there is nothing for this adapter to send either way, which is why there's
//   no opt-out toggle here (matches the product decision already made for this app).
// - GET /v1/models requires the same API key as chat (verified live: an unauthenticated
//   request returns 401 {"detail":"Invalid API Key"}) and carries no pricing/tier field per
//   model — same shape gap as nvidia-nim.ts. Nothing in the API distinguishes a free-eligible
//   model from a paid one; the free/paid split lives entirely at the account/plan level
//   (which key you generated), so — same reasoning as cerebras.ts/nvidia-nim.ts — isFree()
//   is unconditionally true rather than resolved from per-model data that doesn't exist.
// - Reasoning: the dedicated "Magistral" models are deprecated in favor of reasoning_effort
//   on mistral-small-latest / mistral-medium-3-5 (docs.mistral.ai/studio/conversations/reasoning).
//   When reasoning is active, message content (and streamed delta.content) becomes a list of
//   typed chunks — {type:"thinking", thinking:[{type:"text", text}]} then {type:"text", text}
//   — instead of a plain string; a model/request with no reasoning just keeps delta.content a
//   plain string. Both shapes are handled below.

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

const BASE_URL = 'https://api.mistral.ai/v1'
const MODELS_URL = `${BASE_URL}/models`
const CHAT_URL = `${BASE_URL}/chat/completions`
const CACHE_TTL_MS = 30 * 60 * 1000

interface MistralModelEntry {
  id: string
  object?: string
  owned_by?: string
  max_context_length?: number
  capabilities?: { completion_chat?: boolean }
}

// Module-level cache (not a class field): there's only ever one Mistral provider instance,
// and a plain timestamp check is enough — no setInterval/background refresh.
let cache: { models: ModelInfo[]; fetchedAt: number } | undefined

function toModelInfo(entry: MistralModelEntry): ModelInfo {
  return {
    providerId: 'mistral',
    modelId: entry.id,
    // No display name in the listing response — id is all there is (same gap as NVIDIA NIM).
    label: entry.id,
    // Whole hosted API-key surface is free-tier by plan, not by model — see file header.
    isFree: true,
    // mistral-small-latest / mistral-medium-3-5 stream a reasoning trace via reasoning_effort;
    // a model that doesn't support it just never emits a thinking chunk (harmless no-op),
    // same simplification cerebras.ts and nvidia-nim.ts make.
    supportsReasoningTrace: true,
    // Real per-model value straight from the live listing, not a guess — no approx flag.
    contextLength: entry.max_context_length
  }
}

async function fetchModels(): Promise<ModelInfo[]> {
  const apiKey = getApiKey('mistral')
  if (!apiKey) throw new Error('Mistral API key is not configured')

  const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`Mistral model list failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { data: MistralModelEntry[] }
  // The catalog mixes chat, embedding, OCR, moderation, and FIM-only models together —
  // filter to what this adapter can actually call.
  return body.data.filter((m) => m.capabilities?.completion_chat).map(toModelInfo)
}

async function getCachedModels(forceRefresh = false): Promise<ModelInfo[]> {
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models
  const models = await fetchModels()
  cache = { models, fetchedAt: Date.now() }
  return models
}

// Reasoning-enabled responses represent content as a list of typed chunks instead of a
// plain string — see file header.
interface MistralContentChunk {
  type: string
  text?: string
  thinking?: { type: string; text?: string }[]
}

/** Handles both the plain-string and typed-chunk-list shapes `delta.content` can take. */
function extractContentParts(content: string | MistralContentChunk[] | undefined): ChatStreamPart[] {
  if (content === undefined) return []
  if (typeof content === 'string') {
    return content ? [{ type: 'answer', delta: content }] : []
  }
  const parts: ChatStreamPart[] = []
  for (const chunk of content) {
    if (chunk.type === 'thinking') {
      const text = (chunk.thinking ?? []).map((t) => t.text ?? '').join('')
      if (text) parts.push({ type: 'reasoning', delta: text })
    } else if (chunk.type === 'text' && chunk.text) {
      parts.push({ type: 'answer', delta: chunk.text })
    }
  }
  return parts
}

/** One `data: {...}` line, parsed into zero or more stream parts, plus the DONE sentinel. */
function parseEvent(eventBlock: string): { done: boolean; parts: ChatStreamPart[] } {
  const dataLine = eventBlock.split('\n').find((line) => line.startsWith('data:'))
  if (!dataLine) return { done: false, parts: [] } // keep-alive comment lines, blank blocks

  const payload = dataLine.slice(5).trim()
  if (payload === '[DONE]') return { done: true, parts: [] }

  let json: {
    choices?: [{ delta?: { content?: string | MistralContentChunk[] } }]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  try {
    json = JSON.parse(payload)
  } catch {
    return { done: false, parts: [] } // ponytail: malformed chunk skipped, not fatal
  }

  const parts = extractContentParts(json.choices?.[0]?.delta?.content)
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

class MistralProvider implements LLMProvider {
  readonly id = 'mistral' as const
  readonly supportsReasoningTrace = true

  async listModels(opts?: { forceRefresh?: boolean }): Promise<ModelInfo[]> {
    return getCachedModels(opts?.forceRefresh)
  }

  isFree(_modelId: string): boolean {
    // No per-model pricing signal on Mistral's API — the free/paid split is account-level
    // (which plan the key belongs to), not model-level. See file header.
    return true
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const apiKey = getApiKey('mistral')
    if (!apiKey) throw new Error('Mistral API key is not configured')

    // Hard guard before any network call, matching every other provider's contract. Always
    // false today since isFree() is unconditional, but kept as a safety net if Mistral ever
    // splits the API surface by model (e.g. a future Premier-only model).
    if (!this.isFree(opts.modelId) && !getAllowPaid('mistral')) {
      throw new Error(`Mistral model "${opts.modelId}" is paid and paid usage is not enabled`)
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
      throw new Error(`Mistral chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader(), parseEvent)
  }
}

registerProvider(new MistralProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data through the branchy
// bits (model-list filtering/mapping, always-free resolution, SSE chunk parsing including
// the thinking/text content-chunk shape) directly. Plain assert, throws on failure, no test
// framework.
if (require.main === module) {
  void (async () => {
    const fixtureEntries: MistralModelEntry[] = [
      {
        id: 'mistral-small-latest',
        max_context_length: 128000,
        capabilities: { completion_chat: true }
      },
      {
        id: 'mistral-embed',
        max_context_length: 8192,
        capabilities: { completion_chat: false }
      }
    ]
    const chatModels = fixtureEntries.filter((m) => m.capabilities?.completion_chat).map(toModelInfo)
    assert.deepStrictEqual(chatModels, [
      {
        providerId: 'mistral',
        modelId: 'mistral-small-latest',
        label: 'mistral-small-latest',
        isFree: true,
        supportsReasoningTrace: true,
        contextLength: 128000
      }
    ])

    const provider = new MistralProvider()
    assert.strictEqual(provider.isFree('mistral-small-latest'), true, 'no per-model pricing split')
    assert.strictEqual(provider.isFree('unknown-model'), true, 'no per-model pricing split')

    const sseText =
      'data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"Let me "}]}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"think..."}]},{"type":"text","text":"Hel"}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      ': keep-alive, no data line\n\n' +
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n' +
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
      { type: 'reasoning', delta: 'Let me ' },
      { type: 'reasoning', delta: 'think...' },
      { type: 'answer', delta: 'Hel' },
      { type: 'answer', delta: 'lo' },
      { type: 'usage', promptTokens: 10, completionTokens: 2 }
    ])

    console.log('mistral provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
