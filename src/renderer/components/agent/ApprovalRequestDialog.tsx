/**
 * D4：写前审批入口（真实拦截）。
 *
 * 数据源：主进程 ApprovalGateway 在工具执行**之前**阻塞等待的请求。
 * 只有声明了 pre-exec approval 能力的适配器（Claude canUseTool/PreToolUse）才会发出该事件；
 * Codex/OpenCode 等按 capability 降级，不会伪装成写前审批（它们的事后提示仍走 ConfirmationDialog 的降级文案）。
 */
import { ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ApprovalRequestPayload, ApprovalResolutionPayload } from '@shared/types/agent-runtime'
import { useI18n } from '../../i18n/useI18n'
import { computeRemainingSeconds } from './approvalCountdown'
import { unwrapIpcResult } from '../../lib/ipcResult'

const RISK_STYLES: Record<ApprovalRequestPayload['risk'], string> = {
  low: 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950',
  medium: 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950',
  high: 'border-orange-300 bg-orange-50 dark:border-orange-800 dark:bg-orange-950',
  critical: 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950',
}

/**
 * Bash 的 argsJson 是 `{"command":"..."}`；卡片必须展示**命令原文**（不截断），
 * 否则用户可能只看到 `printf` 而批准了 `printf ... > ~/.zshrc`。
 */
function displayCommand(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { command?: unknown }).command === 'string'
    ) {
      return (parsed as { command: string }).command
    }
  } catch {
    // 非 JSON（其他工具的参数）按原样展示
  }
  return argsJson
}

