// The IPC contract between main and renderer. Every subagent codes against this file —
// do not add ad-hoc ipcRenderer.invoke/ipcMain.handle calls outside these channel names.

export const IPC = {
  session: {
    list: 'session:list',
    create: 'session:create',
    rename: 'session:rename',
    archive: 'session:archive',
    updateModel: 'session:updateModel'
  },
  message: {
    list: 'message:list',
    send: 'message:send'
  },
  model: {
    list: 'model:list',
    refreshFree: 'model:refreshFree'
  },
  provider: {
    getStatus: 'provider:getStatus',
    setAllowPaid: 'provider:setAllowPaid',
    listApiKeys: 'provider:listApiKeys',
    addApiKey: 'provider:addApiKey',
    removeApiKey: 'provider:removeApiKey',
    setActiveApiKey: 'provider:setActiveApiKey'
  },
  overrides: {
    get: 'overrides:get',
    set: 'overrides:set'
  },
  task: {
    list: 'task:list'
  },
  events: {
    taskUpdate: 'event:taskUpdate',
    chatChunk: 'event:chatChunk',
    chatDone: 'event:chatDone',
    chatError: 'event:chatError'
  }
} as const

export interface ChatStreamChunk {
  taskId: string
  sessionId: string
  channel: 'answer' | 'reasoning'
  delta: string
}

export interface ChatStreamDone {
  taskId: string
  sessionId: string
}

export interface ChatStreamError {
  taskId: string
  sessionId: string
  error: string
}
