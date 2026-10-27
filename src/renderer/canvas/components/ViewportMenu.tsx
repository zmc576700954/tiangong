import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'
import { useMenuPosition } from '../hooks/useMenuPosition'

interface ViewportMenuProps {
  /** 视口坐标（event.clientX / event.clientY） */
  x: number
  y: number
  className?: string
  style?: CSSProperties
  onClick?: (event: MouseEvent<HTMLDivElement>) => void
  children: ReactNode
  'data-testid'?: string
}

/**
 * 视口定位的浮层菜单（右键菜单）。
 *
 * 必须 portal 到 document.body 且用 position: fixed：
 * 画布容器相对视口有偏移（左侧栏 + 顶部栏），absolute 定位会把 clientX/clientY
 * 当成容器内坐标，菜单整体偏离光标；而 useMenuPosition 又是按 window.innerWidth
 * 裁剪的 —— 两套坐标对不上，靠近右/下边缘时菜单会被推出视口，既点不到也关不掉。
 */
export function ViewportMenu({ x, y, className, style, onClick, children, 'data-testid': testId }: ViewportMenuProps) {
  const { ref, adjustedPos } = useMenuPosition(x, y)

  return createPortal(
    <div
      ref={ref}
      className={cn('fixed z-50', className)}
      style={{ left: adjustedPos.x, top: adjustedPos.y, ...style }}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </div>,
    document.body,
  )
}
