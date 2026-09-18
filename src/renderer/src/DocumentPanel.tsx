import { useEffect, useRef, useState } from 'react'
import type { SessionDocument } from '@shared/models'

interface DocumentPanelProps {
  sessionId: string
}

const MAX_FILE_BYTES = 15 * 1024 * 1024
const SAVE_DEBOUNCE_MS = 600

// The "working file" panel, shown above the chat input. A text document is editable by both
// the user (this textarea) and the model (via the <document> response convention in
// prompt-modules.ts) — loading an image/PDF instead makes it a read-only reference, since
// nothing in this app can generate binary files.
export default function DocumentPanel({ sessionId }: DocumentPanelProps): React.JSX.Element {
  const [doc, setDoc] = useState<SessionDocument | null>(null)
  const [modeEnabled, setModeEnabled] = useState(false)
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  function load(): void {
    window.api
      .getDocument(sessionId)
      .then((d) => {
        setDoc(d)
        setDraft(d?.kind === 'text' ? d.content : '')
      })
      .catch(console.error)
    window.api.getDocumentMode(sessionId).then(setModeEnabled).catch(console.error)
  }

  useEffect(() => {
    load()
    return () => clearTimeout(saveTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Re-fetch after any response completes for this session — a document-mode edit may have
  // just landed.
  useEffect(() => {
    const off = window.api.onChatDone((evt) => {
      if (evt.sessionId === sessionId) load()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  function handleDraftChange(value: string): void {
    setDraft(value)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.api.setDocumentText(sessionId, value).then(setDoc).catch(console.error)
    }, SAVE_DEBOUNCE_MS)
  }

  function handleToggleMode(): void {
    const next = !modeEnabled
    setModeEnabled(next)
    window.api.setDocumentMode(sessionId, next).catch(console.error)
  }

  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked later
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      alert('File is too large (max 15MB)')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      window.api
        .setDocumentFile(sessionId, reader.result as string, file.type || 'application/octet-stream', file.name)
        .then((saved) => {
          setDoc(saved)
          // Editing a binary reference file doesn't mean anything — turn document mode off.
          setModeEnabled(false)
          window.api.setDocumentMode(sessionId, false).catch(console.error)
        })
        .catch((err: unknown) => alert(err instanceof Error ? err.message : String(err)))
    }
    reader.readAsDataURL(file)
  }

  function handleStartTextDoc(): void {
    window.api
      .setDocumentText(sessionId, '', 'Untitled document')
      .then((saved) => {
        setDoc(saved)
        setDraft('')
      })
      .catch(console.error)
  }

  return (
    <div style={{ borderBottom: '1px solid #333' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', fontSize: 12 }}>
        <strong>{doc?.fileName || 'Document'}</strong>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            opacity: doc?.kind === 'file' ? 0.4 : 1
          }}
        >
          <input
            type="checkbox"
            checked={modeEnabled}
            disabled={doc?.kind === 'file'}
            onChange={handleToggleMode}
          />
          Let model edit
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,application/pdf"
          onChange={handleFilePicked}
          style={{ display: 'none' }}
        />
        <button onClick={() => fileInputRef.current?.click()}>Load image/PDF</button>
        {!doc && <button onClick={handleStartTextDoc}>Start text document</button>}
        <button onClick={() => setCollapsed((v) => !v)} style={{ marginLeft: 'auto' }}>
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>
      {!collapsed && (
        <div style={{ maxHeight: 340, overflow: 'auto' }}>
          {!doc && (
            <div style={{ padding: '4px 12px 12px', fontSize: 12, opacity: 0.6 }}>
              No document yet — start a text document the model can edit, or load an
              image/PDF to keep as a reference.
            </div>
          )}
          {doc?.kind === 'text' && (
            <textarea
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              rows={12}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: 12,
                fontFamily: 'inherit',
                fontSize: 13,
                border: 'none',
                resize: 'vertical',
                backgroundColor: '#1a1a22',
                color: '#eee'
              }}
            />
          )}
          {doc?.kind === 'file' && doc.mimeType?.startsWith('image/') && (
            <img
              src={doc.content}
              alt={doc.fileName ?? 'loaded image'}
              style={{ maxWidth: '100%', display: 'block' }}
            />
          )}
          {doc?.kind === 'file' && doc.mimeType === 'application/pdf' && (
            <iframe
              src={doc.content}
              title={doc.fileName ?? 'loaded PDF'}
              style={{ width: '100%', height: 340, border: 'none' }}
            />
          )}
          {doc?.kind === 'file' &&
            doc.mimeType &&
            !doc.mimeType.startsWith('image/') &&
            doc.mimeType !== 'application/pdf' && (
              <div style={{ padding: '4px 12px 12px', fontSize: 12, opacity: 0.6 }}>
                Unsupported file type: {doc.mimeType}
              </div>
            )}
        </div>
      )}
    </div>
  )
}
