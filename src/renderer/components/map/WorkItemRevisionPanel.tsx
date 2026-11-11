/**
 * I.8.F P2：C2 执行中修订面板（修订 diff）。
 *
 * 三件事只由服务端算，本组件只渲染：
 * - 字段级 before/after（`workitem:diff` 的 `fields`）；
 * - `impact` 三项（写域 / 验收 / 依赖）及各自「推不出」的事实（`missing`）；
 * - `gateResult`（历史对比取落库 gate_status；拟修订取生产 gate 引擎预检）。
 *
 * `reason` 的留痕能力由 `reasonTrace` 如实展示：审计表值域不接受 `workitem_revise`
 * 时显示「未留痕」，不静默省略。提交仍走既有 `workitem:revise`，不新造写路径。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '../ui/badge'
import {
  useMapStore,
  type ProposedRevisionInput,
  type WorkItemDiffView,
  type WorkItemImpact,
  type WorkItemRevisionEntry,
} from '../../store/mapStore'
import { formatTs } from './TaskCardTree'

const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  goal: '目标',
  scope_files: '写域文件',
  out_of_scope_files: '排除文件',
  acceptance_json: '验收条目',
  verification_hint: '验证提示',
  depends_on_json: '依赖引用',
}

const IMPACT_LABEL: Record<string, string> = {
  writeScope: '写域文件',
  acceptance: '验收条目',
  dependency: '依赖引用',
}

/** 推不出的具体事实（`missing` 里出现的键 → 可读文案）。 */
const MISSING_LABEL: Record<string, string> = {
  filesActuallyChanged: '文件是否真会被改动（需 run 产出 change_set）',
  invalidatedRuns: '哪些 run 会失效（revise 不产生失效标记）',
  staleEvidence: '哪些证据会 stale（无失效标记）',
  scope_files_unparsable: '写域不是合法字符串数组',
  acceptance_json_unparsable: '验收不是合法数组',
  acceptance_entry_without_stable_id: '验收条目缺稳定 id（不做按位置配对）',
  acceptance_entry_duplicate_id: '验收条目 id 重复',
  depends_on_json_unparsable: '依赖不是合法字符串数组',
}

const ACTION_BUTTON_CLASS =
  'rounded border px-2 py-0.5 text-[10px] hover:bg-gray-500/10 disabled:cursor-not-allowed disabled:opacity-40'
const INPUT_CLASS =
  'w-full rounded border border-gray-500/30 bg-transparent px-1 py-0.5 text-[10px] text-gray-700'

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value === '' ? '（空）' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.length === 0 ? '（空）' : value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n')
  }
  return JSON.stringify(value)
}

function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

interface Props {
  graphId: string
  item: { id: string; lineage_id: string; revision: number }
  error?: string | null
  onClose?: () => void
}

