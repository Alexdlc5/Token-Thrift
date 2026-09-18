// Cloudflare Workers AI, via its OpenAI-compatible chat-completions endpoint:
//   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions
// (the older per-model `/ai/run/@cf/{model}` invocation style still exists but this is the
// current, recommended shape for a chat-completions use case — same SSE delta format as
// OpenRouter/OpenAI, so this adapter is global fetch + the same hand-rolled SSE reader
// pattern, no SDK dependency).
//
// AUTH — two values packed into one stored string ***********************************
// Workers AI needs BOTH a Cloudflare account ID (it's part of the URL path, not a header)
// and an API token (the Bearer credential). This app's key store only holds one string per
// saved key, so both are packed into that single field as `accountId:apiToken`, split on
// the FIRST colon here (account IDs are 32-char hex and API tokens don't contain colons, so
// this is unambiguous). Whoever pastes a key into Settings for this provider must paste
// `<account_id>:<api_token>` — not just the token alone.
//
// MODEL LISTING ***********************************************************************
// Workers AI does have a real model-search REST endpoint
// (`GET /accounts/{account_id}/ai/models/search?task=Text Generation`), but its response
// schema isn't consistently documented (nested task/property objects, uncertain field
// names) and it needs an extra "Workers AI Read" token scope beyond a bare API token — too
// shaky to parse live without a fixture to verify against. Per the reference pattern's own
// precedent (OpenRouter pins its free-router entry rather than trusting the live list for
// it), this adapter ships a curated list of known-good current text-generation models
// instead. ponytail: curated list, not a live call — revisit if Cloudflare ships a
// consistently-documented models endpoint worth parsing.
//
// FREE TIER ***************************************************************************
// The whole account gets 10,000 Neurons/day free (Neurons = Cloudflare's unified compute
// unit across models; the daily allotment resets 00:00 UTC and applies on both the Free and
// Paid Workers plans). Almost every text-generation model is reachable within that free
// allotment — but Cloudflare does carve out a handful of newer/larger models that require a
// paid billing method regardless of the daily allotment (Kimi K2.6/K2.7-Code, GLM-5.2/5.3,
// DeepSeek V4 Flash/Pro, as of this writing). So `isFree()` is a genuine per-model split,
// not "everything here is free" — resolved from CURATED_MODELS below, the same list
// listModels() returns (never a second hardcoded ID set).

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

const CACHE_TTL_MS = 30 * 60 * 1000

