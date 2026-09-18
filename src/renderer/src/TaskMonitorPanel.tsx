import { useEffect, useState } from 'react'
import type { TaskRow } from '@shared/models'
import { PROVIDER_LABELS } from './mockData'
import Resizer from './Resizer'
import { useResizableSize } from './useResizableSize'

// Self-contained: subscribes to window.api directly rather than taking props, so it keeps
// tracking background tasks (§2.4: "must work even when the user switches sessions")
// regardless of whatever the rest of the app has selected.
export default function TaskMonitorPanel(): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [liveText, setLiveText] = useState<Record<string, { answer: string; reasoning: string }>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [width, resizeWidth] = useResizableSize('tt-task-monitor-width', 300, 220, 600)

  useEffect(() => {
    window.api.listTasks().then(setTasks).catch(console.error)

    const offTaskUpdate = window.api.onTaskUpdate((task) => {
      setTasks((prev) => {
        const next = prev.filter((t) => t.id !== task.id)
        return [task, ...next]
      })
    })

    const offChunk = window.api.onChatChunk((evt) => {
      setLiveText((prev) => {
        const entry = prev[evt.taskId] ?? { answer: '', reasoning: '' }
        return {
          ...prev,
          [evt.taskId]: {
            answer: evt.channel === 'answer' ? entry.answer + evt.delta : entry.answer,
            reasoning: evt.channel === 'reasoning' ? entry.reasoning + evt.delta : entry.reasoning
          }
        }
      })
    })

    return () => {
      offTaskUpdate()
      offChunk()
    }
  }, [])

  // Top-level tasks first (parentTaskId === null), each followed by its children — the tree
  // the spec calls for once agentic sub-tasks exist; right now everything is top-level.
  const topLevel = tasks.filter((t) => !t.parentTaskId)
  const childrenOf = (id: string): TaskRow[] => tasks.filter((t) => t.parentTaskId === id)

  function renderTask(task: TaskRow, depth: number): React.JSX.Element {
    const live = liveText[task.id]
    const expanded = expandedId === task.id
    const duration = task.endedAt ? `${((task.endedAt - task.startedAt) / 1000).toFixed(1)}s` : '…'

    return (
      <div key={task.id} style={{ marginLeft: depth * 14 }}>
        <div
          onClick={() => setExpandedId(expanded ? null : task.id)}
          style={{
            padding: '6px 8px',
            cursor: 'pointer',
            borderBottom: '1px solid #2a2a2a',
            fontSize: 12
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
            <span>
              <StatusDot status={task.status} /> {PROVIDER_LABELS[task.providerId]} · {task.modelId}
            </span>
            <span style={{ opacity: 0.6 }}>{duration}</span>
          </div>
          <div style={{ opacity: 0.6, marginTop: 2 }}>
            {task.promptTokens ?? '–'}→{task.completionTokens ?? '–'} tok · ${task.costUsd.toFixed(4)}
            {task.error ? ` · error: ${task.error}` : ''}
          </div>
        </div>
        {expanded && (
          <div style={{ padding: '6px 10px', backgroundColor: '#1a1a22', fontSize: 12 }}>
            <div style={{ marginBottom: 6 }}>
              <strong>System prompt sent:</strong>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0', opacity: 0.85 }}>
                {task.systemPrompt ?? '(none — no lean-coding/fast-reasoning/custom prompt active)'}
              </pre>
            </div>
            {live?.reasoning && (
              <div style={{ marginBottom: 6 }}>
                <strong style={{ color: '#c9a86a' }}>Reasoning:</strong>
                <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0', color: '#c9a86a' }}>
                  {live.reasoning}
                </pre>
              </div>
            )}
            {live?.answer && (
              <div>
                <strong>Answer:</strong>
                <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{live.answer}</pre>
              </div>
            )}
          </div>
        )}
        {childrenOf(task.id).map((child) => renderTask(child, depth + 1))}
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        width,
        flexShrink: 0,
        borderLeft: '1px solid #333',
        display: 'flex',
        flexDirection: 'column',
        height: '100%'
      }}
    >
      <Resizer direction="horizontal" edge="left" onResize={resizeWidth} />
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #333', fontWeight: 600, fontSize: 13 }}>
        Task monitor
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {topLevel.length === 0 ? (
          <div style={{ padding: 12, opacity: 0.6, fontSize: 12 }}>No requests yet.</div>
        ) : (
          topLevel.map((task) => renderTask(task, 0))
        )}
      </div>
      <div style={{ padding: '8px 12px', borderTop: '1px solid #333', fontSize: 11, opacity: 0.7 }}>
        Total: {tasks.reduce((sum, t) => sum + (t.promptTokens ?? 0) + (t.completionTokens ?? 0), 0).toLocaleString()}{' '}
        tok across {tasks.length} request{tasks.length === 1 ? '' : 's'} · $
        {tasks.reduce((sum, t) => sum + t.costUsd, 0).toFixed(4)}
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: TaskRow['status'] }): React.JSX.Element {
  const color = { queued: '#888', streaming: '#4a9eff', done: '#4caf50', error: '#e05252' }[status]
  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        backgroundColor: color,
        marginRight: 4
      }}
    />
  )
}
