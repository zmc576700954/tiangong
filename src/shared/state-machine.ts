/**
 * 节点状态机引擎
 *
 * 定义 NodeStatus 的合法转换路径，防止非法状态变更。
 * 当前状态 → 允许的目标状态列表。
 *
 * 自 v8 起新增 `validateNodeTypeTransition(type, from, to)`：基于
 * `NODE_STATUS_TRANSITIONS[type]` 的 per-NodeType 矩阵校验。比全局
 * `TRANSITION_RULES` 更严格，是 `NodeRepository.update()` 写 status 时的
 * 强制校验点。`InvalidStateTransitionError` 在 `toJSON()` 中输出
 * `code: 'STATE_TRANSITION_INVALID'` 与结构化 `details`，便于 IPC 透传到
 * renderer（见 `src/main/errors.ts` 的 `STATE_TRANSITION_INVALID` 与
 * `src/main/ipc/utils.ts` 的 `createTypedHandle`）。
 */

import type { NodeStatus, BugStatus, NodeType } from './types'
import { NODE_STATUS_TRANSITIONS } from './types/graph'

/** 非法状态转换错误
 *
 * 位于 `@shared/*` 边界，**不**继承 `BizGraphError`（`@shared` 不能 import `@main`
 * 是 ESLint 硬约束）。但通过 `toJSON()` 输出标准字段集（`code` + `details`），
 * 让 `createTypedHandle` 在 IPC 层能识别并透传到 renderer。
 */
export class InvalidStateTransitionError extends Error {
  /** 错误码固定字符串，与 `src/main/errors.ts` 的 `ErrorCode.STATE_TRANSITION_INVALID` 同步 */
  static readonly CODE = 'STATE_TRANSITION_INVALID'

  constructor(
    readonly from: string,
    readonly to: string,
    readonly nodeId?: string,
    readonly nodeType?: string,
  ) {
    super(
      `Invalid state transition${nodeId ? ` for node ${nodeId}` : ''}${nodeType ? ` (${nodeType})` : ''}: "${from}" → "${to}" is not allowed`,
    )
    this.name = 'InvalidStateTransitionError'
  }

  /** IPC 透传用的序列化输出
   *
   * `createTypedHandle` 通过 `err.name === 'InvalidStateTransitionError'` 识别后，
   * 用本输出替换默认包装，保证 renderer 端能拿到 `code` 与 `details.from/to/nodeId/nodeType`。
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: InvalidStateTransitionError.CODE,
      stack: this.stack,
      details: {
        from: this.from,
        to: this.to,
        nodeId: this.nodeId,
        nodeType: this.nodeType,
      },
    }
  }
}

/** 状态转换规则图：from → Set<to> */
const TRANSITION_RULES: Record<NodeStatus, Set<NodeStatus>> = {
  // 草稿：可确认、删除（回到占位）
  draft: new Set<NodeStatus>(['confirmed', 'developing', 'placeholder']),

  // 已确认：可开始开发、回退到草稿、删除（回到占位）、发布为 Wiki 页面
  confirmed: new Set<NodeStatus>(['developing', 'draft', 'placeholder', 'published']),

  // 开发中：可提交测试、回退到已确认、回退到草稿、回退到占位
  developing: new Set<NodeStatus>(['testing', 'confirmed', 'draft', 'placeholder']),

  // 待测试：可通过验收、回退到开发中
  testing: new Set<NodeStatus>(['review', 'developing']),

  // 待验收：可发布、回退到测试
  review: new Set<NodeStatus>(['published', 'testing']),

  // 已发布：可回退到已确认/草稿/占位，便于 Wiki 页面修订后重新发布
  published: new Set<NodeStatus>(['confirmed', 'draft', 'placeholder']),

  // 占位节点：可激活为草稿、可跳过草稿直接确认、可跳过草稿直接开发
  placeholder: new Set<NodeStatus>(['draft', 'confirmed', 'developing']),
}

/**
 * 检查状态转换是否合法
 * @returns true 如果转换允许
 */
export function canTransition(from: NodeStatus, to: NodeStatus): boolean {
  if (from === to) return true // 同状态无需转换
  const allowed = TRANSITION_RULES[from]
  if (!allowed) return false
  return allowed.has(to)
}

/**
 * 验证状态转换，非法时抛出 InvalidStateTransitionError
 */
export function validateTransition(
  from: NodeStatus,
  to: NodeStatus,
  nodeId?: string,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to, nodeId)
  }
}

