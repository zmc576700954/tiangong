/**
 * G8-3：步级确认点展示（C3 测试计划确认 / C4 完成认定）。
 *
 * 只读渲染：`point` / `risk.level` / `reasons` / `required` 全部来自主进程
 * `map:confirmation:status`，本组件**不复算风险等级**，也不改任何状态。
 * 低风险且无决策的步不渲染，避免把确认信号稀释成噪声（D-13/D-19）。
 */

import { Badge } from '../ui/badge'
import type { StepConfirmationView } from '../../store/mapStore'
import { formatTs } from './TaskCardTree'

const POINT_LABEL: Record<'C3' | 'C4', string> = {
  C3: '测试计划确认',
  C4: '完成认定',
}

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

export function StepConfirmationPanel({ view }: { view: StepConfirmationView }) {
  if (!view.point) return null
  // 低风险且无历史决策：不展示（非高风险步不弹确认）。
  if (!view.required && !view.waiting && !view.decision) return null

  const state = stateOf(view)
  const risk = view.risk
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
        <div className="flex flex-wrap items-center gap-1 text-gray-500">
          <span>必填展示项：</span>
          {view.requiredDisplay.map((key) => (
            <span key={key} className="rounded border border-gray-500/30 px-1">
              {key}
            </span>
          ))}
        </div>
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