// Curated text-generation catalog — needs periodic manual review against
// https://developers.cloudflare.com/workers-ai/models/ (context lengths verified against
// Cloudflare's own model pages and cross-checked with models.dev as of 2026-09).
const CURATED_MODELS: Array<{ modelId: string; label: string; contextLength: number; isFree: boolean }> = [
  { modelId: '@cf/meta/llama-3.1-8b-instruct-fp8', label: 'Llama 3.1 8B Instruct', contextLength: 32000, isFree: true },
  { modelId: '@cf/meta/llama-3.2-1b-instruct', label: 'Llama 3.2 1B Instruct', contextLength: 60000, isFree: true },
  { modelId: '@cf/meta/llama-3.2-3b-instruct', label: 'Llama 3.2 3B Instruct', contextLength: 80000, isFree: true },
  { modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B Instruct (fast)', contextLength: 24000, isFree: true },
  { modelId: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B', contextLength: 131000, isFree: true },
  { modelId: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5 Coder 32B', contextLength: 32768, isFree: true },
  { modelId: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3 30B A3B', contextLength: 32768, isFree: true },
  { modelId: '@cf/qwen/qwq-32b', label: 'QwQ 32B (reasoning)', contextLength: 24000, isFree: true },
  { modelId: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1 Distill Qwen 32B', contextLength: 80000, isFree: true },
  { modelId: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B', contextLength: 256000, isFree: true },
  { modelId: '@cf/openai/gpt-oss-120b', label: 'GPT-OSS 120B', contextLength: 128000, isFree: true },
  { modelId: '@cf/openai/gpt-oss-20b', label: 'GPT-OSS 20B', contextLength: 128000, isFree: true },
  { modelId: '@cf/nvidia/nemotron-3-120b-a12b', label: 'Nemotron 3 120B', contextLength: 256000, isFree: true },
  // Requires a paid billing method regardless of the free Neuron allotment.
  { modelId: '@cf/moonshotai/kimi-k2.6', label: 'Kimi K2.6', contextLength: 262144, isFree: false },
  { modelId: '@cf/moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code', contextLength: 262144, isFree: false },
  { modelId: '@cf/zai-org/glm-5.2', label: 'GLM-5.2', contextLength: 262144, isFree: false },
  { modelId: '@cf/zai-org/glm-5.3', label: 'GLM-5.3', contextLength: 1310720, isFree: false },
  { modelId: '@cf/deepseek-ai/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash', contextLength: 1310720, isFree: false },
  { modelId: '@cf/deepseek-ai/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro', contextLength: 1048576, isFree: false }
]

function toModelInfo(entry: (typeof CURATED_MODELS)[number]): ModelInfo {
  return {
    providerId: 'cloudflare-workers-ai',
    modelId: entry.modelId,
    label: entry.label,
    isFree: entry.isFree,
    // The OpenAI-compat endpoint doesn't document a separate reasoning delta field the way
    // OpenRouter does (even for reasoning-capable models like QwQ/R1-distill) — unconfirmed
    // support defaults to false rather than surfacing a field that may never arrive.
    supportsReasoningTrace: false,
    contextLength: entry.contextLength,
    contextLengthApprox: true
  }
}

let cache: { models: ModelInfo[]; fetchedAt: number } | undefined

async function getCachedModels(forceRefresh = false): Promise<ModelInfo[]> {
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models
  const models = CURATED_MODELS.map(toModelInfo)
  cache = { models, fetchedAt: Date.now() }
  return models
}

/** Splits the stored `accountId:apiToken` key into its two parts. Throws on missing/malformed input. */
export function parseStoredKey(stored: string | null): { accountId: string; apiToken: string } {
  if (!stored) throw new Error('Cloudflare Workers AI API key is not configured')
  const sepIndex = stored.indexOf(':')
  if (sepIndex <= 0 || sepIndex === stored.length - 1) {
    throw new Error(
      'Cloudflare Workers AI key must be saved as "<account_id>:<api_token>" (both the account ID and an API token, separated by a colon)'
    )
  }
  return { accountId: stored.slice(0, sepIndex), apiToken: stored.slice(sepIndex + 1) }
}

function chatUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`
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

class CloudflareWorkersAiProvider implements LLMProvider {
  readonly id = 'cloudflare-workers-ai' as const
  readonly supportsReasoningTrace = false

  async listModels(opts?: { forceRefresh?: boolean }): Promise<ModelInfo[]> {
    return getCachedModels(opts?.forceRefresh)
  }

  isFree(modelId: string): boolean {
    return CURATED_MODELS.find((m) => m.modelId === modelId)?.isFree ?? false
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const { accountId, apiToken } = parseStoredKey(getApiKey('cloudflare-workers-ai'))

    // Hard guard before any network call — don't rely on Cloudflare to reject paid usage.
    if (!this.isFree(opts.modelId) && !getAllowPaid('cloudflare-workers-ai')) {
      throw new Error(`Cloudflare Workers AI model "${opts.modelId}" is paid and paid usage is not enabled`)
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

    const res = await fetch(chatUrl(accountId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: opts.signal
    })

    if (!res.ok || !res.body) {
      throw new Error(`Cloudflare Workers AI chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader())
  }
}

registerProvider(new CloudflareWorkersAiProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data through the branchy
// bits (accountId:apiToken splitting, free/paid resolution, SSE chunk parsing) directly.
// Plain assert, throws on failure, no test framework.
if (require.main === module) {
  void (async () => {
    // accountId:apiToken splitting
    const parsed = parseStoredKey('0123456789abcdef0123456789abcdef:my-api-token')
    assert.strictEqual(parsed.accountId, '0123456789abcdef0123456789abcdef', 'account id is the part before the first colon')
    assert.strictEqual(parsed.apiToken, 'my-api-token', 'api token is everything after the first colon')

    // API tokens can themselves contain colon-free but multi-segment-looking strings; only
    // the FIRST colon is the separator.
    const parsedWithExtra = parseStoredKey('acct123:token-with-a:colon-in-it')
    assert.strictEqual(parsedWithExtra.accountId, 'acct123')
    assert.strictEqual(parsedWithExtra.apiToken, 'token-with-a:colon-in-it', 'only the first colon splits')

    assert.throws(() => parseStoredKey(null), /not configured/, 'missing key throws')
    assert.throws(() => parseStoredKey('no-colon-here'), /account_id.*api_token/, 'malformed key (no colon) throws')
    assert.throws(() => parseStoredKey(':missing-account-id'), /account_id.*api_token/, 'empty account id throws')
    assert.throws(() => parseStoredKey('missing-token:'), /account_id.*api_token/, 'empty api token throws')

    // free/paid resolution, sourced from the single curated list (no second hardcoded set)
    const provider = new CloudflareWorkersAiProvider()
    assert.strictEqual(provider.isFree('@cf/meta/llama-3.1-8b-instruct-fp8'), true, 'known free model')
    assert.strictEqual(provider.isFree('@cf/moonshotai/kimi-k2.6'), false, 'known paid-only model')
    assert.strictEqual(provider.isFree('@cf/unknown/model'), false, 'unknown model defaults to paid (fail closed)')

    const models = await provider.listModels()
    assert.ok(models.length === CURATED_MODELS.length, 'listModels returns the full curated catalog')
    assert.ok(
      models.every((m) => m.providerId === 'cloudflare-workers-ai' && m.supportsReasoningTrace === false),
      'every curated model is tagged for this provider with reasoning trace off'
    )

    // SSE chunk parsing (OpenAI-compatible delta shape, plus a trailing usage-only chunk
    // from stream_options.include_usage)
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

    console.log('cloudflare-workers-ai provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
