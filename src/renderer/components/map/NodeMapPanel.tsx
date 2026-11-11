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
import { useAgentStore } from '../../store/agentStore'
import { useAppStore } from '../../store/appStore'
import { useGraphStore } from '../../store/graphStore'
import { useThreadStore } from '../../store/threadStore'
import { STATUS_STYLE, TaskCardTree } from './TaskCardTree'
import { StepConfirmationPanel, hasPendingConfirmation } from './StepConfirmationPanel'
import { PlanDraftPanel } from './PlanDraftPanel'
import { PlanDraftComposer } from './PlanDraftComposer'
import { WorkItemRevisionPanel } from './WorkItemRevisionPanel'
import type { PlanItemInput } from '../../store/mapStore'

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

const ACTION_BUTTON_CLASS =
  'rounded border px-1.5 py-0.5 text-[10px] hover:bg-gray-500/10 disabled:cursor-not-allowed disabled:opacity-40'

interface Props {
  graphId: string | null
  nodeEntityKey: string | null
  nodeId: string | null
  /** 连边按项目隔离（node_links.project_path）；缺项目时连边区只显示「未定位项目」。 */
  projectPath?: string | null
}

export function NodeMapPanel({ graphId, nodeEntityKey, nodeId, projectPath = null }: Props) {
  const overlay = useMapStore(useShallow((s) => (graphId ? s.overlayByGraph.get(graphId) : undefined)))
  const timeline = useMapStore((s) => s.nodeTimeline)
  // 时间线切换（G8-2/§9.5-3）：面板展示 threadIds 全集，点一条即把该会话切为当前会话。
  const currentThreadId = useThreadStore((s) => s.currentThreadId)
  const selectThread = useAgentStore((s) => s.selectThread)
  const loadMessages = useAgentStore((s) => s.loadMessages)
  const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)
  const evidence = useMapStore((s) => s.nodeEvidence)
  // §3.4 证据建议（待裁决）与 §8.4 人工连边：写入口在面板内，不留「通道有、界面无」。
  const suggestions = useMapStore((s) => s.nodeSuggestions)
  const nodeLinks = useMapStore((s) => s.nodeLinks)
  const fetchEvidenceSuggestions = useMapStore((s) => s.fetchEvidenceSuggestions)
  const acceptEvidenceSuggestion = useMapStore((s) => s.acceptEvidenceSuggestion)
  const dismissEvidenceSuggestion = useMapStore((s) => s.dismissEvidenceSuggestion)
  const createHumanJudgment = useMapStore((s) => s.createHumanJudgment)
  const fetchNodeLinks = useMapStore((s) => s.fetchNodeLinks)
  const deleteNodeLink = useMapStore((s) => s.deleteNodeLink)
  const createNodeLink = useMapStore((s) => s.createNodeLink)
  // 新建连边的候选集合来自当前图节点（带 entity_key 的才可作为端点）。
  const graphNodes = useGraphStore((s) => s.nodes)
  const details = useMapStore((s) => s.workItemDetails)
  // G8-3：步级确认视图（后端派生，renderer 只展示）
  const confirmationsByItem = useMapStore((s) => s.confirmationsByItem)
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
  const decideStepConfirmation = useMapStore((s) => s.decideStepConfirmation)
  const planDraftsByGraph = useMapStore((s) => s.planDraftsByGraph)
  const fetchPlanDrafts = useMapStore((s) => s.fetchPlanDrafts)
  const submitPlanDraft = useMapStore((s) => s.submitPlanDraft)
  const confirmPlanDraft = useMapStore((s) => s.confirmPlanDraft)
  const rejectPlanDraft = useMapStore((s) => s.rejectPlanDraft)
  // S7 起草入口（v3.22）：C1 的唯一数据源——手工多子任务计划 → plan_drafts。
  const createPlanDraft = useMapStore((s) => s.createPlanDraft)
  const revisePlanDraft = useMapStore((s) => s.revisePlanDraft)
  const getPlanDraftItems = useMapStore((s) => s.getPlanDraftItems)
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
  /**
   * G8-5：任务/步/run 的展开集合（key 前缀 `task:` / `step:` / `run:`）。
   * 只存内存、不落库；重新挂载即恢复默认（折叠到任务级）。
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  // I.8.F P2：C2 修订面板同时只展开一个任务，避免多份 diff 请求打满界面。
  const [revisionOpenId, setRevisionOpenId] = useState<string | null>(null)
  // G3-10：E1 人工判断的输入草稿（只存内存；写入成功才清空）。
  const [e1Summary, setE1Summary] = useState('')
  // §8.4：新建连边的目标节点（entity_key；空串=未选）。
  const [linkTarget, setLinkTarget] = useState('')
  /**
   * S7 起草编辑器状态：null=收起；create=新建草稿；revise=修改既有草稿
   * （items 为 plan:draft:get 读到的原文，供编辑器预填）。
   */
  const [composer, setComposer] = useState<
    { mode: 'create' } | { mode: 'revise'; id: string; revision: number; items: PlanItemInput[] } | null
  >(null)

  /**
   * 打开修订编辑器：先读条目原文（plan:draft:get 只读），读不到就不打开——
   * 没有原文的修订等于让用户凭空重写，那不是「修订」。
   */
  async function openReviseComposer(id: string, revision: number): Promise<void> {
    await handleAction(`plan-draft-items:${id}`, async () => {
      const items = await getPlanDraftItems(id)
      if (items) setComposer({ mode: 'revise', id, revision, items })
    })
  }

  /** 起草/修订提交：store 负责调 IPC 与重拉列表；成功才收起编辑器。 */
  async function submitComposer(items: PlanItemInput[]): Promise<void> {
    if (!graphId) return
    if (composer?.mode === 'revise') {
      const id = composer.id
      await handleAction(`plan-draft:${id}`, async () => {
        const ok = await revisePlanDraft({ graphId, id, items })
        if (ok) setComposer(null)
      })
      return
    }
    await handleAction(`plan-draft-compose:${graphId}`, async () => {
      const ok = await createPlanDraft({
        graphId,
        projectPath,
        anchorEntityKey: nodeEntityKey,
        anchorNodeId: nodeId,
        items,
      })
      if (ok) setComposer(null)
    })
  }

  function toggleExpanded(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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

  /**
   * G8-2 时间线切换：把时间线上的一条会话切为当前会话。
   *
   * 顺序固定为「先载入消息 → 再切指针 → 最后把右侧面板切到 agent」，与
   * `HistorySidebar` 的切换路径一致；反过来会出现「指针已切、消息还是上一条」
   * 的中间态。已结束会话同样允许切过去（只读历史），不在此处拦截。
   */
  async function switchTimelineThread(threadId: string): Promise<void> {
    if (!threadId || threadId === currentThreadId) return
    await handleAction(`timeline:${threadId}`, async () => {
      await loadMessages(threadId)
      selectThread(threadId)
      setActiveRightPanel('agent')
    })
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
    void fetchEvidenceSuggestions(graphId, nodeEntityKey)
  }, [graphId, nodeEntityKey, fetchNodeData, fetchEvidenceSuggestions])

  // 连边只在拿到项目路径时拉：node_links 按 project_path 隔离，没有项目就无从定位。
  useEffect(() => {
    if (!projectPath || !nodeEntityKey) return
    void fetchNodeLinks(projectPath, nodeEntityKey)
  }, [projectPath, nodeEntityKey, fetchNodeLinks])

  useEffect(() => {
    if (!graphId || !nodeEntityKey) return
    void fetchProposals(graphId, nodeEntityKey)
  }, [graphId, nodeEntityKey, fetchProposals])

  // C1：当前图未确认的计划草稿（含服务端预检投影）；读失败由 store 记在 actionErrors。
  useEffect(() => {
    if (!graphId) return
    void fetchPlanDrafts(graphId)
  }, [graphId, fetchPlanDrafts])

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
        {executionStatus !== null && execEnabled && execAdapter &&
          `执行已开启 · adapter=${execAdapter}${executionStatus.tier ? `（Tier ${executionStatus.tier}）` : ''}`}
        {executionStatus !== null && (!execEnabled || !execAdapter) &&
          `执行未开启：${executionStatus.disabledReason ?? '未配置执行器'}（入队后不会自动运行）`}
      </div>

      {nodeError && (
        <div className="mt-2 rounded border border-red-500/30 bg-red-500/5 px-2 py-1 text-[11px] text-red-600" data-testid="map-node-error">
          读取失败：{nodeError}
        </div>
      )}

      <div className="mt-2 space-y-3 border-t border-gray-200 pt-2 dark:border-gray-700">
        {/* I.8.F P1 + S7 起草入口（v3.22）：C1 计划草稿区常显（未确认的才列出）。
            展示项全部来自服务端投影；「起草计划」是 C1 的唯一数据来源
            （agent 路径不写 plan_drafts），没有它面板永远恒空。 */}
        <section data-testid="node-map-plan-drafts">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide opacity-50">计划草稿</span>
            <button
              type="button"
              className={`${ACTION_BUTTON_CLASS} border-blue-500/40 text-blue-700`}
              data-testid="plan-draft-compose-open"
              disabled={composer !== null}
              title="手工起草多子任务计划（落 plan_drafts，C1 确认后生成任务）"
              onClick={() => setComposer({ mode: 'create' })}
            >
              起草计划
            </button>
          </div>
          {composer && (
            <PlanDraftComposer
              mode={composer.mode}
              reviseOf={composer.mode === 'revise' ? { id: composer.id, revision: composer.revision } : null}
              initialItems={composer.mode === 'revise' ? composer.items : undefined}
              busy={
                composer.mode === 'revise'
                  ? busyKey === `plan-draft:${composer.id}`
                  : busyKey === `plan-draft-compose:${graphId}`
              }
              error={
                composer.mode === 'revise'
                  ? actionErrors[`plan-draft:${composer.id}`]
                  : actionErrors[`plan-draft-compose:${graphId}`]
              }
              onSubmit={(items) => { void submitComposer(items) }}
              onCancel={() => setComposer(null)}
            />
          )}
          <div className="max-h-[40vh] space-y-2 overflow-y-auto">
            {(planDraftsByGraph[graphId] ?? []).map((view) => (
              <PlanDraftPanel
                key={view.draft.id}
                view={view}
                error={actionErrors[`plan-draft:${view.draft.id}`]}
                busy={busyKey === `plan-draft:${view.draft.id}`}
                onDecide={(decision) => {
                  if (decision === 'revise') {
                    void openReviseComposer(view.draft.id, view.draft.revision)
                    return
                  }
                  void handleAction(`plan-draft:${view.draft.id}`, () => {
                    if (decision === 'submit') return submitPlanDraft({ graphId, id: view.draft.id })
                    if (decision === 'approve') {
                      return confirmPlanDraft({ graphId, id: view.draft.id, display: view.display })
                    }
                    return rejectPlanDraft({ graphId, id: view.draft.id })
                  })
                }}
              />
            ))}
            {(planDraftsByGraph[graphId] ?? []).length === 0 && (
              <div className="px-2 text-[11px] opacity-50">无（该图没有未确认的计划草稿，点「起草计划」新建）</div>
            )}
          </div>
          {actionErrors[`plan-drafts:${graphId}`] && (
            <p className="mt-1 text-[10px] text-red-600" data-testid="plan-drafts-error">
              读取计划草稿失败：{actionErrors[`plan-drafts:${graphId}`]}
            </p>
          )}
        </section>

        {/* 锚定该节点的 work item（含执行入口 / steps / 最近 runs） */}
        <section data-testid="node-map-tasks">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">任务</div>
          {/* G8-5：任务多时在容器内滚动（默认折叠到任务级，100 条任务也只渲染卡片头）。 */}
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {tasks.map((t) => {
              const detail = details[t.id]
              const loadError = workItemErrors[t.id]
              const taskActionError = actionErrors[t.id]
              const runs = detail?.runs ?? []
              const steps = detail?.steps ?? []
              // G8-5：证据只按归属任务预过滤；run 归属由 TaskCardTree 按 work_run_id 分组。
              const taskEvidence = evidence.filter((e) => e.work_item_id === t.id)
              // G8-3：按 stepId 索引确认视图；低风险步不渲染面板。
              const taskConfirmations = confirmationsByItem[t.id] ?? []
              const confirmationByStep = new Map(taskConfirmations.map((view) => [view.stepId, view]))
              const taskOpen = expanded.has(`task:${t.id}`)
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
                    {hasPendingConfirmation(taskConfirmations) && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] border bg-amber-500/10 text-amber-700 border-amber-500/30"
                        data-testid={`task-${t.id}-confirmation-pending`}
                      >
                        待确认
                      </Badge>
                    )}
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
                    {/* I.8.F P2：C2 修订入口（写路径仍是 workitem:revise） */}
                    <button
                      type="button"
                      className={`${ACTION_BUTTON_CLASS} border-purple-500/40`}
                      data-testid={`task-${t.id}-revise`}
                      onClick={() => setRevisionOpenId((prev) => (prev === t.id ? null : t.id))}
                    >
                      {revisionOpenId === t.id ? '收起修订' : '修订（C2）'}
                    </button>
                  </div>

                  {taskActionError && (
                    <div className="mt-1 pl-2 text-[10px] text-red-600" data-testid={`task-${t.id}-action-error`}>
                      {taskActionError}
                    </div>
                  )}

                  {revisionOpenId === t.id && (
                    <WorkItemRevisionPanel
                      graphId={graphId}
                      item={t}
                      error={actionErrors[`revision:${t.id}`]}
                      onClose={() => setRevisionOpenId(null)}
                    />
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
                      {!detail && (
                        <div className="mt-1 pl-2 text-[11px] opacity-50" data-testid={`task-${t.id}-steps`}>
                          读取中…
                        </div>
                      )}
                      {detail && (
                        <>
                          <div className="mt-1 pl-2">
                            <button
                              type="button"
                              className={ACTION_BUTTON_CLASS}
                              data-testid={`task-${t.id}-toggle`}
                              aria-expanded={taskOpen}
                              onClick={() => toggleExpanded(`task:${t.id}`)}
                            >
                              {taskOpen
                                ? '收起层级'
                                : `展开层级（步骤 ${steps.length} · 运行 ${runs.length} · 证据 ${taskEvidence.length}）`}
                            </button>
                          </div>
                          {taskOpen && (
                            <TaskCardTree
                              steps={steps}
                              runs={runs}
                              evidence={taskEvidence}
                              expanded={expanded}
                              onToggle={toggleExpanded}
                              renderStepActions={(s) => {
                                const itemRunnable = t.status === 'queued' || t.status === 'running'
                                const showEnqueue = s.step_kind === 'agent' && s.status === 'pending' && itemRunnable
                                if (!showEnqueue) return null
                                const depsOk = depsSatisfied(s, steps)
                                const enqueueReady = gateOk && execEnabled && !!execAdapter && depsOk
                                return (
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
                                )
                              }}
                              renderStepBody={(s) => {
                                const acceptance = s.status === 'needs_input' ? parseAcceptanceRequest(s.input_request_json) : null
                                const unknownInput = s.status === 'needs_input' && !acceptance
                                const stepActionError = actionErrors[s.id]
                                const confirmation = confirmationByStep.get(s.id)
                                return (
                                  <>
                                    {confirmation && (
                                      <div className="ml-7">
                                        <StepConfirmationPanel
                                          view={confirmation}
                                          error={actionErrors[confirmation.stepId]}
                                          busy={busyKey === `confirmation:${s.id}`}
                                          onDecide={(input) =>
                                            void handleAction(`confirmation:${s.id}`, () =>
                                              decideStepConfirmation({ stepId: s.id, ...input }),
                                            )
                                          }
                                        />
                                      </div>
                                    )}
                                    {stepActionError && !confirmation && (
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
                                  </>
                                )
                              }}
                              renderRunActions={(r) =>
                                RUN_ACTIVE.has(r.status) ? (
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
                                ) : null
                              }
                              renderRunBody={(r) => {
                                const runActionError = actionErrors[r.id]
                                return (
                                  <>
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
                                  </>
                                )
                              }}
                            />
                          )}
                        </>
                      )}

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

        {/* 会话时间线（threadIds 全集,§9.5-3）：展示全集并可切换当前会话（G8-2） */}
        <section data-testid="node-map-timeline">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">会话时间线</div>
          <div className="space-y-1">
            {timeline.map((t) => {
              const isCurrent = t.thread_id === currentThreadId
              const busy = busyKey === `timeline:${t.thread_id}`
              return (
                <div
                  key={t.id}
                  className={`flex items-center gap-2 rounded px-2 text-xs ${isCurrent ? 'bg-muted/60' : ''}`}
                  data-testid={`timeline-${t.id}`}
                >
                  <span className="truncate">{t.thread_title ?? t.thread_id}</span>
                  <Badge variant="secondary" className="text-[10px]">{t.link_role}</Badge>
                  <span className="flex-1" />
                  <span
                    className="text-[10px] opacity-50"
                    title={t.ended_at ? '该会话已结束，切换后只能查看历史' : '该会话仍活跃'}
                  >
                    {t.ended_at ? '已结束' : '活跃'} · {t.thread_adapter ?? '-'}
                  </span>
                  <button
                    type="button"
                    onClick={() => { void switchTimelineThread(t.thread_id) }}
                    disabled={isCurrent || busy}
                    className={`${ACTION_BUTTON_CLASS} shrink-0`}
                    data-testid={`timeline-select-${t.id}`}
                    title={isCurrent ? '当前会话' : '切换为该会话'}
                  >
                    {isCurrent ? '当前' : busy ? '切换中' : '切换'}
                  </button>
                </div>
              )
            })}
            {timeline.length === 0 && <div className="px-2 text-[11px] opacity-50">无（该节点没有关联会话）</div>}
          </div>
        </section>

        {/* §3.4 证据建议：agent 提建议 → 人工接受/驳回。接受在同一事务内转写
            node_evidence；驳回只改状态。入口在此，避免「通道有、界面无」。 */}
        <section data-testid="node-map-suggestions">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">
            证据建议（待裁决）
          </div>
          <div className="space-y-1">
            {actionErrors.suggestions && (
              <div className="px-2 text-[11px] text-red-600" data-testid="suggestions-error">
                {actionErrors.suggestions}
              </div>
            )}
            {suggestions.map((s) => {
              const busy = busyKey === `suggestion:${s.id}`
              return (
                <div key={s.id} className="rounded px-2 py-1" data-testid={`suggestion-${s.id}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="secondary" className="text-[10px]">{s.suggested_level}</Badge>
                    <span className="text-[10px] opacity-60">{s.evidence_type}</span>
                    <span className="flex-1 truncate" title={s.rationale}>{s.rationale}</span>
                    <span className="text-[10px] opacity-50">conf={s.confidence.toFixed(2)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <button
                      type="button"
                      className={`${ACTION_BUTTON_CLASS} border-green-500/40`}
                      data-testid={`suggestion-${s.id}-accept`}
                      disabled={busy}
                      title="接受后写入一条证据（同事务，幂等键=建议 id）"
                      onClick={() => {
                        if (!graphId || !nodeEntityKey) return
                        void handleAction(`suggestion:${s.id}`, () =>
                          acceptEvidenceSuggestion({ graphId, nodeEntityKey, id: s.id }),
                        )
                      }}
                    >
                      {busy ? '处理中…' : '接受'}
                    </button>
                    <button
                      type="button"
                      className={`${ACTION_BUTTON_CLASS} border-red-500/40`}
                      data-testid={`suggestion-${s.id}-dismiss`}
                      disabled={busy}
                      title="驳回只改建议状态，不写证据"
                      onClick={() => {
                        if (!graphId || !nodeEntityKey) return
                        void handleAction(`suggestion:${s.id}`, () =>
                          dismissEvidenceSuggestion({ graphId, nodeEntityKey, id: s.id }),
                        )
                      }}
                    >
                      驳回
                    </button>
                  </div>
                  {actionErrors[`suggestion:${s.id}`] && (
                    <div className="mt-1 text-[10px] text-red-600" data-testid={`suggestion-${s.id}-error`}>
                      {actionErrors[`suggestion:${s.id}`]}
                    </div>
                  )}
                </div>
              )
            })}
            {suggestions.length === 0 && !actionErrors.suggestions && (
              <div className="px-2 text-[11px] opacity-50">无（该节点没有待裁决建议）</div>
            )}

            {/* G3-10：E1 人工判断直写。等级/写入方由主进程固定，界面不让用户选。 */}
            <div
              className="mt-1 flex items-center gap-1.5 rounded border border-purple-500/30 bg-purple-500/5 px-2 py-1"
              data-testid="e1-create"
            >
              <input
                className="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-1 py-0.5 text-[11px] dark:border-gray-600"
                placeholder="人工判断（E1）：写下你确认的事实"
                data-testid="e1-summary"
                value={e1Summary}
                onChange={(e) => setE1Summary(e.target.value)}
              />
              <button
                type="button"
                className={`${ACTION_BUTTON_CLASS} border-purple-500/40`}
                data-testid="e1-submit"
                disabled={e1Summary.trim() === '' || busyKey === 'e1'}
                title="写入一条 E1 人工证据（ref 指向当前节点）"
                onClick={() => {
                  if (!graphId || !nodeEntityKey) return
                  void handleAction('e1', async () => {
                    const ok = await createHumanJudgment({
                      graphId,
                      nodeEntityKey,
                      nodeId,
                      projectPath,
                      summary: e1Summary,
                      ref: { kind: 'node', graphId, nodeEntityKey },
                    })
                    if (ok) setE1Summary('')
                  })
                }}
              >
                {busyKey === 'e1' ? '写入中…' : '写入判断（E1）'}
              </button>
            </div>
            {actionErrors.e1 && (
              <div className="px-2 text-[10px] text-red-600" data-testid="e1-error">
                {actionErrors.e1}
              </div>
            )}
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

        {/* §8.4 人工连边：列表 + 撤销。只对 origin='human' 给删除入口——派生/导入
            链接由系统路径回填，删了会被重建，主进程也会显式拒绝。 */}
        <section data-testid="node-map-links">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">关联连边</div>
          <div className="space-y-1">
            {!projectPath && (
              <div className="px-2 text-[11px] opacity-50" data-testid="links-no-project">
                未定位项目（连边按项目隔离，需要项目路径才能列出）
              </div>
            )}
            {actionErrors.links && (
              <div className="px-2 text-[11px] text-red-600" data-testid="links-error">
                {actionErrors.links}
              </div>
            )}
            {/* 新建人工连边：L1 只开 relates_to（链类型由主进程固定），端点限定同图。 */}
            {projectPath && (
              <div className="flex items-center gap-1.5 px-2">
                <select
                  className="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-1 py-0.5 text-[10px] dark:border-gray-600"
                  data-testid="link-target"
                  value={linkTarget}
                  onChange={(e) => setLinkTarget(e.target.value)}
                >
                  <option value="">选择同图节点…</option>
                  {graphNodes
                    .filter((n) => n.graphId === graphId && !!n.entityKey && n.entityKey !== nodeEntityKey)
                    .map((n) => (
                      <option key={n.id} value={n.entityKey}>
                        {n.title}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className={`${ACTION_BUTTON_CLASS} shrink-0 border-blue-500/40`}
                  data-testid="link-create"
                  disabled={linkTarget === '' || busyKey === `link-create:${linkTarget}`}
                  title="建立 relates_to 关联（origin=human，可撤销）"
                  onClick={() => {
                    void handleAction(`link-create:${linkTarget}`, async () => {
                      await createNodeLink({
                        graphId,
                        projectPath,
                        entityKey: nodeEntityKey,
                        fromEntityKey: nodeEntityKey,
                        toEntityKey: linkTarget,
                      })
                      setLinkTarget('')
                    })
                  }}
                >
                  {busyKey === `link-create:${linkTarget}` ? '建立中…' : '建立关联'}
                </button>
              </div>
            )}
            {projectPath && nodeLinks.map((l) => {
              const outgoing = l.from_entity_key === nodeEntityKey
              const other = outgoing ? l.to_entity_key : l.from_entity_key
              const busy = busyKey === `link-delete:${l.id}`
              return (
                <div key={l.id} className="flex items-center gap-2 px-2 text-xs" data-testid={`link-${l.id}`}>
                  <Badge variant="secondary" className="text-[10px]">{l.link_type}</Badge>
                  <span className="text-[10px] opacity-50">{outgoing ? '→' : '←'}</span>
                  <span className="truncate">{other}</span>
                  <Badge variant="secondary" className="text-[10px] border bg-gray-500/10 text-gray-600 border-gray-500/30">
                    {l.origin}
                  </Badge>
                  <span className="flex-1" />
                  {l.origin === 'human' && (
                    <button
                      type="button"
                      className={`${ACTION_BUTTON_CLASS} border-red-500/40`}
                      data-testid={`link-${l.id}-delete`}
                      disabled={busy}
                      title="撤销这条人工连边（硬删；派生/导入链接不可删）"
                      onClick={() => {
                        if (!projectPath || !nodeEntityKey) return
                        void handleAction(`link-delete:${l.id}`, () =>
                          deleteNodeLink({ id: l.id, projectPath, entityKey: nodeEntityKey }),
                        )
                      }}
                    >
                      {busy ? '删除中…' : '删除'}
                    </button>
                  )}
                </div>
              )
            })}
            {projectPath && nodeLinks.length === 0 && !actionErrors.links && (
              <div className="px-2 text-[11px] opacity-50">无（该节点没有关联连边）</div>
            )}
            {projectPath && nodeLinks.some((l) => actionErrors[`link:${l.id}`]) && (
              <div className="px-2 text-[10px] text-red-600" data-testid="link-delete-error">
                {nodeLinks.map((l) => actionErrors[`link:${l.id}`]).filter(Boolean).join('；')}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
