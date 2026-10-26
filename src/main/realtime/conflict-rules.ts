/**
 * Conflict Resolution Rules (D10d-1 / D10d-2)
 *
 * Yjs CRDT 给的是「最终一致」，但业务期望是「按规则区分对待」：
 *   - text 字段（标题、描述、wiki 内容等）：CRDT 自动合并，不主动拒绝
 *   - enum 字段（status、severity、edgeType）：写入前查状态机，非法转换拒绝
 *   - 身份字段（id / graphId / createdAt）：不可写，改了就拒绝
 *   - Lamport 序字段（parentId / position.x / ownerRole）：并发更新时
 *     用 lamport 决胜，只对 loser 做观测报告（不拒绝）
 *
 * 本模块只产出 *规则* 与 *判定函数*；真正挂到 Y.Doc 上是 `attachConflictResolver`。
 * 数据结构与函数分离，便于单测（不需要 Y.Doc 也能跑大部分规则表测试）。
 *
 * 关键设计：
 *   - 规则是纯数据 + 纯函数；不依赖 Y.Doc 实例
 *   - 拒绝路径用 `Y.transact(doc, () => map.set(field, prev))` 回滚
 *   - Lamport clock 持久化在 doc 的 `meta: Y.Map` 中，key = `<entity>:<id>:<field>`
 */

import * as Y from 'yjs'
import type { NodeType, GraphEdge, BugNode } from '@shared/types/graph'
import { validateNodeTypeTransition, validateBugTransition } from '@shared/state-machine'
import { buildConflictId, type ConflictKind, type ConflictReport, type StatusTransitionDetail } from '@shared/types/conflict'
import type { LamportTimestamp } from './lamport'
import { compareLamport, decodeLamport, encodeLamport } from './lamport'

/** 冲突解决策略（按字段级别） */
export type ConflictStrategy =
  | 'text-crdt' // Y.Text 自动合并，不主动干预
  | 'state-machine' // 写入前调用 validate 函数，throw 即拒绝
  | 'last-write-wins' // 接受最新写入（CRDT 默认行为），仅 lamport 元数据记录
  | 'lamport-ordered' // 并发时 lamport 大者赢，loser 写入被回滚
  | 'identity-immutable' // 不允许写；任何 attempt 即拒绝

/** 单字段规则 */
export interface FieldRule {
  /** 字段名（GraphNode / GraphEdge / BugNode 顶层字段） */
  field: string
  /** 应用策略 */
  strategy: ConflictStrategy
  /** state-machine 专用：验证 prev → next 是否合法 */
  validate?: (prev: unknown, next: unknown, nodeType?: NodeType) => void
}

/** 节点类型专属规则表（key = NodeType） */
export type NodeFieldRuleTable = Record<NodeType, FieldRule[]>

/** 边规则表（按 edgeType 子分组；默认规则适用所有 edge） */
export interface EdgeFieldRuleTable {
  default: FieldRule[]
}

/** Bug 字段规则表 */
export type BugFieldRuleTable = FieldRule[]

/** 文本字段名集合（按 GraphNode / Edge / Bug 分组）
 *
 * 注：本字段是 *当前规则表* 内置；若有新增 text 字段必须同时更新。
 * 用静态 set 是为了快速 lookup 与测试断言「该字段是 text」。
 */
export const NODE_TEXT_FIELDS = new Set<string>([
  'title',
  'description',
  'wikiContent',
  'communitySummary',
  // content.* 嵌套字段统一走 nested resolver，不参与本表判定
])
export const EDGE_TEXT_FIELDS = new Set<string>(['label', 'description', 'dataFlow'])
export const BUG_TEXT_FIELDS = new Set<string>(['title', 'description'])

// ============================================================
// 节点规则表（按 NodeType）
// ============================================================

const COMMON_NODE_IDENTITY: FieldRule[] = [
  { field: 'id', strategy: 'identity-immutable' },
  { field: 'graphId', strategy: 'identity-immutable' },
  { field: 'graphType', strategy: 'identity-immutable' },
  { field: 'createdAt', strategy: 'identity-immutable' },
]

const COMMON_NODE_TEXT: FieldRule[] = [
  { field: 'title', strategy: 'text-crdt' },
  { field: 'description', strategy: 'text-crdt' },
  { field: 'wikiContent', strategy: 'text-crdt' },
  { field: 'communitySummary', strategy: 'text-crdt' },
]

const COMMON_NODE_STATUS: FieldRule[] = [
  {
    field: 'status',
    strategy: 'state-machine',
    validate: (prev, next, nodeType) => {
      if (typeof prev !== 'string' || typeof next !== 'string') {
        throw new Error('status must be string')
      }
      validateNodeTypeTransition(nodeType as NodeType, prev as never, next as never)
    },
  },
]

