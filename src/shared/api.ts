import type { ChatStreamChunk, ChatStreamDone, ChatStreamError } from './ipc-contract'
import type {
  ChatMessage,
  ModelInfo,
  ModelOverrides,
  ProviderId,
  ProviderStatus,
  SessionSummary,
  TaskRow
} from './models'

/** The full surface preload exposes as `window.api`. Renderer only ever talks to this. */
export interface TokenThriftApi {
  listSessions(): Promise<SessionSummary[]>
  createSession(providerId: ProviderId, modelId: string, title?: string): Promise<SessionSummary>
  renameSession(id: string, title: string): Promise<void>
  archiveSession(id: string): Promise<void>

  listMessages(sessionId: string): Promise<ChatMessage[]>
  sendMessage(sessionId: string, content: string): Promise<{ taskId: string }>

  listModels(): Promise<ModelInfo[]>
  refreshFreeModels(): Promise<void>

  setProviderApiKey(providerId: ProviderId, apiKey: string): Promise<void>
  getProviderStatus(providerId: ProviderId): Promise<ProviderStatus>
  setProviderAllowPaid(providerId: ProviderId, allow: boolean): Promise<void>

  getModelOverrides(providerId: ProviderId, modelId: string): Promise<ModelOverrides | null>
  setModelOverrides(
    providerId: ProviderId,
    modelId: string,
    overrides: ModelOverrides
  ): Promise<void>

  listTasks(): Promise<TaskRow[]>

  onTaskUpdate(cb: (task: TaskRow) => void): () => void
  onChatChunk(cb: (evt: ChatStreamChunk) => void): () => void
  onChatDone(cb: (evt: ChatStreamDone) => void): () => void
  onChatError(cb: (evt: ChatStreamError) => void): () => void
}
