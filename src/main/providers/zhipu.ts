// Z.ai (Zhipu AI)'s GLM models, via their OpenAI-compatible chat-completions endpoint
// (confirmed against docs.z.ai/api-reference/llm/chat-completion as of 2026-09-17: base URL
// https://api.z.ai/api/paas/v4/chat/completions, Bearer auth, standard `choices`/`usage`/
// `finish_reason` response shape, `data: [DONE]` SSE sentinel) — same fetch + hand-rolled SSE
// reader pattern as every other OpenAI-compatible adapter here, no SDK dependency.
//
// FREE TIER ***************************************************************************
// Z.ai's own pricing page (docs.z.ai/guides/overview/pricing) lists GLM-4.5-Flash and
// GLM-4.7-Flash as "Free" across every pricing column (input/cached-input/output) — every
// other model on that page carries a real per-token price. So, unlike Cerebras/Mistral/NVIDIA
// NIM where free-vs-paid is an account/plan-level split, Z.ai's split is genuinely per-model
// on one shared API surface: isFree() below is resolved from a curated allow-list rather than
// being unconditionally true.
//
// MODEL LISTING ***********************************************************************
// No models-listing endpoint was found documented — ships a curated list of the two
// confirmed-free Flash models instead, same reasoning as cloudflare-workers-ai.ts's
// CURATED_MODELS. Context length (128K) is from docs.z.ai's GLM-4.5 model page, not a live
// per-request value, so it's flagged approximate.
//
// REASONING ***************************************************************************
// No documented separate reasoning-delta field for the OpenAI-compat endpoint (same gap as
// cloudflare-workers-ai.ts) — defaults to false rather than assuming a shape that was never
// confirmed.

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

const CHAT_URL = 'https://api.z.ai/api/paas/v4/chat/completions'

const CURATED_MODELS: Array<{ modelId: string; label: string; contextLength: number }> = [
  { modelId: 'glm-4.5-flash', label: 'GLM-4.5 Flash', contextLength: 128000 },
  { modelId: 'glm-4.7-flash', label: 'GLM-4.7 Flash', contextLength: 128000 }
]

function toModelInfo(entry: (typeof CURATED_MODELS)[number]): ModelInfo {
  return {
    providerId: 'zhipu',
    modelId: entry.modelId,
    label: entry.label,
    isFree: true,
    supportsReasoningTrace: false,
    contextLength: entry.contextLength,
    contextLengthApprox: true
  }
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
    choices?: [{ delta?: { content?: string } }]
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

class ZhipuProvider implements LLMProvider {
  readonly id = 'zhipu' as const
  readonly supportsReasoningTrace = false

  async listModels(): Promise<ModelInfo[]> {
    return CURATED_MODELS.map(toModelInfo)
  }

  isFree(modelId: string): boolean {
    return CURATED_MODELS.some((m) => m.modelId === modelId)
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const apiKey = getApiKey('zhipu')
    if (!apiKey) throw new Error('Z.ai (Zhipu) API key is not configured')

    // Hard guard before any network call — don't rely on Z.ai to reject paid usage.
    if (!this.isFree(opts.modelId) && !getAllowPaid('zhipu')) {
      throw new Error(`Z.ai model "${opts.modelId}" is paid and paid usage is not enabled`)
    }

    const body: Record<string, unknown> = { model: opts.modelId, messages, stream: true }
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.topP !== undefined) body.top_p = opts.topP
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
      throw new Error(`Z.ai chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader())
  }
}

registerProvider(new ZhipuProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data through the branchy
// bits (curated-list free resolution, SSE chunk parsing) directly. Plain assert, throws on
// failure, no test framework.
if (require.main === module) {
  void (async () => {
    const provider = new ZhipuProvider()
    assert.strictEqual(provider.isFree('glm-4.5-flash'), true, 'known free flash model')
    assert.strictEqual(provider.isFree('glm-4.7-flash'), true, 'known free flash model')
    assert.strictEqual(provider.isFree('glm-5.3'), false, 'unlisted/paid model defaults to paid (fail closed)')

    const models = await provider.listModels()
    assert.strictEqual(models.length, CURATED_MODELS.length)
    assert.ok(
      models.every((m) => m.providerId === 'zhipu' && m.isFree === true),
      'every curated model is tagged for this provider and marked free'
    )

    const sseText =
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
      { type: 'answer', delta: 'Hel' },
      { type: 'answer', delta: 'lo' },
      { type: 'usage', promptTokens: 10, completionTokens: 2 }
    ])

    console.log('zhipu provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
