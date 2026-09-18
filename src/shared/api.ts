import type { ChatStreamChunk, ChatStreamDone, ChatStreamError } from './ipc-contract'
import type {
  ChatMessage,
  ModelInfo,
  ModelOverrides,
  ProviderId,
  ProviderStatus,
  SessionSummary,
  StoredKeyInfo,
  TaskRow
} from './models'

/** The full surface preload exposes as `window.api`. Renderer only ever talks to this. */
export interface TokenThriftApi {
  listSessions(): Promise<SessionSummary[]>
  createSession(providerId: ProviderId, modelId: string, title?: string): Promise<SessionSummary>
  renameSession(id: string, title: string): Promise<void>
  setSessionArchived(id: string, archived: boolean): Promise<void>
  /** Switches an existing session to a different provider/model, keeping its message history. */
  updateSessionModel(id: string, providerId: ProviderId, modelId: string): Promise<void>
  /** Permanently deletes a session and its messages/tasks — irreversible, unlike archiving. */
  deleteSession(id: string): Promise<void>

  listMessages(sessionId: string): Promise<ChatMessage[]>
  sendMessage(
    sessionId: string,
    content: string,
    overrides?: ModelOverrides
  ): Promise<{ taskId: string }>

  listModels(): Promise<ModelInfo[]>
  refreshFreeModels(): Promise<void>

  getProviderStatus(providerId: ProviderId): Promise<ProviderStatus>
  setProviderAllowPaid(providerId: ProviderId, allow: boolean): Promise<void>

  listApiKeys(providerId: ProviderId): Promise<StoredKeyInfo[]>
  addApiKey(providerId: ProviderId, label: string, apiKey: string): Promise<StoredKeyInfo>
  removeApiKey(providerId: ProviderId, keyId: string): Promise<void>
  setActiveApiKey(providerId: ProviderId, keyId: string): Promise<void>

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
