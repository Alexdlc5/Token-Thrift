import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { basename, join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { IPC } from '@shared/ipc-contract'
import { getDb } from './db/schema'
import {
  addLibraryItem,
  addMessage,
  createSession,
  createTask,
  deleteSession,
  findLibraryLinkByName,
  getSession,
  getSessionDocument,
  getSessionOverrides,
  isDocumentModeEnabled,
  listMessages,
  listMessagesForModel,
  listSessions,
  listTasks,
  relinkLibraryItem,
  renameSession,
  setDocumentMode,
  setSessionArchived,
  setSessionDocument,
  setSessionOverrides,
  updateSessionModel,
  updateTask
} from './db/repository'
import { getProvider, listProviders } from './providers'
import {
  buildSystemPrompt,
  extractDocumentUpdate,
  extractImageGenerationRequest,
  extractWriteFilesRequest,
  findEarliestTagStart,
  sanitizeAssistantText
} from './prompt-modules'
import { fitHistoryToBudget } from './context-window'
import { maybeCompressSession } from './context-compression'
import { cloudflareImageProvider } from './image-providers/cloudflare-image'
import { readImage } from './image-providers/cloudflare-vision'
import { folderSizeBytes, projectsRoot, snapshotWorkingDirectory, writeProjectFiles } from './agent-files'
import { saveToLibrary, getLibraryItemPath, deleteLibraryDir } from './library'
import { listLibraryItems, reorderLibraryItems } from './db/repository'
import {
  addApiKey,
  getActiveKeyId,
  getAllowPaid,
  getDefaultOverrides,
  hasApiKey,
  listApiKeys,
  removeApiKey,
  setActiveApiKey,
  setAllowPaid,
  setDefaultOverrides
} from './secure-store'
import type { ModelOverrides, ProviderId, TaskRow } from '@shared/models'
import type { ProviderChatMessage } from './providers/LLMProvider'

function createWindow(): void {
  // No File/Edit/View/Window/Help bar — this app has no menu commands worth exposing there,
  // and it was just sitting on top of the UI as unstyled native chrome.
  Menu.setApplicationMenu(null)

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

interface ChatCandidate {
  providerId: ProviderId
  modelId: string
  contextLength: number
}

async function buildPrimaryCandidate(session: {
  providerId: ProviderId
  modelId: string
}): Promise<ChatCandidate> {
  const primaryProvider = getProvider(session.providerId)
  const primaryModels = primaryProvider ? await primaryProvider.listModels().catch(() => []) : []
  const contextLength = primaryModels.find((m) => m.modelId === session.modelId)?.contextLength ?? 32_768
  return { providerId: session.providerId, modelId: session.modelId, contextLength }
}

// One fallback model from every other provider that has a key configured — only called after
// the primary attempt fails, so a normal successful send never pays for listing every other
// provider's models up front.
async function buildFallbackCandidates(excludeProviderId: ProviderId): Promise<ChatCandidate[]> {
  const fallbacks: ChatCandidate[] = []
  for (const provider of listProviders()) {
    if (provider.id === excludeProviderId || !hasApiKey(provider.id)) continue
    const models = await provider.listModels().catch(() => [])
    const allowPaid = getAllowPaid(provider.id)
    const model = models.find((m) => provider.isFree(m.modelId) || allowPaid)
    if (model) {
      fallbacks.push({
        providerId: provider.id,
        modelId: model.modelId,
        contextLength: model.contextLength ?? 32_768
      })
    }
  }
  return fallbacks
}

interface StreamAttemptResult {
  answer: string
  reasoning: string
  usage: { promptTokens: number; completionTokens: number } | undefined
}

// Longest opening tag ("<generate_image>") is 16 chars — hold back that many trailing
// characters from the renderer at all times so a tag can never leak in partially (e.g.
// "<gener" forwarded before "ate_image>" arrives in the next chunk).
const MAX_TAG_PREFIX_LEN = 16

// Runs one provider's streamChat to completion, forwarding live chunks to the renderer except
// once a document/image-generation tag starts — from that point the user should only see the
// thinking indicator, never the raw prompt/content being written inside the tag.
async function streamOneAttempt(
  candidate: ChatCandidate,
  history: ProviderChatMessage[],
  overrides: ModelOverrides | undefined,
  task: TaskRow,
  sessionId: string,
  win: BrowserWindow | null
): Promise<StreamAttemptResult> {
  const provider = getProvider(candidate.providerId)
  if (!provider) throw new Error(`No provider registered for "${candidate.providerId}"`)

  let answer = ''
  let reasoning = ''
  let usage: { promptTokens: number; completionTokens: number } | undefined
  let forwardedLength = 0
  let tagDetected = false

  for await (const part of provider.streamChat(history, {
    modelId: candidate.modelId,
    temperature: overrides?.temperature,
    topP: overrides?.topP,
    maxTokens: overrides?.maxTokens,
    reasoningEffort: overrides?.reasoningEffort
  })) {
    if (part.type === 'answer') {
      answer += part.delta
      if (!tagDetected) {
        const tagStart = findEarliestTagStart(answer)
        if (tagStart !== -1) {
          tagDetected = true
          const preTag = answer.slice(forwardedLength, tagStart)
          if (preTag) {
            win?.webContents.send(IPC.events.chatChunk, {
              taskId: task.id,
              sessionId,
              channel: 'answer',
              delta: preTag
            })
          }
          forwardedLength = tagStart
        } else {
          const safeEnd = Math.max(forwardedLength, answer.length - MAX_TAG_PREFIX_LEN)
          if (safeEnd > forwardedLength) {
            win?.webContents.send(IPC.events.chatChunk, {
              taskId: task.id,
              sessionId,
              channel: 'answer',
              delta: answer.slice(forwardedLength, safeEnd)
            })
            forwardedLength = safeEnd
          }
        }
      }
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

  // Stream ended with no tag ever starting — release the trailing text held back as a
  // just-in-case buffer against a tag arriving in a later chunk.
  if (!tagDetected && forwardedLength < answer.length) {
    win?.webContents.send(IPC.events.chatChunk, {
      taskId: task.id,
      sessionId,
      channel: 'answer',
      delta: answer.slice(forwardedLength)
    })
  }

  return { answer, reasoning, usage }
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

  // The fallback list (every other configured provider's models) is only fetched after the
  // primary attempt actually fails — the common case (primary succeeds) never pays for it.
  let attempts: ChatCandidate[] = [await buildPrimaryCandidate(session)]

  let result: StreamAttemptResult | undefined
  let lastError = ''
  let lastProviderId: ProviderId = session.providerId
  let triedCount = 0

  for (let i = 0; i < attempts.length; i++) {
    const candidate = attempts[i]
    if (i > 0) win?.webContents.send(IPC.events.chatRetry, { taskId: task.id, sessionId })

    // Fit this attempt's history to its own model's real budget — a session's history can run
    // up to SESSION_TOKEN_CAP tokens (compressed as it grows, see context-compression.ts), but
    // any one model's actual context window is usually much smaller, and a fallback provider's
    // window can differ a lot from the session's usual one.
    const reserve = overrides?.maxTokens ?? Math.floor(candidate.contextLength * 0.25)
    const budget = Math.max(1000, candidate.contextLength - reserve)
    const history = fitHistoryToBudget(listMessagesForModel(sessionId), budget)
    if (task.systemPrompt) history.unshift({ role: 'system', content: task.systemPrompt })

    triedCount++
    try {
      result = await streamOneAttempt(candidate, history, overrides, task, sessionId, win)
      break
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      lastProviderId = candidate.providerId
      // First failure: now it's worth the cost of finding out what else is available.
      if (i === 0) attempts = attempts.concat(await buildFallbackCandidates(session.providerId))
    }
  }

  if (!result) {
    const error =
      triedCount > 1
        ? `All ${triedCount} providers failed. Last error (${lastProviderId}): ${lastError}`
        : lastError
    const failed = updateTask(task.id, { status: 'error', endedAt: Date.now(), error })
    emitTaskUpdate(win, failed)
    win?.webContents.send(IPC.events.chatError, { taskId: task.id, sessionId, error })
    return
  }

  try {
    let assistantContent = sanitizeAssistantText(result.answer)

    if (overrides?.imageGeneration) {
      const imageRequest = extractImageGenerationRequest(assistantContent)
      if (imageRequest) {
        assistantContent = imageRequest.remainder
        try {
          const image = await cloudflareImageProvider.generate(imageRequest.prompt)
          setSessionDocument(sessionId, {
            kind: 'file',
            content: image.dataUrl,
            mimeType: image.mimeType,
            fileName: 'generated-image.jpg'
          })
          try {
            saveToLibrary(sessionId, image.dataUrl, image.mimeType, 'generated-image.jpg', imageRequest.prompt)
            win?.webContents.send(IPC.events.libraryUpdated, { sessionId })
          } catch (libraryErr) {
            console.error('Failed to save generated image to library:', libraryErr)
          }
          assistantContent = assistantContent || '_Generated an image — see the panel above._'
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          assistantContent = [assistantContent, `_Image generation failed: ${message}_`]
            .filter(Boolean)
            .join('\n\n')
        }
      }
    }

    if (isDocumentModeEnabled(sessionId)) {
      const update = extractDocumentUpdate(assistantContent)
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

    if (overrides?.agentFileAccess) {
      const filesRequest = extractWriteFilesRequest(assistantContent)
      if (filesRequest) {
        assistantContent = filesRequest.remainder
        try {
          const customDir = overrides.agentWorkingDir?.trim() || null
          // A custom working directory is always the target regardless of the model's chosen
          // project name (see writeProjectFiles) — key the library link by the folder's own
          // name instead, so a resumed conversation reuses the same link no matter what name
          // the model picks that turn. Without a custom dir, the model's project name is the
          // only way to tell which auto-created subfolder a follow-up belongs to.
          const linkName = customDir ? basename(customDir) : filesRequest.request.project
          const existingLink = findLibraryLinkByName(sessionId, linkName)
          const existingPath = existingLink ? (getLibraryItemPath(existingLink.id) ?? null) : null
          const { projectPath, totalBytes } = writeProjectFiles(filesRequest.request, existingPath, customDir)
          if (existingLink) {
            relinkLibraryItem(existingLink.id, projectPath, totalBytes)
          } else {
            addLibraryItem({
              sessionId,
              fileName: linkName,
              filePath: projectPath,
              mimeType: 'inode/directory',
              sizeBytes: totalBytes,
              description: null,
              kind: 'link'
            })
          }
          win?.webContents.send(IPC.events.libraryUpdated, { sessionId })
          const fileList = filesRequest.request.files.map((f) => f.path).join(', ')
          const location = customDir ? projectPath : 'your Documents folder'
          assistantContent =
            assistantContent || `_Wrote "${linkName}" (${fileList}) to ${location} — see the library below._`
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          assistantContent = [assistantContent, `_Writing files failed: ${message}_`].filter(Boolean).join('\n\n')
        }
      }
    }

    addMessage(sessionId, 'assistant', assistantContent, result.reasoning || undefined)
    const done = updateTask(task.id, {
      status: 'done',
      endedAt: Date.now(),
      promptTokens: result.usage?.promptTokens ?? null,
      completionTokens: result.usage?.completionTokens ?? null,
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

// Runs after a file's already saved as the session's document and the IPC call has
// returned — the vision read is a real network round trip (a few seconds), and blocking
// setDocumentFile() on it would reintroduce exactly the "looks frozen" problem the rest of
// this pass fixed. Images get read (structured description/text/objects folded into a
// system message); every file (image or PDF) gets a library entry either way.
async function handleFileSideEffects(
  sessionId: string,
  dataUrl: string,
  mimeType: string,
  fileName: string,
  win: BrowserWindow | null
): Promise<void> {
  let description: string | null = null

  if (mimeType.startsWith('image/')) {
    try {
      const read = await readImage(dataUrl)
      description = read.description || null
      const summary = [
        `[Image loaded: ${fileName}]`,
        read.description ? `Description: ${read.description}` : '',
        read.text ? `Text found in image: ${read.text}` : '',
        read.objects.length ? `Notable elements: ${read.objects.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join('\n')
      addMessage(sessionId, 'system', summary)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      addMessage(sessionId, 'system', `[Image loaded: ${fileName}] (Could not read image contents: ${message})`)
    }
  }

  try {
    saveToLibrary(sessionId, dataUrl, mimeType, fileName, description)
  } catch (err) {
    console.error('Failed to save file to library:', err)
  }

  win?.webContents.send(IPC.events.libraryUpdated, { sessionId })
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
  ipcMain.handle(IPC.session.delete, async (_e, id) => {
    deleteSession(id)
    deleteLibraryDir(id)
  })

  ipcMain.handle(IPC.message.list, async (_e, sessionId) => listMessages(sessionId))
  ipcMain.handle(
    IPC.message.send,
    async (event, sessionId: string, content: string, overrides?: ModelOverrides) => {
      const session = getSession(sessionId)
      if (!session) throw new Error(`Unknown session "${sessionId}"`)

      addMessage(sessionId, 'user', content)

      const modeEnabled = isDocumentModeEnabled(sessionId)
      // Not gated by modeEnabled — a loaded image/PDF always has editing off (it's binary),
      // but the model still needs to know it exists so it doesn't deny having one at all.
      const document = getSessionDocument(sessionId)

      // Snapshot the agent's working directory (real file listing + small text file
      // contents) so it can write into an existing project accurately instead of only ever
      // scaffolding blind — see agent-files.ts's snapshotWorkingDirectory for the budget/
      // skip-list details. Only worth the disk walk when the override is actually on.
      const workingDirSnapshot = overrides?.agentFileAccess
        ? snapshotWorkingDirectory(overrides.agentWorkingDir?.trim() || projectsRoot())
        : null

      const task = createTask({
        parentTaskId: null,
        sessionId,
        providerId: session.providerId,
        modelId: session.modelId,
        systemPrompt: buildSystemPrompt(overrides, { document, modeEnabled }, workingDirSnapshot)
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

  // Per-session overrides (temperature, agentFileAccess, etc.) — previously a stub that
  // never persisted anything (the renderer kept them in local React state only, silently
  // reset on every restart or session switch, which is exactly why toggling something like
  // "agent file access" would appear to stop working). Session-scoped, not per-model: a
  // session already has one fixed provider/model, and overrides go with the conversation.
  ipcMain.handle(IPC.overrides.get, async (_e, sessionId: string) => getSessionOverrides(sessionId))
  ipcMain.handle(IPC.overrides.set, async (_e, sessionId: string, overrides: ModelOverrides) =>
    setSessionOverrides(sessionId, overrides)
  )
  // A deliberate, explicit save (a button in Settings) rather than every per-session tweak —
  // seeds brand-new sessions going forward, doesn't retroactively touch existing ones.
  ipcMain.handle(IPC.overrides.getDefault, async () => getDefaultOverrides())
  ipcMain.handle(IPC.overrides.setDefault, async (_e, overrides: ModelOverrides) => setDefaultOverrides(overrides))

  ipcMain.handle(IPC.system.pickFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

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
  ipcMain.handle(IPC.document.setFile, async (event, sessionId, content, mimeType, fileName) => {
    if (content.length > MAX_DOCUMENT_FILE_BYTES) {
      throw new Error('File is too large (max 15MB)')
    }
    const saved = setSessionDocument(sessionId, { kind: 'file', content, mimeType, fileName })

    const win = BrowserWindow.fromWebContents(event.sender)
    void handleFileSideEffects(sessionId, content, mimeType, fileName, win)

    return saved
  })
  ipcMain.handle(IPC.document.getMode, async (_e, sessionId) => isDocumentModeEnabled(sessionId))
  ipcMain.handle(IPC.document.setMode, async (_e, sessionId, enabled) => setDocumentMode(sessionId, enabled))

  ipcMain.handle(IPC.library.list, async (_e, sessionId) => {
    // 'missing' is computed fresh on every list call, not stored — a link's real target can
    // move or get deleted at any time outside the app's knowledge.
    return listLibraryItems(sessionId).map((item) => {
      if (item.kind !== 'link') return item
      const path = getLibraryItemPath(item.id)
      return { ...item, missing: !path || !existsSync(path) }
    })
  })
  ipcMain.handle(IPC.library.open, async (_e, id) => {
    const path = getLibraryItemPath(id)
    if (!path) throw new Error(`No library item with id "${id}"`)
    const result = await shell.openPath(path)
    if (result) throw new Error(`Could not open file: ${result}`)
  })
  ipcMain.handle(IPC.library.reorder, async (_e, _sessionId, orderedIds) => reorderLibraryItems(orderedIds))
  ipcMain.handle(IPC.library.relink, async (_e, id, newPath) => {
    if (!existsSync(newPath)) throw new Error('That path no longer exists')
    const stat = statSync(newPath)
    const sizeBytes = stat.isDirectory() ? folderSizeBytes(newPath) : stat.size
    return relinkLibraryItem(id, newPath, sizeBytes)
  })
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
