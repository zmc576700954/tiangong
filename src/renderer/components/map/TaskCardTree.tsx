/**
 * TaskCardTree（G8-5 任务卡深度，蓝图 II-31 / D-14）
 *
 * 纯渲染派生，不改数据模型：把 `workitem:get` 已返回的 steps/runs 与节点证据
 * 按「任务 → 步 → run → 证据」四层组织，展开状态只存在组件调用方的内存里。
 *
 * 边界：
 * - 层级上限 4（任务卡片本身算第 1 层，证据是叶子，不提供下钻）；
 * - 组件不拉数据、不复算状态，只按传入数据分组；
 * - 证据按 `work_run_id` 归到 run，未绑定当前 run 的证据在任务级单列；
 * - 折叠状态不落库，面板重新挂载即恢复默认（任务级）。
 */

import type { ReactNode } from 'react'
import { Badge } from '../ui/badge'
import type { EvidenceEntry, WorkRunEntry, WorkStepEntry } from '../../store/mapStore'

/** 层级上限：任务(1) → 步(2) → run(3) → 证据(4)。证据为叶子。 */
export const TASK_TREE_MAX_DEPTH = 4

/** item / step / run 状态共用配色（缺省值回落中性灰）。 */
export const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  planning: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  pending: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  awaiting_confirm: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  queued: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30',
  running: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  waiting_approval: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  review: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  blocked: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  needs_input: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  needs_human: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  paused: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  interrupted: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  succeeded: 'bg-green-500/10 text-green-600 border-green-500/30',
  completed: 'bg-green-500/10 text-green-600 border-green-500/30',
  done: 'bg-green-500/10 text-green-600 border-green-500/30',
  failed: 'bg-red-500/10 text-red-600 border-red-500/30',
  timed_out: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  cancelled: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  skipped: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  superseded: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
}

export function formatTs(ts: number | null | undefined): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const ROW_CLASS = 'flex items-center gap-2 text-[11px]'
const TOGGLE_CLASS = 'w-4 shrink-0 text-[10px] opacity-60 hover:opacity-100'

export interface TaskCardTreeProps {
  steps: WorkStepEntry[]
  runs: WorkRunEntry[]
  /** 仅本任务证据（按 work_item_id 预过滤；含已撤销/过期）。 */
  evidence: EvidenceEntry[]
  /** 受控展开集合，key 为 `step:<id>` / `run:<id>`；由调用方持有，不落库。 */
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  /** 步头部右侧动作（如「入队这一步」）。 */
  renderStepActions?: (step: WorkStepEntry) => ReactNode
  /** 步行下方附加块（验收待确认 / 未知输入 / 动作错误）。 */
  renderStepBody?: (step: WorkStepEntry) => ReactNode
  /** run 头部右侧动作（如「取消运行」）。 */
  renderRunActions?: (run: WorkRunEntry) => ReactNode
  /** run 行下方附加块（结果摘要 / 取消归因 / 动作错误）。 */
  renderRunBody?: (run: WorkRunEntry) => ReactNode
}

