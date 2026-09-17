// NVIDIA NIM's hosted "build.nvidia.com" API-key access (integrate.api.nvidia.com) is a
// free-tier, rate-limited (~40 RPM by default) surface over 100+ hosted models — distinct
// from NVIDIA's paid product of self-hosting a NIM container on your own GPUs, which this
// app doesn't touch. Confirmed OpenAI-compatible: /v1/chat/completions and /v1/models mirror
// OpenAI's shapes, so this follows the openrouter.ts pattern almost verbatim — global fetch,
// hand-rolled SSE parsing, no SDK. One real difference from OpenRouter: NVIDIA's /v1/models
// requires the same API key as chat (there's no public/unauthenticated catalog), and it
// returns bare {id, object, created, owned_by} entries with no display name, pricing, or
// context-length metadata — so listModels() needs a configured key, and ModelInfo.label
// just falls back to the id. Some hosted models (e.g. DeepSeek-R1-class reasoning models)
// stream a separate `reasoning_content` delta field alongside `content`, which is what
// supportsReasoningTrace / the reasoning ChatStreamPart below map to.

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

const BASE_URL = 'https://integrate.api.nvidia.com/v1'
const MODELS_URL = `${BASE_URL}/models`
const CHAT_URL = `${BASE_URL}/chat/completions`
const CACHE_TTL_MS = 30 * 60 * 1000

interface NvidiaModelEntry {
  id: string
  object?: string
  created?: number
  owned_by?: string
}

// Module-level cache (not a class field): there's only ever one NVIDIA NIM provider
// instance, and a plain timestamp check is enough — no setInterval/background refresh.
let cache: { models: ModelInfo[]; fetchedAt: number } | undefined

// No context-length field anywhere in NIM's listing response, and 100+ hosted models makes
// a hand-maintained per-model table impractical (it'd be stale the day it's written). Two
// fallbacks instead, both approximate:
// 1. Many model ids literally encode it (e.g. "phi-3-medium-128k-instruct") - parse that
//    first since it's the most specific signal available.
// 2. Otherwise pattern-match a handful of well-known families by their published base
//    context length, falling back to a generic default for anything unrecognized.
const FAMILY_CONTEXT_LENGTH: [RegExp, number][] = [
  [/llama-?3\.[123]/i, 128000],
  [/deepseek-?r1/i, 128000],
  [/nemotron/i, 128000], // NVIDIA's own tune, built on Llama 3.1
  [/mixtral/i, 32768],
  [/gemma-?2/i, 8192],
  [/qwen-?2\.5/i, 32768]
]
const DEFAULT_CONTEXT_LENGTH = 32768

function approximateContextLength(modelId: string): number {
  const explicit = modelId.match(/(\d+)k(?:-|$)/i)
  if (explicit) return Number(explicit[1]) * 1000
  return FAMILY_CONTEXT_LENGTH.find(([pattern]) => pattern.test(modelId))?.[1] ?? DEFAULT_CONTEXT_LENGTH
}

function toModelInfo(entry: NvidiaModelEntry): ModelInfo {
  return {
    providerId: 'nvidia-nim',
    modelId: entry.id,
    // No display name in NIM's listing response — id (e.g. "deepseek-ai/deepseek-r1") is
    // all there is.
    label: entry.id,
    // Whole hosted API-key surface is free-tier by design; see file header.
    isFree: true,
    supportsReasoningTrace: true,
    contextLength: approximateContextLength(entry.id),
    contextLengthApprox: true
  }
}