const COMMON_NODE_LAMPORT: FieldRule[] = [
  { field: 'parentId', strategy: 'lamport-ordered' },
  { field: 'ownerRole', strategy: 'lamport-ordered' },
  { field: 'position', strategy: 'lamport-ordered' },
]

const COMMON_NODE_LWW: FieldRule[] = [
  // type 在 create 时设定后不应再改，但不构成 immune→immutable（业务偶有修）
  { field: 'type', strategy: 'last-write-wins' },
  { field: 'updatedAt', strategy: 'last-write-wins' },
  { field: 'communityId', strategy: 'last-write-wins' },
  { field: 'communityLevel', strategy: 'last-write-wins' },
  { field: 'contextRefs', strategy: 'last-write-wins' },
  { field: 'rules', strategy: 'last-write-wins' },
  { field: 'metadata', strategy: 'last-write-wins' },
  { field: 'content', strategy: 'last-write-wins' },
  { field: 'wikiMeta', strategy: 'last-write-wins' },
  { field: 'acceptanceCriteria', strategy: 'last-write-wins' },
]

/** NODE_FIELD_RULES — 所有 NodeType 共用一套顶层字段；
 * bug 类型额外有 severity（但 severity 在 BugNode，不在 GraphNode）。
 */
export const NODE_FIELD_RULES: NodeFieldRuleTable = {
  project: [
    ...COMMON_NODE_IDENTITY,
    ...COMMON_NODE_TEXT,
    ...COMMON_NODE_STATUS,
    ...COMMON_NODE_LAMPORT,
    ...COMMON_NODE_LWW,
  ],
  module: [
    ...COMMON_NODE_IDENTITY,
    ...COMMON_NODE_TEXT,
    ...COMMON_NODE_STATUS,
    ...COMMON_NODE_LAMPORT,
    ...COMMON_NODE_LWW,
  ],
  process: [
    ...COMMON_NODE_IDENTITY,
    ...COMMON_NODE_TEXT,
    ...COMMON_NODE_STATUS,
    ...COMMON_NODE_LAMPORT,
    ...COMMON_NODE_LWW,
  ],
  feature: [
    ...COMMON_NODE_IDENTITY,
    ...COMMON_NODE_TEXT,
    ...COMMON_NODE_STATUS,
    ...COMMON_NODE_LAMPORT,
    ...COMMON_NODE_LWW,
  ],
  bug: [
    ...COMMON_NODE_IDENTITY,
    ...COMMON_NODE_TEXT,
    ...COMMON_NODE_STATUS,
    ...COMMON_NODE_LAMPORT,
    ...COMMON_NODE_LWW,
  ],
  'wiki-page': [
    ...COMMON_NODE_IDENTITY,
    ...COMMON_NODE_TEXT,
    ...COMMON_NODE_STATUS,
    ...COMMON_NODE_LAMPORT,
    ...COMMON_NODE_LWW,
  ],
}

// ============================================================
// 边规则表
// ============================================================

export const EDGE_FIELD_RULES: EdgeFieldRuleTable = {
  default: [
    { field: 'id', strategy: 'identity-immutable' },
    { field: 'graphId', strategy: 'identity-immutable' },
    { field: 'source', strategy: 'identity-immutable' },
    { field: 'target', strategy: 'identity-immutable' },
    { field: 'label', strategy: 'text-crdt' },
    { field: 'description', strategy: 'text-crdt' },
    { field: 'dataFlow', strategy: 'text-crdt' },
    { field: 'edgeType', strategy: 'last-write-wins' },
    { field: 'strength', strategy: 'lamport-ordered' },
    { field: 'content', strategy: 'last-write-wins' },
  ],
}

// ============================================================
// Bug 规则表
// ============================================================

export const BUG_FIELD_RULES: BugFieldRuleTable = [
  { field: 'id', strategy: 'identity-immutable' },
  { field: 'nodeId', strategy: 'identity-immutable' },
  { field: 'graphId', strategy: 'identity-immutable' },
  { field: 'createdAt', strategy: 'identity-immutable' },
  { field: 'title', strategy: 'text-crdt' },
  { field: 'description', strategy: 'text-crdt' },
  { field: 'severity', strategy: 'state-machine', validate: (prev, next) => {
    const allowed: Record<string, Set<string>> = {
      low: new Set(['low', 'medium', 'high', 'critical']),
      medium: new Set(['low', 'medium', 'high', 'critical']),
      high: new Set(['low', 'medium', 'high', 'critical']),
      critical: new Set(['low', 'medium', 'high', 'critical']),
    }
    if (typeof prev !== 'string' || typeof next !== 'string') {
      throw new Error('severity must be string')
    }
    if (prev === next) return
    const set = allowed[prev]
    if (!set || !set.has(next)) {
      throw new Error(`Illegal severity transition: ${prev} → ${next}`)
    }
  } },
  { field: 'status', strategy: 'state-machine', validate: (prev, next) => {
    if (typeof prev !== 'string' || typeof next !== 'string') {
      throw new Error('status must be string')
    }
    validateBugTransition(prev as never, next as never)
  } },
  { field: 'updatedAt', strategy: 'last-write-wins' },
]

