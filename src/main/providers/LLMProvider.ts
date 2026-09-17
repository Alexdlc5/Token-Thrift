// Main-process-only interface. Nothing outside src/main/providers and the modules that
// dispatch to a registered provider should ever import this — renderer never talks to a
// provider SDK, only to the IPC contract in src/shared.

import type { ModelInfo, ProviderId } from '@shared/models'

export interface ProviderChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface StreamChatOptions {
  modelId: string
  temperature?: number
  topP?: number
  maxTokens?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  signal?: AbortSignal
}

export type ChatStreamPart =
  | { type: 'answer'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }

/**
 * One implementation per provider (OpenRouter, Groq, ...). The rest of the app only ever
 * talks to a provider through this interface — never import a provider SDK outside its own
 * adapter file.
 */
export interface LLMProvider {
  readonly id: ProviderId
  readonly supportsReasoningTrace: boolean

  /** Live model list from the provider's own API, tagged with current pricing. */
  listModels(opts?: { forceRefresh?: boolean }): Promise<ModelInfo[]>

  /** Resolved from the cached model list — never hardcode free-model IDs. */
  isFree(modelId: string): boolean

  streamChat(
    messages: ProviderChatMessage[],
    opts: StreamChatOptions
  ): AsyncGenerator<ChatStreamPart>
}
