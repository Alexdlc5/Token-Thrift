import { useEffect, useState } from 'react'
import type { LibraryItem } from '@shared/models'

interface LibraryPanelProps {
  sessionId: string
}

// Continuous icon size + color scale by file size (log scale — sizes here range from a few
// KB to 15MB, and a linear scale would make everything under ~1MB look identical): small
// dark-blue up through blue/purple/burgundy to large dark-red.
const MIN_BYTES = 1024
const MAX_BYTES = 15 * 1024 * 1024
const COLOR_STOPS: [number, [number, number, number]][] = [
  [0, [20, 40, 130]], // dark blue
  [0.4, [90, 60, 160]], // blue/purple
  [0.7, [120, 40, 70]], // burgundy
  [1, [140, 20, 20]] // dark red
]

function libraryVisual(bytes: number): { size: number; color: string } {
  const clamped = Math.min(Math.max(bytes, MIN_BYTES), MAX_BYTES)
  const t = (Math.log(clamped) - Math.log(MIN_BYTES)) / (Math.log(MAX_BYTES) - Math.log(MIN_BYTES))
  const size = 32 + t * (72 - 32)

  let color = COLOR_STOPS[0][1]
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [t0, c0] = COLOR_STOPS[i]
    const [t1, c1] = COLOR_STOPS[i + 1]
    if (t >= t0 && t <= t1) {
      const localT = (t - t0) / (t1 - t0 || 1)
      color = [
        Math.round(c0[0] + (c1[0] - c0[0]) * localT),
        Math.round(c0[1] + (c1[1] - c0[1]) * localT),
        Math.round(c0[2] + (c1[2] - c0[2]) * localT)
      ]
      break
    }
  }
  return { size, color: `rgb(${color[0]}, ${color[1]}, ${color[2]})` }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// A session's saved-file history — every loaded reference file and every generated image,
// in addition to (not instead of) whichever one is currently shown in the document panel
// above. Self-contained like the other side panels: fetches on mount/session change and
// subscribes to its own real-time update event.
export default function LibraryPanel({ sessionId }: LibraryPanelProps): React.JSX.Element {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [collapsed, setCollapsed] = useState(false)

  function load(): void {
    window.api.listLibraryItems(sessionId).then(setItems).catch(console.error)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    const off = window.api.onLibraryUpdated((evt) => {
      if (evt.sessionId === sessionId) load()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  function handleOpen(id: string): void {
    window.api.openLibraryItem(id).catch((err: unknown) => alert(err instanceof Error ? err.message : String(err)))
  }

  return (
    <div style={{ borderTop: '1px solid #333', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', fontSize: 12 }}>
        <strong>Library</strong>
        <span style={{ marginLeft: 8, opacity: 0.6 }}>
          {items.length} file{items.length === 1 ? '' : 's'}
        </span>
        <button onClick={() => setCollapsed((v) => !v)} style={{ marginLeft: 'auto' }}>
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>
      {!collapsed && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            padding: '4px 12px 12px',
            maxHeight: 170,
            overflowY: 'auto',
            alignContent: 'flex-start'
          }}
        >
          {items.length === 0 && (
            <div style={{ fontSize: 12, opacity: 0.5, padding: '8px 0' }}>
              No files yet — loaded or generated images/PDFs show up here.
            </div>
          )}
          {items.map((item) => {
            const { size, color } = libraryVisual(item.sizeBytes)
            const kindLabel = item.mimeType.startsWith('image/') ? 'IMG' : item.mimeType === 'application/pdf' ? 'PDF' : 'FILE'
            return (
              <button
                key={item.id}
                onClick={() => handleOpen(item.id)}
                title={item.fileName}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  width: 84,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#eee'
                }}
              >
                <span
                  style={{
                    width: size,
                    height: size,
                    borderRadius: 8,
                    backgroundColor: color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    fontWeight: 600,
                    flexShrink: 0
                  }}
                >
                  {kindLabel}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    opacity: 0.75,
                    textAlign: 'center',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    width: '100%'
                  }}
                >
                  {item.description ? item.description.slice(0, 40) : item.fileName}
                </span>
                <span style={{ fontSize: 9, opacity: 0.5 }}>{formatSize(item.sizeBytes)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
