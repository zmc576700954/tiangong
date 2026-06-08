/**
 * 运行时类型守卫
 * 用于校验从 DB / 外部输入读取的值是否符合联合类型约束
 */

import {
  NODE_STATUS_VALUES, NODE_TYPE_VALUES, GRAPH_TYPE_VALUES,
  EDGE_TYPE_VALUES, BUG_SEVERITY_VALUES, BUG_STATUS_VALUES,
} from './types'
import type { NodeStatus, NodeType, GraphType, EdgeType, BugSeverity, BugStatus } from './types'

function makeGuard<T extends string>(values: readonly T[]) {
  const set = new Set<string>(values)
  return (value: string): value is T => set.has(value)
}

export const isNodeStatus = makeGuard<NodeStatus>(NODE_STATUS_VALUES)
export const isNodeType = makeGuard<NodeType>(NODE_TYPE_VALUES)
export const isGraphType = makeGuard<GraphType>(GRAPH_TYPE_VALUES)
export const isEdgeType = makeGuard<EdgeType>(EDGE_TYPE_VALUES)
export const isBugSeverity = makeGuard<BugSeverity>(BUG_SEVERITY_VALUES)
export const isBugStatus = makeGuard<BugStatus>(BUG_STATUS_VALUES)

/** 校验并返回合法值，否则抛出 TypeError */
export function assertNodeStatus(value: string, field = 'status'): NodeStatus {
  if (!isNodeStatus(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${NODE_STATUS_VALUES.join(', ')}`)
  return value
}

export function assertNodeType(value: string, field = 'type'): NodeType {
  if (!isNodeType(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${NODE_TYPE_VALUES.join(', ')}`)
  return value
}

export function assertGraphType(value: string, field = 'type'): GraphType {
  if (!isGraphType(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${GRAPH_TYPE_VALUES.join(', ')}`)
  return value
}

export function assertEdgeType(value: string, field = 'edgeType'): EdgeType {
  if (!isEdgeType(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${EDGE_TYPE_VALUES.join(', ')}`)
  return value
}

export function assertBugSeverity(value: string, field = 'severity'): BugSeverity {
  if (!isBugSeverity(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${BUG_SEVERITY_VALUES.join(', ')}`)
  return value
}

export function assertBugStatus(value: string, field = 'status'): BugStatus {
  if (!isBugStatus(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${BUG_STATUS_VALUES.join(', ')}`)
  return value
}
