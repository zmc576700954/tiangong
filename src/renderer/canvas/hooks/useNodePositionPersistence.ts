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
  /** 位置已被「重挂」接管的节点 —— 自由位置持久化跳过它们 */
  const suppressedIdsRef = useRef<Set<string>>(new Set())

  const flushPositionUpdates = useCallback(() => {
    const updates = pendingPositionUpdates.current
    if (updates.size === 0) return
    const batch = Array.from(updates.entries()).map(([id, pos]) => ({ id, x: pos.x, y: pos.y }))
    useGraphStore.getState().batchUpdatePositions(batch).catch((err) => {
      console.error('[useNodePositionPersistence] Failed to batch persist positions:', err)
    })
    pendingPositionUpdates.current = new Map()
  }, [])

  /**
   * 标记这些节点的位置由「重挂」接管。
   *
   * 除了跳过它们后续的 position change，还要**把已经在队列里的那一条删掉** ——
   * 拖拽结束的那一下 position change 可能先于重挂处理器发生（xyflow 在
   * `onNodeDragStop` 之前就派发了它），队列里已经躺着了，只加抑制标记不够。
   */
  const suppressPositions = useCallback((ids: string[]) => {
    for (const id of ids) {
      suppressedIdsRef.current.add(id)
      pendingPositionUpdates.current.delete(id)
    }
    if (pendingPositionUpdates.current.size === 0 && debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  /** 解除抑制 —— 之后的自由位置持久化恢复正常 */
  const releasePositions = useCallback((ids: string[]) => {
    for (const id of ids) suppressedIdsRef.current.delete(id)
  }, [])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      /** 这一批里「位置已经定下来」的节点 —— store 要立刻跟上，落库仍然防抖 */
      const localUpdates: Array<{ id: string; x: number; y: number }> = []
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          if (suppressedIdsRef.current.has(change.id)) continue
          // store 立刻跟上画布（不落库）：松手后 memo 会因为 zIndex 变化而重建被拖节点，
          // 重建时带的是 store 里的位置 —— store 落后 300ms 就会弹回拖拽前的位置。
          localUpdates.push({ id: change.id, x: change.position.x, y: change.position.y })
          // 落库仍然防抖、仍然能被 suppressPositions 摘掉（重挂的位置权威在主进程）
          pendingPositionUpdates.current.set(change.id, { ...change.position })
        }
      }

      if (localUpdates.length > 0) {
        useGraphStore.getState().applyLocalPositions(localUpdates)
      }

      // 防抖：300ms 内没有新的位置变化则批量保存
      if (pendingPositionUpdates.current.size > 0) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = setTimeout(flushPositionUpdates, 300)
      }
    },
    [flushPositionUpdates],
  )

  // 切换图时先刷入待保存的位置队列，再清空
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    flushPositionUpdates()
  }, [graphId, flushPositionUpdates])

  // 组件卸载时刷入最后的位置更新
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        flushPositionUpdates()
      }
    }
  }, [flushPositionUpdates])

  return { handleNodesChange, suppressPositions, releasePositions }
}
