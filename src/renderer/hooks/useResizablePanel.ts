import { useState, useEffect, useCallback } from 'react'

export interface UseResizablePanelOptions {
  /** 初始宽度 */
  initialWidth: number
  /** 最小宽度 */
  minWidth: number
  /** 最大宽度 */
  maxWidth: number
  /** 方向：'left' 从左侧计算，'right' 从右侧计算 */
  direction: 'left' | 'right'
}

export interface UseResizablePanelResult {
  width: number
  isResizing: boolean
  startResize: () => void
  /** 设置为固定宽度（如展开模式） */
  setFixedWidth: (width: number | null) => void
  fixedWidth: number | null
}

/**
 * 可拖拽面板宽度调整 Hook
 *
 * 支持左/右方向面板，通过鼠标拖拽调整宽度。
 * 可设置固定宽度覆盖（如 Agent 面板展开模式）。
 */
export function useResizablePanel(options: UseResizablePanelOptions): UseResizablePanelResult {
  const { initialWidth, minWidth, maxWidth, direction } = options
  const [width, setWidth] = useState(initialWidth)
  const [isResizing, setIsResizing] = useState(false)
  const [fixedWidth, setFixedWidth] = useState<number | null>(null)

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (direction === 'left') {
        setWidth(Math.max(minWidth, Math.min(maxWidth, e.clientX)))
      } else {
        setWidth(Math.max(minWidth, Math.min(maxWidth, window.innerWidth - e.clientX)))
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, direction, minWidth, maxWidth])

  const startResize = useCallback(() => {
    setIsResizing(true)
  }, [])

  return {
    width: fixedWidth ?? width,
    isResizing,
    startResize,
    setFixedWidth,
    fixedWidth,
  }
}
