/**
 * useReparentDrag —— 拖拽重挂父节点
 *
 * 拖动节点时实时判定「指针下面那个节点」能不能当新父节点：
 * 能 → 绿色高亮 + 幽灵连线；不能 → 红色高亮 + 原因说明。
 * 松手在合法落点上就调 `graph:reparent`（主进程算好锚点位置并平移整棵子树）。
 *
 * 坐标系：**flow 坐标**。换算由调用方（GraphCanvas）用 `screenToFlowPosition` 做 ——
 * 本 hook 不自己调 `useReactFlow()`，否则脱离 `<ReactFlowProvider />` 会抛。
 *
 * 判定规则与主进程 `nodeTypeRegistry.validateParentChild` 逐条对齐，
 * 详见 `checkTypeRule` 的注释（两处写反就会出现「画布说能挂、主进程拒掉」）。
 */
import { useCallback, useRef, useState } from 'react'
import type { Node } from '@xyflow/react'
import type { GraphNode, NodeTypeConfig } from '@shared/types'
import type { TranslationKey } from '@shared/i18n'
import { useGraphStore } from '../../store/graphStore'
import { useNodeTypeConfigs } from './useNodeTypeConfigs'
import { estimateNodeHeight, estimateNodeWidth } from '../layouts/force-layout'
import { useI18n } from '../../i18n/useI18n'
import { toastError, toastSuccess } from '../../lib/toast'

/** 落点非法的原因 */
export type ReparentReason = 'cycle' | 'type' | 'cross-graph'

export interface ReparentCandidate {
  /** 被命中的候选父节点 id */
  nodeId: string
  /** 落点是否合法 */
  valid: boolean
  /** 非法原因；合法时没有 */
  reason?: ReparentReason
}

/** 非法原因 → i18n key。红框旁的说明文字用它。 */
export const REPARENT_REASON_I18N_KEY: Record<ReparentReason, TranslationKey> = {
  cycle: 'canvas.reparent.cycle',
  type: 'canvas.reparent.invalidType',
  'cross-graph': 'canvas.reparent.crossGraph',
}

export interface UseReparentDragOptions {
  /**
   * 「位置已被重挂接管」的抑制入口。
   * 重挂的权威位置来自主进程返回的 movedPositions，自由位置持久化必须让位。
   */
  suppressPositions?: (ids: string[]) => void
  /** 重挂结束（成功或失败）后解除抑制 */
  releasePositions?: (ids: string[]) => void
}

/** flow 坐标下的节点矩形 */
interface FlowRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 把 GraphNode 换算成 React Flow 的 Node —— `estimateNodeWidth/Height` 吃的是
 * 前者（读 `node.data.type` / `node.data.title`），不是 GraphNode。
 */
function toFlowNode(node: GraphNode): Node {
  return {
    id: node.id,
    position: node.position,
    data: { type: node.type, title: node.title },
  }
}

/** 节点的命中矩形（flow 坐标）。尺寸与 force-layout 的估算保持一致 —— 落点判定要跟用户看到的对得上。 */
function nodeRect(node: GraphNode): FlowRect {
  const flowNode = toFlowNode(node)
  return {
    x: node.position.x,
    y: node.position.y,
    width: estimateNodeWidth(flowNode),
    height: estimateNodeHeight(flowNode),
  }
}

/**
 * 找出包含 pointer 的节点。
 *
 * 只排除**被拖节点自身** —— 拖动时指针必然落在它自己的矩形里（节点跟着指针走），
 * 不排除的话每个落点都会被它自己吃掉。
 * 后代**不能**排除：「把节点拖到自己的子节点上」是用户真的会犯的错，
 * 要给它红色反馈（reason: 'cycle'），而不是当作「没命中」。
 *
 * 遍历 store 里的**全部**节点（不只当前图）—— 别的图的节点也要能被命中，
 * 才能被判成 cross-graph。
 */
function findHitNode(
  nodes: GraphNode[],
  pointer: { x: number; y: number },
  excludeId: string | null,
): GraphNode | null {
  let hit: GraphNode | null = null
  for (const node of nodes) {
    if (node.id === excludeId) continue
    const rect = nodeRect(node)
    const inside =
      pointer.x >= rect.x &&
      pointer.x <= rect.x + rect.width &&
      pointer.y >= rect.y &&
      pointer.y <= rect.y + rect.height
    if (inside) hit = node
  }
  // 多个节点同时命中时取最后一个：store 的数组顺序即渲染顺序，后者在上面。
  return hit
}

