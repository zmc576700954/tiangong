/**
 * D10b: 远端用户光标 / 选区渲染层
 *
 * 在 @xyflow/react 画布上叠加渲染其他用户的：
 * 1. 鼠标位置 — 带名字标签 + 颜色填充的箭头
 * 2. 选中节点 — 该节点的边框颜色 = 该用户的颜色
 *
 * 设计要点：
 * - 通过 ReactFlow 的 useStore 订阅 viewport，把 flow 坐标换算为屏幕坐标
 * - 使用 React Portal（XYFlow's Panel + absolute 定位）渲染光标
 * - 渲染节流：awareness 自带 50ms throttle，组件不做额外节流
 * - 颜色：AWARENESS_COLOR_PALETTE 由 colorIndex 解析
 * - aria-hidden：装饰性 overlay 不进 a11y 树
 *
 * 选区聚合逻辑（computeRemoteSelectionByNode / colorForUser）放在
 * `./remote-selection.ts`，本文件只放组件。
 */

import { memo, useMemo } from 'react'
import type { ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import { useRemoteAwareness } from '../realtime/hooks'
import { resolveAwarenessColor, type RemoteAwarenessState } from '@shared/realtime'

interface RemoteCursorsProps {
  /** 本地 userId（用于过滤自己） */
  localUserId: string
  /** 节点 id → 该节点被哪些用户选中的 map（外部计算后传入，避免重渲染画布） */
  /** 注意：实际选中高亮我们用节点的 data 字段；这里只渲染 cursor overlay */
}

/**
 * RemoteCursors — 在画布右上角叠加一层光标 / 选区提示
 *
 * 选区高亮通过 BizNode 渲染时读取 GraphCanvas 的「按 user 染色」逻辑统一处理
 * （见 GraphCanvas 的 selectedByRemote prop），本组件只负责光标和远端用户列表角标。
 */
function RemoteCursorsInner(_props: RemoteCursorsProps): ReactElement | null {
  const remoteStates = useRemoteAwareness()
  const viewport = useStore((state) => ({
    x: state.transform[0],
    y: state.transform[1],
    zoom: state.transform[2],
  }))

  const cursors = useMemo(() => {
    return remoteStates.filter(
      (s) => s.user.userId !== _props.localUserId && s.cursor !== null,
    )
  }, [remoteStates, _props.localUserId])

  if (cursors.length === 0) return null

  return (
    <div
      className="pointer-events-none absolute inset-0 z-30"
      data-testid="remote-cursors-overlay"
      aria-hidden="true"
    >
      {cursors.map((state) => (
        <RemoteCursor
          key={state.user.userId}
          state={state}
          viewport={viewport}
        />
      ))}
    </div>
  )
}

/** 单个远端光标渲染 */
interface RemoteCursorProps {
  state: RemoteAwarenessState
  viewport: { x: number; y: number; zoom: number }
}

function RemoteCursor({ state, viewport }: RemoteCursorProps): ReactElement | null {
  const cursor = state.cursor
  if (!cursor) return null
  // flow → screen：screen = flow * zoom + (tx, ty)
  const sx = cursor.x * viewport.zoom + viewport.x
  const sy = cursor.y * viewport.zoom + viewport.y
  const color = resolveAwarenessColor(state.user.colorIndex)
  return (
    <div
      style={{
        position: 'absolute',
        left: sx,
        top: sy,
        transform: 'translate(-2px, -2px)',
      }}
      data-testid="remote-cursor"
      data-user-id={state.user.userId}
    >
      {/* 箭头 */}
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        style={{ display: 'block' }}
      >
        <path
          d="M2 2 L2 16 L7 12 L10 18 L13 17 L10 11 L16 11 Z"
          fill={color}
          stroke="#fff"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
      {/* 名字标签 */}
      <div
        style={{
          position: 'absolute',
          left: 16,
          top: 14,
          backgroundColor: color,
          color: '#fff',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        }}
        data-testid="remote-cursor-label"
      >
        {state.user.userName}
      </div>
    </div>
  )
}

/**
 * RemotePresenceBadge — 右上角小角标，列出当前协作人数
 *
 * 独立组件：RemoteCursors 在没有用户时不渲染，但徽章总是显示（即使 0 人）
 */
interface RemotePresenceBadgeProps {
  localUserId: string
}

export function RemotePresenceBadge({ localUserId }: RemotePresenceBadgeProps): ReactElement {
  const remoteStates = useRemoteAwareness()
  const remoteCount = useMemo(
    () => remoteStates.filter((s) => s.user.userId !== localUserId).length,
    [remoteStates, localUserId],
  )
  return (
    <div
      className="flex items-center gap-1 text-[11px] text-muted-foreground"
      data-testid="remote-presence-badge"
      data-count={remoteCount}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
      <span>
        {remoteCount === 0
          ? '仅你'
          : `${remoteCount} 人在协作`}
      </span>
    </div>
  )
}

export const RemoteCursors = memo(RemoteCursorsInner)