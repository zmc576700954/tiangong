/**
 * useForceLayout — 交互式力导向布局 hook
 *
 * 提供：
 * - `applyForceLayout()` —— 一键布局：同步 200 tick 后写入 store 并持久化
 * - 拖拽事件处理器（start / move / stop） —— 在 force mode 下与 d3 仿真协作
 * - `isForceMode` ref —— 供 UI 判断当前是否处于 force mode
 *
 * 与 useAutoLayout 的差异：
 * - applyForceLayout 完成后保持一个「冻结」的 d3 simulation
 * - 拖拽节点时把 simulation 的 fx/fy 跟随 ReactFlow 的拖拽位置，
 *   alphaTarget=0 让 simulation 在拖拽期间不主动位移
 * - 拖拽结束时清 fx/fy、alpha=0.3 重启、同步 tick 至冷却，再把位置写回 store
 *
 * 注意：所有操作只在 force mode 下生效；UI 在切换布局类型时应先调
 * `setForceMode(false)` 或重新加载图来退出 force mode。
 */
import { useCallback, useEffect, useRef } from 'react'
import { useReactFlow, type NodeMouseHandler } from '@xyflow/react'
import {
  type Simulation,
} from 'd3-force'
import { computeForceLayout, createForceSimulation, type ForceNodeDatum, type ForceLinkDatum } from '../layouts/force-layout'
import { useGraphStore } from '../../store/graphStore'

export interface UseForceLayoutOptions {
  /** 画布中心 x；不传则用 ReactFlow 当前 viewport 中心 */
  centerX?: number
  /** 画布中心 y */
  centerY?: number
  /** 拖拽结束后 reheat 的最大 tick 数（防御性上限，避免极端图收敛过慢） */
  reheatMaxTicks?: number
  /** reheat 后收敛阈值 —— alpha 低于此值则停止 tick */
  reheatAlphaThreshold?: number
}

const DEFAULT_REHEAT_MAX_TICKS = 300
const DEFAULT_REHEAT_ALPHA_THRESHOLD = 0.01

interface SimulationHolder {
  simulation: Simulation<ForceNodeDatum, ForceLinkDatum>
  simNodes: Map<string, ForceNodeDatum>
  reheatMaxTicks: number
  reheatAlphaThreshold: number
}

