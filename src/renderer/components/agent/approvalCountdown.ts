/**
 * 审批倒计时计算（B4）。
 *
 * 首帧的 `now` 可能早于请求到达时间（组件挂载早于审批），直接做
 * `expiresAt - now` 会算出大于超时上限的值（真机实测出现 126/141 秒）。
 * 这里同时做下界 0 与上界 timeoutMs 的 clamp，保证任何时刻都落在 [0, timeout]。
 */

export interface ApprovalCountdownInput {
  expiresAt: number
  createdAt: number
  /** 主进程下发的审批超时上限；缺失时退化为 createdAt→expiresAt 区间 */
  timeoutMs?: number
}

export function computeRemainingSeconds(payload: ApprovalCountdownInput, now: number): number {
  const declared = payload.timeoutMs && payload.timeoutMs > 0
    ? payload.timeoutMs
    : Math.max(0, payload.expiresAt - payload.createdAt)
  const maxSeconds = Math.max(0, Math.ceil(declared / 1000))
  const rawSeconds = Math.ceil((payload.expiresAt - now) / 1000)
  return Math.min(maxSeconds, Math.max(0, rawSeconds))
}
