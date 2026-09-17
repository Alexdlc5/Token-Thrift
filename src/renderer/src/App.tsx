import { useEffect, useState } from 'react'
import type { ChatMessage, ModelInfo, ModelOverrides, ProviderId, SessionSummary } from '@shared/models'
import Sidebar from './Sidebar'
import ChatPane from './ChatPane'
import SettingsScreen, { type ProviderSetting } from './SettingsScreen'
import NewSessionPicker from './NewSessionPicker'
import TaskMonitorPanel from './TaskMonitorPanel'
import UsageTracker from './UsageTracker'
import { DEFAULT_OVERRIDES } from './mockData'

const ALL_PROVIDERS: ProviderId[] = [
  'openrouter',
  'groq',
  'google-ai-studio',
  'cerebras',
  'nvidia-nim',
  'huggingface'
]

function emptyProviderSettings(): Record<ProviderId, ProviderSetting> {
  return Object.fromEntries(ALL_PROVIDERS.map((id) => [id, { apiKey: '', allowPaid: false }])) as Record<
    ProviderId,
    ProviderSetting
  >
}

type View = 'chat' | 'settings'

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [view, setView] = useState<View>('chat')
  const [showPicker, setShowPicker] = useState(false)
  const [showMonitor, setShowMonitor] = useState(true)
  const [providerSettings, setProviderSettings] = useState<Record<ProviderId, ProviderSetting>>(
    emptyProviderSettings()
  )
  const [overridesBySession, setOverridesBySession] = useState<Record<string, ModelOverrides>>({})

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const activeMessages = messages.filter((m) => m.sessionId === activeSessionId)
  const activeOverrides = (activeSessionId && overridesBySession[activeSessionId]) || DEFAULT_OVERRIDES
  const activeModelInfo = activeSession
    ? models.find((m) => m.providerId === activeSession.providerId && m.modelId === activeSession.modelId)
    : undefined

  function replaceSessionMessages(sessionId: string, next: ChatMessage[]): void {
    setMessages((prev) => [...prev.filter((m) => m.sessionId !== sessionId), ...next])
  }

  // Initial load: sessions, models, and each provider's stored-key/allow-paid status.
  useEffect(() => {
    window.api.listSessions().then(setSessions).catch(console.error)
    window.api.listModels().then(setModels).catch(console.error)
    Promise.all(ALL_PROVIDERS.map((id) => window.api.getProviderStatus(id)))
      .then((statuses) => {
        setProviderSettings((prev) => {
          const next = { ...prev }
          ALL_PROVIDERS.forEach((id, i) => {
            next[id] = { apiKey: '', allowPaid: statuses[i].allowPaid }
          })
          return next
        })
      })
      .catch(console.error)
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

  // Live streaming events from main, for the whole app's lifetime (not just the active session).
  useEffect(() => {
    const offChunk = window.api.onChatChunk((evt) => {
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
          createdAt: Date.now()
        }
        return [...prev, placeholder]
      })
    })

    const offDone = window.api.onChatDone((evt) => {
      window.api
        .listMessages(evt.sessionId)
        .then((msgs) => replaceSessionMessages(evt.sessionId, msgs))
        .catch(console.error)
    })

    const offError = window.api.onChatError((evt) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${evt.taskId}`,
          sessionId: evt.sessionId,
          role: 'system',
          content: `Error: ${evt.error}`,
          createdAt: Date.now()
        }
      ])
    })

    return () => {
      offChunk()
      offDone()
      offError()
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

  function handlePickModel(model: ModelInfo): void {
    window.api
      .createSession(model.providerId, model.modelId, `New chat (${model.label})`)
      .then((session) => {
        setSessions((prev) => [session, ...prev])
        setActiveSessionId(session.id)
        setShowPicker(false)
        setView('chat')
      })
      .catch(console.error)
  }

  function handleSend(content: string): void {
    if (!activeSessionId) return
    const sessionId = activeSessionId
    const optimisticUser: ChatMessage = {
      id: `local-${Date.now()}`,
      sessionId,
      role: 'user',
      content,
      createdAt: Date.now()
    }
    setMessages((prev) => [...prev, optimisticUser])
    window.api.sendMessage(sessionId, content, activeOverrides).catch((err: unknown) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          sessionId,
          role: 'system',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: Date.now()
        }
      ])
    })
  }

  function handleUpdateProviderSetting(providerId: ProviderId, patch: Partial<ProviderSetting>): void {
    setProviderSettings((prev) => ({ ...prev, [providerId]: { ...prev[providerId], ...patch } }))
    if (patch.apiKey !== undefined) {
      window.api.setProviderApiKey(providerId, patch.apiKey).catch(console.error)
    }
    if (patch.allowPaid !== undefined) {
      window.api.setProviderAllowPaid(providerId, patch.allowPaid).catch(console.error)
    }
  }

  function handleUpdateOverrides(patch: Partial<ModelOverrides>): void {
    if (!activeSessionId) return
    setOverridesBySession((prev) => ({
      ...prev,
      [activeSessionId]: { ...(prev[activeSessionId] || DEFAULT_OVERRIDES), ...patch }
    }))
  }

  return (
    <div
      style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif', backgroundColor: '#15151d', color: '#eee' }}
    >
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={handleSelectSession}
        onRename={handleRenameSession}
        onToggleArchive={handleToggleArchive}
        onNewSession={() => setShowPicker(true)}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: '1px solid #333' }}>
          <button onClick={() => setView('chat')} disabled={view === 'chat'}>
            Chat
          </button>
          <button onClick={() => setView('settings')} disabled={view === 'settings'}>
            Settings
          </button>
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
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
          {view === 'chat' ? (
            <ChatPane session={activeSession} messages={activeMessages} onSend={handleSend} />
          ) : (
            <SettingsScreen
              providerSettings={providerSettings}
              onUpdateProviderSetting={handleUpdateProviderSetting}
              activeSession={activeSession}
              overrides={activeOverrides}
              onUpdateOverrides={handleUpdateOverrides}
            />
          )}
        </div>
      </div>
      {showMonitor && <TaskMonitorPanel />}
      {showPicker && (
        <NewSessionPicker models={models} onPick={handlePickModel} onCancel={() => setShowPicker(false)} />
      )}
    </div>
  )
}
