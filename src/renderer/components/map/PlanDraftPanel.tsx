/**
 * I.8.F P1：C1 计划草稿确认面板（计划批准）。
 *
 * 展示内容全部来自 `plan:draft:list` / `plan:draft:preview` 的服务端投影
 * （8 个必填展示项，其中 `gateMissing` 由生产 gate 引擎对草稿条目预检得出）；
 * 本组件**不复算准入、不拼装展示载荷**，确认时把 `display` 原样回传给
 * `plan:draft:confirm`。成功后由 store 重拉列表，不在本地猜草稿状态。
 */

import { Badge } from '../ui/badge'
import type { PlanDraftView } from '../../store/mapStore'
import { formatTs } from './TaskCardTree'

/** §5.6 C1 展示项的界面文案（键名 → 中文）。 */
const DISPLAY_LABEL: Record<string, string> = {
  subtasks: '子任务',
  scopeFiles: '写域文件',
  acceptance: '验收条件',
  dependencies: '依赖关系',
  candidateScore: '候选得分',
  gateMissing: '准入缺失项',
  excludedItems: '被剔除项',
  anchorStates: '锚点派生状态',
}

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  awaiting_confirm: '待确认',
  confirmed: '已确认',
  rejected: '已驳回',
  superseded: '已被修订取代',
}

const ACTION_BUTTON_CLASS =
  'rounded border px-2 py-0.5 text-[10px] hover:bg-gray-500/10 disabled:cursor-not-allowed disabled:opacity-40'

/** 展示值 → 可读文本；`{count, items}` 信封按「数量 + 逐条」展开。 */
function formatDisplayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.length === 0 ? '（空）' : value.map((item) => formatDisplayValue(item)).join('\n')
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Array.isArray(record.items) && typeof record.count === 'number') {
      const lines = record.items.map((item) => formatDisplayValue(item))
      return `${record.count} 项${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`
    }
    return JSON.stringify(value)
  }
  return '—'
}

interface Props {
  view: PlanDraftView
  /** 该草稿动作失败的中文提示（由 store 把错误码翻好）。 */
  error?: string | null
  busy?: boolean
  onDecide?: (decision: 'submit' | 'approve' | 'reject') => void
}

export function PlanDraftPanel({ view, error, busy, onDecide }: Props) {
  const { draft, display } = view
  // draft 先要 submit 才能 confirm（服务层状态机如此）；awaiting_confirm 才给确认/驳回。
  const submittable = draft.status === 'draft'
  const decidable = draft.status === 'awaiting_confirm'

  return (
    <div
      data-testid={`plan-draft-${draft.id}`}
      className="mt-1 space-y-1 rounded border border-blue-500/40 bg-blue-500/5 p-1.5 text-[10px]"
    >
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="secondary" className="border border-blue-500/40 text-[10px] text-blue-700">
          C1 计划批准
        </Badge>
        <Badge variant="secondary" className="border border-gray-500/30 text-[10px] text-gray-600">
          {STATUS_TEXT[draft.status] ?? draft.status}
        </Badge>
        <span className="text-gray-500">
          修订 {draft.revision} · 更新 {formatTs(Date.parse(draft.updated_at))}
        </span>
      </div>

      <p className="text-gray-600">确认即生成 work_items，不可原地回退；驳回则不生成任务。</p>

      <div className="space-y-0.5" data-testid={`plan-draft-${draft.id}-display`}>
        {Object.keys(DISPLAY_LABEL).map((key) => {
          const value = display[key]
          const isGateMissing = key === 'gateMissing'
          return (
            <div key={key} data-testid={`plan-draft-${draft.id}-display-${key}`} className="pl-1">
              <span className="text-gray-500">{DISPLAY_LABEL[key]}：</span>
              {value === undefined ? (
                <span className="text-red-600">无内容</span>
              ) : (
                <pre
                  className={`inline whitespace-pre-wrap break-all ${
                    isGateMissing && (display.gateMissing as { count?: number })?.count
                      ? 'text-amber-700'
                      : 'text-gray-700'
                  }`}
                >
                  {formatDisplayValue(value)}
                </pre>
              )}
            </div>
          )
        })}
      </div>

      {(() => {
        const skipped = (display.gateMissing as { skippedGates?: Array<{ gate?: string; reason?: string }> })
          ?.skippedGates
        if (!Array.isArray(skipped) || skipped.length === 0) return null
        return (
          <ul className="list-disc space-y-0.5 pl-4 text-gray-500" data-testid={`plan-draft-${draft.id}-skipped`}>
            {skipped.map((item) => (
              <li key={String(item.gate)}>
                {item.gate} 草稿阶段未判定：{item.reason}
              </li>
            ))}
          </ul>
        )
      })()}

      {submittable ? (
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={`${ACTION_BUTTON_CLASS} border-blue-500/40 text-blue-700`}
            disabled={busy}
            onClick={() => onDecide?.('submit')}
            data-testid={`plan-draft-${draft.id}-submit`}
          >
            提交确认
          </button>
        </div>
      ) : null}

      {decidable ? (
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={`${ACTION_BUTTON_CLASS} border-green-500/40 text-green-700`}
            disabled={busy}
            onClick={() => onDecide?.('approve')}
            data-testid={`plan-draft-${draft.id}-approve`}
          >
            确认计划
          </button>
          <button
            type="button"
            className={`${ACTION_BUTTON_CLASS} border-red-500/40 text-red-700`}
            disabled={busy}
            onClick={() => onDecide?.('reject')}
            data-testid={`plan-draft-${draft.id}-reject`}
          >
            驳回
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="text-red-600" data-testid={`plan-draft-${draft.id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  )
}
