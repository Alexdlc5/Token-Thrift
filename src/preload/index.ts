import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type { ChatStreamChunk, ChatStreamDone, ChatStreamError } from '@shared/ipc-contract'
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

  listMessages: (sessionId) => ipcRenderer.invoke(IPC.message.list, sessionId),
  sendMessage: (sessionId, content) => ipcRenderer.invoke(IPC.message.send, sessionId, content),

  listModels: () => ipcRenderer.invoke(IPC.model.list),
  refreshFreeModels: () => ipcRenderer.invoke(IPC.model.refreshFree),

  setProviderApiKey: (providerId, apiKey) =>
    ipcRenderer.invoke(IPC.provider.setApiKey, providerId, apiKey),
  getProviderStatus: (providerId) => ipcRenderer.invoke(IPC.provider.getStatus, providerId),
  setProviderAllowPaid: (providerId, allow) =>
    ipcRenderer.invoke(IPC.provider.setAllowPaid, providerId, allow),

  getModelOverrides: (providerId, modelId) =>
    ipcRenderer.invoke(IPC.overrides.get, providerId, modelId),
  setModelOverrides: (providerId, modelId, overrides) =>
    ipcRenderer.invoke(IPC.overrides.set, providerId, modelId, overrides),

  listTasks: () => ipcRenderer.invoke(IPC.task.list),

  onTaskUpdate: (cb) => on<TaskRow>(IPC.events.taskUpdate, cb),
  onChatChunk: (cb) => on<ChatStreamChunk>(IPC.events.chatChunk, cb),
  onChatDone: (cb) => on<ChatStreamDone>(IPC.events.chatDone, cb),
  onChatError: (cb) => on<ChatStreamError>(IPC.events.chatError, cb)
}

contextBridge.exposeInMainWorld('api', api)
