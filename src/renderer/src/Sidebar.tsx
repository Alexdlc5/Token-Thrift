import { useState } from 'react'
import type { SessionSummary } from '@shared/models'
import { PROVIDER_LABELS } from './mockData'

interface SidebarProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onToggleArchive: (id: string) => void
  onDelete: (id: string) => void
  onNewSession: () => void
}

export default function Sidebar({
  sessions,
  activeSessionId,
  onSelect,
  onRename,
  onToggleArchive,
  onDelete,
  onNewSession
}: SidebarProps): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')

  function startEditing(session: SessionSummary): void {
    setEditingId(session.id)
    setDraftTitle(session.title)
  }

  function commitEditing(): void {
    if (editingId && draftTitle.trim()) {
      onRename(editingId, draftTitle.trim())
    }
    setEditingId(null)
  }

  return (
    <div style={{ width: 260, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 12, borderBottom: '1px solid #333' }}>
        <button onClick={onNewSession} style={{ width: '100%', padding: 8, cursor: 'pointer' }}>
          + New session
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sessions.map((session) => (
          <div
            key={session.id}
            onClick={() => onSelect(session.id)}
            style={{
              padding: '10px 12px',
              cursor: 'pointer',
              backgroundColor: session.id === activeSessionId ? '#2a2a3a' : 'transparent',
              opacity: session.archived ? 0.5 : 1,
              borderBottom: '1px solid #2a2a2a'
            }}
          >
            {editingId === session.id ? (
              <input
                autoFocus
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={commitEditing}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEditing()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onClick={(e) => e.stopPropagation()}
                style={{ width: '100%' }}
              />
            ) : (
              <div
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  startEditing(session)
                }}
                style={{ fontWeight: session.id === activeSessionId ? 600 : 400 }}
              >
                {session.title}
              </div>
            )}
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
              {PROVIDER_LABELS[session.providerId]} · {session.modelId}
            </div>
            <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  startEditing(session)
                }}
                style={{ fontSize: 11 }}
              >
                Rename
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleArchive(session.id)
                }}
                style={{ fontSize: 11 }}
              >
                {session.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`Delete "${session.title}"? This can't be undone.`)) {
                    onDelete(session.id)
                  }
                }}
                style={{ fontSize: 11 }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
