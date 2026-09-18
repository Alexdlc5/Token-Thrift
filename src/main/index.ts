import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc-contract'
import { getDb } from './db/schema'
import {
  addMessage,
  createSession,
  createTask,
  deleteSession,
  getSession,
  getSessionDocument,
  isDocumentModeEnabled,
  listMessages,
  listMessagesForModel,
  listSessions,
  listTasks,
  renameSession,
  setDocumentMode,
  setSessionArchived,
  setSessionDocument,
  updateSessionModel,
  updateTask
} from './db/repository'
import { getProvider, listProviders } from './providers'
import { buildSystemPrompt, extractDocumentUpdate } from './prompt-modules'
import { fitHistoryToBudget } from './context-window'
import { maybeCompressSession } from './context-compression'
import {
  addApiKey,
  getActiveKeyId,
  getAllowPaid,
  hasApiKey,
  listApiKeys,
  removeApiKey,
  setActiveApiKey,
  setAllowPaid
} from './secure-store'
import type { ModelOverrides, TaskRow } from '@shared/models'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function emitTaskUpdate(win: BrowserWindow | null, task: TaskRow): void {
  win?.webContents.send(IPC.events.taskUpdate, task)
}

// Runs one provider streaming call to completion, persisting the assistant message and
// task-log row and pushing live events to the renderer. Fire-and-forget from the IPC
// handler's point of view — sendMessage() already returned the taskId by the time this runs.
async function runChatTask(
  task: TaskRow,
  sessionId: string,
  overrides: ModelOverrides | undefined,
  win: BrowserWindow | null
): Promise<void> {
  const session = getSession(sessionId)
  const provider = session && getProvider(session.providerId)

  if (!session || !provider) {
    const failed = updateTask(task.id, {
      status: 'error',
      endedAt: Date.now(),
      error: `No provider registered for session "${sessionId}"`
    })
    emitTaskUpdate(win, failed)
    win?.webContents.send(IPC.events.chatError, {
      taskId: task.id,
      sessionId,
      error: failed.error
    })
    return
  }

  emitTaskUpdate(win, updateTask(task.id, { status: 'streaming' }))

  // Fit this request to the active model's real budget — a session's history can run up to
  // SESSION_TOKEN_CAP tokens (compressed as it grows, see context-compression.ts), but any
  // one model's actual context window is usually much smaller than that.
  const modelInfo = (await provider.listModels().catch(() => [])).find(
    (m) => m.modelId === session.modelId
  )
  const contextLength = modelInfo?.contextLength ?? 32_768
  const reserve = overrides?.maxTokens ?? Math.floor(contextLength * 0.25)
  const budget = Math.max(1000, contextLength - reserve)

  const history = fitHistoryToBudget(listMessagesForModel(sessionId), budget)
  if (task.systemPrompt) history.unshift({ role: 'system', content: task.systemPrompt })

  let answer = ''
  let reasoning = ''
  let usage: { promptTokens: number; completionTokens: number } | undefined

  try {
    for await (const part of provider.streamChat(history, {
      modelId: session.modelId,
      temperature: overrides?.temperature,
      topP: overrides?.topP,
      maxTokens: overrides?.maxTokens,
      reasoningEffort: overrides?.reasoningEffort
    })) {
      if (part.type === 'answer') {
        answer += part.delta
        win?.webContents.send(IPC.events.chatChunk, {
          taskId: task.id,
          sessionId,
          channel: 'answer',
          delta: part.delta
        })
      } else if (part.type === 'reasoning') {
        reasoning += part.delta
        win?.webContents.send(IPC.events.chatChunk, {
          taskId: task.id,
          sessionId,
          channel: 'reasoning',
          delta: part.delta
        })
      } else if (part.type === 'usage') {
        usage = { promptTokens: part.promptTokens, completionTokens: part.completionTokens }
      }
    }

    let assistantContent = answer
    if (isDocumentModeEnabled(sessionId)) {
      const update = extractDocumentUpdate(answer)
      if (update) {
        const existing = getSessionDocument(sessionId)
        setSessionDocument(sessionId, {
          kind: 'text',
          content: update.content,
          mimeType: null,
          fileName: existing?.fileName ?? null
        })
        assistantContent = update.remainder || '_Updated the document — see the panel above._'
      }
    }

    addMessage(sessionId, 'assistant', assistantContent, reasoning || undefined)
    const done = updateTask(task.id, {
      status: 'done',
      endedAt: Date.now(),
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      costUsd: 0
    })
    emitTaskUpdate(win, done)
    win?.webContents.send(IPC.events.chatDone, { taskId: task.id, sessionId })

    // Fire-and-forget: doesn't block the response the user is already reading, and any
    // failure (no summarizer configured, the call itself errors) just skips this round.
    void maybeCompressSession(sessionId, session.providerId, session.modelId).catch(console.error)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const failed = updateTask(task.id, { status: 'error', endedAt: Date.now(), error })
    emitTaskUpdate(win, failed)
    win?.webContents.send(IPC.events.chatError, { taskId: task.id, sessionId, error })
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.session.list, async () => listSessions())
  ipcMain.handle(IPC.session.create, async (_e, providerId, modelId, title) =>
    createSession(providerId, modelId, title)
  )
  ipcMain.handle(IPC.session.rename, async (_e, id, title) => renameSession(id, title))
  ipcMain.handle(IPC.session.archive, async (_e, id, archived) => setSessionArchived(id, archived))
  ipcMain.handle(IPC.session.updateModel, async (_e, id, providerId, modelId) => {
    updateSessionModel(id, providerId, modelId)
    addMessage(id, 'system', `[Switched to ${providerId} / ${modelId}]`)
  })
  ipcMain.handle(IPC.session.delete, async (_e, id) => deleteSession(id))

  ipcMain.handle(IPC.message.list, async (_e, sessionId) => listMessages(sessionId))
  ipcMain.handle(
    IPC.message.send,
    async (event, sessionId: string, content: string, overrides?: ModelOverrides) => {
      const session = getSession(sessionId)
      if (!session) throw new Error(`Unknown session "${sessionId}"`)

      addMessage(sessionId, 'user', content)

      const modeEnabled = isDocumentModeEnabled(sessionId)
      const document = modeEnabled ? getSessionDocument(sessionId) : null

      const task = createTask({
        parentTaskId: null,
        sessionId,
        providerId: session.providerId,
        modelId: session.modelId,
        systemPrompt: buildSystemPrompt(overrides, { document, modeEnabled })
      })

      const win = BrowserWindow.fromWebContents(event.sender)
      void runChatTask(task, sessionId, overrides, win)

      return { taskId: task.id }
    }
  )

  // allSettled, not all: most providers require an API key even to list models, so one
  // unconfigured provider (the common case before the user has pasted every key) must not
  // blank out every other provider's model list.
  ipcMain.handle(IPC.model.list, async () => {
    const results = await Promise.allSettled(listProviders().map((p) => p.listModels()))
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  })
  ipcMain.handle(IPC.model.refreshFree, async () => {
    await Promise.allSettled(listProviders().map((p) => p.listModels({ forceRefresh: true })))
  })

  ipcMain.handle(IPC.provider.getStatus, async (_e, providerId) => ({
    hasApiKey: hasApiKey(providerId),
    allowPaid: getAllowPaid(providerId),
    activeKeyId: getActiveKeyId(providerId)
  }))
  ipcMain.handle(IPC.provider.setAllowPaid, async (_e, providerId, allow) =>
    setAllowPaid(providerId, allow)
  )

  ipcMain.handle(IPC.provider.listApiKeys, async (_e, providerId) => listApiKeys(providerId))
  ipcMain.handle(IPC.provider.addApiKey, async (_e, providerId, label, apiKey) =>
    addApiKey(providerId, label, apiKey)
  )
  ipcMain.handle(IPC.provider.removeApiKey, async (_e, providerId, keyId) =>
    removeApiKey(providerId, keyId)
  )
  ipcMain.handle(IPC.provider.setActiveApiKey, async (_e, providerId, keyId) =>
    setActiveApiKey(providerId, keyId)
  )

  // Per-model overrides (§2.5) aren't persisted yet — no phase in the delegation plan owns
  // this storage yet. Renderer keeps them in local state in the meantime.
  ipcMain.handle(IPC.overrides.get, async () => null)
  ipcMain.handle(IPC.overrides.set, async () => {})

  ipcMain.handle(IPC.task.list, async () => listTasks())

  // Data-URL uploads land here as a full string over IPC — cap it so a huge file doesn't
  // bloat the SQLite settings row indefinitely (base64 inflates ~33% over the raw bytes).
  const MAX_DOCUMENT_FILE_BYTES = 15 * 1024 * 1024
  ipcMain.handle(IPC.document.get, async (_e, sessionId) => getSessionDocument(sessionId))
  ipcMain.handle(IPC.document.setText, async (_e, sessionId, content, fileName) => {
    const existing = getSessionDocument(sessionId)
    return setSessionDocument(sessionId, {
      kind: 'text',
      content,
      mimeType: null,
      fileName: fileName !== undefined ? fileName : (existing?.fileName ?? null)
    })
  })
  ipcMain.handle(IPC.document.setFile, async (_e, sessionId, content, mimeType, fileName) => {
    if (content.length > MAX_DOCUMENT_FILE_BYTES) {
      throw new Error('File is too large (max 15MB)')
    }
    return setSessionDocument(sessionId, { kind: 'file', content, mimeType, fileName })
  })
  ipcMain.handle(IPC.document.getMode, async (_e, sessionId) => isDocumentModeEnabled(sessionId))
  ipcMain.handle(IPC.document.setMode, async (_e, sessionId, enabled) => setDocumentMode(sessionId, enabled))
}

// A second launch (e.g. double-clicking the desktop shortcut while a previous instance is
// still alive in the background) would otherwise race the first instance on the same
// SQLite file and settings JSON — request the lock and quit immediately if another instance
// already holds it, focusing that instance's window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    getDb()
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
