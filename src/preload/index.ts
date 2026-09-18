import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type {
  ChatStreamChunk,
  ChatStreamDone,
  ChatStreamError,
  ChatStreamRetry,
  LibraryUpdated
} from '@shared/ipc-contract'
import type { TaskRow } from '@shared/models'
import type { TokenThriftApi } from '@shared/api'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: TokenThriftApi = {
  listSessions: () => ipcRenderer.invoke(IPC.session.list),
  createSession: (providerId, modelId, title) =>
    ipcRenderer.invoke(IPC.session.create, providerId, modelId, title),
  renameSession: (id, title) => ipcRenderer.invoke(IPC.session.rename, id, title),
  setSessionArchived: (id, archived) => ipcRenderer.invoke(IPC.session.archive, id, archived),
  updateSessionModel: (id, providerId, modelId) =>
    ipcRenderer.invoke(IPC.session.updateModel, id, providerId, modelId),
  deleteSession: (id) => ipcRenderer.invoke(IPC.session.delete, id),

  listMessages: (sessionId) => ipcRenderer.invoke(IPC.message.list, sessionId),
  sendMessage: (sessionId, content, overrides) =>
    ipcRenderer.invoke(IPC.message.send, sessionId, content, overrides),

  listModels: () => ipcRenderer.invoke(IPC.model.list),
  refreshFreeModels: () => ipcRenderer.invoke(IPC.model.refreshFree),

  getProviderStatus: (providerId) => ipcRenderer.invoke(IPC.provider.getStatus, providerId),
  setProviderAllowPaid: (providerId, allow) =>
    ipcRenderer.invoke(IPC.provider.setAllowPaid, providerId, allow),

  listApiKeys: (providerId) => ipcRenderer.invoke(IPC.provider.listApiKeys, providerId),
  addApiKey: (providerId, label, apiKey) =>
    ipcRenderer.invoke(IPC.provider.addApiKey, providerId, label, apiKey),
  removeApiKey: (providerId, keyId) => ipcRenderer.invoke(IPC.provider.removeApiKey, providerId, keyId),
  setActiveApiKey: (providerId, keyId) =>
    ipcRenderer.invoke(IPC.provider.setActiveApiKey, providerId, keyId),

  getSessionOverrides: (sessionId) => ipcRenderer.invoke(IPC.overrides.get, sessionId),
  setSessionOverrides: (sessionId, overrides) =>
    ipcRenderer.invoke(IPC.overrides.set, sessionId, overrides),
  getDefaultOverrides: () => ipcRenderer.invoke(IPC.overrides.getDefault),
  saveAsDefaultOverrides: (overrides) => ipcRenderer.invoke(IPC.overrides.setDefault, overrides),

  pickFolder: () => ipcRenderer.invoke(IPC.system.pickFolder),
  checkWorkingDirSize: (path) => ipcRenderer.invoke(IPC.system.checkWorkingDir, path),

  listTasks: () => ipcRenderer.invoke(IPC.task.list),

  getDocument: (sessionId) => ipcRenderer.invoke(IPC.document.get, sessionId),
  setDocumentText: (sessionId, content, fileName) =>
    ipcRenderer.invoke(IPC.document.setText, sessionId, content, fileName),
  setDocumentFile: (sessionId, content, mimeType, fileName) =>
    ipcRenderer.invoke(IPC.document.setFile, sessionId, content, mimeType, fileName),
  getDocumentMode: (sessionId) => ipcRenderer.invoke(IPC.document.getMode, sessionId),
  setDocumentMode: (sessionId, enabled) => ipcRenderer.invoke(IPC.document.setMode, sessionId, enabled),

  listLibraryItems: (sessionId) => ipcRenderer.invoke(IPC.library.list, sessionId),
  openLibraryItem: (id) => ipcRenderer.invoke(IPC.library.open, id),
  reorderLibraryItems: (sessionId, orderedIds) =>
    ipcRenderer.invoke(IPC.library.reorder, sessionId, orderedIds),
  relinkLibraryItem: (id, newPath) => ipcRenderer.invoke(IPC.library.relink, id, newPath),

  onTaskUpdate: (cb) => on<TaskRow>(IPC.events.taskUpdate, cb),
  onChatChunk: (cb) => on<ChatStreamChunk>(IPC.events.chatChunk, cb),
  onChatRetry: (cb) => on<ChatStreamRetry>(IPC.events.chatRetry, cb),
  onChatDone: (cb) => on<ChatStreamDone>(IPC.events.chatDone, cb),
  onChatError: (cb) => on<ChatStreamError>(IPC.events.chatError, cb),
  onLibraryUpdated: (cb) => on<LibraryUpdated>(IPC.events.libraryUpdated, cb)
}

contextBridge.exposeInMainWorld('api', api)
