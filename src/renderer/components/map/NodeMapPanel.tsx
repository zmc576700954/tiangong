/**
 * NodeMapPanel（L1 M1/M2 渲染层,session-map 蓝图 §9.4 职责）
 *
 * 选中节点的执行入口 + 只读详情：派生状态徽标 + 锚定该节点的 work item +
 * 每个 item 的步骤/最近 runs + 会话时间线（threadIds 全集,§9.5-3）+ 证据级别与新鲜度。
 *
 * 写操作（均接真实 IPC，不伪造状态）：
 * - 执行任务：`workitem:run:start` 只做 confirm 入队（不内联执行、不写 gate）；
 *   仅在 gate 已 pass/waived 且执行开关开启时可用。
 * - 取消任务：`workitem:cancel` 只改 item 状态，不终止进程；有活跃 run 时只给 run 级取消。
 * - 入队步骤：`workitem:step:run` 只入队，turn 由主进程 tick 异步驱动。
 * - 取消运行：`workitem:run:cancel` 条件取消并尝试终止在跑会话。
 * - 验收确认：`workitem:acceptance:confirm` 只记录人工事实并重算验收。
 *
 * 空态只写"无"；读取失败与“无数据”分开显示，不生成占位内容。
 */

import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Badge } from '../ui/badge'
import { useMapStore } from '../../store/mapStore'
import type { ExecutionStateValue, WorkItemSummary, WorkStepEntry } from '../../store/mapStore'

interface PendingAcceptanceEntry {
  id: string
  expected: string
  text?: string
}

/** 解析 `input_request_json`（kind=acceptance_manual_confirm）；非法/未知/空返回 null。 */
function parseAcceptanceRequest(json: string | null): PendingAcceptanceEntry[] | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as { kind?: unknown; entries?: unknown }
    if (parsed?.kind !== 'acceptance_manual_confirm' || !Array.isArray(parsed.entries)) return null
    const entries = parsed.entries.filter(
      (entry): entry is PendingAcceptanceEntry =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as PendingAcceptanceEntry).id === 'string' &&
        typeof (entry as PendingAcceptanceEntry).expected === 'string',
    )
    return entries.length > 0 ? entries : null
  } catch {
    return null
  }
}

/** 从 `input_request_json` 取 kind（未知 kind 兜底展示用）；非法返回 null。 */
function parseInputKind(json: string | null): string | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as { kind?: unknown }
    return typeof parsed?.kind === 'string' ? parsed.kind : null
  } catch {
    return null
  }
}