/** 收集某节点的全部后代（沿 parentId 下行） */
function collectDescendants(nodes: GraphNode[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  for (const node of nodes) {
    if (!node.parentId) continue
    const siblings = childrenByParent.get(node.parentId)
    if (siblings) siblings.push(node.id)
    else childrenByParent.set(node.parentId, [node.id])
  }

  const descendants = new Set<string>()
  const stack: string[] = [rootId]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    for (const child of childrenByParent.get(current) ?? []) {
      if (descendants.has(child)) continue
      descendants.add(child)
      stack.push(child)
    }
  }
  return descendants
}

/**
 * 父子类型判定 —— 必须与主进程 `nodeTypeRegistry.validateParentChild` 逐条对齐。
 *
 * 主进程语义（`src/main/shared/node-type-registry.ts`）：
 *   - 配置对象缺失（未知类型） → `if (!parent || !child) return false` → 拒绝
 *   - `allowedChildTypes` 缺字段 → 注册时已归一化成 `[]`（= 不允许任何子节点）→ 拒绝
 *   - `allowedParentTypes` 缺字段 → 故意**不**归一化，缺省表示「无限制」→ 放行
 *
 * 两个字段的缺省语义是**相反**的（子类型表缺省 = 拒绝 / 父类型表缺省 = 允许）。
 * 写反了就会出现「渲染端说可以挂、主进程 graph:reparent 拒掉」。
 */
function checkTypeRule(
  configs: Record<string, NodeTypeConfig>,
  parentType: string,
  childType: string,
): boolean {
  const parentCfg = configs[parentType]
  const childCfg = configs[childType]
  const parentOk = !!parentCfg && (parentCfg.allowedChildTypes ?? []).includes(childType)
  const childOk =
    !!childCfg && (!childCfg.allowedParentTypes || childCfg.allowedParentTypes.includes(parentType))
  return parentOk && childOk
}

