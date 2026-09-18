import type { ChatStreamChunk, ChatStreamDone, ChatStreamError, LibraryUpdated } from './ipc-contract'
import type {
  ChatMessage,
  LibraryItem,
  ModelInfo,
  ModelOverrides,
  ProviderId,
  ProviderStatus,
  SessionDocument,
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

  getDocument(sessionId: string): Promise<SessionDocument | null>
  /** User- or model-authored edit to the session's text document. */
  setDocumentText(sessionId: string, content: string, fileName?: string): Promise<SessionDocument>
  /** Loads an image/PDF as the session's reference document — content must be a data: URL. */
  setDocumentFile(
    sessionId: string,
    content: string,
    mimeType: string,
    fileName: string
  ): Promise<SessionDocument>
  getDocumentMode(sessionId: string): Promise<boolean>
  /** Whether the model is instructed to edit the text document via its response convention. */
  setDocumentMode(sessionId: string, enabled: boolean): Promise<void>

  listLibraryItems(sessionId: string): Promise<LibraryItem[]>
  /** Opens a library file with the OS default handler (shell.openPath). */
  openLibraryItem(id: string): Promise<void>

  onTaskUpdate(cb: (task: TaskRow) => void): () => void
  onChatChunk(cb: (evt: ChatStreamChunk) => void): () => void
  onChatDone(cb: (evt: ChatStreamDone) => void): () => void
  onChatError(cb: (evt: ChatStreamError) => void): () => void
  onLibraryUpdated(cb: (evt: LibraryUpdated) => void): () => void
}
