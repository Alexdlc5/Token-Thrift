// Shared DTOs used across main, preload, and renderer. No provider SDK types leak in here.

export type ProviderId =
  | 'openrouter'
  | 'groq'
  | 'google-ai-studio'
  | 'cerebras'
  | 'nvidia-nim'
  | 'huggingface'

export interface ModelInfo {
  providerId: ProviderId
  modelId: string
  label: string
  isFree: boolean
  supportsReasoningTrace: boolean
  contextLength?: number
}

export interface SessionSummary {
  id: string
  providerId: ProviderId
  modelId: string
  title: string
  createdAt: number
  archived: boolean
}

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  sessionId: string
  role: ChatRole
  content: string
  reasoning?: string
  createdAt: number
}

export type TaskStatus = 'queued' | 'streaming' | 'done' | 'error'

export interface TaskRow {
  id: string
  parentTaskId: string | null
  sessionId: string | null
  providerId: ProviderId
  modelId: string
  status: TaskStatus
  promptTokens: number | null
  completionTokens: number | null
  costUsd: number
  startedAt: number
  endedAt: number | null
  error: string | null
  /** The resolved system prompt actually sent (custom prompt + active efficiency modules, §5), for inspection in the task monitor. */
  systemPrompt: string | null
}

export interface ModelOverrides {
  temperature?: number
  topP?: number
  maxTokens?: number
  systemPrompt?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
  leanCoding?: boolean
  fastReasoning?: boolean
}

export interface ProviderStatus {
  hasApiKey: boolean
  allowPaid: boolean
}
