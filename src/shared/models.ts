// Shared DTOs used across main, preload, and renderer. No provider SDK types leak in here.

export type ProviderId =
  | 'openrouter'
  | 'groq'
  | 'google-ai-studio'
  | 'cerebras'
  | 'nvidia-nim'
  | 'huggingface'
  | 'mistral'
  | 'cloudflare-workers-ai'
  | 'cohere'
  | 'zhipu'

export interface ModelInfo {
  providerId: ProviderId
  modelId: string
  label: string
  isFree: boolean
  supportsReasoningTrace: boolean
  contextLength?: number
  /** True when contextLength isn't from the provider's live listing (a static lookup, a family-pattern guess, or a router's min-across-candidates) — never authoritative for the exact request that will run. */
  contextLengthApprox?: boolean
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
  /** True once this message has been folded into a later summary — still shown in the UI, no longer sent to the model. */
  compressed: boolean
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
  /** Lets the model hand off an image-generation prompt instead of saying it can't make images. */
  imageGeneration?: boolean
  /** Lets the model write real multi-file projects to disk via the <write_files> response
   * convention (see main/agent-files.ts) — off by default, unlike imageGeneration, since it
   * touches the real filesystem outside the app's own sandboxed library storage. */
  agentFileAccess?: boolean
  /** Where agentFileAccess writes/reads — an absolute path the user picked. Empty/unset falls
   * back to a per-project subfolder under the user's Documents folder (see agent-files.ts).
   * When set, this exact folder is the target (no per-project subfolder nesting) — picking a
   * specific folder is usually "work inside my existing project", not "start a new one". */
  agentWorkingDir?: string
}

export interface ProviderStatus {
  hasApiKey: boolean
  allowPaid: boolean
  activeKeyId: string | null
}

/** One saved, named API key for a provider — never the decrypted value itself. */
export interface StoredKeyInfo {
  id: string
  label: string
  createdAt: number
}

export type DocumentKind = 'text' | 'file'

/**
 * The one working file a session can carry, shown above the chat input. 'text' documents
 * are editable by both the user and (when documentMode is on) the model, via a response
 * convention — see main/prompt-modules.ts. 'file' documents are a loaded image/PDF shown
 * as a reference; the model never edits those, only text ones.
 */
export interface SessionDocument {
  kind: DocumentKind
  /** Plain text for 'text'; a data: URL for 'file'. */
  content: string
  mimeType: string | null
  fileName: string | null
  updatedAt: number
}

/**
 * One item in a session's library. Most are 'file': copied into the app's own storage
 * (userData/library/<sessionId>/...) — every loaded reference file and every generated image
 * lands here, in addition to (not instead of) whatever's currently in the single-slot
 * document panel. `description` is the vision-read summary for an uploaded image, or the
 * original prompt for a generated one.
 *
 * A 'link' item is different: nothing is copied. It's a reference to a real path elsewhere on
 * disk — currently only created by the agent file-writing tool (main/agent-files.ts) for a
 * project it just wrote, so the result is a real, findable folder outside the app's own data
 * directory rather than something buried in userData. `missing` is computed live each list
 * call (the target may have moved or been deleted since) — the UI lets the user drag a
 * replacement file/folder onto a missing link to fix its stored path.
 */
export interface LibraryItem {
  id: string
  sessionId: string
  kind: 'file' | 'link'
  fileName: string
  mimeType: string
  sizeBytes: number
  description: string | null
  createdAt: number
  /** Only meaningful for kind: 'link' — true when the stored path no longer exists. */
  missing?: boolean
}
