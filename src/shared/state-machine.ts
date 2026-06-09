/**
 * 节点状态机引擎
 *
 * 定义 NodeStatus 的合法转换路径，防止非法状态变更。
 * 当前状态 → 允许的目标状态列表。
 */

import type { NodeStatus, BugStatus } from './types'

/** 非法状态转换错误 */
export class InvalidStateTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly nodeId?: string,
  ) {
    super(
      `Invalid state transition${nodeId ? ` for node ${nodeId}` : ''}: "${from}" → "${to}" is not allowed`,
    )
    this.name = 'InvalidStateTransitionError'
  }
}

/** 状态转换规则图：from → Set<to> */
const TRANSITION_RULES: Record<NodeStatus, Set<NodeStatus>> = {
  // 草稿：可确认、删除（回到占位）
  draft: new Set<NodeStatus>(['confirmed', 'placeholder']),

  // 已确认：可开始开发、回退到草稿
  confirmed: new Set<NodeStatus>(['developing', 'draft', 'placeholder']),

  // 开发中：可提交测试、回退到已确认
  developing: new Set<NodeStatus>(['testing', 'confirmed']),

  // 待测试：可通过验收、回退到开发中
  testing: new Set<NodeStatus>(['review', 'developing']),

  // 待验收：可发布、回退到测试
  review: new Set<NodeStatus>(['published', 'testing']),

  // 已发布：终态，不可转换（除非回滚到 review）
  published: new Set<NodeStatus>(['review']),

  // 占位节点：可激活为草稿
  placeholder: new Set<NodeStatus>(['draft', 'confirmed']),
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
