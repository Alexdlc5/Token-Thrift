import { useCallback, useState } from 'react'

/** A single resizable panel dimension (width or height), persisted per-device in
 * localStorage so a panel keeps its size across restarts — same "remembers what you set"
 * expectation as the library's drag-and-drop order, just for layout instead of item order. */
export function useResizableSize(
  storageKey: string,
  defaultSize: number,
  min: number,
  max: number
): [number, (deltaPx: number) => void] {
  const [size, setSize] = useState<number>(() => {
    const stored = Number(localStorage.getItem(storageKey))
    return stored > 0 ? Math.min(Math.max(stored, min), max) : defaultSize
  })

  const resize = useCallback(
    (deltaPx: number) => {
      setSize((prev) => {
        const next = Math.min(Math.max(prev + deltaPx, min), max)
        localStorage.setItem(storageKey, String(next))
        return next
      })
    },
    [storageKey, min, max]
  )

  return [size, resize]
}
