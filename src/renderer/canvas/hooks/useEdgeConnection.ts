import { useState, useCallback } from 'react'
import type { Connection } from '@xyflow/react'
import type { EdgeType, EdgeContent } from '@shared/types'
import { useGraphStore } from '../../store/graphStore'

/**
 * 管理边创建流程：验证连接、弹出边类型菜单、创建边。
 */
export function useEdgeConnection(graphId: string) {
  const graphNodes = useGraphStore((state) => state.nodes)
  const graphEdges = useGraphStore((state) => state.edges)
  const createEdge = useGraphStore((state) => state.createEdge)

  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null)
  const [showEdgeTypeMenu, setShowEdgeTypeMenu] = useState(false)
  const [edgeMenuPosition, setEdgeMenuPosition] = useState({ x: 0, y: 0 })

  const validateConnection = useCallback((connection: Connection): boolean => {
    if (!connection.source || !connection.target) return false
    if (connection.source === connection.target) return false
    const existingEdge = graphEdges.find(
      (e) => e.source === connection.source && e.target === connection.target,
    )
    if (existingEdge) return false
    return true
  }, [graphEdges])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!validateConnection(connection)) return
      if (connection.source && connection.target) {
        const sourceNode = graphNodes.find((n) => n.id === connection.source)
        const targetNode = graphNodes.find((n) => n.id === connection.target)
        if (sourceNode && targetNode) {
          const midX = (sourceNode.position.x + targetNode.position.x) / 2 + 100
          const midY = (sourceNode.position.y + targetNode.position.y) / 2
          setEdgeMenuPosition({ x: midX, y: midY })
        }
      }
      setPendingConnection(connection)
      setShowEdgeTypeMenu(true)
    },
    [validateConnection, graphNodes],
  )

  const handleCreateEdge = useCallback(
    async (edgeType: EdgeType, content?: EdgeContent) => {
      if (!pendingConnection?.source || !pendingConnection?.target) return
      await createEdge({
        source: pendingConnection.source,
        target: pendingConnection.target,
        label: content?.condition || '',
        graphId,
        edgeType,
        content,
      })
      setPendingConnection(null)
      setShowEdgeTypeMenu(false)
    },
    [pendingConnection, createEdge, graphId],
  )

  const cancelPendingConnection = useCallback(() => {
    setPendingConnection(null)
    setShowEdgeTypeMenu(false)
  }, [])

  return {
    pendingConnection,
    showEdgeTypeMenu,
    edgeMenuPosition,
    onConnect,
    handleCreateEdge,
    cancelPendingConnection,
  }
}
