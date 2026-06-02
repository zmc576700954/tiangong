/**
 * useAutoLayout — 手动触发布局整理的 hook
 *
 * 提供 applyLayout() 函数，调用后用 dagre 重新计算所有节点位置，
 * 通过单次 IPC 调用批量持久化到数据库。
 */
import { useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'
import { computeDagreLayout, type LayoutOptions } from '../layout'
import { useGraphStore } from '../../store/graphStore'

export function useAutoLayout(layoutOptions?: LayoutOptions) {
  const { getNodes, getEdges, setNodes, fitView } = useReactFlow()
  const batchUpdatePositions = useGraphStore((s) => s.batchUpdatePositions)

  const applyLayout = useCallback(() => {
    const nodes = getNodes()
    const edges = getEdges()
    if (nodes.length === 0) return

    const layouted = computeDagreLayout(nodes, edges, layoutOptions)

    // 更新画布
    setNodes(layouted)

    // 单次 IPC 批量持久化所有节点位置
    const updates = layouted.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
    }))
    batchUpdatePositions(updates).catch((err) => {
      console.error('[useAutoLayout] Failed to batch persist positions:', err)
    })

    // fitView 并限制最小缩放比例，避免节点多时过度缩小
    setTimeout(() => {
      fitView({
        padding: 0.15,
        duration: 400,
        minZoom: 0.4,
        maxZoom: 1.2,
      })
    }, 50)
  }, [getNodes, getEdges, setNodes, batchUpdatePositions, fitView, layoutOptions])

  return { applyLayout }
}
