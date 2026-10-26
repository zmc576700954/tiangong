/**
 * Conflict store (D10d-3)
 *
 * 渲染端 conflict reports 总览：
 *   - 接收 onConflictReported 推送，触发对应 toast
 *   - 维护最近 50 条 reports，供 LintPanel 实时刷新使用
 *   - 提供 dismiss(id) / clearAll() 给 UI
 *
 * Toast 触发通过 lib/toast 的 pushToast，避免引入新依赖。
 */

import { create } from 'zustand'
import type { ConflictReport, ConflictKind } from '@shared/types/conflict'
import { pushToast } from '../lib/toast'

const MAX_REPORTS = 50

/** 哪些 kind 需要触发 toast（严重冲突；text-merge-info 仅供 LintPanel 静默展示） */
const TOAST_KINDS: ReadonlySet<ConflictKind> = new Set<ConflictKind>([
  'illegal-status-transition',
  'identity-immutable',
  'lamport-loser',
  'concurrent-delete-edit',
])

interface ConflictStoreState {
  recentReports: ConflictReport[]
  /** 注入一条新 report：内部 dedupe by id */
  pushReport: (report: ConflictReport) => void
  /** 删除单条（用户手动 dismiss） */
  dismiss: (id: string) => void
  /** 清空所有 */
  clearAll: () => void
}

export const useConflictStore = create<ConflictStoreState>((set, get) => ({
  recentReports: [],
  pushReport: (report) => {
    const current = get().recentReports
    if (current.some((r) => r.id === report.id)) return
    const next = [...current, report]
    if (next.length > MAX_REPORTS) {
      next.splice(0, next.length - MAX_REPORTS)
    }
    set({ recentReports: next })
    if (TOAST_KINDS.has(report.kind)) {
      pushToast({
        kind: 'error',
        title: toastTitle(report.kind),
        message: report.reason,
      })
    }
  },
  dismiss: (id) => {
    set({ recentReports: get().recentReports.filter((r) => r.id !== id) })
  },
  clearAll: () => set({ recentReports: [] }),
}))

function toastTitle(kind: ConflictKind): string {
  switch (kind) {
    case 'illegal-status-transition':
      return '状态机拒绝'
    case 'identity-immutable':
      return '身份字段被锁定'
    case 'lamport-loser':
      return '本地编辑过期'
    case 'concurrent-delete-edit':
      return '节点已删除'
    default:
      return '冲突已合并'
  }
}

/** 在应用启动时挂全局监听
 *
 * 由 root 组件 useEffect 调用；返回 cleanup 函数。
 */
export function attachConflictListener(): () => void {
  if (typeof window === 'undefined' || !window.electronAPI?.onConflictReported) {
    return () => {}
  }
  const cleanup = window.electronAPI.onConflictReported((report) => {
    useConflictStore.getState().pushReport(report)
  })
  return cleanup
}