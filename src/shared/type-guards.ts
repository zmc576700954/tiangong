/**
 * 运行时类型守卫
 * 用于校验从 DB / 外部输入读取的值是否符合联合类型约束
 */

import {
  NODE_STATUS_VALUES, NODE_TYPE_VALUES, GRAPH_TYPE_VALUES,
  EDGE_TYPE_VALUES, BUG_SEVERITY_VALUES, BUG_STATUS_VALUES,
} from './types'
import type {
  NodeStatus, NodeType, GraphType, EdgeType, BugSeverity, BugStatus,
  AgentCommand, AgentOutput, ContextRef, ToolCallBlock, MessageError,
  BusinessRule, NodeMetadata, NodeContent, EdgeContent,
} from './types'

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

/**
 * JSON 列的运行时形状守卫。
 * DB 里的 JSON 列是「不可信输入」——旧版本写入、手工改库、外部同步都可能留下
 * 形状不对的值。解析点必须用这些守卫把脏数据挡在类型边界之外，退化为默认值
 * 而不是把错误形状原样交给渲染层（渲染层会 .map / .forEach，直接崩）。
 */

/** 普通对象（排除 null 与数组） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 字符串数组 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

/**
 * 具名元素数组（apis / services / entities）—— 每个元素必须是带 name 的对象。
 * 渲染层直接读 `api.name`，元素为 null 时会崩。
 */
function isNamedRecordArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => isRecord(v) && typeof v.name === 'string')
}

/** 文件关联数组 —— 每个元素必须有 path 与 type */
function isFileAssociationArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(
    (v) => isRecord(v) && typeof v.path === 'string' && typeof v.type === 'string',
  )
}

// ---------------------------------------------------------------------------
// 元素级守卫
//
// 「是数组」不等于「元素形状对」。渲染层拿到 `[null]` 会直接 `.name` 崩掉 ——
// 所以数组列必须逐元素校验，脏数据退化为默认值而不是原样递交。
// ---------------------------------------------------------------------------

/** ContextRef —— type / id / label 必须是字符串 */
export function isContextRef(value: unknown): value is ContextRef {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.id === 'string'
    && typeof value.label === 'string'
}

/** ContextRef 数组 —— 逐元素校验 */
export function isContextRefArray(value: unknown): value is ContextRef[] {
  return Array.isArray(value) && value.every(isContextRef)
}

/** ToolCallBlock —— type / content / status 必须是字符串 */
export function isToolCallBlock(value: unknown): value is ToolCallBlock {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.content === 'string'
    && typeof value.status === 'string'
}

/** ToolCallBlock 数组 —— 逐元素校验 */
export function isToolCallBlockArray(value: unknown): value is ToolCallBlock[] {
  return Array.isArray(value) && value.every(isToolCallBlock)
}

/** BusinessRule —— id / title / description / condition / action 必须是字符串 */
export function isBusinessRule(value: unknown): value is BusinessRule {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.description === 'string'
    && typeof value.condition === 'string'
    && typeof value.action === 'string'
}

/** BusinessRule 数组 —— 逐元素校验 */
export function isBusinessRuleArray(value: unknown): value is BusinessRule[] {
  return Array.isArray(value) && value.every(isBusinessRule)
}

/** MessageError —— code / message 必须是字符串 */
export function isMessageError(value: unknown): value is MessageError {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
}

/** NodeMetadata —— 数组字段逐元素校验 */
export function isNodeMetadata(value: unknown): value is NodeMetadata {
  if (!isRecord(value)) return false
  if (value.apis !== undefined && !isNamedRecordArray(value.apis)) return false
  if (value.services !== undefined && !isNamedRecordArray(value.services)) return false
  if (value.entities !== undefined && !isNamedRecordArray(value.entities)) return false
  if (value.fileAssociations !== undefined && !isFileAssociationArray(value.fileAssociations)) return false
  return true
}

/** NodeContent —— fullDescription 必填；数组字段逐元素校验 */
export function isNodeContent(value: unknown): value is NodeContent {
  if (!isRecord(value)) return false
  if (typeof value.fullDescription !== 'string') return false
  if (value.businessRules !== undefined && !isBusinessRuleArray(value.businessRules)) return false
  if (value.acceptanceCriteria !== undefined && !isStringArray(value.acceptanceCriteria)) return false
  if (value.implementationNotes !== undefined && !isStringArray(value.implementationNotes)) return false
  if (value.relatedFiles !== undefined && !isStringArray(value.relatedFiles)) return false
  if (value.codeSignatures !== undefined && !isStringArray(value.codeSignatures)) return false
  return true
}

/** EdgeContent —— 可选字段按各自形状校验 */
export function isEdgeContent(value: unknown): value is EdgeContent {
  if (!isRecord(value)) return false
  if (value.condition !== undefined && typeof value.condition !== 'string') return false
  if (value.note !== undefined && typeof value.note !== 'string') return false
  if (value.guard !== undefined && typeof value.guard !== 'string') return false
  if (value.trigger !== undefined && typeof value.trigger !== 'string') return false
  if (value.timeout !== undefined && typeof value.timeout !== 'number') return false
  if (value.suggested !== undefined && typeof value.suggested !== 'boolean') return false
  if (value.retry !== undefined) {
    if (!isRecord(value.retry)) return false
    if (typeof value.retry.max !== 'number' || typeof value.retry.delay !== 'number') return false
  }
  return true
}

/** AgentCommand —— type / description / targetNodeId 三个字段都必须是字符串 */
export function isAgentCommand(value: unknown): value is AgentCommand {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.description === 'string'
    && typeof value.targetNodeId === 'string'
}

/** AgentOutput —— type / data 必须是字符串（timestamp 等可选字段不参与判定） */
export function isAgentOutput(value: unknown): value is AgentOutput {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.data === 'string'
}

/** AgentOutput 数组 —— 元素必须逐个通过 isAgentOutput */
export function isAgentOutputArray(value: unknown): value is AgentOutput[] {
  return Array.isArray(value) && value.every((v) => isAgentOutput(v))
}
