import { useRef, useState, useLayoutEffect } from 'react'

/**
 * Render-then-measure menu positioning.
 * Places menu at (x, y), then adjusts if it overflows the viewport.
 */
export function useMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState({ x, y })

  useLayoutEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const padding = 8
    const maxX = window.innerWidth - rect.width - padding
    const maxY = window.innerHeight - rect.height - padding
    setAdjustedPos({
      x: Math.max(padding, Math.min(x, maxX)),
      y: Math.max(padding, Math.min(y, maxY)),
    })
  }, [x, y])

  return { ref, adjustedPos }
}