export function WorkItemRevisionPanel({ graphId, item, error, onClose }: Props) {
  const fetchWorkItemHistory = useMapStore((state) => state.fetchWorkItemHistory)
  const fetchWorkItemDiff = useMapStore((state) => state.fetchWorkItemDiff)
  const reviseWorkItem = useMapStore((state) => state.reviseWorkItem)

  const [history, setHistory] = useState<WorkItemRevisionEntry[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [diff, setDiff] = useState<WorkItemDiffView | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [compareFrom, setCompareFrom] = useState<number>(item.revision)
  const [compareTo, setCompareTo] = useState<number>(item.revision)
  const [reason, setReason] = useState('')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [scopeFiles, setScopeFiles] = useState('')
  const [dependsOn, setDependsOn] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const currentRevision = useMemo(
    () => history.find((entry) => entry.is_current)?.revision ?? item.revision,
    [history, item.revision],
  )
  const currentItemId = useMemo(
    () => history.find((entry) => entry.is_current)?.id ?? item.id,
    [history, item.id],
  )

  const loadHistory = useCallback(async () => {
    setHistoryError(null)
    try {
      const rows = await fetchWorkItemHistory(item.lineage_id)
      setHistory(rows)
      const current = rows.find((entry) => entry.is_current) ?? rows[rows.length - 1]
      if (current) {
        setCompareFrom((prev) => (rows.some((row) => row.revision === prev) ? prev : current.revision))
        setCompareTo((prev) => (rows.some((row) => row.revision === prev) ? prev : current.revision))
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err))
    }
  }, [fetchWorkItemHistory, item.lineage_id])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const buildProposed = (): ProposedRevisionInput | null => {
    setFormError(null)
    const proposed: ProposedRevisionInput = {}
    if (title.trim() !== '') proposed.title = title.trim()
    if (goal.trim() !== '') proposed.goal = goal
    if (scopeFiles.trim() !== '') proposed.scopeFiles = splitList(scopeFiles)
    if (dependsOn.trim() !== '') proposed.dependsOn = splitList(dependsOn)
    if (acceptance.trim() !== '') {
      try {
        const parsed = JSON.parse(acceptance)
        if (!Array.isArray(parsed)) {
          setFormError('验收条目必须是 JSON 数组')
          return null
        }
        proposed.acceptance = parsed as Array<Record<string, unknown>>
      } catch {
        setFormError('验收条目不是合法 JSON')
        return null
      }
    }
    return proposed
  }

  const runDiff = useCallback(
    async (query: { from: number; to?: number; proposed?: ProposedRevisionInput }) => {
      setBusy(true)
      setDiffError(null)
      try {
        const result = await fetchWorkItemDiff({ lineageId: item.lineage_id, ...query })
        setDiff(result)
      } catch (err) {
        setDiff(null)
        setDiffError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [fetchWorkItemDiff, item.lineage_id],
  )

  const onPreview = async () => {
    const proposed = buildProposed()
    if (!proposed) return
    await runDiff({ from: currentRevision, proposed })
  }

  const onSubmit = async () => {
    if (!diff || diff.to.stored) {
      setFormError('请先「预检修订」生成拟修订的 diff / impact / gate 结论')
      return
    }
    if (reason.trim() === '') {
      setFormError('请填写修订原因（C2 必填展示项）')
      return
    }
    const proposed = buildProposed()
    if (!proposed) return
    setBusy(true)
    try {
      const audit = await reviseWorkItem({
        graphId,
        id: currentItemId,
        title: proposed.title,
        goal: proposed.goal,
        scopeFiles: proposed.scopeFiles,
        acceptance: proposed.acceptance,
        dependsOn: proposed.dependsOn,
        reason: reason.trim(),
        display: {
          diff: diff.fields,
          impact: diff.impact,
          reason: reason.trim(),
          gateResult: diff.gateResult,
        },
      })
      if (!audit) return // 错误已由 store 写入 actionErrors
      await loadHistory()
      setDiff(null)
      onClose?.()
    } finally {
      setBusy(false)
    }
  }

  const showStored = async () => {
    await runDiff({ from: compareFrom, to: compareTo })
  }

  return (
    <div
      data-testid={`workitem-revision-${item.id}`}
      className="mt-1 space-y-1 rounded border border-purple-500/40 bg-purple-500/5 p-1.5 text-[10px]"
    >
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="secondary" className="border border-purple-500/40 text-[10px] text-purple-700">
          C2 执行中修订
        </Badge>
        <span className="text-gray-500">lineage {item.lineage_id} · 当前 r{currentRevision}</span>
        <button type="button" className={`${ACTION_BUTTON_CLASS} border-gray-500/30`} onClick={onClose}>
          收起
        </button>
      </div>

      <p className="text-gray-600">
        提交后会生成新 revision，旧 revision 置 superseded。修订只表达单任务字段级变化；新增 / 删除 / 合并 / 拆分不在本通道能力内。
      </p>

      <div data-testid={`workitem-revision-${item.id}-history`} className="space-y-0.5">
        <span className="text-gray-500">历史 revision：</span>
        {history.length === 0 ? (
          <span className="text-gray-500">{historyError ? `读取失败：${historyError}` : '无记录'}</span>
        ) : (
          <ul className="list-disc pl-4 text-gray-600">
            {history.map((entry) => (
              <li key={entry.id}>
                r{entry.revision} · {entry.status} · gate {entry.gate_status}
                {entry.is_current ? ' · 当前' : ''} · {formatTs(Date.parse(entry.updated_at))}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <label className="text-gray-500">
          对比
          <select
            className="mx-1 rounded border border-gray-500/30 bg-transparent px-1 py-0.5"
            value={compareFrom}
            onChange={(event) => setCompareFrom(Number(event.target.value))}
            data-testid={`workitem-revision-${item.id}-from`}
          >
            {history.map((entry) => (
              <option key={entry.id} value={entry.revision}>
                r{entry.revision}
              </option>
            ))}
          </select>
          →
          <select
            className="mx-1 rounded border border-gray-500/30 bg-transparent px-1 py-0.5"
            value={compareTo}
            onChange={(event) => setCompareTo(Number(event.target.value))}
            data-testid={`workitem-revision-${item.id}-to`}
          >
            {history.map((entry) => (
              <option key={entry.id} value={entry.revision}>
                r{entry.revision}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`${ACTION_BUTTON_CLASS} border-gray-500/30`}
          disabled={busy || history.length < 2}
          onClick={() => void showStored()}
          data-testid={`workitem-revision-${item.id}-compare`}
        >
          对比历史两版
        </button>
      </div>

      <div className="space-y-1 rounded border border-gray-500/20 p-1">
        <div className="text-gray-500">拟修订（留空 = 保持当前值）</div>
        <label className="block">
          <span className="text-gray-500">标题</span>
          <input className={INPUT_CLASS} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="block">
          <span className="text-gray-500">目标</span>
          <textarea className={INPUT_CLASS} rows={2} value={goal} onChange={(event) => setGoal(event.target.value)} />
        </label>
        <label className="block">
          <span className="text-gray-500">写域文件（逗号或换行分隔）</span>
          <textarea className={INPUT_CLASS} rows={2} value={scopeFiles} onChange={(event) => setScopeFiles(event.target.value)} />
        </label>
        <label className="block">
          <span className="text-gray-500">依赖引用（逗号或换行分隔）</span>
          <textarea className={INPUT_CLASS} rows={2} value={dependsOn} onChange={(event) => setDependsOn(event.target.value)} />
        </label>
        <label className="block">
          <span className="text-gray-500">验收条目（JSON 数组，条目需带 id）</span>
          <textarea className={INPUT_CLASS} rows={3} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} />
        </label>
        <label className="block">
          <span className="text-gray-500">修订原因（C2 必填）</span>
          <textarea
            className={INPUT_CLASS}
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            data-testid={`workitem-revision-${item.id}-reason`}
          />
        </label>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={`${ACTION_BUTTON_CLASS} border-blue-500/40 text-blue-700`}
            disabled={busy}
            onClick={() => void onPreview()}
            data-testid={`workitem-revision-${item.id}-preview`}
          >
            预检修订
          </button>
          <button
            type="button"
            className={`${ACTION_BUTTON_CLASS} border-green-500/40 text-green-700`}
            disabled={busy || !diff || diff.to.stored || reason.trim() === ''}
            onClick={() => void onSubmit()}
            data-testid={`workitem-revision-${item.id}-submit`}
          >
            提交修订
          </button>
        </div>
      </div>

      {formError ? <p className="text-red-600">{formError}</p> : null}
      {diffError ? (
        <p className="text-red-600" data-testid={`workitem-revision-${item.id}-diff-error`}>
          {diffError}
        </p>
      ) : null}

      {diff ? (
        <div data-testid={`workitem-revision-${item.id}-diff`} className="space-y-1">
          <div className="text-gray-500">
            {diff.to.stored
              ? `历史对比 r${diff.from.revision} → r${diff.to.revision}`
              : `拟修订预检 r${diff.from.revision} → r${diff.to.revision}（未落库）`}
          </div>
          <ul className="space-y-0.5">
            {diff.fields.map((field) => (
              <li key={field.field} className={field.changed ? 'text-gray-800' : 'text-gray-400'}>
                <span className="text-gray-500">{FIELD_LABEL[field.field] ?? field.field}：</span>
                {field.changed ? (
                  <>
                    <span className="text-red-600 line-through">{formatValue(field.before)}</span>
                    {' → '}
                    <span className="text-green-700">{formatValue(field.after)}</span>
                  </>
                ) : (
                  <span>{formatValue(field.before)}</span>
                )}
              </li>
            ))}
          </ul>

          <div className="space-y-1" data-testid={`workitem-revision-${item.id}-impact`}>
            {diff.impact.map((impact) => (
              <ImpactRow key={impact.kind} itemId={item.id} impact={impact} />
            ))}
          </div>

          <div className="text-gray-600">
            gate 结论：{diff.gateResult.status === 'precheck' ? '预检' : '落库'} · {diff.gateResult.gateStatus}
            {diff.gateResult.missing.length > 0 ? ` · 缺失 ${diff.gateResult.missing.join(', ')}` : ''}
          </div>

          <div data-testid={`workitem-revision-${item.id}-reason-trace`} className={diff.reasonTrace.sink ? 'text-green-700' : 'text-amber-700'}>
            修订原因留痕：{diff.reasonTrace.sink ? `写入 ${diff.reasonTrace.sink}` : `未留痕（${diff.reasonTrace.note}）`}
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-red-600" data-testid={`workitem-revision-${item.id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  )
}

function ImpactRow({ impact, itemId }: { impact: WorkItemImpact; itemId: string }) {
  const detail = impact.detail as { added?: string[]; removed?: string[]; unchanged?: string[]; modified?: string[] }
  return (
    <div data-testid={`workitem-revision-${itemId}-impact-${impact.kind}`} className="pl-1">
      <span className="text-gray-500">{IMPACT_LABEL[impact.kind] ?? impact.kind}：</span>
      {impact.status === 'missing' ? <span className="text-red-600">推不出</span> : null}
      {Array.isArray(detail.added) && detail.added.length > 0 ? <span className="ml-1 text-green-700">+{detail.added.join(', ')}</span> : null}
      {Array.isArray(detail.removed) && detail.removed.length > 0 ? <span className="ml-1 text-red-600">-{detail.removed.join(', ')}</span> : null}
      {Array.isArray(detail.modified) && detail.modified.length > 0 ? <span className="ml-1 text-amber-700">~{detail.modified.join(', ')}</span> : null}
      {Array.isArray(detail.unchanged) && detail.unchanged.length > 0 ? (
        <span className="ml-1 text-gray-500">不变 {detail.unchanged.length} 项</span>
      ) : null}
      <span className="ml-1 text-gray-500">{impact.note}</span>
      {impact.missing.length > 0 ? (
        <ul className="list-disc pl-4 text-amber-700" data-testid={`workitem-revision-${itemId}-missing-${impact.kind}`}>
          {impact.missing.map((key) => (
            <li key={key}>推不出：{MISSING_LABEL[key] ?? key}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