/**
 * Per-NodeType 校验：基于 NODE_STATUS_TRANSITIONS[type] 矩阵
 *
 * 与全局 `validateTransition(from, to)` 的差异：
 * - 全局规则只校验"任意 NodeType 是否允许 from→to"
 * - per-type 规则额外校验"该 NodeType 是否允许 from→to"
 *
 * 例如 `placeholder→developing` 全局规则允许，但仅 `feature` NodeType 允许；
 * `project` / `module` / `process` / `bug` / `wiki-page` 类型的 placeholder 节点
 * 走这条路径会被拒。这是 `NodeRepository.update()` 写 status 时的强制校验点。
 *
 * 同状态 from===to 直接通过（与 `canTransition` 一致）。
 *
 * @param type 节点类型（如 'project' / 'feature' / 'wiki-page'）
 * @param from 当前状态
 * @param to 目标状态
 * @param nodeId 可选，错误信息附加节点 ID
 */
export function validateNodeTypeTransition(
  type: NodeType,
  from: NodeStatus,
  to: NodeStatus,
  nodeId?: string,
): void {
  if (from === to) return
  const allowed = NODE_STATUS_TRANSITIONS[type]
  if (!allowed) {
    // 未知 NodeType：保守拒绝
    throw new InvalidStateTransitionError(from, to, nodeId, type)
  }
  const isAllowed = allowed.some((t) => t.from === from && t.to === to)
  if (!isAllowed) {
    throw new InvalidStateTransitionError(from, to, nodeId, type)
  }
}

/**
 * 获取从指定状态可转换到的所有状态
 */
export function getAllowedTransitions(from: NodeStatus): NodeStatus[] {
  return Array.from(TRANSITION_RULES[from] ?? [])
}

/**
 * 获取状态转换路径（用于 UI 展示转换链路）
 * @returns 从 from 到 to 的最短路径，如果不可达则返回 null
 */
export function findTransitionPath(
  from: NodeStatus,
  to: NodeStatus,
): NodeStatus[] | null {
  if (from === to) return [from]
  if (!canTransition(from, to)) {
    // BFS 查找间接路径
    const queue: { status: NodeStatus; path: NodeStatus[] }[] = [
      { status: from, path: [from] },
    ]
    const visited = new Set<NodeStatus>([from])

    while (queue.length > 0) {
      const { status, path } = queue.shift()!
      const nextStatuses = getAllowedTransitions(status)
      for (const next of nextStatuses) {
        if (next === to) return [...path, next]
        if (!visited.has(next)) {
          visited.add(next)
          queue.push({ status: next, path: [...path, next] })
        }
      }
    }
    return null
  }
  return [from, to]
}

// ============================================
// Bug 状态机
// ============================================

/** Bug 状态转换规则：open → fixed → verified */
const BUG_TRANSITION_RULES: Record<BugStatus, Set<BugStatus>> = {
  open: new Set<BugStatus>(['fixed']),
  fixed: new Set<BugStatus>(['verified', 'open']),
  verified: new Set<BugStatus>(['open']),
}

/**
 * 检查 Bug 状态转换是否合法
 */
export function canBugTransition(from: BugStatus, to: BugStatus): boolean {
  if (from === to) return true
  const allowed = BUG_TRANSITION_RULES[from]
  if (!allowed) return false
  return allowed.has(to)
}

/**
 * 验证 Bug 状态转换，非法时抛出 InvalidStateTransitionError
 */
export function validateBugTransition(
  from: BugStatus,
  to: BugStatus,
  bugId?: string,
): void {
  if (!canBugTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to, bugId)
  }
}

// ============================================
// 启动时一致性校验
// ============================================

/**
 * 校验 TRANSITION_RULES 与 NODE_STATUS_TRANSITIONS 的一致性
 * 在应用启动时调用，发现不一致时打印错误日志
 * @returns 不一致的数量（0 表示一致）
 */
export function validateTransitionConsistency(): number {
  let inconsistencies = 0
  for (const [nodeType, transitions] of Object.entries(NODE_STATUS_TRANSITIONS)) {
    for (const { from, to } of transitions) {
      if (!canTransition(from, to)) {
        console.error(
          `[StateMachine] Inconsistency: NODE_STATUS_TRANSITIONS[${nodeType}].${from}→${to} is allowed but TRANSITION_RULES does not permit it`,
        )
        inconsistencies++
      }
    }
  }
  // 反向检查：TRANSITION_RULES 中允许但 NODE_STATUS_TRANSITIONS 中没有任何 nodeType 允许的转换
  for (const [from, toSet] of Object.entries(TRANSITION_RULES)) {
    for (const to of toSet) {
      const allowedByAnyNodeType = Object.values(NODE_STATUS_TRANSITIONS).some(
        (transitions) => transitions.some((t) => t.from === from && t.to === to),
      )
      if (!allowedByAnyNodeType) {
        console.warn(
          `[StateMachine] Warning: TRANSITION_RULES.${from}→${to} is allowed but no NodeType permits it in NODE_STATUS_TRANSITIONS`,
        )
      }
    }
  }
  return inconsistencies
}
