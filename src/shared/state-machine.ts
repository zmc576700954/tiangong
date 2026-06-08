/**
 * 状态转换校验
 * 定义节点和 Bug 的合法状态转换路径
 */

import type { NodeStatus, BugStatus } from './types'

// 节点状态合法转换映射
const NODE_TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  draft: ['confirmed', 'placeholder'],
  confirmed: ['developing', 'placeholder'],
  developing: ['testing', 'confirmed'],
  testing: ['review', 'developing'],
  review: ['published', 'testing'],
  published: ['review'],
  placeholder: ['developing', 'confirmed'],
}

// Bug 状态合法转换映射
const BUG_TRANSITIONS: Record<BugStatus, BugStatus[]> = {
  open: ['fixed'],
  fixed: ['verified', 'open'],
  verified: ['open'],
}

export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return NODE_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionBug(from: BugStatus, to: BugStatus): boolean {
  return BUG_TRANSITIONS[from]?.includes(to) ?? false
}

export function validateNodeTransition(from: NodeStatus, to: NodeStatus): void {
  if (!canTransitionNode(from, to)) {
    throw new Error(`Invalid node status transition: ${from} → ${to}. Allowed: ${NODE_TRANSITIONS[from]?.join(', ') ?? 'none'}`)
  }
}

export function validateBugTransition(from: BugStatus, to: BugStatus): void {
  if (!canTransitionBug(from, to)) {
    throw new Error(`Invalid bug status transition: ${from} → ${to}. Allowed: ${BUG_TRANSITIONS[from]?.join(', ') ?? 'none'}`)
  }
}