export function ApprovalRequestDialog() {
  const { t } = useI18n()
  const [pending, setPending] = useState<ApprovalRequestPayload[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let mounted = true
    const api = window.electronAPI
    void api['agent:getPendingApprovals']()
      .then((list) => {
        if (mounted) {
          setPending(list as ApprovalRequestPayload[])
          // B4：挂载早于请求时 now 是陈旧值，必须随请求到达重设，否则首帧倒计时会超过上限。
          if (list.length > 0) setNow(Date.now())
        }
      })
      .catch(() => {
        // 忽略：可能尚未有 runtime
      })
    const offRequest = api.onApprovalRequest((raw) => {
      const payload = raw as ApprovalRequestPayload
      if (!payload?.approvalId) return
      setNow(Date.now())
      // 新请求到达即清空旧错误：横幅只描述「刚刚失败的那一次」。
      setError(null)
      setPending((prev) =>
        prev.some((item) => item.approvalId === payload.approvalId) ? prev : [...prev, payload],
      )
    })
    const offResolved = api.onApprovalResolved((raw) => {
      const payload = raw as ApprovalResolutionPayload
      if (!payload?.approvalId) return
      setPending((prev) => prev.filter((item) => item.approvalId !== payload.approvalId))
    })
    return () => {
      mounted = false
      offRequest()
      offResolved()
    }
  }, [])

  useEffect(() => {
    if (pending.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pending.length])

  // 卡片清空后不能直接返回 null：失败原因（尤其 APPROVAL_STALE）必须继续可见，
  // 否则用户只看到弹窗消失、以为「已允许」，而命令其实没执行。
  if (pending.length === 0 && !error) return null

  const resolve = async (
    payload: ApprovalRequestPayload,
    decision: 'allow' | 'deny',
    scope: 'once' | 'session' = 'once',
  ) => {
    setBusy((prev) => ({ ...prev, [payload.approvalId]: true }))
    setError(null)
    try {
      unwrapIpcResult(
        await window.electronAPI['agent:resolveApproval']({
          approvalId: payload.approvalId,
          decision,
          argsHash: payload.argsHash,
          // 归属校验：主进程据此确认审批确实属于该会话/轮次，而不是只在同名 hash 上放行。
          sessionId: payload.sessionId,
          turnId: payload.turnId,
          ...(decision === 'allow' ? { scope } : {}),
        }),
      )
      setPending((prev) => prev.filter((item) => item.approvalId !== payload.approvalId))
    } catch (err) {
      // 批准后无人执行（陈旧审批）必须明确报错，不能静默关闭弹窗。
      const code = (err as { code?: unknown } | null)?.code
      const message = err instanceof Error && err.message ? err.message : null
      const prefix = code === 'APPROVAL_STALE' ? `${t('agent.approval.stale')} ` : ''
      setError(`${prefix}${message ?? t('agent.approval.resolveFailed')}`)
      setPending((prev) => prev.filter((item) => item.approvalId !== payload.approvalId))
    } finally {
      setBusy((prev) => ({ ...prev, [payload.approvalId]: false }))
    }
  }

  return (
    <div className="space-y-2 mx-2 mb-2">
      {error && (
        <p
          role="alert"
          data-testid="approval-error"
          className="text-xs text-red-600 dark:text-red-400 px-1"
        >
          {error}
        </p>
      )}
      {pending.map((payload) => {
        const remaining = computeRemainingSeconds(payload, now)
        return (
          <div key={payload.approvalId} className={`border rounded-lg p-3 ${RISK_STYLES[payload.risk]}`}>
            <div className="flex items-start gap-2">
              <ShieldAlert size={16} className="text-orange-600 dark:text-orange-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-orange-800 dark:text-orange-200">
                  {t('agent.approval.title')} · {payload.toolName}
                </p>
                <p className="text-xs text-orange-700 dark:text-orange-300 mt-1">{t('agent.approval.blocked')}</p>
                <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                  {t('agent.approval.risk')}: {t(`agent.approval.risk.${payload.risk}`)} ·{' '}
                  {t('agent.approval.mode')}:{' '}
                  {payload.mode === 'unattended' ? t('agent.approval.mode.unattended') : t('agent.approval.mode.interactive')} ·{' '}
                  {t('agent.approval.expiresIn').replace('{seconds}', String(remaining))}
                </p>
                {payload.policyRule && (
                  <p
                    data-testid="approval-policy-rule"
                    className="text-xs text-orange-700 dark:text-orange-300 mt-1"
                  >
                    {t('agent.approval.rule')}: <span className="font-mono">{payload.policyRule}</span>
                    {payload.policyReason ? ` · ${payload.policyReason}` : ''}
                  </p>
                )}
                {payload.argsRedacted && (
                  <p
                    role="note"
                    data-testid="approval-redacted-notice"
                    className="text-xs text-orange-700 dark:text-orange-300 mt-1"
                  >
                    {t('agent.approval.redactedNotice')}
                  </p>
                )}
                {payload.argsJson && (
                  <pre className="text-xs text-orange-700 dark:text-orange-300 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">
                    {displayCommand(payload.argsJson)}
                  </pre>
                )}
              </div>
            </div>
            <div className="flex gap-2 mt-2 justify-end">
              <button
                disabled={busy[payload.approvalId]}
                onClick={() => void resolve(payload, 'deny')}
                className="px-3 py-1 text-xs rounded-md border border-red-300 dark:border-red-600 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
              >
                {t('agent.approval.deny')}
              </button>
              <button
                disabled={busy[payload.approvalId]}
                onClick={() => void resolve(payload, 'allow', 'once')}
                className="px-3 py-1 text-xs rounded-md bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {t('agent.approval.allowOnce')}
              </button>
              {payload.sessionGrantable === true && (
                <button
                  disabled={busy[payload.approvalId]}
                  onClick={() => void resolve(payload, 'allow', 'session')}
                  className="px-3 py-1 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {t('agent.approval.allowSession')}
                </button>
              )}
            </div>
            {payload.sessionGrantable !== true && (
              <p
                role="note"
                data-testid="approval-session-unavailable"
                className="text-xs text-orange-700 dark:text-orange-300 mt-1 text-right"
              >
                {t('agent.approval.sessionUnavailable')}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