export function useReparentDrag(options: UseReparentDragOptions = {}) {
  const { suppressPositions, releasePositions } = options
  const nodes = useGraphStore((s) => s.nodes)
  const reparentNode = useGraphStore((s) => s.reparentNode)
  const batchUpdatePositions = useGraphStore((s) => s.batchUpdatePositions)
  const { configs, loaded } = useNodeTypeConfigs()
  const { t } = useI18n()

  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<ReparentCandidate | null>(null)

  /** 拖动中的节点 id —— ref 是权威，state 只是给渲染层看的 */
  const draggingIdRef = useRef<string | null>(null)
  /** 被拖节点的后代集合（成环判定用） */
  const descendantsRef = useRef<Set<string>>(new Set())
  /** 拖拽开始时的原位 —— 重挂失败时回弹用 */
  const originRef = useRef<{ x: number; y: number } | null>(null)
  /** 上一轮候选 —— 避免每次指针移动都 setState（拖拽全程每帧重渲染会掉帧） */
  const candidateRef = useRef<ReparentCandidate | null>(null)

  const applyCandidate = useCallback((next: ReparentCandidate | null) => {
    const prev = candidateRef.current
    if (prev === next) return
    if (
      prev &&
      next &&
      prev.nodeId === next.nodeId &&
      prev.valid === next.valid &&
      prev.reason === next.reason
    ) {
      return
    }
    candidateRef.current = next
    setCandidate(next)
  }, [])

  /**
   * 判定落点。
   *
   * 返回 null = 没有候选（不画任何高亮）。返回 valid:false = 命中了但非法。
   */
  const computeCandidate = useCallback(
    (pointer: { x: number; y: number }): ReparentCandidate | null => {
      const draggingId = draggingIdRef.current
      if (!draggingId) return null
      const draggingNode = nodes.find((n) => n.id === draggingId)
      if (!draggingNode) return null

      const hit = findHitNode(nodes, pointer, draggingId)
      if (!hit) return null

      // 规则表未就绪 → 不做任何判定。
      // loaded === false 时 configs 是空表，照常判定会把**所有**合法落点
      // 判成 type 不合法，给用户一个错误的红框。
      if (!loaded) return null
      // 空表 = 规则**不可用**（IPC 失败），不是「所有类型都非法」。
      // 规则没说「不」，只是没拿到 —— 没有规则就没有红框。
      if (Object.keys(configs).length === 0) return null

      // ① 命中的是自己的后代 → 成环
      if (descendantsRef.current.has(hit.id)) {
        return { nodeId: hit.id, valid: false, reason: 'cycle' }
      }
      // ② 跨图
      if (hit.graphId !== draggingNode.graphId) {
        return { nodeId: hit.id, valid: false, reason: 'cross-graph' }
      }
      // ③ 父子类型不合法
      if (!checkTypeRule(configs, hit.type, draggingNode.type)) {
        return { nodeId: hit.id, valid: false, reason: 'type' }
      }
      // ④ 合法
      return { nodeId: hit.id, valid: true }
    },
    [nodes, configs, loaded],
  )

  /** 拖拽开始：记下被拖节点、它的后代集合与原位 */
  const onDragStart = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId)
      draggingIdRef.current = nodeId
      descendantsRef.current = collectDescendants(nodes, nodeId)
      originRef.current = node ? { x: node.position.x, y: node.position.y } : null
      setDraggingNodeId(nodeId)
      applyCandidate(null)
    },
    [nodes, applyCandidate],
  )

  /** 拖拽中：更新高亮候选 */
  const onDrag = useCallback(
    (pointer: { x: number; y: number }) => {
      if (!draggingIdRef.current) return
      applyCandidate(computeCandidate(pointer))
    },
    [computeCandidate, applyCandidate],
  )

  /**
   * 松手。
   *
   * 必须收落点坐标并**在落点重新判一次**候选：最后一次 onDrag 的坐标与真正
   * 松手的位置可能差一次 mousemove（xyflow 的拖拽事件与鼠标事件不同步），
   * 拿 onDrag 的候选当裁决会出现「明明松在目标上，却因为最后一次候选判定是空的
   * 而没有重挂」—— 用户看到的是「拖过去没反应」。
   */
  const onDragEnd = useCallback(
    (pointer: { x: number; y: number }) => {
      const draggingId = draggingIdRef.current
      if (!draggingId) return

      const final = computeCandidate(pointer)

      draggingIdRef.current = null
      setDraggingNodeId(null)
      applyCandidate(null)

      // 未命中 / 非法落点 → 什么都不做：拖拽退化成普通移动，位置照常持久化。
      if (!final || !final.valid) return

      const origin = originRef.current
      const parentTitle = nodes.find((n) => n.id === final.nodeId)?.title ?? final.nodeId

      // 位置权威：重挂接管这个节点的位置 —— 先抑制自由位置持久化并把它从待写队列里摘掉，
      // 否则「指针松开处的坐标」会和「主进程算出的锚点位置」抢同一个节点，
      // 顺序不保证 → 节点停在手指松开的地方，整棵子树的跟随就白做了。
      suppressPositions?.([draggingId])

      void Promise.resolve(reparentNode(draggingId, final.nodeId))
        .then(() => {
          releasePositions?.([draggingId])
          toastSuccess(t('canvas.reparent.success', { parent: parentTitle }))
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          toastError(t('canvas.reparent.failed'), message)
          // 回弹到原位。位置必须是**新建的字面量**：flowNodes 的缓存比的是引用，
          // 引用相同 → 复用旧节点对象 → xyflow 不更新位置 → 看起来没回弹。
          if (origin) {
            void batchUpdatePositions([{ id: draggingId, x: origin.x, y: origin.y }]).catch(
              (rollbackErr: unknown) => {
                console.error('[useReparentDrag] Failed to roll back position:', rollbackErr)
              },
            )
          }
          releasePositions?.([draggingId])
        })
    },
    [
      computeCandidate,
      applyCandidate,
      nodes,
      reparentNode,
      batchUpdatePositions,
      suppressPositions,
      releasePositions,
      t,
    ],
  )

  return { draggingNodeId, candidate, onDragStart, onDrag, onDragEnd }
}