// ============================================================
// Hooks 上下文
// ============================================================

/** 解析器挂载时给的回调 */
export interface ConflictHooks {
  /** 当一个冲突被记录时调用（已自动 rollback） */
  onConflict: (report: ConflictReport) => void
  /** 当前 actor id（写入 Lamport 用） */
  actorId: string
  /** 当前 graph id（写入 ConflictReport 用） */
  graphId: string
}

/** 解析器内部状态：doc → 挂载句柄 */
export interface ResolverHandle {
  /** 卸载：调用 doc.off 解绑所有 observer */
  detach: () => void
}

// ============================================================
// Lamport meta 持久化（存在 Y.Doc 的 meta Y.Map 中）
// ============================================================

const META_LAMPORT_PREFIX = 'lamport:'

function lamportMetaKey(entity: 'node' | 'edge' | 'bug', id: string, field: string): string {
  return `${META_LAMPORT_PREFIX}${entity}:${id}:${field}`
}

function readLamportMeta(doc: Y.Doc, entity: 'node' | 'edge' | 'bug', id: string, field: string): LamportTimestamp | null {
  const meta = doc.getMap('meta')
  const raw = meta.get(lamportMetaKey(entity, id, field))
  return decodeLamport(raw)
}

function writeLamportMeta(doc: Y.Doc, entity: 'node' | 'edge' | 'bug', id: string, field: string, ts: LamportTimestamp): void {
  const meta = doc.getMap('meta')
  meta.set(lamportMetaKey(entity, id, field), encodeLamport(ts))
}

// ============================================================
// 单次变更判定（纯逻辑，可单测）
// ============================================================

export interface ChangeContext {
  /** 字段名 */
  field: string
  /** 旧值（来自 Y.Map.get(field) before transaction） */
  prev: unknown
  /** 新值（来自 transaction applied） */
  next: unknown
  /** NodeType（仅节点；边/bug 传 undefined） */
  nodeType?: NodeType
  /** entity 类型（用于查 lamport meta） */
  entity: 'node' | 'edge' | 'bug'
  /** 实体 id */
  entityId: string
}

export interface VerdictAction {
  /** 是否要回滚 */
  rollback: boolean
  /** 是否要写入 lamport 元数据 */
  bumpLamport: boolean
  /** 若产生冲突，对应 ConflictKind（rollback=true 时一定有） */
  kind?: ConflictKind
  /** 拒绝原因（rollback=true 时必填） */
  reason?: string
}

/** 判定一条变更的处置
 *
 * - prev === next → no-change（不产生 report）
 * - 命中 IMMUTABLE 且 next !== prev → rollback
 * - 命中 STATE_MACHINE 且 validate(prev, next) 抛错 → rollback
 * - 命中 LAMPORT_ORDERED：与 meta 中远端 clock 比较，远端大 → rollback + loser 报告
 *   （无远端 lamport 即首次写入 → 放行 + 写 meta）
 * - 命中 TEXT_CRT / LAST_WRITE_WINS → 放行，不写 lamport
 */
