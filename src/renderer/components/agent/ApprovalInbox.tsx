/**
 * 全局审批入口（方案一）。
 *
 * 与聊天内弹窗共用 `approvalStore` 这一份 pending 事实源，区别只在位置：
 * 本组件挂在应用根，任何页面（项目树、画布、节点编辑、Agent 页）都能看到并决议。
 * 审批来源不区分：用户聊天、编排 runtime 的 kernel turn、测试计划、legacy 路径，
 * 只要 `ApprovalGateway` 推了请求就会出现在这里。
 *
 * 不重复实现网关语义：倒计时只是展示（超时判定仍由主进程定时器/扫描完成），
 * 决议仍走 `agent:resolveApproval`（归属校验 + argsHash 防 TOCTOU）。
 */

import { ShieldAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useApprovalStore } from '../../store/approvalStore'
import { useI18n } from '../../i18n/useI18n'
import { computeRemainingSeconds } from './approvalCountdown'
import { approvalSourceParts, displayCommand } from './approvalView'

const RISK_TONE: Record<string, string> = {
  low: 'text-blue-600 dark:text-blue-400',
  medium: 'text-amber-600 dark:text-amber-400',
  high: 'text-orange-600 dark:text-orange-400',
  critical: 'text-red-600 dark:text-red-400',
}

export function ApprovalInbox() {
  const { t } = useI18n()
  const pending = useApprovalStore((s) => s.pending)
  const busy = useApprovalStore((s) => s.busy)
  const error = useApprovalStore((s) => s.error)
  const resolve = useApprovalStore((s) => s.resolve)
  const clearError = useApprovalStore((s) => s.clearError)
  const [collapsed, setCollapsed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (pending.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pending.length])

  if (pending.length === 0) {
    // 失败横幅在队列清空后仍需可见（否则用户会以为已允许），因此单独兜底渲染。
    if (!error) return null
    return (
      <div className="fixed top-14 right-4 z-40 w-80">
        <div
          role="alert"
          data-testid="approval-inbox-error"
          className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
        >
          <span className="flex-1">{error}</span>
          <button onClick={clearError} aria-label={t('agent.approval.inbox.dismiss')}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="approval-inbox"
      className="fixed top-14 right-4 z-40 w-80 max-h-[65vh] overflow-y-auto rounded-lg border bg-background shadow-lg"
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        data-testid="approval-inbox-toggle"
        className="flex w-full items-center gap-2 border-b px-3 py-2 text-left"
      >
        <ShieldAlert className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
        <span className="flex-1 text-sm font-medium">
          {t('agent.approval.inbox.title')}
        </span>
        <span className="rounded-full bg-orange-600 px-2 py-0.5 text-[11px] text-white">{pending.length}</span>
      </button>

      {!collapsed && (
        <div className="space-y-2 p-2">
          {error && (
            <p role="alert" data-testid="approval-inbox-error" className="px-1 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          {pending.map((payload) => {
            const remaining = computeRemainingSeconds(payload, now)
            const sources = approvalSourceParts(payload)
            return (
              <div
                key={payload.approvalId}
                data-testid="approval-inbox-item"
                className="rounded-md border p-2 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{payload.toolName}</span>
                  <span className={`ml-auto ${RISK_TONE[payload.risk] ?? ''}`}>
                    {t(`agent.approval.risk.${payload.risk}`)}
                  </span>
                </div>
                {payload.argsJson && (
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1 font-mono text-[11px]">
                    {displayCommand(payload.argsJson)}
                  </pre>
                )}
                {sources.length > 0 && (
                  <p className="mt-1 break-all text-muted-foreground" data-testid="approval-inbox-source">
                    {sources.map((part) => `${t(part.key)} ${part.value}`).join(' · ')}
                  </p>
                )}
                <p className="mt-1 text-muted-foreground">
                  {t('agent.approval.expiresIn').replace('{seconds}', String(remaining))}
                </p>
                <div className="mt-1 flex justify-end gap-2">
                  <button
                    disabled={busy[payload.approvalId]}
                    onClick={() => void resolve(payload, 'deny')}
                    data-testid="approval-inbox-deny"
                    className="rounded border border-red-300 px-2 py-0.5 text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-600 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    {t('agent.approval.deny')}
                  </button>
                  <button
                    disabled={busy[payload.approvalId]}
                    onClick={() => void resolve(payload, 'allow', 'once')}
                    data-testid="approval-inbox-allow"
                    className="rounded bg-orange-600 px-2 py-0.5 text-white hover:bg-orange-700 disabled:opacity-50"
                  >
                    {t('agent.approval.allowOnce')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
