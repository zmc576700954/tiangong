/**
 * Conflict Reporter — main-process service (D10d-3)
 *
 * 职责：
 *   - 按 graph 维护 Y.Doc 实例 + resolver attach 句柄
 *   - 维护每个 graph 的最近冲突报告环形缓冲（最多 50 条）
 *   - 把每条新冲突通过 webContents.send 广播给所有窗口
 *   - 给 wiki:lint 提供「realtime-conflict」分组的 issue 列表
 *   - 给 IPC 提供 getRecentReports / clearReports 接口
 *
 * 单例：由 ipc-handlers.ts 在 registerIpcHandlers 时创建。
 */

import type { BrowserWindow } from 'electron'
import type * as Y from 'yjs'
import type { LintIssue } from '@shared/types/wiki'
import { buildConflictId, type ConflictKind, type ConflictReport } from '@shared/types/conflict'
import { LamportClock, type LamportTimestamp } from '../realtime/lamport'
import {
  attachConflictResolver,
  getOrCreateRealtimeDoc,
  type LamportClockLike,
  type ResolverHandle,
} from '../realtime'
import type { ConflictHooks } from '../realtime/conflict-rules'

const MAX_REPORTS_PER_GRAPH = 50

/** Per-graph attach state */
interface GraphAttachState {
  doc: Y.Doc
  clock: LamportClock
  clockLike: LamportClockLike
  handle: ResolverHandle
  reports: ConflictReport[]
}

export class ConflictReporter {
  private readonly states = new Map<string, GraphAttachState>()
  private actorId: string

  constructor(initialActorId: string = 'local') {
    this.actorId = initialActorId
  }

  /** 设置当前 actor id（来自 settings.userId） */
  setActorId(actorId: string): void {
    this.actorId = actorId
    for (const state of this.states.values()) {
      // LamportClock.actorId 在构造后即不再改变；通过重建 clock 同步
      const oldClock = state.clock
      const newClock = new LamportClock(oldClock.value, actorId)
      state.clock = newClock
      state.clockLike = {
        currentTimestamp: (): LamportTimestamp => newClock.tick(),
      }
    }
  }

  /** 把 graphId 关联到 Y.Doc + 挂 resolver；若已 attach 则 no-op */
  attachToGraph(graphId: string): void {
    if (this.states.has(graphId)) return
    const doc = getOrCreateRealtimeDoc(graphId)
    const clock = new LamportClock(0, this.actorId)
    const clockLike: LamportClockLike = {
      currentTimestamp: (): LamportTimestamp => clock.tick(),
    }
    const hooks: ConflictHooks = {
      graphId,
      actorId: this.actorId,
      onConflict: (report) => this.recordConflict(report),
    }
    const handle = attachConflictResolver(doc, hooks, clockLike)
    this.states.set(graphId, {
      doc,
      clock,
      clockLike,
      handle,
      reports: [],
    })
  }

  /** 解绑 graph 关联的 resolver；doc 不销毁（可能被其它组件持有） */
  detachFromGraph(graphId: string): void {
    const state = this.states.get(graphId)
    if (!state) return
    state.handle.detach()
    this.states.delete(graphId)
  }

  /** 内部：累积 + 截断 + 广播 */
  private recordConflict(report: ConflictReport): void {
    const state = this.states.get(report.graphId)
    if (!state) return
    // dedupe by id
    if (state.reports.some((r) => r.id === report.id)) return
    state.reports.push(report)
    if (state.reports.length > MAX_REPORTS_PER_GRAPH) {
      state.reports.splice(0, state.reports.length - MAX_REPORTS_PER_GRAPH)
    }
    broadcastToWindows('conflict:onReported', report)
  }

  /** 取某 graph 最近 N 条冲突（默认全量，最多 MAX_REPORTS_PER_GRAPH） */
  getRecentReports(graphId: string, limit?: number): ConflictReport[] {
    const state = this.states.get(graphId)
    if (!state) return []
    if (limit === undefined || limit >= state.reports.length) {
      return [...state.reports]
    }
    return state.reports.slice(-limit)
  }