/** gate 缺失项（gate_missing_json = JSON string[]）；非法/空返回 []。 */
function parseGateMissing(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** 步骤依赖是否已满足（succeeded / skipped）。 */
function depsSatisfied(step: WorkStepEntry, steps: WorkStepEntry[]): boolean {
  if (!step.depends_on_step_ids_json) return true
  let deps: unknown
  try {
    deps = JSON.parse(step.depends_on_step_ids_json)
  } catch {
    return false
  }
  if (!Array.isArray(deps)) return false
  return deps.every((depId) => {
    if (typeof depId !== 'string') return false
    const dep = steps.find((s) => s.id === depId)
    return !!dep && (dep.status === 'succeeded' || dep.status === 'skipped')
  })
}

/** 可执行（confirm 入队）的 item 状态：draft / awaiting_confirm。 */
const ITEM_STARTABLE = new Set(['draft', 'awaiting_confirm'])
/** workitem:cancel 允许的 item 状态（终态不可取消）。 */
const ITEM_CANCELLABLE = new Set([
  'queued', 'running', 'needs_input', 'needs_human', 'paused', 'interrupted',
  'draft', 'awaiting_confirm', 'blocked',
])
/** 非终态 run：存在时只允许 run 级取消，不暴露任务级取消。 */
const RUN_ACTIVE = new Set(['queued', 'running', 'awaiting_approval', 'blocked', 'interrupted'])

/** 派生态徽标配色（verified 与 signed_off 按可复现性分色,禁止混同 §3.5）。 */
const STATE_STYLE: Record<ExecutionStateValue, string> = {
  untouched: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  planned: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  in_progress: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  implemented: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30',
  verified: 'bg-green-500/10 text-green-600 border-green-500/30',
  signed_off: 'bg-teal-500/10 text-teal-700 border-teal-500/30',
  failed: 'bg-red-500/10 text-red-600 border-red-500/30',
  blocked: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  stale: 'bg-yellow-500/10 text-yellow-700 border-yellow-500/30',
}

/** item / step / run 状态共用配色（缺省值回落中性灰）。 */
const STATUS_STYLE: Record<string, string> = {
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

function formatTs(ts: number | null | undefined): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const ACTION_BUTTON_CLASS =
  'rounded border px-1.5 py-0.5 text-[10px] hover:bg-gray-500/10 disabled:cursor-not-allowed disabled:opacity-40'

interface Props {
  graphId: string | null
  nodeEntityKey: string | null
  nodeId: string | null
}

export function NodeMapPanel({ graphId, nodeEntityKey }: Props) {
  const overlay = useMapStore(useShallow((s) => (graphId ? s.overlayByGraph.get(graphId) : undefined)))
  const timeline = useMapStore((s) => s.nodeTimeline)
  const evidence = useMapStore((s) => s.nodeEvidence)
  const details = useMapStore((s) => s.workItemDetails)
  const workItemErrors = useMapStore((s) => s.workItemErrors)
  const nodeError = useMapStore((s) => s.nodeError)
  const actionErrors = useMapStore((s) => s.actionErrors)
  const executionStatus = useMapStore((s) => s.executionStatus)
  const fetchExecutionStatus = useMapStore((s) => s.fetchExecutionStatus)
  const fetchOverlay = useMapStore((s) => s.fetchOverlay)
  const fetchNodeData = useMapStore((s) => s.fetchNodeData)
  const fetchWorkItemDetail = useMapStore((s) => s.fetchWorkItemDetail)
  const startWorkItem = useMapStore((s) => s.startWorkItem)
  const cancelWorkItem = useMapStore((s) => s.cancelWorkItem)
  const enqueueStep = useMapStore((s) => s.enqueueStep)
  const cancelRun = useMapStore((s) => s.cancelRun)
  const confirmAcceptance = useMapStore((s) => s.confirmAcceptance)
  const proposals = useMapStore((s) => s.proposals)
  const proposalDiffs = useMapStore((s) => s.proposalDiffs)
  const proposalErrors = useMapStore((s) => s.proposalErrors)
  const fetchProposals = useMapStore((s) => s.fetchProposals)
  const fetchProposalDiff = useMapStore((s) => s.fetchProposalDiff)
  const acceptProposal = useMapStore((s) => s.acceptProposal)
  const rejectProposal = useMapStore((s) => s.rejectProposal)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [openDiffId, setOpenDiffId] = useState<string | null>(null)
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({})

  const execEnabled = executionStatus?.enabled === true
  const execAdapter = executionStatus?.adapterName ?? null

  async function handleAction(key: string, action: () => Promise<void>): Promise<void> {
    setBusyKey(key)
    try {
      await action()
    } finally {
      setBusyKey(null)
    }
  }

  async function handleConfirm(itemId: string, stepId: string, entryId: string): Promise<void> {
    if (!graphId) return
    const key = `${stepId}:${entryId}`
    setConfirmingKey(key)
    setConfirmError(null)
    try {
      await confirmAcceptance({ graphId, workItemId: itemId, stepId, entryIds: [entryId] })
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : String(error))
    } finally {
      setConfirmingKey(null)
    }
  }

  useEffect(() => {
    void fetchExecutionStatus()
  }, [fetchExecutionStatus])

  useEffect(() => {
    if (!graphId) return
    void fetchOverlay(graphId)
  }, [graphId, fetchOverlay])

  useEffect(() => {
    if (!graphId || !nodeEntityKey) return
    void fetchNodeData(graphId, nodeEntityKey)
  }, [graphId, nodeEntityKey, fetchNodeData])

  useEffect(() => {
    if (!graphId || !nodeEntityKey) return
    void fetchProposals(graphId, nodeEntityKey)
  }, [graphId, nodeEntityKey, fetchProposals])

  const tasks: WorkItemSummary[] = (overlay?.workItems ?? []).filter((w) => w.anchor_entity_key === nodeEntityKey)
  const taskIds = tasks.map((t) => t.id).join(',')

  useEffect(() => {
    if (!taskIds) return
    for (const id of taskIds.split(',')) void fetchWorkItemDetail(id)
  }, [taskIds, fetchWorkItemDetail])

  if (!graphId || !nodeEntityKey) return null

  const exec = overlay?.executionStates.find((e) => e.node_entity_key === nodeEntityKey)

  return (
    <div className="my-2 rounded-md border border-gray-200 bg-white/60 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900/40" data-testid="node-map-panel">
      <div className="flex flex-wrap items-center gap-2" data-testid="node-map-header">
        <span className="text-xs font-medium opacity-70">地图</span>
        {exec ? (
          <Badge variant="secondary" className={`text-[10px] border ${STATE_STYLE[exec.execution_state]}`} data-testid="node-exec-state">
            {exec.execution_state}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px] border bg-gray-500/10 text-gray-500 border-gray-500/30">无派生态</Badge>
        )}
        {exec && exec.stale_count > 0 && (
          <Badge variant="secondary" className="text-[10px] border bg-yellow-500/10 text-yellow-700 border-yellow-500/30">
            stale ×{exec.stale_count}
          </Badge>
        )}
        <span className="ml-auto text-[10px] opacity-50">
          {tasks.length} 任务 · {timeline.length} 会话 · {evidence.length} 证据
        </span>
      </div>

      {/* 执行开关只读状态：关闭/未配置执行器时说明「为什么入队后不会跑」 */}
      <div
        className={`mt-2 rounded border px-2 py-1 text-[10px] ${
          execEnabled && execAdapter
            ? 'border-green-500/30 bg-green-500/5 text-green-700'
            : 'border-amber-500/30 bg-amber-500/5 text-amber-700'
        }`}
        data-testid="map-exec-status"
      >
        {executionStatus === null && '读取执行状态…'}
        {executionStatus !== null && execEnabled && execAdapter && `执行已开启 · adapter=${execAdapter}`}
        {executionStatus !== null && (!execEnabled || !execAdapter) &&
          `执行未开启：${executionStatus.disabledReason ?? '未配置执行器'}（入队后不会自动运行）`}
      </div>

      {nodeError && (
        <div className="mt-2 rounded border border-red-500/30 bg-red-500/5 px-2 py-1 text-[11px] text-red-600" data-testid="map-node-error">
          读取失败：{nodeError}
        </div>
      )}

      <div className="mt-2 space-y-3 border-t border-gray-200 pt-2 dark:border-gray-700">
        {/* 锚定该节点的 work item（含执行入口 / steps / 最近 runs） */}
        <section data-testid="node-map-tasks">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">任务</div>
          <div className="space-y-2">
            {tasks.map((t) => {
              const detail = details[t.id]
              const loadError = workItemErrors[t.id]
              const taskActionError = actionErrors[t.id]
              const runs = detail?.runs ?? []
              const steps = detail?.steps ?? []
              const recentRuns = runs.slice(-5).reverse()
              const activeRuns = runs.filter((r) => RUN_ACTIVE.has(r.status))
              const hasActiveRun = activeRuns.length > 0
              const gateOk = t.gate_status === 'pass' || t.gate_status === 'waived'
              const gateMissing = parseGateMissing(t.gate_missing_json)
              const canStart = gateOk && execEnabled && !!execAdapter && !hasActiveRun
              const startDisabledReason = !gateOk
                ? `gate 未通过：缺 ${gateMissing.length > 0 ? gateMissing.join('、') : '检查项'}`
                : !execEnabled || !execAdapter
                  ? executionStatus?.disabledReason ?? '执行未开启'
                  : hasActiveRun
                    ? '已有运行中的 run，先等待或取消当前 run'
                    : null

              return (
                <div key={t.id} className="rounded px-2 py-1" data-testid={`task-${t.id}`}>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className={`text-[10px] border ${STATUS_STYLE[t.status] ?? ''}`}>{t.status}</Badge>
                    <span className="flex-1 truncate text-xs">{t.title}</span>
                    <span className="text-[10px] opacity-50">r{t.revision} · gate={t.gate_status}</span>
                  </div>

                  {/* 任务级动作：执行（confirm 入队）/ 取消（不终止进程） */}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-2">
                    {ITEM_STARTABLE.has(t.status) && (
                      <button
                        type="button"
                        className={`${ACTION_BUTTON_CLASS} border-blue-500/40`}
                        data-testid={`task-${t.id}-run`}
                        disabled={!canStart || busyKey === `start:${t.id}`}
                        title={startDisabledReason ?? '确认并排队该任务（turn 由后台 tick 驱动）'}
                        onClick={() => void handleAction(`start:${t.id}`, () => startWorkItem(t.id))}
                      >
                        {busyKey === `start:${t.id}` ? '入队中…' : '执行任务'}
                      </button>
                    )}
                    {!gateOk && (
                      <span className="text-[10px] text-amber-700" data-testid={`task-${t.id}-gate-missing`}>
                        gate 缺：{gateMissing.length > 0 ? gateMissing.join('、') : '检查项'}
                      </span>
                    )}
                    {ITEM_CANCELLABLE.has(t.status) && !!detail && !hasActiveRun && (
                      <button
                        type="button"
                        className={`${ACTION_BUTTON_CLASS} border-red-500/40`}
                        data-testid={`task-${t.id}-cancel`}
                        disabled={busyKey === `cancel:${t.id}`}
                        title="取消任务本身（不会终止已在跑的执行进程）"
                        onClick={() => void handleAction(`cancel:${t.id}`, () => cancelWorkItem(t.id))}
                      >
                        {busyKey === `cancel:${t.id}` ? '取消中…' : '取消任务'}
                      </button>
                    )}
                    {hasActiveRun && (
                      <span className="text-[10px] text-amber-700" data-testid={`task-${t.id}-active-run-hint`}>
                        先取消运行中的 run（任务级取消不会停止进程）
                      </span>
                    )}
                    {t.cancel_reason && (
                      <span className="text-[10px] opacity-60" data-testid={`task-${t.id}-cancel-reason`}>
                        cancel={t.cancel_reason}
                      </span>
                    )}
                  </div>

                  {taskActionError && (
                    <div className="mt-1 pl-2 text-[10px] text-red-600" data-testid={`task-${t.id}-action-error`}>
                      {taskActionError}
                    </div>
                  )}

                  {loadError ? (
                    <div className="mt-1 flex items-center gap-2 pl-2 text-[11px] text-red-600" data-testid={`task-${t.id}-load-error`}>
                      <span className="flex-1">步骤/运行读取失败：{loadError}</span>
                      <button
                        type="button"
                        className={ACTION_BUTTON_CLASS}
                        data-testid={`task-${t.id}-retry`}
                        onClick={() => void fetchWorkItemDetail(t.id)}
                      >
                        重试
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="mt-1 pl-2" data-testid={`task-${t.id}-steps`}>
                        <div className="text-[10px] opacity-50">步骤</div>
                        {!detail && <div className="text-[11px] opacity-50">读取中…</div>}
                        {detail && steps.length === 0 && (
                          <div className="text-[11px] opacity-50">无（该任务没有步骤）</div>
                        )}
                        {steps.map((s) => {
                          const acceptance = s.status === 'needs_input' ? parseAcceptanceRequest(s.input_request_json) : null
                          const unknownInput = s.status === 'needs_input' && !acceptance
                          const itemRunnable = t.status === 'queued' || t.status === 'running'
                          const showEnqueue = s.step_kind === 'agent' && s.status === 'pending' && itemRunnable
                          const depsOk = depsSatisfied(s, steps)
                          const enqueueReady = gateOk && execEnabled && !!execAdapter && depsOk
                          const stepActionError = actionErrors[s.id]
                          return (
                            <div key={s.id} data-testid={`step-${s.id}`}>
                              <div className="flex items-center gap-2 text-[11px]">
                                <span className="w-5 text-right opacity-50">{s.seq}</span>
                                <Badge variant="secondary" className={`text-[10px] border ${STATUS_STYLE[s.status] ?? ''}`}>{s.status}</Badge>
                                <span className="flex-1 truncate">{s.title}</span>
                                <span className="text-[10px] opacity-50">
                                  {s.step_kind} · #{s.attempt}
                                  {s.skip_reason ? ` · skip=${s.skip_reason}` : ''}
                                  {s.failure_class ? ` · ${s.failure_class}` : ''}
                                </span>
                                {showEnqueue && (
                                  <button
                                    type="button"
                                    className={ACTION_BUTTON_CLASS}
                                    data-testid={`step-${s.id}-enqueue`}
                                    disabled={!enqueueReady || busyKey === `enqueue:${s.id}`}
                                    title={
                                      !gateOk
                                        ? 'gate 未通过，不能入队'
                                        : !execEnabled || !execAdapter
                                          ? executionStatus?.disabledReason ?? '执行未开启'
                                          : !depsOk
                                            ? '依赖步骤尚未成功，不能入队'
                                            : '只入队这一步（turn 由后台 tick 驱动）'
                                    }
                                    onClick={() =>
                                      void handleAction(`enqueue:${s.id}`, () =>
                                        enqueueStep({ graphId, workItemId: t.id, stepId: s.id }),
                                      )
                                    }
                                  >
                                    {busyKey === `enqueue:${s.id}` ? '入队中…' : '入队这一步'}
                                  </button>
                                )}
                              </div>
                              {stepActionError && (
                                <div className="ml-7 text-[10px] text-red-600" data-testid={`step-${s.id}-action-error`}>
                                  {stepActionError}
                                </div>
                              )}
                              {acceptance && (
                                <div
                                  className="ml-7 mt-1 space-y-1 rounded border border-purple-500/30 bg-purple-500/5 p-1.5"
                                  data-testid={`acceptance-pending-${s.id}`}
                                >
                                  <div className="text-[10px] opacity-60">待人工确认（确认后自动重算验收）</div>
                                  {acceptance.map((entry) => {
                                    const key = `${s.id}:${entry.id}`
                                    return (
                                      <div key={entry.id} className="flex items-center gap-2 text-[11px]">
                                        <span className="flex-1">
                                          {entry.expected}
                                          {entry.text ? <span className="opacity-60"> · {entry.text}</span> : null}
                                        </span>
                                        <button
                                          type="button"
                                          className={`${ACTION_BUTTON_CLASS} border-purple-500/40`}
                                          disabled={confirmingKey === key}
                                          onClick={() => void handleConfirm(t.id, s.id, entry.id)}
                                        >
                                          {confirmingKey === key ? '确认中…' : '确认'}
                                        </button>
                                      </div>
                                    )
                                  })}
                                  {confirmError && <div className="text-[10px] text-red-600">{confirmError}</div>}
                                </div>
                              )}
                              {unknownInput && (
                                <div
                                  className="ml-7 mt-1 rounded border border-amber-500/30 bg-amber-500/5 p-1.5 text-[10px] text-amber-700"
                                  data-testid={`step-${s.id}-needs-input-unknown`}
                                >
                                  <div>
                                    无法识别的待处理输入（kind=
                                    {parseInputKind(s.input_request_json) ?? 'unknown'}），请在主进程处理。
                                  </div>
                                  {s.input_request_json && (
                                    <details className="mt-1">
                                      <summary className="cursor-pointer opacity-70">原始请求 JSON</summary>
                                      <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all opacity-70">
                                        {s.input_request_json}
                                      </pre>
                                    </details>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>

                      <div className="mt-1 pl-2" data-testid={`task-${t.id}-runs`}>
                        <div className="text-[10px] opacity-50">最近运行</div>
                        {!detail && <div className="text-[11px] opacity-50">读取中…</div>}
                        {detail && recentRuns.length === 0 && <div className="text-[11px] opacity-50">无（尚无运行记录）</div>}
                        {recentRuns.map((r) => {
                          const runActionError = actionErrors[r.id]
                          return (
                            <div key={r.id} data-testid={`run-${r.id}`}>
                              <div className="flex items-center gap-2 text-[11px]">
                                <Badge variant="secondary" className={`text-[10px] border ${STATUS_STYLE[r.status] ?? ''}`}>{r.status}</Badge>
                                <span className="truncate">step {r.step_id ?? '-'}</span>
                                <span className="flex-1" />
                                <span className="text-[10px] opacity-50">
                                  seq #{r.run_seq} · #{r.attempt}
                                  {r.adapter_name ? ` · ${r.adapter_name}` : ''}
                                  {r.failure_class ? ` · ${r.failure_class}` : ''} · {formatTs(r.created_at)}
                                </span>
                                {RUN_ACTIVE.has(r.status) && (
                                  <button
                                    type="button"
                                    className={`${ACTION_BUTTON_CLASS} border-red-500/40`}
                                    data-testid={`run-${r.id}-cancel`}
                                    disabled={busyKey === `run-cancel:${r.id}`}
                                    title="取消该 run（会尝试终止在跑会话）"
                                    onClick={() =>
                                      void handleAction(`run-cancel:${r.id}`, () =>
                                        cancelRun({ graphId, workItemId: t.id, runId: r.id }),
                                      )
                                    }
                                  >
                                    {busyKey === `run-cancel:${r.id}` ? '取消中…' : '取消运行'}
                                  </button>
                                )}
                              </div>
                              {r.result_summary && (
                                <div className="ml-2 text-[10px] opacity-60" data-testid={`run-${r.id}-result`}>
                                  结果：{r.result_summary}
                                </div>
                              )}
                              {r.cancel_reason && (
                                <div className="ml-2 text-[10px] opacity-60" data-testid={`run-${r.id}-cancel-reason`}>
                                  取消归因：{r.cancel_reason}
                                </div>
                              )}
                              {runActionError && (
                                <div className="ml-2 text-[10px] text-red-600" data-testid={`run-${r.id}-action-error`}>
                                  {runActionError}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
            {tasks.length === 0 && <div className="px-2 text-[11px] opacity-50">无（该节点未被任何 work item 锚定）</div>}
          </div>
        </section>

        {/* G1-14 线上提案：只读列表 + 按需 diff；采纳/驳回只收口提案状态，
            不会自动改 online 图（人工先在图里改，再回来采纳）。 */}
        <section data-testid="node-map-proposals">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">线上提案</div>
          <div className="space-y-1">
            {proposalErrors['__list__'] && (
              <div className="px-2 text-[11px] text-red-600" data-testid="proposal-list-error">
                {proposalErrors['__list__']}
              </div>
            )}
            {proposals.map((p) => {
              const open = p.status === 'awaiting_confirm' || p.status === 'queued'
              const diff = proposalDiffs[p.id]
              const error = proposalErrors[p.id]
              const rejectDraft = rejectDrafts[p.id] ?? ''
              return (
                <div key={p.id} className="rounded px-2 py-1" data-testid={`proposal-${p.id}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="secondary" className={`text-[10px] border ${STATUS_STYLE[p.status] ?? ''}`}>
                      {p.status}
                    </Badge>
                    <span className="truncate">{p.title}</span>
                    {p.stale === 1 && (
                      <Badge variant="secondary" className="text-[10px] border bg-yellow-500/10 text-yellow-700 border-yellow-500/30">
                        stale
                      </Badge>
                    )}
                    {p.weight !== null && (
                      <Badge variant="secondary" className="text-[10px] border bg-gray-500/10 text-gray-600 border-gray-500/30">
                        w={p.weight.toFixed(2)}
                      </Badge>
                    )}
                    {p.truncated === 1 && <span className="text-[10px] text-amber-700">已截断</span>}
                    <span className="flex-1" />
                    <span className="text-[10px] opacity-50">
                      {p.created_by ?? '-'} · {p.created_at}
                      {p.conflict_group ? ` · ${p.conflict_group}` : ''}
                    </span>
                  </div>
                  {p.status === 'blocked' && (
                    <div className="mt-1 text-[10px] text-amber-700" data-testid={`proposal-${p.id}-blocked`}>
                      等待前序提案结束（conflict_group 串行；超 24h 自动取消）
                    </div>
                  )}
                  {p.reject_reason && (
                    <div className="mt-1 text-[10px] opacity-60" data-testid={`proposal-${p.id}-reject-reason`}>
                      驳回理由：{p.reject_reason}
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      className={ACTION_BUTTON_CLASS}
                      data-testid={`proposal-${p.id}-diff`}
                      onClick={() => {
                        const next = openDiffId === p.id ? null : p.id
                        setOpenDiffId(next)
                        if (next && !proposalDiffs[p.id]) void fetchProposalDiff(p.id)
                      }}
                    >
                      {openDiffId === p.id ? '收起 diff' : '查看 diff'}
                    </button>
                    {open && (
                      <>
                        <button
                          type="button"
                          className={`${ACTION_BUTTON_CLASS} border-green-500/40`}
                          data-testid={`proposal-${p.id}-accept`}
                          disabled={busyKey === `proposal-accept:${p.id}`}
                          title="仅收口提案状态；需先在 online 图完成编辑"
                          onClick={() => {
                            if (!graphId || !nodeEntityKey) return
                            void handleAction(`proposal-accept:${p.id}`, () =>
                              acceptProposal({ graphId, nodeEntityKey, id: p.id }),
                            )
                          }}
                        >
                          {busyKey === `proposal-accept:${p.id}` ? '采纳中…' : '采纳'}
                        </button>
                        <input
                          className="w-32 rounded border border-gray-300 bg-transparent px-1 py-0.5 text-[10px] dark:border-gray-600"
                          placeholder="驳回理由（必填）"
                          data-testid={`proposal-${p.id}-reject-input`}
                          value={rejectDraft}
                          onChange={(e) => setRejectDrafts({ ...rejectDrafts, [p.id]: e.target.value })}
                        />
                        <button
                          type="button"
                          className={`${ACTION_BUTTON_CLASS} border-red-500/40`}
                          data-testid={`proposal-${p.id}-reject`}
                          disabled={busyKey === `proposal-reject:${p.id}` || rejectDraft.trim() === ''}
                          onClick={() => {
                            if (!graphId || !nodeEntityKey) return
                            void handleAction(`proposal-reject:${p.id}`, async () => {
                              await rejectProposal({ graphId, nodeEntityKey, id: p.id, reason: rejectDraft })
                              setRejectDrafts({ ...rejectDrafts, [p.id]: '' })
                            })
                          }}
                        >
                          {busyKey === `proposal-reject:${p.id}` ? '驳回中…' : '驳回'}
                        </button>
                      </>
                    )}
                  </div>
                  {error && <div className="mt-1 text-[10px] text-red-600" data-testid={`proposal-${p.id}-error`}>{error}</div>}
                  {openDiffId === p.id && diff && (
                    <div className="mt-1 space-y-1 rounded border border-gray-200 p-1.5 text-[10px] dark:border-gray-700" data-testid={`proposal-${p.id}-diff-body`}>
                      {diff.reason && <div className="opacity-70">理由：{diff.reason}</div>}
                      {diff.evidenceRefs.length > 0 && <div className="opacity-60">证据：{diff.evidenceRefs.join('、')}</div>}
                      {diff.stale && <div className="text-amber-700">已过期：online 节点在提案后又被修改</div>}
                      {diff.truncated && <div className="text-amber-700">内容超过 200KB，已截断显示</div>}
                      <div>
                        <div className="opacity-50">before</div>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all opacity-80">{diff.beforeText}</pre>
                      </div>
                      <div>
                        <div className="opacity-50">after</div>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all opacity-80">{diff.afterText}</pre>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {proposals.length === 0 && !proposalErrors['__list__'] && (
              <div className="px-2 text-[11px] opacity-50">无（该节点没有待处理提案）</div>
            )}
          </div>
        </section>

        {/* 会话时间线（threadIds 全集,§9.5-3；只读展示,不提供切换操作） */}
        <section data-testid="node-map-timeline">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">会话时间线</div>
          <div className="space-y-1">
            {timeline.map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-2 text-xs" data-testid={`timeline-${t.id}`}>
                <span className="truncate">{t.thread_title ?? t.thread_id}</span>
                <Badge variant="secondary" className="text-[10px]">{t.link_role}</Badge>
                <span className="flex-1" />
                <span className="text-[10px] opacity-50">{t.ended_at ? '已结束' : '活跃'} · {t.thread_adapter ?? '-'}</span>
              </div>
            ))}
            {timeline.length === 0 && <div className="px-2 text-[11px] opacity-50">无（该节点没有关联会话）</div>}
          </div>
        </section>

        {/* 证据列表：级别 + 新鲜度 */}
        <section data-testid="node-map-evidence">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">证据</div>
          <div className="space-y-1">
            {evidence.map((e) => (
              <div key={e.id} className="flex items-center gap-2 px-2 text-xs" data-testid={`evidence-${e.id}`}>
                <Badge variant="secondary" className="text-[10px]">{e.evidence_level}</Badge>
                <span className="truncate">{e.summary ?? e.evidence_type}</span>
                <span className="flex-1" />
                <span className="text-[10px] opacity-50">
                  {e.freshness} · {e.produced_by}{e.revoked_at ? ' · 已撤销' : ''}
                </span>
              </div>
            ))}
            {evidence.length === 0 && <div className="px-2 text-[11px] opacity-50">无（该节点没有证据）</div>}
          </div>
        </section>
      </div>
    </div>
  )
}
