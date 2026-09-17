import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc-contract'
import { getDb } from './db/schema'
import {
  addMessage,
  createSession,
  createTask,
  getSession,
  listMessages,
  listSessions,
  listTasks,
  renameSession,
  setSessionArchived,
  updateTask
} from './db/repository'
import { getProvider, listProviders } from './providers'
import { getAllowPaid, hasApiKey, setAllowPaid, setApiKey } from './secure-store'
import type { TaskRow } from '@shared/models'

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
async function runChatTask(task: TaskRow, sessionId: string, win: BrowserWindow | null): Promise<void> {
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

  const history = listMessages(sessionId).map((m) => ({ role: m.role, content: m.content }))
  let answer = ''
  let reasoning = ''
  let usage: { promptTokens: number; completionTokens: number } | undefined

  try {
    for await (const part of provider.streamChat(history, { modelId: session.modelId })) {
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

    addMessage(sessionId, 'assistant', answer, reasoning || undefined)
    const done = updateTask(task.id, {
      status: 'done',
      endedAt: Date.now(),
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      costUsd: 0
    })
    emitTaskUpdate(win, done)
    win?.webContents.send(IPC.events.chatDone, { taskId: task.id, sessionId })
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

  ipcMain.handle(IPC.message.list, async (_e, sessionId) => listMessages(sessionId))
  ipcMain.handle(IPC.message.send, async (event, sessionId: string, content: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error(`Unknown session "${sessionId}"`)

    addMessage(sessionId, 'user', content)
    const task = createTask({
      parentTaskId: null,
      sessionId,
      providerId: session.providerId,
      modelId: session.modelId
    })

    const win = BrowserWindow.fromWebContents(event.sender)
    void runChatTask(task, sessionId, win)

    return { taskId: task.id }
  })

  ipcMain.handle(IPC.model.list, async () => {
    const lists = await Promise.all(listProviders().map((p) => p.listModels()))
    return lists.flat()
  })
  ipcMain.handle(IPC.model.refreshFree, async () => {
    await Promise.all(listProviders().map((p) => p.listModels({ forceRefresh: true })))
  })

  ipcMain.handle(IPC.provider.setApiKey, async (_e, providerId, apiKey) =>
    setApiKey(providerId, apiKey)
  )
  ipcMain.handle(IPC.provider.getStatus, async (_e, providerId) => ({
    hasApiKey: hasApiKey(providerId),
    allowPaid: getAllowPaid(providerId)
  }))
  ipcMain.handle(IPC.provider.setAllowPaid, async (_e, providerId, allow) =>
    setAllowPaid(providerId, allow)
  )

  // Per-model overrides (§2.5) aren't persisted yet — no phase in the delegation plan owns
  // this storage yet. Renderer keeps them in local state in the meantime.
  ipcMain.handle(IPC.overrides.get, async () => null)
  ipcMain.handle(IPC.overrides.set, async () => {})

  ipcMain.handle(IPC.task.list, async () => listTasks())
}

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
