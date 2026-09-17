import { useState } from 'react'
import type { ChatMessage, SessionSummary } from '@shared/models'
import { PROVIDER_LABELS } from './mockData'

interface ChatPaneProps {
  session: SessionSummary | null
  messages: ChatMessage[]
  onSend: (content: string) => void
}

export default function ChatPane({ session, messages, onSend }: ChatPaneProps): React.JSX.Element {
  const [draft, setDraft] = useState('')

  function handleSend(): void {
    const content = draft.trim()
    if (!content) return
    onSend(content)
    setDraft('')
  }

  if (!session) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.6 }}>
        Select or start a session to begin chatting.
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #333' }}>
        <strong>{session.title}</strong>
        <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>
          {PROVIDER_LABELS[session.providerId]} · {session.modelId}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '70%',
              backgroundColor: msg.role === 'user' ? '#2d5f8a' : msg.role === 'assistant' ? '#333340' : '#5a4a2a',
              borderRadius: 10,
              padding: '8px 12px'
            }}
          >
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4, textTransform: 'uppercase' }}>{msg.role}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #333' }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend()
          }}
          placeholder="Type a message..."
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={handleSend} style={{ padding: '8px 16px', cursor: 'pointer' }}>
          Send
        </button>
      </div>
    </div>
  )
}
