import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc-contract'
import { getDb } from './db/schema'
import { getAllowPaid, hasApiKey, setAllowPaid, setApiKey } from './secure-store'

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

// --- IPC handler stubs -------------------------------------------------------------
// Placeholder logic only, matching the shared contract's return shapes so the renderer
// boots without live data. Subagent B replaces session/message/task handlers with the
// real SQLite-backed repository; Phase 2 wires in the real provider dispatch.

function registerIpcStubs(): void {
  ipcMain.handle(IPC.session.list, async () => [])
  ipcMain.handle(IPC.session.create, async (_e, providerId, modelId, title) => ({
    id: crypto.randomUUID(),
    providerId,
    modelId,
    title: title ?? 'New session',
    createdAt: Date.now(),
    archived: false
  }))
  ipcMain.handle(IPC.session.rename, async () => {})
  ipcMain.handle(IPC.session.archive, async () => {})

  ipcMain.handle(IPC.message.list, async () => [])
  ipcMain.handle(IPC.message.send, async () => ({ taskId: crypto.randomUUID() }))

  ipcMain.handle(IPC.model.list, async () => [])
  ipcMain.handle(IPC.model.refreshFree, async () => {})

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

  ipcMain.handle(IPC.overrides.get, async () => null)
  ipcMain.handle(IPC.overrides.set, async () => {})

  ipcMain.handle(IPC.task.list, async () => [])
}

void app.whenReady().then(() => {
  getDb()
  registerIpcStubs()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
