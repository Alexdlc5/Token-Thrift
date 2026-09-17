import { useState } from 'react'
import type { ChatMessage, ModelInfo, ModelOverrides, ProviderId, SessionSummary } from '@shared/models'
import Sidebar from './Sidebar'
import ChatPane from './ChatPane'
import SettingsScreen, { type ProviderSetting } from './SettingsScreen'
import NewSessionPicker from './NewSessionPicker'
import { DEFAULT_OVERRIDES, MOCK_MESSAGES, MOCK_MODELS, MOCK_SESSIONS } from './mockData'

const ALL_PROVIDERS: ProviderId[] = ['openrouter', 'groq', 'google-ai-studio', 'cerebras', 'nvidia-nim', 'huggingface']

function makeDefaultProviderSettings(): Record<ProviderId, ProviderSetting> {
  return Object.fromEntries(ALL_PROVIDERS.map((id) => [id, { apiKey: '', allowPaid: false }])) as Record<
    ProviderId,
    ProviderSetting
  >
}

let nextId = 1000

type View = 'chat' | 'settings'

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>(MOCK_SESSIONS)
  const [messages, setMessages] = useState<ChatMessage[]>(MOCK_MESSAGES)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(MOCK_SESSIONS[0]?.id ?? null)
  const [view, setView] = useState<View>('chat')
  const [showPicker, setShowPicker] = useState(false)
  const [providerSettings, setProviderSettings] = useState<Record<ProviderId, ProviderSetting>>(
    makeDefaultProviderSettings()
  )
  const [overridesBySession, setOverridesBySession] = useState<Record<string, ModelOverrides>>({})

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const activeMessages = messages.filter((m) => m.sessionId === activeSessionId)
  const activeOverrides = (activeSessionId && overridesBySession[activeSessionId]) || DEFAULT_OVERRIDES

  function handleSelectSession(id: string): void {
    setActiveSessionId(id)
    setView('chat')
  }

  function handleRenameSession(id: string, title: string): void {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
  }

  function handleToggleArchive(id: string): void {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, archived: !s.archived } : s)))
  }

  function handlePickModel(model: ModelInfo): void {
    const id = `s${nextId++}`
    const newSession: SessionSummary = {
      id,
      providerId: model.providerId,
      modelId: model.modelId,
      title: `New chat (${model.label})`,
      createdAt: Date.now(),
      archived: false
    }
    setSessions((prev) => [newSession, ...prev])
    setActiveSessionId(id)
    setShowPicker(false)
    setView('chat')
  }

  function handleSend(content: string): void {
    if (!activeSessionId) return
    const userMessage: ChatMessage = {
      id: `m${nextId++}`,
      sessionId: activeSessionId,
      role: 'user',
      content,
      createdAt: Date.now()
    }
    setMessages((prev) => [...prev, userMessage])

    // Optional polish: fake an assistant echo reply after a short delay.
    const sessionId = activeSessionId
    setTimeout(() => {
      const reply: ChatMessage = {
        id: `m${nextId++}`,
        sessionId,
        role: 'assistant',
        content: `(mock reply) You said: "${content}"`,
        createdAt: Date.now()
      }
      setMessages((prev) => [...prev, reply])
    }, 600)
  }

  function handleUpdateProviderSetting(providerId: ProviderId, patch: Partial<ProviderSetting>): void {
    setProviderSettings((prev) => ({ ...prev, [providerId]: { ...prev[providerId], ...patch } }))
  }

  function handleUpdateOverrides(patch: Partial<ModelOverrides>): void {
    if (!activeSessionId) return
    setOverridesBySession((prev) => ({
      ...prev,
      [activeSessionId]: { ...(prev[activeSessionId] || DEFAULT_OVERRIDES), ...patch }
    }))
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif', backgroundColor: '#15151d', color: '#eee' }}>
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
        </div>
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
      {showPicker && (
        <NewSessionPicker models={MOCK_MODELS} onPick={handlePickModel} onCancel={() => setShowPicker(false)} />
      )}
    </div>
  )
}
