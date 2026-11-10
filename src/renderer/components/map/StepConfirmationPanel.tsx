/**
 * G8-3：步级确认点展示与决策出口（C3 测试计划确认 / C4 完成认定）。
 *
 * 只读部分：`point` / `risk.level` / `reasons` / `required` / `display` 全部来自主进程
 * `map:confirmation:status`，本组件**不复算风险等级**，也不自行拼装展示载荷。
 * 写出口：`map:confirmation:decide`；成功后不改本地状态，等主进程 broadcast 重拉。
 * 低风险且无决策的步不渲染，避免把确认信号稀释成噪声（D-13/D-19）。
 */

import { useState } from 'react'
import { Badge } from '../ui/badge'
import type { StepConfirmationView } from '../../store/mapStore'
import { formatTs } from './TaskCardTree'

const POINT_LABEL: Record<'C3' | 'C4', string> = {
  C3: '测试计划确认',
  C4: '完成认定',
}

/** §5.6 展示项的界面文案（键名 → 中文）。 */
const DISPLAY_LABEL: Record<string, string> = {
  commands: '命令清单',
  worktree: 'worktree 与基线',
  affectedFiles: '影响文件',
  policies: '策略判定',
  planHash: '计划哈希',
  durationLimit: '预计时长上限',
  executionState: '执行状态',
  evidence: '证据列表',
  staleEvidence: 'stale 证据',
  unmetAcceptance: '未满足的验收',
  suggestions: '建议',
  statusDiff: '与人工状态的差异',
}

const ACTION_BUTTON_CLASS =
  'rounded border px-2 py-0.5 text-[10px] hover:bg-gray-500/10 disabled:cursor-not-allowed disabled:opacity-40'

/** 该步是否需要用户注意（任务级角标用）。 */
export function hasPendingConfirmation(views: readonly StepConfirmationView[]): boolean {
  return views.some((view) => view.point !== null && (view.required || view.waiting))
}

function stateOf(view: StepConfirmationView): { text: string; className: string } {
  if (view.decision) {
    return view.decision.decision === 'approve'
      ? { text: '已通过', className: 'bg-green-500/10 text-green-700 border-green-500/30' }
      : { text: '已驳回', className: 'bg-red-500/10 text-red-700 border-red-500/30' }
  }
  if (view.waiting) {
    return { text: '待确认', className: 'bg-amber-500/10 text-amber-700 border-amber-500/30' }
  }
  return { text: '需确认', className: 'bg-amber-500/10 text-amber-700 border-amber-500/30' }
}

function formatDisplayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.length === 0 ? '（空）' : value.map((item) => formatDisplayValue(item)).join('\n')
  }
  if (value && typeof value === 'object') return JSON.stringify(value)
  return '—'
}

export interface StepConfirmationDecisionInput {
  decision: 'approve' | 'reject'
  display: Record<string, unknown>
  note?: string
}

interface Props {
  view: StepConfirmationView
  /** 该步动作失败的中文提示（由 store 把错误码翻好）。 */
  error?: string | null
  busy?: boolean
  onDecide?: (input: StepConfirmationDecisionInput) => void
}

export function StepConfirmationPanel({ view, error, busy, onDecide }: Props) {
  const [note, setNote] = useState('')
  if (!view.point) return null
  // 低风险且无历史决策：不展示（非高风险步不弹确认）。
  if (!view.required && !view.waiting && !view.decision) return null

  const state = stateOf(view)
  const risk = view.risk
  const missing = view.requiredDisplay.filter((key) => view.display[key] === undefined)
  const waiting = view.waiting && !view.decision
  const blocked = missing.length > 0

  return (
    <div
      data-testid={`step-${view.stepId}-confirmation`}
      className="mt-1 space-y-1 rounded border border-amber-500/40 bg-amber-500/5 p-1.5 text-[10px]"
    >
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="secondary" className="border text-[10px] border-amber-500/40 text-amber-700">
          {view.point} {POINT_LABEL[view.point]}
        </Badge>
        <Badge variant="secondary" className={`border text-[10px] ${state.className}`}>
          {state.text}
        </Badge>
        {risk ? (
          <Badge
            variant="secondary"
            className={`border text-[10px] ${
              risk.level === 'high'
                ? 'bg-red-500/10 text-red-700 border-red-500/30'
                : 'bg-gray-500/10 text-gray-600 border-gray-500/30'
            }`}
            data-testid={`step-${view.stepId}-risk`}
          >
            风险 {risk.level === 'high' ? '高' : '低'}
          </Badge>
        ) : null}
      </div>

      {view.trigger ? (
        <p data-testid={`step-${view.stepId}-why`} className="text-gray-600">
          为什么要确认：{view.trigger}
        </p>
      ) : null}

      {risk ? (
        <ul data-testid={`step-${view.stepId}-reasons`} className="list-disc space-y-0.5 pl-4 text-gray-600">
          {risk.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      {view.requiredDisplay.length > 0 ? (
        <div className="space-y-0.5" data-testid={`step-${view.stepId}-display`}>
          <div className="text-gray-500">确认前展示：</div>
          {view.requiredDisplay.map((key) => {
            const label = DISPLAY_LABEL[key] ?? key
            const value = view.display[key]
            return (
              <div key={key} data-testid={`step-${view.stepId}-display-${key}`} className="pl-2">
                <span className="text-gray-500">{label}：</span>
                {value === undefined ? (
                  <span className="text-red-600">无内容</span>
                ) : (
                  <pre className="inline whitespace-pre-wrap break-all text-gray-700">
                    {formatDisplayValue(value)}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

      {waiting && blocked ? (
        <p data-testid={`step-${view.stepId}-confirmation-missing`} className="text-red-600">
          缺少展示项（{missing.map((key) => DISPLAY_LABEL[key] ?? key).join('、')}），无法确认
        </p>
      ) : null}

      {waiting ? (
        <div className="flex flex-wrap items-center gap-1">
          <input
            className="min-w-[6rem] flex-1 rounded border px-1 py-0.5 text-[10px]"
            placeholder="备注（可选）"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            data-testid={`step-${view.stepId}-confirmation-note`}
          />
          <button
            type="button"
            className={`${ACTION_BUTTON_CLASS} border-green-500/40 text-green-700`}
            disabled={busy || blocked}
            onClick={() =>
              onDecide?.({
                decision: 'approve',
                display: view.display,
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            }
            data-testid={`step-${view.stepId}-confirmation-approve`}
          >
            通过
          </button>
          <button
            type="button"
            className={`${ACTION_BUTTON_CLASS} border-red-500/40 text-red-700`}
            disabled={busy || blocked}
            onClick={() =>
              onDecide?.({
                decision: 'reject',
                display: view.display,
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            }
            data-testid={`step-${view.stepId}-confirmation-reject`}
          >
            驳回
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="text-red-600" data-testid={`step-${view.stepId}-confirmation-error`}>
          {error}
        </p>
      ) : null}

      {view.decision ? (
        <p data-testid={`step-${view.stepId}-decision`} className="text-gray-600">
          决策：{view.decision.decision === 'approve' ? '通过' : '驳回'} · {view.decision.decidedBy} ·{' '}
          {formatTs(view.decision.decidedAt)}
          {view.decision.note ? ` · ${view.decision.note}` : ''}
        </p>
      ) : null}

      {!view.decision && view.rejectPath ? (
        <p className="text-gray-500">驳回后：{view.rejectPath}</p>
      ) : null}
    </div>
  )
}
