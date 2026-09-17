import { useEffect, useState } from 'react'
import type { TaskRow } from '@shared/models'

interface UsageTrackerProps {
  sessionId: string
  /** The active session's model context length, if the provider reports (or approximates) one. */
  contextLength?: number
  /** True when contextLength is a lookup/pattern/router-min guess, not a live per-model API field. */
  contextLengthApprox?: boolean
}

// Self-contained like TaskMonitorPanel: subscribes to window.api directly rather than
// reading App.tsx's state, so it reflects real persisted/streamed task data without
// duplicating that bookkeeping in the parent.
export default function UsageTracker({
  sessionId,
  contextLength,
  contextLengthApprox
}: UsageTrackerProps): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskRow[]>([])

  useEffect(() => {
    window.api.listTasks().then(setTasks).catch(console.error)
    const off = window.api.onTaskUpdate((task) => {
      setTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)])
    })
    return off
  }, [])

  const sessionTasks = tasks.filter((t) => t.sessionId === sessionId)
  const totalTokens = sessionTasks.reduce(
    (sum, t) => sum + (t.promptTokens ?? 0) + (t.completionTokens ?? 0),
    0
  )

  // Context window fill is a snapshot, not a running sum: each request resends the whole
  // conversation, so the most recent request's total token count IS the current context
  // usage (a real reported number from the provider, not an estimate from a tokenizer).
  const latest = sessionTasks.reduce<TaskRow | null>(
    (latest, t) => (!latest || t.startedAt > latest.startedAt ? t : latest),
    null
  )
  const contextUsed = latest ? (latest.promptTokens ?? 0) + (latest.completionTokens ?? 0) : 0
  const pct = contextLength ? Math.min(100, (contextUsed / contextLength) * 100) : null
  const barColor = pct === null ? '#555' : pct > 90 ? '#e05252' : pct > 70 ? '#c9a86a' : '#4caf50'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '4px 16px',
        fontSize: 11,
        opacity: 0.8,
        borderBottom: '1px solid #2a2a2a'
      }}
    >
      <span>Session usage: {totalTokens.toLocaleString()} tok</span>
      {contextLength ? (
        <span
          style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, maxWidth: 320 }}
          title={contextLengthApprox ? 'Approximate — not reported by a live per-model API field' : undefined}
        >
          Context: {contextUsed.toLocaleString()} / {contextLengthApprox ? '~' : ''}
          {contextLength.toLocaleString()} ({pct!.toFixed(1)}%)
          <span
            style={{
              flex: 1,
              height: 4,
              backgroundColor: '#2a2a2a',
              borderRadius: 2,
              overflow: 'hidden'
            }}
          >
            <span style={{ display: 'block', height: '100%', width: `${pct}%`, backgroundColor: barColor }} />
          </span>
        </span>
      ) : (
        <span style={{ opacity: 0.6 }}>Context length unknown for this model</span>
      )}
    </div>
  )
}
