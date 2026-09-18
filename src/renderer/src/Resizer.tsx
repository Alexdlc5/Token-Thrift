import { useRef } from 'react'

interface ResizerProps {
  /** 'horizontal' = a vertical bar you drag left/right to resize a width.
   *  'vertical' = a horizontal bar you drag up/down to resize a height. */
  direction: 'horizontal' | 'vertical'
  onResize: (deltaPx: number) => void
  /** Which edge of the panel this sits on, so it's positioned outside the panel's own bounds. */
  edge: 'left' | 'right' | 'top' | 'bottom'
}

// Absolutely positioned over the panel's edge — the panel it belongs to must set
// `position: 'relative'` on its outer element. Uses pointer capture instead of window-level
// listeners so dragging past the handle's own bounds keeps working with no manual cleanup.
export default function Resizer({ direction, onResize, edge }: ResizerProps): React.JSX.Element {
  const lastPos = useRef(0)

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId)
    lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.buttons !== 1) return
    const pos = direction === 'horizontal' ? e.clientX : e.clientY
    const delta = pos - lastPos.current
    lastPos.current = pos
    // A handle on the panel's leading edge (left/top) grows the panel as it moves AWAY from
    // the panel, i.e. a negative delta — the trailing edge (right/bottom) grows it directly.
    onResize(edge === 'left' || edge === 'top' ? -delta : delta)
  }

  const edgeStyle: React.CSSProperties =
    direction === 'horizontal'
      ? { top: 0, bottom: 0, width: 6, ...(edge === 'left' ? { left: -3 } : { right: -3 }) }
      : { left: 0, right: 0, height: 6, ...(edge === 'top' ? { top: -3 } : { bottom: -3 }) }

  return (
    <div
      className="tt-resizer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      style={{
        position: 'absolute',
        zIndex: 10,
        touchAction: 'none',
        cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize',
        ...edgeStyle
      }}
    />
  )
}
