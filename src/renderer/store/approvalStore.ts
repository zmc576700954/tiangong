/**
 * 全局待审批队列（方案一：审批入口不再依赖聊天线程）。
 *
 * 背景：`ApprovalRequestDialog` 只挂在 `AgentChatPanel` 的「有线程」分支，
 * 编排 runtime 发起的 kernel turn 不建 UI 线程，审批请求到达 renderer 后无人渲染，
 * 只能等 120s 交互超时被 fail-closed 拒绝。本 store 是渲染端**唯一**的
 * pending 事实源：全局入口与聊天内弹窗都投影它。
 *
 * 边界（不重复实现网关语义）：
 * - 超时/冻结/归属校验/幂等全部仍在主进程 `ApprovalGateway`；
 * - 本 store 只做「列出 + 决议 + 跟随事件增减」，不另起计时器、不改 deadline。
 */

import { create } from 'zustand'
import { t as translate } from '@shared/i18n'
import type { ApprovalRequestPayload, ApprovalResolutionPayload } from '@shared/types/agent-runtime'
import { unwrapIpcResult } from '../lib/ipcResult'

interface ApprovalState {
  pending: ApprovalRequestPayload[]
  /** 决议请求在途的 approvalId（两个入口共享，避免同一请求被并发提交）。 */
  busy: Record<string, boolean>
  /** 最近一次决议失败的说明（陈旧审批、参数不匹配等）。 */
  error: string | null
  /** 从主进程拉取当前 pending（挂载/重连时补齐事件流之前的事实）。 */
  hydrate: () => Promise<void>
  upsert: (payload: ApprovalRequestPayload) => void
  applyResolved: (payload: ApprovalResolutionPayload) => void
  resolve: (
    payload: ApprovalRequestPayload,
    decision: 'allow' | 'deny',
    scope?: 'once' | 'session',
  ) => Promise<void>
  clearError: () => void
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  pending: [],
  busy: {},
  error: null,

  hydrate: async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.['agent:getPendingApprovals']) return
    try {
      const list = (await api['agent:getPendingApprovals']()) as ApprovalRequestPayload[]
      if (!Array.isArray(list)) return
      // 事件可能比这次 fetch 更新：以 id 去重合并，不覆盖已到达的新请求。
      const merged = [...get().pending]
      for (const item of list) {
        if (!item?.approvalId) continue
        if (merged.some((existing) => existing.approvalId === item.approvalId)) continue
        merged.push(item)
      }
      set({ pending: merged })
    } catch {
      // 忽略：runtime 未就绪时没有可列出的审批，等事件到达即可。
    }
  },

  upsert: (payload) => {
    if (!payload?.approvalId) return
    const current = get().pending
    if (current.some((item) => item.approvalId === payload.approvalId)) return
    set({
      pending: [...current, payload],
      // 新请求到达即清掉上一轮失败横幅（它只描述「刚刚失败的那一次」）。
      error: null,
    })
  },

  applyResolved: (payload) => {
    if (!payload?.approvalId) return
    set({ pending: get().pending.filter((item) => item.approvalId !== payload.approvalId) })
  },

  resolve: async (payload, decision, scope = 'once') => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.['agent:resolveApproval']) return
    set({ busy: { ...get().busy, [payload.approvalId]: true }, error: null })
    try {
      unwrapIpcResult(
        await api['agent:resolveApproval']({
          approvalId: payload.approvalId,
          decision,
          argsHash: payload.argsHash,
          // 归属校验：主进程据此确认审批确实属于该会话/轮次，而不是只在同名 hash 上放行。
          sessionId: payload.sessionId,
          // S8/D6:subject 审批(test_plan)无 turn——归属由 approvalId 本体承担
          turnId: payload.turnId ?? undefined,
          ...(decision === 'allow' ? { scope } : {}),
        }),
      )
      set({ pending: get().pending.filter((item) => item.approvalId !== payload.approvalId) })
    } catch (err) {
      // 批准后无人执行（陈旧审批）必须明确报错，不能静默移除；但请求本身已终态，
      // 继续留在队列只会让用户误以为还能再点，因此同样移出并保留横幅。
      const code = (err as { code?: unknown } | null)?.code
      const message = err instanceof Error && err.message ? err.message : null
      const prefix = code === 'APPROVAL_STALE' ? `${translate('agent.approval.stale')} ` : ''
      set({
        error: `${prefix}${message ?? translate('agent.approval.resolveFailed')}`,
        pending: get().pending.filter((item) => item.approvalId !== payload.approvalId),
      })
    } finally {
      const next = { ...get().busy }
      delete next[payload.approvalId]
      set({ busy: next })
    }
  },

  clearError: () => set({ error: null }),
}))

/**
 * 挂全局审批事件监听（应用启动调用一次）。
 * 这两个通道由 `ApprovalGateway` 的 notifier 广播，来源包括用户聊天、编排 turn、
 * 测试计划与 legacy 路径——因此全局队列天然覆盖所有来源。
 */
export function attachApprovalListener(): () => void {
  if (typeof window === 'undefined') return () => {}
  const api = window.electronAPI
  if (!api?.onApprovalRequest) return () => {}
  void useApprovalStore.getState().hydrate()
  const offRequest = api.onApprovalRequest((raw) => {
    useApprovalStore.getState().upsert(raw as ApprovalRequestPayload)
  })
  const offResolved = api.onApprovalResolved?.((raw) => {
    useApprovalStore.getState().applyResolved(raw as ApprovalResolutionPayload)
  })
  return () => {
    offRequest()
    offResolved?.()
  }
}
