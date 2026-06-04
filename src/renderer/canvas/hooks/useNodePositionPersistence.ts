import { useCallback, useEffect, useRef } from 'react'
import type { NodeChange } from '@xyflow/react'
import { useGraphStore } from '../../store/graphStore'

/**
 * 管理节点拖拽位置的防抖持久化。
 * 拖拽结束时记录位置，300ms 内无新变化后批量写入数据库。
 */
export function useNodePositionPersistence(graphId: string) {
  const pendingPositionUpdates = useRef<Map<string, { x: number; y: number }>>(new Map())
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPositionUpdates = useCallback(() => {
    const updates = pendingPositionUpdates.current
    if (updates.size === 0) return
    const store = useGraphStore.getState()
    updates.forEach((position, nodeId) => {
      store.updateNode(nodeId, { position }).catch((err) => {
        console.error('[useNodePositionPersistence] Failed to persist node position:', err)
      })
    })
    pendingPositionUpdates.current = new Map()
  }, [])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // 检测拖拽结束相关的 position 变化
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          pendingPositionUpdates.current.set(change.id, { ...change.position })
        }
      }

      // 防抖：300ms 内没有新的位置变化则批量保存
      if (pendingPositionUpdates.current.size > 0) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = setTimeout(flushPositionUpdates, 300)
      }
    },
    [flushPositionUpdates],
  )

  // 切换图时清空待保存的位置队列
  useEffect(() => {
    pendingPositionUpdates.current = new Map()
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [graphId])

  // 组件卸载时刷入最后的位置更新
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        flushPositionUpdates()
      }
    }
  }, [flushPositionUpdates])

  return { handleNodesChange }
}
