// Google AI Studio (Gemini API) is NOT OpenAI-compatible: requests use `contents`/`parts`
// with role 'user' | 'model' (no 'assistant'), system prompts go in a separate
// `systemInstruction` field, auth is an `x-goog-api-key` header (no Bearer token), and
// streaming is `:streamGenerateContent?alt=sse` returning `GenerateContentResponse` chunks
// (not OpenAI-style `choices[].delta`). Same adapter shape as openrouter.ts otherwise:
// module-level 30-min model cache, hard free/paid guard before any network call, self-register,
// fixture-based self-check.
//
// The API also now offers a newer unified "Interactions API" (generativelanguage.googleapis.com
// /v1beta/interactions) that Google's docs present as the forward path for agentic use cases.
// This adapter deliberately targets the older `generateContent`/`streamGenerateContent` REST
// surface instead: it's still live, it's a straight `contents`/`parts` translation from
// ProviderChatMessage (what this app already has), and its shape is corroborated by Google's
// own REST API reference plus independent third-party usage — see the report for details/caveats.

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

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const MODELS_URL = `${API_BASE}/models`
const CACHE_TTL_MS = 30 * 60 * 1000

// Google doesn't publish a "free" boolean anywhere in the Model resource or a per-model price
// like OpenRouter's pricing block (verified against the REST reference and rate-limits docs —
// neither exposes a tier/price field). Free-tier eligibility is a fact about the account/API-key,
// not the model, and Google only surfaces current limits in the AI Studio dashboard, not the API.
// So: pattern-match known free-tier-eligible families (all "flash" models, including "-lite"
// variants) and treat everything else (e.g. "pro") as not-free-by-default. This is a documented
// allowlist *shape*, not a promise the exact model IDs below still exist — verify against a live
// `listModels()` call before shipping, since Google churns model IDs (2.0 -> 2.5 -> 3.x flash).
const FREE_TIER_MODEL_PATTERN = /flash/i

interface GeminiModelEntry {
  name: string // "models/gemini-2.5-flash"
  displayName?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  supportedGenerationMethods?: string[]
}

// Module-level cache (not a class field): one provider instance, plain timestamp check.
let cache: { models: ModelInfo[]; fetchedAt: number } | undefined

function bareModelId(resourceName: string): string {
  return resourceName.startsWith('models/') ? resourceName.slice('models/'.length) : resourceName
}

function toModelInfo(entry: GeminiModelEntry): ModelInfo {
  const modelId = bareModelId(entry.name)
  return {
    providerId: 'google-ai-studio',
    modelId,
    label: entry.displayName ?? modelId,
    isFree: FREE_TIER_MODEL_PATTERN.test(modelId),
    supportsReasoningTrace: true, // narrowed to true "thinking" models below, once identified
    contextLength: entry.inputTokenLimit
  }
}