  /** 清空某 graph 的冲突缓冲（用户操作） */
  clearReports(graphId: string): void {
    const state = this.states.get(graphId)
    if (!state) return
    state.reports.length = 0
  }

  /** 提供给 wiki:lint 的 LintIssue 列表（按 'realtime-conflict' 分组） */
  getLintIssuesForGraph(graphId: string): LintIssue[] {
    const state = this.states.get(graphId)
    if (!state) return []
    const issues: LintIssue[] = []
    for (const r of state.reports) {
      // 高严重度冲突按 warning；text-merge-info / lamport-loser 按 info
      const severity: LintIssue['severity'] =
        r.kind === 'illegal-status-transition' || r.kind === 'identity-immutable' || r.kind === 'concurrent-delete-edit'
          ? 'warning'
          : 'info'
      issues.push({
        kind: 'realtime-conflict',
        severity,
        nodeId: r.nodeId,
        message: formatLintMessage(r),
        hint: hintForKind(r.kind),
      })
    }
    return issues
  }

  /** 测试 / 调试：是否已 attach 到 graphId */
  isAttached(graphId: string): boolean {
    return this.states.has(graphId)
  }
}

/** 广播到所有非销毁窗口；electron BrowserWindow 在 main 内 import，
 * 这里用结构类型避免循环依赖。 */
type BC = BrowserWindow | { isDestroyed: () => boolean; webContents: { send: (channel: string, ...args: unknown[]) => void } }
function broadcastToWindows(channel: string, ...args: unknown[]): void {
  // 延迟 require 避免在测试时引入 electron 模块
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BrowserWindow } = require('electron') as { BrowserWindow: { getAllWindows: () => BC[] } }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

function formatLintMessage(r: ConflictReport): string {
  const fieldLabel = r.field ? `「${r.field}」` : ''
  switch (r.kind) {
    case 'illegal-status-transition':
      return `节点「${r.nodeTitle ?? r.nodeId}」${fieldLabel}转换被状态机拒绝（${String(r.prevValue)} → ${String(r.attemptedValue)}）`
    case 'identity-immutable':
      return `节点「${r.nodeTitle ?? r.nodeId}」尝试变更身份字段${fieldLabel}，已回滚`
    case 'lamport-loser':
      return `节点「${r.nodeTitle ?? r.nodeId}」${fieldLabel}本地版本过期，已被远端覆盖`
    case 'concurrent-delete-edit':
      return `节点「${r.nodeTitle ?? r.nodeId}」已被删除后仍有写入落到该条目`
    case 'text-merge-info':
      return `节点「${r.nodeTitle ?? r.nodeId}」文本字段合并（CRDT）`
    default:
      return r.reason
  }
}

function hintForKind(kind: ConflictKind): string {
  switch (kind) {
    case 'illegal-status-transition':
      return '查看状态机的合法转换路径，或撤销这次状态变更'
    case 'identity-immutable':
      return '节点 id / graphId / createdAt 创建后不可修改'
    case 'lamport-loser':
      return '刷新页面让本地视图与最新同步结果对齐'
    case 'concurrent-delete-edit':
      return '节点已删除，新编辑会被丢弃；恢复节点或丢弃编辑'
    case 'text-merge-info':
      return '文本字段已由 CRDT 自动合并，无需操作'
    default:
      return ''
  }
}

/** 单例访问：避免在模块顶层 new（测试时可替换） */
let singleton: ConflictReporter | null = null
export function getConflictReporter(): ConflictReporter {
  if (!singleton) singleton = new ConflictReporter()
  return singleton
}

/** 测试 / 启动时注入 */
export function setConflictReporter(reporter: ConflictReporter | null): void {
  singleton = reporter
}

/** 提供 buildConflictId 给上层（re-export 让 ipc/preload 用同一个 id 规则） */
export { buildConflictId }