export function useForceLayout(options: UseForceLayoutOptions = {}) {
  const { getNodes, getEdges, setNodes, fitView } = useReactFlow()
  const batchUpdatePositions = useGraphStore((s) => s.batchUpdatePositions)

  const holderRef = useRef<SimulationHolder | null>(null)
  const isForceModeRef = useRef(false)

  /**
   * 把当前 simNodes 位置写回 ReactFlow nodes 并持久化。
   * `excludePinned` 为 true 时跳过 fx/fy 非空的节点（保留用户当前拖拽位置）。
   */
  const syncPositionsToStore = useCallback(
    (excludePinned: boolean) => {
      const holder = holderRef.current
      if (!holder) return
      const allNodes = getNodes()
      const updated = allNodes.map((n) => {
        const sn = holder.simNodes.get(n.id)
        if (!sn) return n
        if (excludePinned && (sn.fx != null || sn.fy != null)) return n
        return {
          ...n,
          position: {
            x: sn.x ?? n.position.x,
            y: sn.y ?? n.position.y,
          },
        }
      })
      setNodes(updated)
    },
    [getNodes, setNodes],
  )

  const applyForceLayout = useCallback(() => {
    const nodes = getNodes()
    const edges = getEdges()
    if (nodes.length === 0) return

    const center = options.centerX != null && options.centerY != null
      ? { x: options.centerX, y: options.centerY }
      : null

    // 1. 一次性同步 200 tick 拿到初始位置
    const layouted = computeForceLayout(nodes, edges, {
      centerX: center?.x,
      centerY: center?.y,
    })

    // 2. 写回 ReactFlow 并持久化
    setNodes(layouted)
    const updates = layouted.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
    }))
    batchUpdatePositions(updates).catch((err) => {
      console.error('[useForceLayout] Failed to batch persist positions:', err)
    })

    requestAnimationFrame(() => {
      fitView({
        padding: 0.15,
        duration: 400,
        minZoom: 0.4,
        maxZoom: 1.2,
      })
    })

    // 3. 建立一个冻结的 simulation（alpha=0），供后续拖拽交互使用
    if (holderRef.current) {
      holderRef.current.simulation.stop()
      holderRef.current = null
    }
    if (layouted.length > 0) {
      const { simulation, simNodes } = createForceSimulation(layouted, edges, {
        centerX: center?.x,
        centerY: center?.y,
      })
      holderRef.current = {
        simulation,
        simNodes: new Map(simNodes.map((sn) => [sn.id, sn])),
        reheatMaxTicks: options.reheatMaxTicks ?? DEFAULT_REHEAT_MAX_TICKS,
        reheatAlphaThreshold: options.reheatAlphaThreshold ?? DEFAULT_REHEAT_ALPHA_THRESHOLD,
      }
      isForceModeRef.current = true
    }
  }, [
    getNodes,
    getEdges,
    setNodes,
    batchUpdatePositions,
    fitView,
    options.centerX,
    options.centerY,
    options.reheatMaxTicks,
    options.reheatAlphaThreshold,
  ])

  /** 退出 force mode —— 在切换布局类型或卸载图时调用 */
  const exitForceMode = useCallback(() => {
    holderRef.current?.simulation.stop()
    holderRef.current = null
    isForceModeRef.current = false
  }, [])

  // 拖拽开始：pin 当前节点，simulation 冻结
  const onNodeDragStart: NodeMouseHandler = useCallback((_event, node) => {
    if (!isForceModeRef.current) return
    const holder = holderRef.current
    if (!holder) return
    const simNode = holder.simNodes.get(node.id)
    if (!simNode) return
    simNode.fx = node.position.x
    simNode.fy = node.position.y
    holder.simulation.alphaTarget(0).restart()
  }, [])

  // 拖拽中：跟随更新 fx/fy
  const onNodeDrag: NodeMouseHandler = useCallback((_event, node) => {
    if (!isForceModeRef.current) return
    const holder = holderRef.current
    if (!holder) return
    const simNode = holder.simNodes.get(node.id)
    if (!simNode) return
    simNode.fx = node.position.x
    simNode.fy = node.position.y
  }, [])

  // 拖拽结束：清 pin、reheat、同步收敛、写回 store
  const onNodeDragStop: NodeMouseHandler = useCallback((_event, node) => {
    if (!isForceModeRef.current) return
    const holder = holderRef.current
    if (!holder) return
    const simNode = holder.simNodes.get(node.id)
    if (!simNode) return
    simNode.fx = null
    simNode.fy = null

    holder.simulation.alpha(0.3).alphaTarget(0).restart()

    // 同步 tick 至收敛或上限（避免长时间阻塞主线程）
    let ticks = 0
    while (
      holder.simulation.alpha() > holder.reheatAlphaThreshold &&
      ticks < holder.reheatMaxTicks
    ) {
      holder.simulation.tick()
      ticks += 1
    }
    holder.simulation.stop()

    syncPositionsToStore(true)

    // 持久化所有节点的最终位置
    const allNodes = getNodes()
    const updates = allNodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }))
    batchUpdatePositions(updates).catch((err) => {
      console.error('[useForceLayout] Failed to persist after drag-stop:', err)
    })
  }, [getNodes, batchUpdatePositions, syncPositionsToStore])

  // 组件卸载 / graphId 切换时清理 simulation
  useEffect(() => {
    return () => {
      holderRef.current?.simulation.stop()
      holderRef.current = null
      isForceModeRef.current = false
    }
  }, [])

  return {
    applyForceLayout,
    exitForceMode,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    isForceModeRef,
  }
}