export function TaskCardTree({
  steps,
  runs,
  evidence,
  expanded,
  onToggle,
  renderStepActions,
  renderStepBody,
  renderRunActions,
  renderRunBody,
}: TaskCardTreeProps) {
  const runIds = new Set(runs.map((r) => r.id))
  // 未绑定到当前任务 run 的证据（E1 等无 run 归属，或属于历史 revision 的 run）。
  const unattached = evidence.filter((e) => !e.work_run_id || !runIds.has(e.work_run_id))

  return (
    <div className="mt-1 pl-2" data-testid="task-tree">
      <div className="text-[10px] opacity-50">步骤</div>
      {steps.length === 0 && <div className="text-[11px] opacity-50">无（该任务没有步骤）</div>}
      {steps.map((step) => {
        const stepKey = `step:${step.id}`
        const stepOpen = expanded.has(stepKey)
        const stepRuns = runs
          .filter((r) => r.step_id === step.id)
          .sort((a, b) => b.run_seq - a.run_seq || b.attempt - a.attempt)
        return (
          <div key={step.id} data-testid={`step-${step.id}`} data-depth={2}>
            <div className={ROW_CLASS}>
              <button
                type="button"
                className={TOGGLE_CLASS}
                data-testid={`step-${step.id}-toggle`}
                aria-expanded={stepOpen}
                title={stepOpen ? '收起该步的运行' : '展开该步的运行'}
                onClick={() => onToggle(stepKey)}
              >
                {stepOpen ? '▾' : '▸'}
              </button>
              <span className="w-5 text-right opacity-50">{step.seq}</span>
              <Badge variant="secondary" className={`text-[10px] border ${STATUS_STYLE[step.status] ?? ''}`}>
                {step.status}
              </Badge>
              <span className="flex-1 truncate">{step.title}</span>
              <span className="text-[10px] opacity-50">
                {step.step_kind} · #{step.attempt}
                {step.skip_reason ? ` · skip=${step.skip_reason}` : ''}
                {step.failure_class ? ` · ${step.failure_class}` : ''}
              </span>
              {renderStepActions?.(step)}
            </div>
            {renderStepBody?.(step)}
            {stepOpen && (
              <div className="ml-7 mt-1" data-testid={`step-${step.id}-runs`} data-depth={3}>
                <div className="text-[10px] opacity-50">运行（{stepRuns.length}）</div>
                {stepRuns.length === 0 && <div className="text-[11px] opacity-50">无（尚无运行记录）</div>}
                {stepRuns.map((run) => {
                  const runKey = `run:${run.id}`
                  const runOpen = expanded.has(runKey)
                  const runEvidence = evidence.filter((e) => e.work_run_id === run.id)
                  return (
                    <div key={run.id} data-testid={`run-${run.id}`} data-depth={3}>
                      <div className={ROW_CLASS}>
                        <button
                          type="button"
                          className={TOGGLE_CLASS}
                          data-testid={`run-${run.id}-toggle`}
                          aria-expanded={runOpen}
                          title={runOpen ? '收起该运行的证据' : '展开该运行的证据'}
                          onClick={() => onToggle(runKey)}
                        >
                          {runOpen ? '▾' : '▸'}
                        </button>
                        <Badge variant="secondary" className={`text-[10px] border ${STATUS_STYLE[run.status] ?? ''}`}>
                          {run.status}
                        </Badge>
                        <span className="truncate">#{run.run_seq}</span>
                        <span className="flex-1" />
                        <span className="text-[10px] opacity-50">
                          #{run.attempt}
                          {run.adapter_name ? ` · ${run.adapter_name}` : ''}
                          {run.failure_class ? ` · ${run.failure_class}` : ''} · {formatTs(run.created_at)}
                        </span>
                        {renderRunActions?.(run)}
                      </div>
                      {renderRunBody?.(run)}
                      {runOpen && (
                        <div className="ml-5 mt-1" data-testid={`run-${run.id}-evidence`} data-depth={TASK_TREE_MAX_DEPTH}>
                          <div className="text-[10px] opacity-50">证据（{runEvidence.length}）</div>
                          {runEvidence.length === 0 && (
                            <div className="text-[11px] opacity-50">无（该运行没有绑定证据）</div>
                          )}
                          {runEvidence.map((e) => (
                            <EvidenceRow key={e.id} entry={e} testIdPrefix="run-evidence" />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {unattached.length > 0 && (
        <div className="mt-1" data-testid="task-unattached-evidence">
          <div className="text-[10px] opacity-50">未绑定运行的证据（{unattached.length}）</div>
          {unattached.map((e) => (
            <EvidenceRow key={e.id} entry={e} testIdPrefix="task-evidence" />
          ))}
        </div>
      )}
    </div>
  )
}

function EvidenceRow({ entry, testIdPrefix }: { entry: EvidenceEntry; testIdPrefix: string }) {
  return (
    <div className={ROW_CLASS} data-testid={`${testIdPrefix}-${entry.id}`} data-depth={TASK_TREE_MAX_DEPTH}>
      <Badge variant="secondary" className="text-[10px]">{entry.evidence_level}</Badge>
      <span className="truncate">{entry.summary ?? entry.evidence_type}</span>
      <span className="flex-1" />
      <span className="text-[10px] opacity-50">
        {entry.freshness} · {entry.produced_by}
        {entry.revoked_at ? ' · 已撤销' : ''}
      </span>
    </div>
  )
}