export function judgeChange(
  ctx: ChangeContext,
  rule: FieldRule,
  remoteLamport: LamportTimestamp | null,
  localLamport: LamportClockLike,
): VerdictAction {
  // same-node: 本人同字段重复 set 不算 conflict
  if (ctx.prev === ctx.next) {
    return { rollback: false, bumpLamport: false }
  }

  switch (rule.strategy) {
    case 'identity-immutable': {
      // identity 字段不容许变更；但首创建（prev === undefined）允许
      if (ctx.prev === undefined) {
        return { rollback: false, bumpLamport: false }
      }
      return {
        rollback: true,
        bumpLamport: false,
        kind: 'identity-immutable',
        reason: `字段「${ctx.field}」为身份字段，写入后不可变更`,
      }
    }

    case 'state-machine': {
      if (ctx.prev === undefined) {
        // 首创建：状态机允许任意合法值；validate 已在外层 NodeRepository.create 处理
        return { rollback: false, bumpLamport: false }
      }
      try {
        rule.validate?.(ctx.prev, ctx.next, ctx.nodeType)
        return { rollback: false, bumpLamport: false }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          rollback: true,
          bumpLamport: false,
          kind: 'illegal-status-transition',
          reason: message,
        }
      }
    }

    case 'lamport-ordered': {
      if (!remoteLamport) {
        // 首次写入本字段：放行，写 meta
        return { rollback: false, bumpLamport: true }
      }
      // 本地事务的 lamport（由 hooks 注入）
      const localTs = localLamport.currentTimestamp()
      const cmp = compareLamport(localTs, remoteLamport)
      if (cmp === 0) {
        // 同 lamport：accept（Yjs 已保证 ID 不重复）
        return { rollback: false, bumpLamport: true }
      }
      if (cmp > 0) {
        // 本地 lamport 更新：accept
        return { rollback: false, bumpLamport: true }
      }
      // cmp < 0：远端更新 → rollback
      return {
        rollback: true,
        bumpLamport: false,
        kind: 'lamport-loser',
        reason: `字段「${ctx.field}」的远端 Lamport 更新（${remoteLamport.clock}@${remoteLamport.actorId}）晚于本地（${localTs.clock}@${localTs.actorId}），回滚`,
      }
    }

    case 'text-crdt':
    case 'last-write-wins':
    default:
      return { rollback: false, bumpLamport: false }
  }
}

/** 抽象的 LamportClockLike 接口 — 避免依赖 LamportClock 实例，便于单测 */
export interface LamportClockLike {
  currentTimestamp: () => LamportTimestamp
}

// ============================================================
// 解析器挂载到 Y.Doc
// ============================================================

/** attachConflictResolver
 *
 * 把所有 nodes / edges / bugs 子 Map 的 observeDeep 钩到 doc 上。
 * 每次变更后调用 judgeChange：
 *   - rollback=true：用 Y.transact 包内 set(prev) 还原，并 emit onConflict
 *   - bumpLamport=true：写 lamport meta
 *
 * detach() 完整解绑（按 observerHandle 列表）。
 */
