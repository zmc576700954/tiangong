/**
 * Conflict resolution types — shared between main and renderer.
 *
 * 冲突解决策略层 (D10d) 的对外契约。所有类型在 @shared 边界，避免
 * renderer / main 在协议字段上漂移。
 */

import type { NodeStatus, BugStatus } from './graph'

/** 冲突类型分类
 *
 * - `illegal-status-transition`: NodeStatus 或 BugStatus 转换被状态机拒绝
 * - `identity-immutable`: 尝试改 id/graphId/createdAt 等身份字段
 * - `lamport-loser`: 同字段并发更新中，clock 较小者（仅观测，不主动拒绝）
 * - `concurrent-delete-edit`: 节点/边被并发删除后仍有写入落到该条目
 * - `text-merge-info`: 文本 CRDT 合并结果供 LintPanel 展示（低优先级，不触发 toast）
 */
export type ConflictKind =
  | 'illegal-status-transition'
  | 'identity-immutable'
  | 'lamport-loser'
  | 'concurrent-delete-edit'
  | 'text-merge-info'

/** 单条冲突报告
 *
 * 由 `ConflictReporter` 在 main 进程产生，推送至 renderer 渲染 toast
 * 与 LintPanel 列表。每条带稳定 id（用于 store dedupe）。
 */
export interface ConflictReport {
  /** 稳定 id：`<graphId>:<kind>:<nodeId>:<field>:<clock>`，clock 来自触发该报告的事务所 */
  id: string
  /** 冲突类型 */
  kind: ConflictKind
  /** 涉及的 graph id */
  graphId: string
  /** 涉及节点/边 id（按 kind 而定；text-merge-info 可空） */
  nodeId?: string
  /** 涉及字段名（"status" / "title" / ...） */
  field?: string
  /** 改动前的值（文本类可能没有） */
  prevValue?: unknown
  /** 尝试写入的值 */
  attemptedValue?: unknown
  /** 触发该报告的 Lamport clock（重新开始或 0） */
  lamportClock: number
  /** 触发 actor id（来自 settings.userId 或 session 标识） */
  actorId: string
  /** 人类可读原因（中文，i18n TODO） */
  reason: string
  /** ISO 时间戳 */
  ts: string
  /** 节点 title（仅 toast / LintPanel 用，便于用户识别） */
  nodeTitle?: string
}

/** 状态转换专用 details（透传 state-machine 错误细节） */
export interface StatusTransitionDetail {
  nodeId: string
  nodeType: string
  from: NodeStatus | BugStatus | string
  to: NodeStatus | BugStatus | string
}

/** 构造稳定 id 的工具
 *
 * 同一 graph + kind + nodeId + field + clock 在同一时刻只产生一次报告，
 * dedupe 由 store / caller 用 Map 实现，id 设计上支持该模式。
 */
export function buildConflictId(
  graphId: string,
  kind: ConflictKind,
  nodeId: string | undefined,
  field: string | undefined,
  clock: number,
): string {
  return `${graphId}:${kind}:${nodeId ?? ''}:${field ?? ''}:${clock}`
}