async function fetchModels(): Promise<ModelInfo[]> {
  const apiKey = getApiKey('nvidia-nim')
  if (!apiKey) throw new Error('NVIDIA NIM API key is not configured')

  const res = await fetch(MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`NVIDIA NIM model list failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { data: NvidiaModelEntry[] }
  return body.data.map(toModelInfo)
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
    choices?: [{ delta?: { content?: string; reasoning_content?: string } }]
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
  if (delta?.reasoning_content) parts.push({ type: 'reasoning', delta: delta.reasoning_content })
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

class NvidiaNimProvider implements LLMProvider {
  readonly id = 'nvidia-nim' as const
  readonly supportsReasoningTrace = true

  async listModels(opts?: { forceRefresh?: boolean }): Promise<ModelInfo[]> {
    return getCachedModels(opts?.forceRefresh)
  }

  isFree(_modelId: string): boolean {
    // Entire hosted API-key surface is free-tier (rate-limited, not billed) — see file
    // header. Paid NIM is a separate self-hosting product this app doesn't talk to.
    return true
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const apiKey = getApiKey('nvidia-nim')
    if (!apiKey) throw new Error('NVIDIA NIM API key is not configured')

    // Hard guard before any network call, matching every other provider's contract. Always
    // false today since isFree() is unconditional, but kept as a safety net if that ever
    // changes (e.g. NVIDIA splits the API surface later).
    if (!this.isFree(opts.modelId) && !getAllowPaid('nvidia-nim')) {
      throw new Error(`NVIDIA NIM model "${opts.modelId}" is paid and paid usage is not enabled`)
    }

    const body: Record<string, unknown> = {
      model: opts.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    }
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
      throw new Error(`NVIDIA NIM chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader())
  }
}

registerProvider(new NvidiaNimProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data through the two
// branchy bits (model-list mapping, SSE chunk parsing) directly. Plain assert, throws
// on failure, no test framework.
if (require.main === module) {
  void (async () => {
    const fixtureEntries: NvidiaModelEntry[] = [
      { id: 'deepseek-ai/deepseek-r1', object: 'model', owned_by: 'deepseek-ai' },
      { id: 'meta/llama-3.1-8b-instruct', object: 'model', owned_by: 'meta' },
      { id: 'microsoft/phi-3-medium-128k-instruct', object: 'model', owned_by: 'microsoft' },
      { id: 'some-vendor/brand-new-model', object: 'model', owned_by: 'some-vendor' }
    ]
    const models = fixtureEntries.map(toModelInfo)
    assert.deepStrictEqual(models, [
      {
        providerId: 'nvidia-nim',
        modelId: 'deepseek-ai/deepseek-r1',
        label: 'deepseek-ai/deepseek-r1',
        isFree: true,
        supportsReasoningTrace: true,
        contextLength: 128000,
        contextLengthApprox: true
      },
      {
        providerId: 'nvidia-nim',
        modelId: 'meta/llama-3.1-8b-instruct',
        label: 'meta/llama-3.1-8b-instruct',
        isFree: true,
        supportsReasoningTrace: true,
        contextLength: 128000,
        contextLengthApprox: true
      },
      {
        providerId: 'nvidia-nim',
        modelId: 'microsoft/phi-3-medium-128k-instruct',
        label: 'microsoft/phi-3-medium-128k-instruct',
        isFree: true,
        supportsReasoningTrace: true,
        contextLength: 128000, // parsed from the "128k" in the id itself, not a family guess
        contextLengthApprox: true
      },
      {
        providerId: 'nvidia-nim',
        modelId: 'some-vendor/brand-new-model',
        label: 'some-vendor/brand-new-model',
        isFree: true,
        supportsReasoningTrace: true,
        contextLength: DEFAULT_CONTEXT_LENGTH,
        contextLengthApprox: true
      }
    ])

    const provider = new NvidiaNimProvider()
    assert.strictEqual(provider.isFree('deepseek-ai/deepseek-r1'), true, 'whole surface is free')
    assert.strictEqual(provider.isFree('unknown/model'), true, 'whole surface is free')

    const sseText =
      'data: {"choices":[{"delta":{"reasoning_content":"Let me think..."}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      ': keep-alive, no data line\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
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
    for await (const part of parseSseStream(fakeReader)) parts.push(part)

    assert.deepStrictEqual(parts, [
      { type: 'reasoning', delta: 'Let me think...' },
      { type: 'answer', delta: 'Hel' },
      { type: 'answer', delta: 'lo' },
      { type: 'usage', promptTokens: 10, completionTokens: 2 }
    ])

    console.log('nvidia-nim provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
