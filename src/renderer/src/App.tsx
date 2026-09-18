import { useEffect, useState } from 'react'
import type { ChatMessage, ModelInfo, ModelOverrides, ProviderId, SessionSummary, StoredKeyInfo } from '@shared/models'
import Sidebar from './Sidebar'
import ChatPane from './ChatPane'
import SettingsScreen from './SettingsScreen'
import NewSessionPicker from './NewSessionPicker'
import TaskMonitorPanel from './TaskMonitorPanel'
import UsageTracker from './UsageTracker'
import DocumentPanel from './DocumentPanel'
import LibraryPanel from './LibraryPanel'
import { ALL_PROVIDERS, DEFAULT_OVERRIDES } from './mockData'

function emptyRecord<T>(fill: T): Record<ProviderId, T> {
  return Object.fromEntries(ALL_PROVIDERS.map((id) => [id, fill])) as Record<ProviderId, T>
}

type View = 'chat' | 'settings'
type PickerMode = 'new' | 'switch' | null

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [view, setView] = useState<View>('chat')
  const [pickerMode, setPickerMode] = useState<PickerMode>(null)
  const [creatingSession, setCreatingSession] = useState(false)
  const [pendingSessionIds, setPendingSessionIds] = useState<Set<string>>(new Set())
  const [showMonitor, setShowMonitor] = useState(true)
  const [apiKeysByProvider, setApiKeysByProvider] = useState<Record<ProviderId, StoredKeyInfo[]>>(
    emptyRecord<StoredKeyInfo[]>([])
  )
  const [activeKeyByProvider, setActiveKeyByProvider] = useState<Record<ProviderId, string | null>>(
    emptyRecord<string | null>(null)
  )
  const [allowPaidByProvider, setAllowPaidByProvider] = useState<Record<ProviderId, boolean>>(
    emptyRecord(false)
  )
  const [overridesBySession, setOverridesBySession] = useState<Record<string, ModelOverrides>>({})
  // The chat input's unsent text, per session — kept in memory on every keystroke (cheap),
  // flushed to disk only at specific moments (opening Settings, the window closing), not
  // continuously, since a draft is low-stakes compared to what already gets saved eagerly.
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({})

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const activeMessages = messages.filter((m) => m.sessionId === activeSessionId)
  const activeOverrides = (activeSessionId && overridesBySession[activeSessionId]) || DEFAULT_OVERRIDES
  const activeModelInfo = activeSession
    ? models.find((m) => m.providerId === activeSession.providerId && m.modelId === activeSession.modelId)
    : undefined

  function replaceSessionMessages(sessionId: string, next: ChatMessage[]): void {
    setMessages((prev) => [...prev.filter((m) => m.sessionId !== sessionId), ...next])
  }

  function refreshProviderStatus(): void {
    Promise.all(
      ALL_PROVIDERS.map((id) =>
        Promise.all([window.api.getProviderStatus(id), window.api.listApiKeys(id)])
      )
    )
      .then((results) => {
        const nextActive: Record<ProviderId, string | null> = emptyRecord<string | null>(null)
        const nextAllowPaid: Record<ProviderId, boolean> = emptyRecord(false)
        const nextKeys: Record<ProviderId, StoredKeyInfo[]> = emptyRecord<StoredKeyInfo[]>([])
        ALL_PROVIDERS.forEach((id, i) => {
          const [status, keys] = results[i]
          nextActive[id] = status.activeKeyId
          nextAllowPaid[id] = status.allowPaid
          nextKeys[id] = keys
        })
        setActiveKeyByProvider(nextActive)
        setAllowPaidByProvider(nextAllowPaid)
        setApiKeysByProvider(nextKeys)
      })
      .catch(console.error)
  }

  // Initial load: sessions, models, and every provider's saved keys/allow-paid status.
  useEffect(() => {
    window.api
      .listSessions()
      .then(setSessions)
      .catch(console.error)
      .finally(() => setSessionsLoaded(true))
    window.api
      .listModels()
      .then(setModels)
      .catch(console.error)
      .finally(() => setModelsLoaded(true))
    refreshProviderStatus()
  }, [])

  // Load message history whenever the active session changes.
  useEffect(() => {
    if (!activeSessionId) return
    window.api
      .listMessages(activeSessionId)
      .then((msgs) => replaceSessionMessages(activeSessionId, msgs))
      .catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // Hydrate this session's saved overrides once, the first time it's opened — previously
  // these lived only in local state and silently reset on every restart or session switch
  // (a toggle like "agent file access" would look like it stopped working for no reason).
  useEffect(() => {
    if (!activeSessionId || overridesBySession[activeSessionId]) return
    window.api
      .getSessionOverrides(activeSessionId)
      .then((saved) => {
        if (saved) setOverridesBySession((prev) => ({ ...prev, [activeSessionId]: saved }))
      })
      .catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // Hydrate this session's saved draft once, the first time it's opened — restores whatever
  // was half-typed the last time the window closed.
  useEffect(() => {
    if (!activeSessionId || draftBySession[activeSessionId] !== undefined) return
    window.api
      .getSessionDraft(activeSessionId)
      .then((saved) => {
        if (saved) setDraftBySession((prev) => ({ ...prev, [activeSessionId]: saved }))
      })
      .catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  function handleDraftChange(text: string): void {
    if (!activeSessionId) return
    setDraftBySession((prev) => ({ ...prev, [activeSessionId]: text }))
  }

  // Flushes the active session's draft to disk — called at the two moments that matter
  // (opening Settings, the window closing), not on every keystroke.
  function flushActiveDraft(): void {
    if (!activeSessionId) return
    window.api.setSessionDraft(activeSessionId, draftBySession[activeSessionId] ?? '').catch(console.error)
  }

  // Re-registered whenever the draft or active session changes so the listener always closes
  // over the current value — window-level, so it fires for the OS close button too.
  useEffect(() => {
    window.addEventListener('beforeunload', flushActiveDraft)
    return () => window.removeEventListener('beforeunload', flushActiveDraft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, draftBySession])

  function handleOpenSettings(): void {
    flushActiveDraft()
    setView('settings')
  }

  function clearPending(sessionId: string): void {
    setPendingSessionIds((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }

  // Live streaming events from main, for the whole app's lifetime (not just the active session).
  useEffect(() => {
    const offChunk = window.api.onChatChunk((evt) => {
      // Only real answer text should stop the "thinking..." indicator — a reasoning-only
      // chunk was clearing it prematurely (the dot would vanish the instant a reasoning
      // model started its thinking phase, well before any visible answer content existed,
      // since reasoning itself isn't rendered in the chat bubble at all).
      if (evt.channel === 'answer') clearPending(evt.sessionId)
      setMessages((prev) => {
        const existing = prev.find((m) => m.id === evt.taskId)
        if (existing) {
          return prev.map((m) =>
            m.id === evt.taskId
              ? {
                  ...m,
                  content: evt.channel === 'answer' ? m.content + evt.delta : m.content,
                  reasoning: evt.channel === 'reasoning' ? (m.reasoning ?? '') + evt.delta : m.reasoning
                }
              : m
          )
        }
        const placeholder: ChatMessage = {
          id: evt.taskId,
          sessionId: evt.sessionId,
          role: 'assistant',
          content: evt.channel === 'answer' ? evt.delta : '',
          reasoning: evt.channel === 'reasoning' ? evt.delta : undefined,
          createdAt: Date.now(),
          compressed: false
        }
        return [...prev, placeholder]
      })
    })

    const offRetry = window.api.onChatRetry((evt) => {
      // A fallback attempt is starting after a provider failure — wipe whatever partial
      // text the failed attempt had streamed in, back to just the thinking indicator, so
      // the user never sees a half-written response from a call that's being abandoned.
      setPendingSessionIds((prev) => new Set(prev).add(evt.sessionId))
      setMessages((prev) =>
        prev.map((m) => (m.id === evt.taskId ? { ...m, content: '', reasoning: undefined } : m))
      )
    })

    const offDone = window.api.onChatDone((evt) => {
      clearPending(evt.sessionId)
      window.api
        .listMessages(evt.sessionId)
        .then((msgs) => replaceSessionMessages(evt.sessionId, msgs))
        .catch(console.error)
    })

    const offError = window.api.onChatError((evt) => {
      clearPending(evt.sessionId)
      const isRateLimit = /\b429\b/.test(evt.error)
      const content = isRateLimit
        ? `Error: ${evt.error}\n\n_This looks like a rate limit — try switching to a different saved key for this provider (or another provider) in Settings._`
        : `Error: ${evt.error}`
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${evt.taskId}`,
          sessionId: evt.sessionId,
          role: 'system',
          content,
          createdAt: Date.now(),
          compressed: false
        }
      ])
    })

    // A library update (file loaded, image generated) may have added a system message
    // outside of any chat task (e.g. the vision-read summary after an upload) — refresh
    // that session's messages the same way a chatDone would.
    const offLibrary = window.api.onLibraryUpdated((evt) => {
      window.api
        .listMessages(evt.sessionId)
        .then((msgs) => replaceSessionMessages(evt.sessionId, msgs))
        .catch(console.error)
    })

    return () => {
      offChunk()
      offRetry()
      offDone()
      offError()
      offLibrary()
    }
  }, [])

  function handleSelectSession(id: string): void {
    setActiveSessionId(id)
    setView('chat')
  }

  function handleRenameSession(id: string, title: string): void {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    window.api.renameSession(id, title).catch(console.error)
  }

  function handleToggleArchive(id: string): void {
    const next = !sessions.find((s) => s.id === id)?.archived
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, archived: next } : s)))
    window.api.setSessionArchived(id, next).catch(console.error)
  }

  function handleDeleteSession(id: string): void {
    setSessions((prev) => prev.filter((s) => s.id !== id))
    setMessages((prev) => prev.filter((m) => m.sessionId !== id))
    if (activeSessionId === id) setActiveSessionId(null)
    window.api.deleteSession(id).catch(console.error)
  }

  function handlePickModel(model: ModelInfo): void {
    setCreatingSession(true)

    if (pickerMode === 'switch' && activeSessionId) {
      window.api
        .updateSessionModel(activeSessionId, model.providerId, model.modelId)
        .then(() => {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === activeSessionId ? { ...s, providerId: model.providerId, modelId: model.modelId } : s
            )
          )
          return window.api.listMessages(activeSessionId)
        })
        .then((msgs) => replaceSessionMessages(activeSessionId, msgs))
        .catch(console.error)
        .finally(() => {
          setCreatingSession(false)
          setPickerMode(null)
        })
      return
    }

    window.api
      .createSession(model.providerId, model.modelId, `New chat (${model.label})`)
      .then((session) => {
        setSessions((prev) => [session, ...prev])
        setActiveSessionId(session.id)
        setView('chat')
        // Seed from the user's saved default overrides (if they've ever saved one) instead
        // of always starting a fresh session from the hardcoded app defaults.
        return window.api.getDefaultOverrides().then((defaults) => {
          if (!defaults) return
          setOverridesBySession((prev) => ({ ...prev, [session.id]: defaults }))
          window.api.setSessionOverrides(session.id, defaults).catch(console.error)
        })
      })
      .catch(console.error)
      .finally(() => {
        setCreatingSession(false)
        setPickerMode(null)
      })
  }

  function handleSend(content: string): void {
    if (!activeSessionId) return
    const sessionId = activeSessionId
    // The sent text is no longer "unsent" — clear the draft locally and on disk so a crash
    // right after sending doesn't resurrect it as a stale draft on next launch.
    setDraftBySession((prev) => ({ ...prev, [sessionId]: '' }))
    window.api.setSessionDraft(sessionId, '').catch(console.error)
    const optimisticUser: ChatMessage = {
      id: `local-${Date.now()}`,
      sessionId,
      role: 'user',
      content,
      createdAt: Date.now(),
      compressed: false
    }
    setMessages((prev) => [...prev, optimisticUser])
    setPendingSessionIds((prev) => new Set(prev).add(sessionId))
    window.api.sendMessage(sessionId, content, activeOverrides).catch((err: unknown) => {
      clearPending(sessionId)
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          sessionId,
          role: 'system',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: Date.now(),
          compressed: false
        }
      ])
    })
  }

  function handleAddApiKey(providerId: ProviderId, label: string, apiKey: string): void {
    window.api.addApiKey(providerId, label, apiKey).then(refreshProviderStatus).catch(console.error)
  }

  function handleRemoveApiKey(providerId: ProviderId, keyId: string): void {
    window.api.removeApiKey(providerId, keyId).then(refreshProviderStatus).catch(console.error)
  }

  function handleSetActiveApiKey(providerId: ProviderId, keyId: string): void {
    window.api.setActiveApiKey(providerId, keyId).then(refreshProviderStatus).catch(console.error)
  }

  function handleSetAllowPaid(providerId: ProviderId, allow: boolean): void {
    setAllowPaidByProvider((prev) => ({ ...prev, [providerId]: allow }))
    window.api.setProviderAllowPaid(providerId, allow).catch(console.error)
  }

  function handleUpdateOverrides(patch: Partial<ModelOverrides>): void {
    if (!activeSessionId) return
    const sessionId = activeSessionId
    const merged = { ...(overridesBySession[sessionId] || DEFAULT_OVERRIDES), ...patch }
    setOverridesBySession((prev) => ({ ...prev, [sessionId]: merged }))
    window.api.setSessionOverrides(sessionId, merged).catch(console.error)
  }

  // A deliberate save (the "Save as default" button), not fired on every per-session tweak —
  // only changes what a brand-new session is seeded with going forward.
  function handleSaveAsDefaultOverrides(overrides: ModelOverrides): void {
    window.api.saveAsDefaultOverrides(overrides).catch(console.error)
  }

  return (
    <div
      style={{ display: 'flex', height: '100vh', backgroundColor: '#15151d', color: '#eee' }}
    >
      <Sidebar
        sessions={sessions}
        loading={!sessionsLoaded}
        activeSessionId={activeSessionId}
        onSelect={handleSelectSession}
        onRename={handleRenameSession}
        onToggleArchive={handleToggleArchive}
        onDelete={handleDeleteSession}
        onNewSession={() => setPickerMode('new')}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: '1px solid #333', alignItems: 'center' }}>
          <button onClick={() => setView('chat')} disabled={view === 'chat'}>
            Chat
          </button>
          <button onClick={handleOpenSettings} disabled={view === 'settings'}>
            Settings
          </button>
          {view === 'chat' && activeSession && (
            <button onClick={() => setPickerMode('switch')}>Switch model</button>
          )}
          <button onClick={() => setShowMonitor((v) => !v)} style={{ marginLeft: 'auto' }}>
            {showMonitor ? 'Hide monitor' : 'Show monitor'}
          </button>
        </div>
        {view === 'chat' && activeSession && (
          <UsageTracker
            sessionId={activeSession.id}
            contextLength={activeModelInfo?.contextLength}
            contextLengthApprox={activeModelInfo?.contextLengthApprox}
          />
        )}
        {view === 'chat' && activeSession && <DocumentPanel sessionId={activeSession.id} />}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
          {view === 'chat' ? (
            <ChatPane
              session={activeSession}
              messages={activeMessages}
              onSend={handleSend}
              isPending={activeSessionId ? pendingSessionIds.has(activeSessionId) : false}
              draft={activeSessionId ? (draftBySession[activeSessionId] ?? '') : ''}
              onDraftChange={handleDraftChange}
            />
          ) : (
            <SettingsScreen
              apiKeysByProvider={apiKeysByProvider}
              activeKeyByProvider={activeKeyByProvider}
              allowPaidByProvider={allowPaidByProvider}
              onAddApiKey={handleAddApiKey}
              onRemoveApiKey={handleRemoveApiKey}
              onSetActiveApiKey={handleSetActiveApiKey}
              onSetAllowPaid={handleSetAllowPaid}
              activeSession={activeSession}
              overrides={activeOverrides}
              onUpdateOverrides={handleUpdateOverrides}
              onSaveAsDefaultOverrides={handleSaveAsDefaultOverrides}
            />
          )}
        </div>
        {view === 'chat' && activeSession && <LibraryPanel sessionId={activeSession.id} />}
      </div>
      {showMonitor && <TaskMonitorPanel />}
      {pickerMode && (
        <NewSessionPicker
          models={models}
          loading={!modelsLoaded}
          creating={creatingSession}
          onPick={handlePickModel}
          onCancel={() => setPickerMode(null)}
        />
      )}
    </div>
  )
}