export function attachConflictResolver(
  doc: Y.Doc,
  hooks: ConflictHooks,
  clock: LamportClockLike,
): ResolverHandle {
  const observers: Array<() => void> = []

  // 注册 nodes / edges / bugs：
  // 1) 顶层 map 用 observe 监听「entity 增删」；新加的 entity 再挂字段级 observer
  // 2) 已存在的 entity 在 attach 时直接挂
  const nodesMap = doc.getMap<Y.Map<unknown>>('nodes')
  const edgesMap = doc.getMap<Y.Map<unknown>>('edges')
  const bugsMap = doc.getMap<Y.Map<unknown>>('bugs')

  // 跟踪 entity 内部字段 observer，便于 entity 被删除时解绑
  const entityDetachers = new Map<string, () => void>()

  const attachEntity = (entity: 'node' | 'edge' | 'bug', entityMap: Y.Map<unknown>) => {
    let entityId: string | null = null
    const idRaw = entityMap.get('id')
    if (typeof idRaw === 'string') entityId = idRaw

    // 选 rule table
    const getRulesForEntity = (_eid: string, nodeType?: NodeType): FieldRule[] => {
      if (entity === 'edge') return EDGE_FIELD_RULES.default
      if (entity === 'bug') return BUG_FIELD_RULES
      // node
      if (!nodeType) return NODE_FIELD_RULES.module
      return NODE_FIELD_RULES[nodeType] ?? NODE_FIELD_RULES.module
    }
    const getNodeType = (): NodeType | undefined => {
      const t = entityMap.get('type')
      return typeof t === 'string' ? (t as NodeType) : undefined
    }

    // 单 map 字段级 observer
    const fieldObserver = (event: Y.YMapEvent<unknown>) => {
      // 跳过回滚事务，避免无限递归
      if (event.transaction.origin === 'conflict-rollback') return
      if (event.target !== (entityMap as unknown as Y.Map<unknown>)) return
      for (const [key, change] of event.changes.keys.entries()) {
        if (!entityId) {
          // 延迟取 id（首次 observe 时 id 字段可能未写入）
          const idNow = entityMap.get('id')
          if (typeof idNow !== 'string') continue
          entityId = idNow
        }
        const nodeType = entity === 'node' ? getNodeType() : undefined
        const rules = getRulesForEntity(entityId, nodeType)
        const rule = rules.find((r) => r.field === key)
        if (!rule) continue
        const remoteTs = readLamportMeta(doc, entity, entityId, key)
        const nextValue = change.action === 'delete' ? undefined : entityMap.get(key)
        const verdict = judgeChange(
          {
            field: key,
            prev: change.oldValue,
            next: nextValue,
            nodeType,
            entity,
            entityId,
          },
          rule,
          remoteTs,
          clock,
        )
        if (verdict.bumpLamport) {
          writeLamportMeta(doc, entity, entityId, key, clock.currentTimestamp())
        }
        if (verdict.rollback && verdict.kind) {
          const prevValue = change.oldValue
          Y.transact(doc, () => {
            entityMap.set(key, prevValue)
          }, 'conflict-rollback')
          const report: ConflictReport = {
            id: buildConflictId(hooks.graphId, verdict.kind, entityId, key, clock.currentTimestamp().clock),
            kind: verdict.kind,
            graphId: hooks.graphId,
            nodeId: entityId,
            field: key,
            prevValue: change.oldValue,
            attemptedValue: nextValue,
            lamportClock: clock.currentTimestamp().clock,
            actorId: hooks.actorId,
            reason: verdict.reason ?? 'conflict',
            ts: new Date().toISOString(),
            nodeTitle: typeof entityMap.get('title') === 'string' ? (entityMap.get('title') as string) : undefined,
          }
          hooks.onConflict(report)
        }
      }
    }
    entityMap.observe(fieldObserver as Parameters<typeof entityMap.observe>[0])
    return () => entityMap.unobserve(fieldObserver as Parameters<typeof entityMap.unobserve>[0])
  }

  // 顶层 entity map 监听：增删时管理 entity 内部 observer
  const watchEntityMap = (
    entity: 'node' | 'edge' | 'bug',
    topMap: Y.Map<Y.Map<unknown>>,
  ) => {
    const topObserver = (event: Y.YMapEvent<unknown>) => {
      // 顶层 map 的增删事件不带 rollback 标记，但同样跳过 rollback 事务
      if (event.transaction.origin === 'conflict-rollback') return
      if (event.target !== (topMap as unknown as Y.Map<unknown>)) return
      for (const [id, change] of event.changes.keys.entries()) {
        if (change.action === 'add' || change.action === 'update') {
          // 新增或替换（update 也走 attach，因为 entity 内容变化可能改了 id 字段）
          const existing = entityDetachers.get(id)
            ?? entityDetachers.get(`${entity}:${id}`)
            ?? null
          if (existing) {
            // 已有：先解绑旧的再挂新（entity 内容整体被替换时）
            existing()
          }
          const subMap = topMap.get(id)
          if (subMap) {
            const detach = attachEntity(entity, subMap)
            entityDetachers.set(id, detach)
          }
        } else if (change.action === 'delete') {
          const det = entityDetachers.get(id)
          if (det) {
            det()
            entityDetachers.delete(id)
          }
        }
      }
    }
    topMap.observe(topObserver as Parameters<typeof topMap.observe>[0])
    observers.push(() => topMap.unobserve(topObserver as Parameters<typeof topMap.unobserve>[0]))

    // 已存在的 entity 立即 attach
    topMap.forEach((subMap, id) => {
      const detach = attachEntity(entity, subMap)
      entityDetachers.set(id, detach)
    })
  }

  watchEntityMap('node', nodesMap)
  watchEntityMap('edge', edgesMap)
  watchEntityMap('bug', bugsMap)

  return {
    detach: () => {
      observers.forEach((fn) => fn())
      observers.length = 0
      entityDetachers.forEach((fn) => fn())
      entityDetachers.clear()
    },
  }
}

/** 类型守卫：GraphEdge / BugNode 是否包含规则相关字段
// ============================================================
// ============================================================

/** 边规则表中的字段 */
export const EDGE_RULE_FIELDS = new Set(EDGE_FIELD_RULES.default.map((r) => r.field))
/** Bug 规则表中字段 */
export const BUG_RULE_FIELDS = new Set(BUG_FIELD_RULES.map((r) => r.field))

/** GraphEdge 字段子集：可用于测试 GraphEdge 类型 import 不被 lint 删除 */
export type _EdgeFieldSubset = Pick<GraphEdge, 'edgeType' | 'source' | 'target' | 'label'>
/** BugNode 字段子集 */
export type _BugFieldSubset = Pick<BugNode, 'severity' | 'status' | 'title' | 'description'>

// ============================================================
// 状态转换 detail（用于 toast 详情展示）
// ============================================================

/** 状态转换 detail 工厂 */
export function makeStatusTransitionDetail(
  nodeId: string,
  nodeType: string,
  from: string,
  to: string,
): StatusTransitionDetail {
  return { nodeId, nodeType, from, to }
}