async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch(MODELS_URL, { headers: { 'x-goog-api-key': apiKey } })
  if (!res.ok) throw new Error(`Google AI Studio model list failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { models: GeminiModelEntry[] }
  return body.models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') ?? true)
    .map(toModelInfo)
}

async function getCachedModels(apiKey: string, forceRefresh = false): Promise<ModelInfo[]> {
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models
  const models = await fetchModels(apiKey)
  cache = { models, fetchedAt: Date.now() }
  return models
}

function toGeminiRole(role: ProviderChatMessage['role']): 'user' | 'model' {
  return role === 'assistant' ? 'model' : 'user'
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: { text: string }[]
}

/** Gemini has no inline 'system' role — system messages become a separate `systemInstruction`. */
function toGeminiRequest(messages: ProviderChatMessage[]): {
  contents: GeminiContent[]
  systemInstruction?: { parts: { text: string }[] }
} {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }))
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: toGeminiRole(m.role), parts: [{ text: m.content }] }))
  return systemParts.length > 0
    ? { contents, systemInstruction: { parts: systemParts } }
    : { contents }
}

interface GeminiPart {
  text?: string
  thought?: boolean // set on "thinking" chunks when the request enabled includeThoughts
}

interface GeminiStreamChunk {
  candidates?: [{ content?: { parts?: GeminiPart[] } }]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
  }
}

// Gemini's `alt=sse` stream has no `[DONE]`-style sentinel of its own — done is always false
// here, relying entirely on the HTTP stream closing (parseSseStream's own reader.read() done
// check), unlike the OpenAI-shaped providers that watch for a literal `data: [DONE]` line.
/** One `data: {...}` line from the `alt=sse` stream, parsed into zero or more stream parts. */
function parseEvent(eventBlock: string): { done: boolean; parts: ChatStreamPart[] } {
  const dataLine = eventBlock.split('\n').find((line) => line.startsWith('data:'))
  if (!dataLine) return { done: false, parts: [] } // keep-alive/blank blocks

  const payload = dataLine.slice(5).trim()
  if (!payload) return { done: false, parts: [] }

  let json: GeminiStreamChunk
  try {
    json = JSON.parse(payload)
  } catch {
    return { done: false, parts: [] } // ponytail: malformed chunk skipped, not fatal
  }

  const parts: ChatStreamPart[] = []
  for (const part of json.candidates?.[0]?.content?.parts ?? []) {
    if (!part.text) continue
    parts.push(part.thought ? { type: 'reasoning', delta: part.text } : { type: 'answer', delta: part.text })
  }
  const usage = json.usageMetadata
  if (usage?.promptTokenCount !== undefined && usage?.candidatesTokenCount !== undefined) {
    parts.push({
      type: 'usage',
      promptTokens: usage.promptTokenCount,
      completionTokens: usage.candidatesTokenCount
    })
  }
  return { done: false, parts }
}

class GoogleAiStudioProvider implements LLMProvider {
  readonly id = 'google-ai-studio' as const
  readonly supportsReasoningTrace = true

  async listModels(opts?: { forceRefresh?: boolean }): Promise<ModelInfo[]> {
    const apiKey = getApiKey('google-ai-studio')
    if (!apiKey) throw new Error('Google AI Studio API key is not configured')
    return getCachedModels(apiKey, opts?.forceRefresh)
  }

  isFree(modelId: string): boolean {
    const cached = cache?.models.find((m) => m.modelId === modelId)
    if (cached) return cached.isFree
    return FREE_TIER_MODEL_PATTERN.test(modelId) // fail open to the documented pattern, not closed
  }

  async *streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart> {
    const apiKey = getApiKey('google-ai-studio')
    if (!apiKey) throw new Error('Google AI Studio API key is not configured')

    // Hard guard before any network call — don't rely on Google to reject paid usage.
    if (!this.isFree(opts.modelId) && !getAllowPaid('google-ai-studio')) {
      throw new Error(
        `Google AI Studio model "${opts.modelId}" is paid and paid usage is not enabled`
      )
    }

    const { contents, systemInstruction } = toGeminiRequest(messages)
    const generationConfig: Record<string, unknown> = {}
    if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature
    if (opts.topP !== undefined) generationConfig.topP = opts.topP
    if (opts.maxTokens !== undefined) generationConfig.maxOutputTokens = opts.maxTokens

    const body: Record<string, unknown> = { contents }
    if (systemInstruction) body.systemInstruction = systemInstruction
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig

    const url = `${API_BASE}/models/${opts.modelId}:streamGenerateContent?alt=sse`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal
    })

    if (!res.ok || !res.body) {
      throw new Error(`Google AI Studio chat request failed: ${res.status} ${res.statusText}`)
    }

    yield* parseSseStream(res.body.getReader(), parseEvent)
  }
}

registerProvider(new GoogleAiStudioProvider())

// --- self-check ---------------------------------------------------------------------
// No API key/network in this environment, so this feeds fixture data through the two
// branchy bits (free/paid detection, SSE chunk parsing incl. thought parts). Plain assert,
// throws on failure, no test framework.
if (require.main === module) {
  void (async () => {
    const fixtureEntries: GeminiModelEntry[] = [
      {
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        inputTokenLimit: 1_000_000,
        supportedGenerationMethods: ['generateContent']
      },
      {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        inputTokenLimit: 1_000_000,
        supportedGenerationMethods: ['generateContent']
      }
    ]
    cache = { models: fixtureEntries.map(toModelInfo), fetchedAt: Date.now() }

    const provider = new GoogleAiStudioProvider()
    assert.strictEqual(provider.isFree('gemini-2.5-flash'), true, 'flash model must be free')
    assert.strictEqual(provider.isFree('gemini-2.5-pro'), false, 'pro model must not be free')
    assert.strictEqual(
      provider.isFree('gemini-9.9-flash-lite'),
      true,
      'uncached flash-lite model falls back to the documented pattern'
    )

    const sseText =
      'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}]}}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n' +
      ': keep-alive, no data line\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}\n\n'

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

    const { contents, systemInstruction } = toGeminiRequest([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ])
    assert.deepStrictEqual(systemInstruction, { parts: [{ text: 'be terse' }] })
    assert.deepStrictEqual(contents, [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] }
    ])

    console.log('google-ai-studio provider self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
