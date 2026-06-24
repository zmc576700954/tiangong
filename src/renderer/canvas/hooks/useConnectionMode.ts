import { useState, useRef, useEffect, useCallback } from 'react'
import type { Connection, Edge } from '@xyflow/react'
import type { GraphEdge } from '@shared/types'
import { getEdgeMarkerEnd } from '../edge-utils'

/** 沿 DOM 向上查找 ReactFlow 节点包裹层的 data-id */
function findNodeIdFromDom(el: EventTarget | null): string | null {
  let node: HTMLElement | null = el as HTMLElement | null
  while (node) {
    const id = node.getAttribute('data-id')
    if (id) return id
    node = node.parentElement
  }
  return null
}

/** 浏览器端 ID 生成 */
function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '')}`
}

export interface ConnectionModeState {
  /** 当前处于连线模式的源节点 ID（null 表示未在连线模式） */
  connectingSourceId: string | null
  /** 是否正处于连线模式 */
  isConnecting: boolean
  /** 进入连线模式 */
  startConnect: (sourceId: string) => void
  /** 取消连线模式 */
  cancelConnect: () => void
}

interface UseConnectionModeOptions {
  /** 当前图中的所有边，用于检测重复 */
  graphEdges: Array<{ source: string; target: string }>
  /** 创建边并持久化到数据库 */
  createEdge: (data: Omit<GraphEdge, 'id'>) => Promise<GraphEdge>
  /** 当前图 ID */
  graphId: string
  /** 更新 ReactFlow 边状态 */
  setRfEdges: React.Dispatch<React.SetStateAction<Edge[]>>
  /** 选择边类型后创建边（替代直接创建） */
  onConnect?: (connection: Connection) => void
}

/**
 * 连线模式 Hook
 *
 * 管理"点击源节点 → 点击目标节点"的连线交互流程：
 * 1. 用户通过右键菜单选择"连线"触发 startConnect(sourceId)
 * 2. 组件显示连线模式提示，高亮源节点
 * 3. 用户在 capture 阶段点击目标节点完成连线
 * 4. 点击空白处或调用 cancelConnect() 取消
 *
 * 使用 capture 阶段事件监听，绕过 ReactFlow 合成事件系统，
 * 确保连线模式下点击目标节点可靠触发（不触发 onPaneClick 清除状态）。
 */
export function useConnectionMode({
  graphEdges,
  createEdge,
  graphId,
  setRfEdges,
  onConnect,
}: UseConnectionModeOptions): ConnectionModeState {
  const [connectingSourceId, setConnectingSourceId] = useState<string | null>(null)
  const connectingSourceIdRef = useRef<string | null>(null)
  const graphEdgesRef = useRef(graphEdges)

  useEffect(() => {
    connectingSourceIdRef.current = connectingSourceId
  }, [connectingSourceId])

  // 保持 graphEdgesRef 始终指向最新值
  useEffect(() => {
    graphEdgesRef.current = graphEdges
  }, [graphEdges])

  /**
   * 在 document capture 阶段拦截点击。
   * 当处于连线模式时，检测点击的目标节点并完成连线。
   */
  useEffect(() => {
    function handleCaptureClick(e: MouseEvent) {
      const srcId = connectingSourceIdRef.current
      if (!srcId) return

      const targetNodeId = findNodeIdFromDom(e.target)
      if (!targetNodeId || targetNodeId === srcId) return

      // 阻止事件继续传播，防止 onPaneClick 清除连线状态
      e.stopPropagation()
      e.preventDefault()

      const exists = graphEdgesRef.current.some(
        (ed) => ed.source === srcId && ed.target === targetNodeId,
      )

      if (exists) {
        setConnectingSourceId(null)
        connectingSourceIdRef.current = null
        return
      }

      if (onConnect) {
        onConnect({ source: srcId, target: targetNodeId, sourceHandle: null, targetHandle: null })
        setConnectingSourceId(null)
        connectingSourceIdRef.current = null
        return
      }

      const edgeId = generateId('edge')
      const newEdge: Edge = {
        id: edgeId,
        source: srcId,
        target: targetNodeId,
        type: 'bizEdge',
        data: { edgeType: 'default' as const },
        markerEnd: getEdgeMarkerEnd('default'),
        style: { stroke: '#94a3b8', strokeWidth: 2 },
      }
      setRfEdges((eds) => [...eds, newEdge])

      // 异步持久化到数据库
      createEdge({
        source: srcId,
        target: targetNodeId,
        label: '',
        graphId,
        edgeType: 'default',
      }).catch((err: unknown) => {
        console.error('[useConnectionMode] Failed to persist edge:', err)
      })

      setConnectingSourceId(null)
      connectingSourceIdRef.current = null
    }

    document.addEventListener('click', handleCaptureClick, { capture: true })
    return () => document.removeEventListener('click', handleCaptureClick, { capture: true })
  }, [createEdge, graphId, setRfEdges, onConnect])

  const startConnect = useCallback((sourceId: string) => {
    setConnectingSourceId(sourceId)
    connectingSourceIdRef.current = sourceId
  }, [])

  const cancelConnect = useCallback(() => {
    setConnectingSourceId(null)
    connectingSourceIdRef.current = null
  }, [])

  return {
    connectingSourceId,
    isConnecting: !!connectingSourceId,
    startConnect,
    cancelConnect,
  }
}
