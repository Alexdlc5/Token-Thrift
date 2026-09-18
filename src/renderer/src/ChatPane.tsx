import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, SessionSummary } from '@shared/models'
import { PROVIDER_LABELS } from './mockData'

/** Shared by the whole-message copy button and each code block's — `getText` is a lazy
 * getter (not a plain string) so the code-block variant can read the live DOM at click time
 * instead of trying to reconstruct source text from react-markdown's children tree. */
function CopyButton({ getText, style }: { getText: () => string; style?: React.CSSProperties }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  function handleClick(): void {
    navigator.clipboard
      .writeText(getText())
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(console.error)
  }

  return (
    <button
      onClick={handleClick}
      style={{ fontSize: 10, padding: '2px 6px', lineHeight: 1.4, opacity: copied ? 1 : 0.65, ...style }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

/** react-markdown's <pre> override for fenced code blocks — inline code (`like this`) never
 * gets a <pre> wrapper, so this is the one reliable way to target just real code blocks,
 * language hint or not (a plain ``` block with no language has no distinguishing className). */
function CodeBlock(props: React.ComponentPropsWithoutRef<'pre'>): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div style={{ position: 'relative' }}>
      <pre ref={ref} {...props} />
      <CopyButton
        getText={() => ref.current?.textContent ?? ''}
        style={{ position: 'absolute', top: 6, right: 6 }}
      />
    </div>
  )
}

interface ChatPaneProps {
  session: SessionSummary | null
  messages: ChatMessage[]
  onSend: (content: string) => void
  /** True from the moment a message is sent until the first response chunk arrives — the
   * gap where nothing else on screen shows anything is happening. */
  isPending: boolean
  /** Controlled by App.tsx (not local state) so it survives switching to Settings and back,
   * and so App.tsx can flush it to disk on the moments that matter. */
  draft: string
  onDraftChange: (text: string) => void
}

function ThinkingIndicator(): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        backgroundColor: '#e0403f',
        boxShadow: '0 0 6px 1px rgba(224,64,63,0.6)',
        animation: 'tt-pulse 1s ease-in-out infinite'
      }}
    />
  )
}

export default function ChatPane({
  session,
  messages,
  onSend,
  isPending,
  draft,
  onDraftChange
}: ChatPaneProps): React.JSX.Element {
  // null = editing a fresh draft; otherwise an index into promptHistory being browsed.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('')

  // Switching sessions invalidates whatever index was being browsed (a different session has
  // a different history) — drop back to a fresh draft rather than showing the wrong entry.
  useEffect(() => {
    setHistoryIndex(null)
  }, [session?.id])

  // Most recent first, so ArrowUp/scroll-up steps backwards through time like a shell history.
  const promptHistory = messages
    .filter((m) => m.role === 'user')
    .slice(-50)
    .map((m) => m.content)
    .reverse()

  function navigateHistory(direction: 'older' | 'newer'): void {
    if (direction === 'older') {
      if (promptHistory.length === 0) return
      if (historyIndex === null) setDraftBeforeHistory(draft)
      const nextIndex = historyIndex === null ? 0 : Math.min(historyIndex + 1, promptHistory.length - 1)
      setHistoryIndex(nextIndex)
      onDraftChange(promptHistory[nextIndex])
    } else {
      if (historyIndex === null) return
      if (historyIndex === 0) {
        setHistoryIndex(null)
        onDraftChange(draftBeforeHistory)
      } else {
        const nextIndex = historyIndex - 1
        setHistoryIndex(nextIndex)
        onDraftChange(promptHistory[nextIndex])
      }
    }
  }

  function handleSend(): void {
    const content = draft.trim()
    if (!content) return
    onSend(content)
    setHistoryIndex(null)
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
        {messages
          .filter((msg) => !(msg.role === 'system' && msg.content.startsWith('[Image loaded:')))
          .map((msg) => (
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7, textTransform: 'uppercase' }}>{msg.role}</span>
              <CopyButton getText={() => msg.content} />
            </div>
            <div className="tt-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
                {msg.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
        {isPending && (
          <div
            style={{
              alignSelf: 'flex-start',
              backgroundColor: '#333340',
              borderRadius: 10,
              padding: '8px 12px'
            }}
          >
            <ThinkingIndicator />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #333' }}>
        <input
          value={draft}
          onChange={(e) => {
            onDraftChange(e.target.value)
            if (historyIndex !== null) setHistoryIndex(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend()
            else if (e.key === 'ArrowUp') {
              e.preventDefault()
              navigateHistory('older')
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              navigateHistory('newer')
            }
          }}
          onWheel={(e) => {
            if (e.deltaY < 0) navigateHistory('older')
            else if (e.deltaY > 0) navigateHistory('newer')
          }}
          placeholder="Type a message... (you can send another any time, even mid-response)"
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={handleSend} style={{ padding: '8px 16px', cursor: 'pointer' }}>
          Send
        </button>
      </div>
    </div>
  )
}
