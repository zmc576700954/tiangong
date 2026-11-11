// @vitest-environment jsdom
/**
 * NodeMapPanel 执行入口（G3-3/G8-6）
 *
 * 覆盖：
 *  - gate 未通过：执行按钮禁用并列出缺项（不伪造 gate pass）
 *  - 执行开关关闭：入口禁用并说明原因
 *  - 有活跃 run：只给 run 级取消，任务级取消隐藏并提示
 *  - 未知 needs_input kind：兜底展示原始 JSON
 *  - 读取失败：显示错误与重试，不伪装成「无步骤」
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { NodeMapPanel } from '../NodeMapPanel'
import { useMapStore } from '../../../store/mapStore'
import { useAgentStore } from '../../../store/agentStore'
import { useAppStore } from '../../../store/appStore'
import { useGraphStore } from '../../../store/graphStore'
import { useThreadStore } from '../../../store/threadStore'
import type { EvidenceEntry, EvidenceSuggestionEntry, NodeLinkEntry, StepConfirmationView, TimelineEntry, WorkItemDetail, WorkItemDiffView, WorkItemSummary, WorkRunEntry } from '../../../store/mapStore'

function makeItem(overrides: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id: 'wi-1',
    lineage_id: 'lin-1',
    revision: 1,
    anchor_entity_key: 'node-1',
    title: '任务一',
    status: 'draft',
    gate_status: 'incomplete',
    gate_missing_json: '["tests","review"]',
    cancel_reason: null,
    updated_at: '2026-01-01',
    ...overrides,
  }
}

function makeDetail(
  item: WorkItemSummary,
  overrides: Partial<WorkItemDetail> = {},
): WorkItemDetail {
  return {
    item,
    steps: [
      {
        id: 'step-1',
        work_item_id: 'wi-1',
        work_item_revision: 1,
        seq: 1,
        title: '第一步',
        step_kind: 'agent',
        status: 'pending',
        attempt: 0,
        depends_on_step_ids_json: null,
        skip_reason: null,
        failure_class: null,
        input_request_json: null,
        started_at: null,
        ended_at: null,
      },
    ],
    runs: [],
    ...overrides,
  }
}

function setup(opts: {
  items?: WorkItemSummary[]
  details?: Record<string, WorkItemDetail>
  evidence?: EvidenceEntry[]
  confirmationsByItem?: Record<string, StepConfirmationView[]>
  workItemErrors?: Record<string, string>
  executionStatus?: { enabled: boolean; adapterName: string | null; disabledReason: string | null } | null
  actionErrors?: Record<string, string>
  proposals?: Array<Record<string, unknown>>
  proposalDiffs?: Record<string, Record<string, unknown>>
  proposalErrors?: Record<string, string>
  planDraftsByGraph?: Record<string, Array<Record<string, unknown>>>
  timeline?: TimelineEntry[]
  suggestions?: EvidenceSuggestionEntry[]
  links?: NodeLinkEntry[]
} = {}): void {
  const items = opts.items ?? [makeItem()]
  // G8-2 时间线切换：会话侧动作不触碰真实 IPC / 真实会话加载
  useThreadStore.setState({ currentThreadId: null })
  useAgentStore.setState({
    loadMessages: vi.fn(async () => {}),
    selectThread: vi.fn(),
  })
  useAppStore.setState({ setActiveRightPanel: vi.fn() })
  useMapStore.setState({
    overlayByGraph: new Map([['g-1', { executionStates: [], workItems: items }]]),
    nodeTimeline: opts.timeline ?? [],
    nodeEvidence: opts.evidence ?? [],
    nodeSuggestions: opts.suggestions ?? [],
    nodeLinks: opts.links ?? [],
    workItemDetails: opts.details ?? { 'wi-1': makeDetail(items[0]) },
    confirmationsByItem: opts.confirmationsByItem ?? {},
    workItemErrors: opts.workItemErrors ?? {},
    nodeError: null,
    actionErrors: opts.actionErrors ?? {},
    executionStatus:
      opts.executionStatus === undefined
        ? { enabled: true, adapterName: 'claude', disabledReason: null }
        : opts.executionStatus,
    loadingNode: false,
    proposals: (opts.proposals ?? []) as never,
    proposalDiffs: (opts.proposalDiffs ?? {}) as never,
    proposalErrors: opts.proposalErrors ?? {},
    planDraftsByGraph: (opts.planDraftsByGraph ?? {}) as never,
    // 效果与动作在组件测试里不需要真实 IPC
    fetchExecutionStatus: vi.fn(async () => {}),
    fetchOverlay: vi.fn(async () => {}),
    fetchNodeData: vi.fn(async () => {}),
    fetchEvidenceSuggestions: vi.fn(async () => {}),
    acceptEvidenceSuggestion: vi.fn(async () => {}),
    dismissEvidenceSuggestion: vi.fn(async () => {}),
    createHumanJudgment: vi.fn(async () => true),
    fetchNodeLinks: vi.fn(async () => {}),
    deleteNodeLink: vi.fn(async () => {}),
    createNodeLink: vi.fn(async () => {}),
    clearNodeData: vi.fn(),
    fetchProposals: vi.fn(async () => {}),
    fetchProposalDiff: vi.fn(async () => {}),
    acceptProposal: vi.fn(async () => {}),
    rejectProposal: vi.fn(async () => {}),
    fetchWorkItemDetail: vi.fn(async () => {}),
    startWorkItem: vi.fn(async () => {}),
    cancelWorkItem: vi.fn(async () => {}),
    enqueueStep: vi.fn(async () => {}),
    cancelRun: vi.fn(async () => {}),
    confirmAcceptance: vi.fn(async () => {}),
    decideStepConfirmation: vi.fn(async () => {}),
    fetchPlanDrafts: vi.fn(async () => {}),
    submitPlanDraft: vi.fn(async () => {}),
    confirmPlanDraft: vi.fn(async () => {}),
    rejectPlanDraft: vi.fn(async () => {}),
    // S7 起草入口（v3.22）：create / revise / 原文预填
    createPlanDraft: vi.fn(async () => true),
    revisePlanDraft: vi.fn(async () => true),
    getPlanDraftItems: vi.fn(async () => []),
    fetchWorkItemHistory: vi.fn(async () => [
      {
        id: 'wi-1',
        revision: 1,
        is_current: true,
        supersedes_id: null,
        status: 'draft',
        gate_status: 'incomplete',
        title: '任务一',
        created_at: 't',
        updated_at: 't',
      },
    ]),
    fetchWorkItemDiff: vi.fn(async () => makeRevisionDiff()),
    reviseWorkItem: vi.fn(async () => ({ traced: false, sink: null, note: '未留痕' })),
  })
}

/** I.8.F P2：C2 预检投影（服务端真实计算，这里只作为组件输入）。 */
function makeRevisionDiff(): WorkItemDiffView {
  return {
    lineageId: 'lin-1',
    from: { id: 'wi-1', revision: 1 },
    to: { id: null, revision: 2, stored: false },
    fields: [
      { field: 'title', before: '任务一', after: '任务一', changed: false },
      { field: 'scope_files', before: ['a.ts'], after: ['a.ts', 'b.ts'], changed: true },
    ],
    impact: [
      {
        kind: 'writeScope',
        status: 'derived',
        detail: { added: ['b.ts'], removed: [], unchanged: ['a.ts'] },
        missing: ['filesActuallyChanged'],
        note: '文件是否真会被改动需 run 产出 change_set，当前无数据来源',
      },
      { kind: 'acceptance', status: 'derived', detail: { added: [], removed: [], modified: [] }, missing: [], note: '' },
      {
        kind: 'dependency',
        status: 'derived',
        detail: { added: [], removed: [] },
        missing: ['invalidatedRuns', 'staleEvidence'],
        note: '哪些 run 会失效、哪些证据会 stale 无数据来源',
      },
    ],
    gateResult: { status: 'precheck', gateStatus: 'pass', missing: [] },
    reasonTrace: { sink: null, note: '审计表 kind 值域不含 workitem_revise，修订原因未留痕（未做 schema 变更）' },
  }
}

function renderPanel(projectPath: string | null = null): void {
  render(<NodeMapPanel graphId="g-1" nodeEntityKey="node-1" nodeId="n-1" projectPath={projectPath} />)
}

/** G8-5：任务卡默认折叠到任务级，测试按需逐层展开。 */
async function expandTask(taskId = 'wi-1'): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`task-${taskId}-toggle`))
  })
}

async function expandStep(stepId = 'step-1'): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`step-${stepId}-toggle`))
  })
}

describe('NodeMapPanel 执行入口', () => {
  beforeEach(() => {
    useMapStore.setState({ actionErrors: {} })
  })

  it('gate 未通过时禁用执行并列出缺失项', () => {
    setup()
    renderPanel()

    const runButton = screen.getByTestId('task-wi-1-run') as HTMLButtonElement
    expect(runButton.disabled).toBe(true)
    expect(screen.getByTestId('task-wi-1-gate-missing').textContent).toContain('tests')
    expect(screen.getByTestId('task-wi-1-gate-missing').textContent).toContain('review')
  })

  it('执行开关关闭时禁用入口并说明原因', () => {
    setup({
      items: [makeItem({ status: 'awaiting_confirm', gate_status: 'pass', gate_missing_json: null })],
      executionStatus: { enabled: false, adapterName: null, disabledReason: '执行触发未开启（BIZGRAPH_MAP_EXECUTION=1）' },
    })
    renderPanel()

    expect((screen.getByTestId('task-wi-1-run') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('map-exec-status').textContent).toContain('执行触发未开启')
  })

  it('gate 通过且执行开启时可点击执行，并只传 item id', async () => {
    const item = makeItem({ status: 'awaiting_confirm', gate_status: 'pass', gate_missing_json: null })
    setup({ items: [item] })
    renderPanel()

    const runButton = screen.getByTestId('task-wi-1-run') as HTMLButtonElement
    expect(runButton.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(runButton)
    })
    expect(useMapStore.getState().startWorkItem).toHaveBeenCalledWith('wi-1')
  })

  it('item 已入队时可按步骤入队', async () => {
    const item = makeItem({ status: 'queued', gate_status: 'pass', gate_missing_json: null })
    setup({ items: [item] })
    renderPanel()
    await expandTask()

    const enqueueButton = screen.getByTestId('step-step-1-enqueue') as HTMLButtonElement
    expect(enqueueButton.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(enqueueButton)
    })
    expect(useMapStore.getState().enqueueStep).toHaveBeenCalledWith({
      graphId: 'g-1',
      workItemId: 'wi-1',
      stepId: 'step-1',
    })
  })

  it('有活跃 run 时隐藏任务级取消，提示先取消 run', async () => {
    const item = makeItem({ status: 'running', gate_status: 'pass', gate_missing_json: null })
    setup({
      items: [item],
      details: {
        'wi-1': makeDetail(item, {
          runs: [
            {
              id: 'run-1',
              work_item_id: 'wi-1',
              work_item_lineage_id: 'lin-1',
              work_item_revision: 1,
              step_id: 'step-1',
              run_seq: 1,
              attempt: 1,
              executor_kind: 'agent',
              status: 'running',
              failure_class: null,
              created_at: 1,
              started_at: 1,
              ended_at: null,
            },
          ],
        }),
      },
    })
    renderPanel()
    await expandTask()
    await expandStep()

    expect(screen.queryByTestId('task-wi-1-cancel')).toBeNull()
    expect(screen.getByTestId('task-wi-1-active-run-hint').textContent).toContain('先取消运行中的 run')
    expect(screen.getByTestId('run-run-1-cancel')).toBeTruthy()
  })

  it('展示 run 结果摘要、取消归因与执行器', async () => {
    const item = makeItem({ status: 'done', gate_status: 'pass', gate_missing_json: null })
    setup({
      items: [item],
      details: {
        'wi-1': makeDetail(item, {
          runs: [
            {
              id: 'run-2',
              work_item_id: 'wi-1',
              work_item_lineage_id: 'lin-1',
              work_item_revision: 1,
              step_id: 'step-1',
              run_seq: 1,
              attempt: 1,
              executor_kind: 'agent',
              status: 'cancelled',
              failure_class: null,
              result_summary: '完成一半',
              cancel_reason: 'user',
              adapter_name: 'claude',
              created_at: 1,
              started_at: 1,
              ended_at: 2,
            },
          ],
        }),
      },
    })
    renderPanel()
    await expandTask()
    await expandStep()

    expect(screen.getByTestId('run-run-2-result').textContent).toContain('完成一半')
    expect(screen.getByTestId('run-run-2-cancel-reason').textContent).toContain('user')
    expect(screen.getByTestId('run-run-2').textContent).toContain('claude')
  })

  it('未知 needs_input kind 兜底展示原始 JSON', async () => {
    const item = makeItem({ status: 'needs_input', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = {
      ...detail.steps[0],
      status: 'needs_input',
      input_request_json: JSON.stringify({ kind: 'future_kind', payload: { a: 1 } }),
    }
    setup({ items: [item], details: { 'wi-1': detail } })
    renderPanel()
    await expandTask()

    const fallback = screen.getByTestId('step-step-1-needs-input-unknown')
    expect(fallback.textContent).toContain('future_kind')
    expect(screen.getByText('原始请求 JSON')).toBeTruthy()
  })

  it('读取失败显示错误与重试，不显示「无步骤」', () => {
    setup({
      workItemErrors: { 'wi-1': '读取失败：boom' },
      details: {},
    })
    renderPanel()

    expect(screen.getByTestId('task-wi-1-load-error').textContent).toContain('boom')
    expect(screen.getByTestId('task-wi-1-retry')).toBeTruthy()
    expect(screen.queryByText('无（该任务没有步骤）')).toBeNull()
  })

  it('动作失败显示在对应任务下', () => {
    setup({ actionErrors: { 'wi-1': 'GATE_NOT_PASSED: gate 未通过' } })
    renderPanel()

    expect(screen.getByTestId('task-wi-1-action-error').textContent).toContain('GATE_NOT_PASSED')
  })

  it('提案区展示列表、stale 与 diff，驳回未填理由时禁用', async () => {
    setup({
      proposals: [
        {
          id: 'p-1',
          lineage_id: 'pl-1',
          revision: 1,
          project_path: null,
          graph_id: 'g-1',
          anchor_entity_key: 'node-1',
          title: '补状态字段',
          status: 'awaiting_confirm',
          cancel_reason: null,
          created_by: 'alice',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          base_revision: 'r1',
          conflict_group: null,
          weight: 0.5,
          truncated: 0,
          reject_reason: null,
          online_updated_at: 'r2',
          stale: 1,
        },
      ],
      proposalDiffs: {
        'p-1': {
          id: 'p-1',
          graphId: 'g-1',
          nodeEntityKey: 'node-1',
          status: 'awaiting_confirm',
          title: '补状态字段',
          reason: '对账口径',
          evidenceRefs: [],
          baseRevision: 'r1',
          onlineUpdatedAt: 'r2',
          conflictGroup: null,
          weight: 0.5,
          truncated: false,
          stale: true,
          rejectReason: null,
          before: { title: '旧' },
          after: { title: '新' },
          beforeText: '{"title":"旧"}',
          afterText: '{"title":"新"}',
        },
      },
    })
    renderPanel()

    const row = screen.getByTestId('proposal-p-1')
    expect(row.textContent).toContain('补状态字段')
    expect(row.textContent).toContain('stale')

    const rejectButton = screen.getByTestId('proposal-p-1-reject') as HTMLButtonElement
    expect(rejectButton.disabled).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByTestId('proposal-p-1-diff'))
    })
    expect(screen.getByTestId('proposal-p-1-diff-body').textContent).toContain('对账口径')
    expect(screen.getByTestId('proposal-p-1-diff-body').textContent).toContain('已过期')

    await act(async () => {
      fireEvent.click(screen.getByTestId('proposal-p-1-accept'))
    })
    expect(useMapStore.getState().acceptProposal).toHaveBeenCalledWith({
      graphId: 'g-1',
      nodeEntityKey: 'node-1',
      id: 'p-1',
    })
  })
})

function makeRun(overrides: Partial<WorkRunEntry> = {}): WorkRunEntry {
  return {
    id: 'run-1',
    work_item_id: 'wi-1',
    work_item_lineage_id: 'lin-1',
    work_item_revision: 1,
    step_id: 'step-1',
    run_seq: 1,
    attempt: 1,
    executor_kind: 'agent',
    status: 'completed',
    failure_class: null,
    created_at: 1,
    started_at: 1,
    ended_at: 2,
    ...overrides,
  }
}

function makeEvidence(overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
  return {
    id: 'ev-1',
    evidence_level: 'E3',
    evidence_type: 'test',
    freshness: 'fresh',
    produced_by: 'test_executor',
    summary: '用例通过',
    created_at: '2026-01-01',
    revoked_at: null,
    work_item_id: 'wi-1',
    work_run_id: null,
    ...overrides,
  }
}

describe('G8-5 任务卡深度', () => {
  it('默认折叠到任务级，逐层展开后才渲染步 / run / 证据', async () => {
    const item = makeItem({ status: 'done', gate_status: 'pass', gate_missing_json: null })
    setup({
      items: [item],
      details: { 'wi-1': makeDetail(item, { runs: [makeRun()] }) },
      evidence: [makeEvidence({ id: 'ev-1', work_run_id: 'run-1' })],
    })
    renderPanel()

    expect(screen.queryByTestId('step-step-1')).toBeNull()
    await expandTask()
    expect(screen.getByTestId('step-step-1')).toBeTruthy()
    expect(screen.queryByTestId('run-run-1')).toBeNull()
    await expandStep()
    expect(screen.getByTestId('run-run-1')).toBeTruthy()
    expect(screen.queryByTestId('run-evidence-ev-1')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('run-run-1-toggle'))
    })
    expect(screen.getByTestId('run-evidence-ev-1').textContent).toContain('E3')
  })

  it('证据按 work_run_id 归到 run；无 run 归属的留在任务级，其他任务证据不混入', async () => {
    const item = makeItem({ status: 'done', gate_status: 'pass', gate_missing_json: null })
    setup({
      items: [item],
      details: { 'wi-1': makeDetail(item, { runs: [makeRun()] }) },
      evidence: [
        makeEvidence({ id: 'ev-run', work_item_id: 'wi-1', work_run_id: 'run-1' }),
        makeEvidence({ id: 'ev-free', work_item_id: 'wi-1', work_run_id: null }),
        makeEvidence({ id: 'ev-other', work_item_id: 'wi-2', work_run_id: null }),
      ],
    })
    renderPanel()
    await expandTask()

    const unattached = screen.getByTestId('task-unattached-evidence')
    expect(unattached.textContent).toContain('未绑定运行的证据')
    expect(screen.getByTestId('task-evidence-ev-free')).toBeTruthy()
    expect(screen.queryByTestId('task-evidence-ev-other')).toBeNull()

    await expandStep()
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-run-1-toggle'))
    })
    expect(screen.getByTestId('run-evidence-ev-run')).toBeTruthy()
  })

  it('100 条任务默认折叠时只渲染任务头，不铺开步骤', () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      makeItem({ id: `wi-${i}`, lineage_id: `lin-${i}`, title: `任务${i}` }),
    )
    const details = Object.fromEntries(items.map((it) => [it.id, makeDetail(it)]))
    setup({ items, details })
    renderPanel()

    expect(screen.getAllByTestId(/^task-wi-\d+$/).length).toBe(100)
    expect(screen.queryByTestId('step-step-1')).toBeNull()
  })
})

function makeConfirmation(overrides: Partial<StepConfirmationView> = {}): StepConfirmationView {
  return {
    stepId: 'step-1',
    workItemId: 'wi-1',
    workItemRevision: 1,
    stepKind: 'test',
    point: 'C3',
    status: 'waiting_approval',
    required: true,
    waiting: true,
    risk: {
      level: 'high',
      files: 20,
      estimatedLines: 900,
      reasons: ['写域 20 个文件，达到 G4 高风险线 20'],
    },
    requiredDisplay: ['commands', 'worktree', 'affectedFiles', 'policies', 'planHash', 'durationLimit'],
    trigger: '测试执行前确认命令、工作区与计划哈希',
    rejectPath: 'waiting_approval → cancelled',
    decision: null,
    request: null,
    display: {
      commands: [{ seq: 1, command: 'npx vitest run', cwd: '.' }],
      worktree: { path: '/tmp/wt', baseCommit: 'abc123' },
      affectedFiles: ['src/a.ts'],
      policies: [{ seq: 1, decision: 'allow' }],
      planHash: 'hash-1',
      durationLimit: { totalMs: 60000 },
      executionState: { state: 'verified', evidenceLevel: 'test', evidenceCount: 1, staleCount: 0 },
      evidence: [{ id: 'ev-1', level: 'test', type: 'command', summary: 'npx vitest run 全绿' }],
      staleEvidence: { count: 0, items: [] },
      unmetAcceptance: { total: 0, items: [] },
      suggestions: { count: 0, items: [] },
      statusDiff: { humanStatus: 'implemented', derivedState: 'verified' },
    },
    ...overrides,
  }
}

describe('G8-3 确认点渲染', () => {
  it('高风险待确认 test 步：展示为什么确认 + 后端风险原因，并给任务级待确认角标', async () => {
    const item = makeItem({ status: 'running', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = { ...detail.steps[0], step_kind: 'test', status: 'waiting_approval' }
    setup({
      items: [item],
      details: { 'wi-1': detail },
      confirmationsByItem: { 'wi-1': [makeConfirmation()] },
    })
    renderPanel()

    expect(screen.getByTestId('task-wi-1-confirmation-pending').textContent).toContain('待确认')
    await expandTask()

    const panel = screen.getByTestId('step-step-1-confirmation')
    expect(panel.textContent).toContain('C3')
    expect(screen.getByTestId('step-step-1-why').textContent).toContain('测试执行前确认')
    expect(screen.getByTestId('step-step-1-risk').textContent).toContain('高')
    expect(screen.getByTestId('step-step-1-reasons').textContent).toContain('G4 高风险线')
    expect(panel.textContent).toContain('计划哈希')
    expect(panel.textContent).toContain('驳回后')
  })

  it('低风险且无决策：不渲染面板、不出现待确认角标', async () => {
    const item = makeItem({ status: 'running', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = { ...detail.steps[0], step_kind: 'test', status: 'pending' }
    setup({
      items: [item],
      details: { 'wi-1': detail },
      confirmationsByItem: {
        'wi-1': [
          makeConfirmation({
            status: 'pending',
            required: false,
            waiting: false,
            risk: {
              level: 'low',
              files: 1,
              estimatedLines: 10,
              reasons: ['写域 1 个文件，未达 G4 高风险线 20'],
            },
          }),
        ],
      },
    })
    renderPanel()

    expect(screen.queryByTestId('task-wi-1-confirmation-pending')).toBeNull()
    await expandTask()
    expect(screen.queryByTestId('step-step-1-confirmation')).toBeNull()
  })

  it('已决策：展示通过状态、决策人与备注', async () => {
    const item = makeItem({ status: 'running', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = { ...detail.steps[0], step_kind: 'test', status: 'pending' }
    setup({
      items: [item],
      details: { 'wi-1': detail },
      confirmationsByItem: {
        'wi-1': [
          makeConfirmation({
            status: 'pending',
            required: false,
            waiting: false,
            decision: {
              decision: 'approve',
              decidedBy: 'alice',
              decidedAt: 1,
              note: '命令已核对',
              risk: 'high',
              reasons: ['写域 20 个文件，达到 G4 高风险线 20'],
            },
          }),
        ],
      },
    })
    renderPanel()
    await expandTask()

    const panel = screen.getByTestId('step-step-1-confirmation')
    expect(panel.textContent).toContain('已通过')
    expect(screen.getByTestId('step-step-1-decision').textContent).toContain('alice')
    expect(screen.getByTestId('step-step-1-decision').textContent).toContain('命令已核对')
  })

  it('C4 人工步展示完成认定与返工拒绝路径', async () => {
    const item = makeItem({ status: 'running', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = { ...detail.steps[0], step_kind: 'human', status: 'waiting_approval' }
    setup({
      items: [item],
      details: { 'wi-1': detail },
      confirmationsByItem: {
        'wi-1': [
          makeConfirmation({
            point: 'C4',
            stepKind: 'human',
            requiredDisplay: ['executionState', 'evidence', 'staleEvidence', 'unmetAcceptance', 'suggestions', 'statusDiff'],
            trigger: '完成认定前核对执行状态与未满足验收',
            rejectPath: 'waiting_approval → pending（返工）',
          }),
        ],
      },
    })
    renderPanel()
    await expandTask()

    const panel = screen.getByTestId('step-step-1-confirmation')
    expect(panel.textContent).toContain('C4 完成认定')
    expect(panel.textContent).toContain('完成认定前核对')
    expect(panel.textContent).toContain('返工')
  })

  it('待确认步展示必填展示项的实际内容，通过时原样回传 display', async () => {
    const item = makeItem({ status: 'running', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = { ...detail.steps[0], step_kind: 'test', status: 'waiting_approval' }
    const confirmation = makeConfirmation()
    setup({
      items: [item],
      details: { 'wi-1': detail },
      confirmationsByItem: { 'wi-1': [confirmation] },
    })
    renderPanel()
    await expandTask()

    const commands = screen.getByTestId('step-step-1-display-commands')
    expect(commands.textContent).toContain('npx vitest run')
    expect(screen.getByTestId('step-step-1-display-planHash').textContent).toContain('hash-1')

    const approve = screen.getByTestId('step-step-1-confirmation-approve') as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(approve)
    })
    expect(useMapStore.getState().decideStepConfirmation).toHaveBeenCalledWith({
      stepId: 'step-1',
      decision: 'approve',
      display: confirmation.display,
    })
  })

  it('驳回时把备注一并带上', async () => {
    const item = makeItem({ status: 'running', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = { ...detail.steps[0], step_kind: 'human', status: 'waiting_approval' }
    setup({
      items: [item],
      details: { 'wi-1': detail },
      confirmationsByItem: {
        'wi-1': [
          makeConfirmation({
            point: 'C4',
            stepKind: 'human',
            requiredDisplay: ['executionState', 'evidence', 'staleEvidence', 'unmetAcceptance', 'suggestions', 'statusDiff'],
          }),
        ],
      },
    })
    renderPanel()
    await expandTask()

    fireEvent.change(screen.getByTestId('step-step-1-confirmation-note'), {
      target: { value: '验收条件未覆盖' },
    })
    const reject = screen.getByTestId('step-step-1-confirmation-reject') as HTMLButtonElement
    expect(reject.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(reject)
    })
    expect(useMapStore.getState().decideStepConfirmation).toHaveBeenCalledWith({
      stepId: 'step-1',
      decision: 'reject',
      display: makeConfirmation().display,
      note: '验收条件未覆盖',
    })
  })

  it('缺必填展示项时禁用通过/驳回并说明缺哪几项', async () => {
    const item = makeItem({ status: 'running', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = { ...detail.steps[0], step_kind: 'test', status: 'waiting_approval' }
    setup({
      items: [item],
      details: { 'wi-1': detail },
      confirmationsByItem: {
        'wi-1': [makeConfirmation({ display: { affectedFiles: ['src/a.ts'] } })],
      },
    })
    renderPanel()
    await expandTask()

    expect(screen.getByTestId('step-step-1-confirmation-missing').textContent).toContain('命令清单')
    expect(screen.getByTestId('step-step-1-confirmation-missing').textContent).toContain('计划哈希')
    expect((screen.getByTestId('step-step-1-confirmation-approve') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('step-step-1-confirmation-reject') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByTestId('step-step-1-confirmation-approve'))
    })
    expect(useMapStore.getState().decideStepConfirmation).not.toHaveBeenCalled()
  })

  it('决策失败展示中文提示，不回显错误码', async () => {
    const item = makeItem({ status: 'running', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = { ...detail.steps[0], step_kind: 'test', status: 'waiting_approval' }
    setup({
      items: [item],
      details: { 'wi-1': detail },
      confirmationsByItem: { 'wi-1': [makeConfirmation()] },
      actionErrors: { 'step-1': '该步当前不在确认状态（可能已被处理），请刷新后重试' },
    })
    renderPanel()
    await expandTask()

    const error = screen.getByTestId('step-step-1-confirmation-error')
    expect(error.textContent).toContain('该步当前不在确认状态')
    expect(error.textContent).not.toContain('STEP_NOT_WAITING')
    expect(screen.queryByTestId('step-step-1-action-error')).toBeNull()
  })

  // I.8.F P1：C1 计划草稿确认（服务端投影原样展示、原样回传）
  function makePlanDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      draft: {
        id: 'pd-1',
        lineage_id: 'pl-1',
        revision: 1,
        graph_id: 'g-1',
        status: 'awaiting_confirm',
        updated_at: '2026-01-01T00:00:00Z',
      },
      display: {
        subtasks: { count: 1, items: [{ key: 'item-1', title: '改一处', goal: null, dependsOn: [] }] },
        scopeFiles: { count: 1, items: ['src/a.ts'] },
        acceptance: { count: 1, items: [{ key: 'item-1', entries: [{ type: 'manual', expected: 'OK' }] }] },
        dependencies: { count: 0, items: [] },
        candidateScore: { count: 0, items: [], derivationRunId: null },
        gateMissing: { count: 0, items: [], skippedGates: [{ gate: 'G5', reason: '草稿阶段未判定' }] },
        excludedItems: { count: 0, items: [], unparsed: 0 },
        anchorStates: { count: 0, items: [], missing: [] },
      },
      ...overrides,
    }
  }

  it('C1 草稿：八项展示按服务端投影渲染，确认时 display 原样回传', async () => {
    setup({ planDraftsByGraph: { 'g-1': [makePlanDraft()] } })
    renderPanel()

    expect(screen.getByTestId('node-map-plan-drafts')).toBeTruthy()
    expect(screen.getByTestId('plan-draft-pd-1-display-subtasks').textContent).toContain('1 项')
    expect(screen.getByTestId('plan-draft-pd-1-display-gateMissing').textContent).toContain('0 项')
    expect(screen.getByTestId('plan-draft-pd-1-skipped').textContent).toContain('G5')

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-draft-pd-1-approve'))
    })
    expect(useMapStore.getState().confirmPlanDraft).toHaveBeenCalledWith({
      graphId: 'g-1',
      id: 'pd-1',
      display: (makePlanDraft().display as Record<string, unknown>),
    })
  })

  it('C1 草稿：驳回走独立通道，不带 display、不带备注', async () => {
    setup({ planDraftsByGraph: { 'g-1': [makePlanDraft()] } })
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-draft-pd-1-reject'))
    })
    expect(useMapStore.getState().rejectPlanDraft).toHaveBeenCalledWith({ graphId: 'g-1', id: 'pd-1' })
    expect(useMapStore.getState().confirmPlanDraft).not.toHaveBeenCalled()
  })

  it('C1 草稿：draft 状态只给「提交确认」，不越过状态机直接 confirm', async () => {
    const draft = makePlanDraft({
      draft: { id: 'pd-1', lineage_id: 'pl-1', revision: 1, graph_id: 'g-1', status: 'draft', updated_at: 't' },
    })
    setup({ planDraftsByGraph: { 'g-1': [draft] } })
    renderPanel()

    expect(screen.getByTestId('plan-draft-pd-1-submit')).toBeTruthy()
    expect(screen.queryByTestId('plan-draft-pd-1-approve')).toBeNull()
    expect(screen.queryByTestId('plan-draft-pd-1-reject')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-draft-pd-1-submit'))
    })
    expect(useMapStore.getState().submitPlanDraft).toHaveBeenCalledWith({ graphId: 'g-1', id: 'pd-1' })
    expect(useMapStore.getState().confirmPlanDraft).not.toHaveBeenCalled()
  })

  it('C1 草稿：无草稿时区块常显但只给空态（v3.22 起区块承载起草入口，不再整体隐藏）', () => {
    setup()
    renderPanel()
    // 区块必须存在：起草入口（S7 数据源）在这里，藏起来等于回到「面板恒空」。
    expect(screen.getByTestId('node-map-plan-drafts')).toBeTruthy()
    expect(screen.getByTestId('plan-draft-compose-open')).toBeTruthy()
    // 但不伪造卡片：空态明说「没有未确认草稿」。
    expect(screen.queryByTestId('plan-draft-pd-1')).toBeNull()
    expect(screen.getByTestId('node-map-plan-drafts').textContent).toContain(
      '无（该图没有未确认的计划草稿',
    )
  })
})

describe('I.8.F P2 C2 修订入口', () => {
  it('点「修订（C2）」展开面板；预检后 missing 与「未留痕」都在界面上可见', async () => {
    setup()
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-wi-1-revise'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('workitem-revision-wi-1')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByTestId('workitem-revision-wi-1-preview'))
    })
    expect(screen.getByTestId('workitem-revision-wi-1-diff')).toBeTruthy()
    expect(screen.getByTestId('workitem-revision-wi-1-missing-writeScope').textContent).toContain('文件是否真会被改动')
    expect(screen.getByTestId('workitem-revision-wi-1-missing-dependency').textContent).toContain('哪些 run 会失效')
    expect(screen.getByTestId('workitem-revision-wi-1-reason-trace').textContent).toContain('未留痕')
  })

  it('未填原因时提交禁用；填原因后把服务端 diff/impact/gateResult 原样放进 display', async () => {
    setup()
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-wi-1-revise'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('workitem-revision-wi-1-preview'))
    })

    const submit = screen.getByTestId('workitem-revision-wi-1-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.change(screen.getByTestId('workitem-revision-wi-1-reason'), { target: { value: '补验收' } })
    await act(async () => {
      fireEvent.click(submit)
    })

    const expected = makeRevisionDiff()
    expect(useMapStore.getState().reviseWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: 'g-1',
        id: 'wi-1',
        reason: '补验收',
        display: { diff: expected.fields, impact: expected.impact, reason: '补验收', gateResult: expected.gateResult },
      }),
    )
  })
})

/**
 * G8-2 时间线切换：面板展示 threadIds 全集，点一条即切换当前会话。
 *
 * 契约（与 HistorySidebar 一致）：先 loadMessages → 再 selectThread → 再把右侧
 * 面板切到 agent。已结束会话允许切换（只读历史），不拦截。
 */
describe('NodeMapPanel 会话时间线切换（G8-2）', () => {
  const entries: TimelineEntry[] = [
    {
      id: 'l-1',
      thread_id: 'th-1',
      thread_title: '会话一',
      thread_status: 'idle',
      thread_adapter: 'claude',
      link_role: 'primary',
      session_origin: 'map_task',
      started_at: 1,
      ended_at: null,
      created_at: 100,
    },
    {
      id: 'l-2',
      thread_id: 'th-2',
      thread_title: '会话二',
      thread_status: 'idle',
      thread_adapter: 'codex',
      link_role: 'related',
      session_origin: 'map_task',
      started_at: 2,
      ended_at: 3,
      created_at: 200,
    },
  ]

  it('展示 threadIds 全集，当前会话按钮禁用且标「当前」', () => {
    setup({ timeline: entries })
    // setup 会把 currentThreadId 重置为 null，当前会话要在其后设置
    useThreadStore.setState({ currentThreadId: 'th-1' })
    renderPanel()

    expect(screen.getByTestId('timeline-l-1')).toBeTruthy()
    expect(screen.getByTestId('timeline-l-2')).toBeTruthy()

    const current = screen.getByTestId('timeline-select-l-1') as HTMLButtonElement
    expect(current.disabled).toBe(true)
    expect(current.textContent).toBe('当前')

    const other = screen.getByTestId('timeline-select-l-2') as HTMLButtonElement
    expect(other.disabled).toBe(false)
    expect(other.textContent).toBe('切换')
  })

  it('点「切换」先载入消息、再切指针、最后切到 agent 面板', async () => {
    setup({ timeline: entries })
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('timeline-select-l-2'))
    })

    const loadMessages = useAgentStore.getState().loadMessages as unknown as ReturnType<typeof vi.fn>
    const selectThread = useAgentStore.getState().selectThread as unknown as ReturnType<typeof vi.fn>
    const setActiveRightPanel = useAppStore.getState().setActiveRightPanel as unknown as ReturnType<typeof vi.fn>

    expect(loadMessages).toHaveBeenCalledWith('th-2')
    expect(selectThread).toHaveBeenCalledWith('th-2')
    expect(setActiveRightPanel).toHaveBeenCalledWith('agent')
    // 顺序：消息先到位，指针后切 —— 避免「指针已切、消息还是上一条」的中间态
    expect(loadMessages.mock.invocationCallOrder[0]).toBeLessThan(selectThread.mock.invocationCallOrder[0])
  })

  it('已结束会话同样可切换（只读历史），不额外拦截', async () => {
    setup({ timeline: entries })
    renderPanel()

    expect(screen.getByTestId('timeline-l-2').textContent).toContain('已结束')
    const ended = screen.getByTestId('timeline-select-l-2') as HTMLButtonElement
    expect(ended.disabled).toBe(false)
  })

  it('无关联会话时只给空态，不渲染切换按钮', () => {
    setup({ timeline: [] })
    renderPanel()

    expect(screen.getByTestId('node-map-timeline').textContent).toContain('无（该节点没有关联会话）')
    expect(screen.queryByTestId('timeline-select-l-1')).toBeNull()
  })
})

/**
 * §3.4 证据建议裁决 + G3-10 E1 直写 + §8.4 人工连边。
 *
 * 这组覆盖的正是此前「通道已暴露、renderer 零调用」的三条写通道：断言的是
 * 面板真的把用户动作发到对应 IPC（不是只渲染列表），并且删除入口只对
 * `origin='human'` 出现（派生/导入链接主进程会拒绝）。
 */
describe('NodeMapPanel 证据建议 / E1 / 连边', () => {
  function makeSuggestion(overrides: Partial<EvidenceSuggestionEntry> = {}): EvidenceSuggestionEntry {
    return {
      id: 'sg-1',
      graph_id: 'g-1',
      node_entity_key: 'node-1',
      suggested_level: 'E3',
      evidence_type: 'test_run',
      rationale: '测试通过但未绑定提交',
      confidence: 0.6,
      status: 'pending',
      produced_by_run_id: null,
      created_at: '2026-01-01',
      ...overrides,
    }
  }

  function makeLink(overrides: Partial<NodeLinkEntry> = {}): NodeLinkEntry {
    return {
      id: 'nl-1',
      project_path: '/p',
      from_entity_key: 'node-1',
      to_entity_key: 'node-2',
      link_type: 'relates_to',
      origin: 'human',
      status: 'active',
      reason: null,
      created_at: '2026-01-01',
      ...overrides,
    }
  }

  it('待裁决建议：接受/驳回分别调用对应写通道', async () => {
    setup({ suggestions: [makeSuggestion()] })
    renderPanel()

    expect(screen.getByTestId('suggestion-sg-1').textContent).toContain('测试通过但未绑定提交')

    await act(async () => {
      fireEvent.click(screen.getByTestId('suggestion-sg-1-accept'))
    })
    const accept = useMapStore.getState().acceptEvidenceSuggestion as unknown as ReturnType<typeof vi.fn>
    expect(accept).toHaveBeenCalledWith({ graphId: 'g-1', nodeEntityKey: 'node-1', id: 'sg-1' })

    await act(async () => {
      fireEvent.click(screen.getByTestId('suggestion-sg-1-dismiss'))
    })
    const dismiss = useMapStore.getState().dismissEvidenceSuggestion as unknown as ReturnType<typeof vi.fn>
    expect(dismiss).toHaveBeenCalledWith({ graphId: 'g-1', nodeEntityKey: 'node-1', id: 'sg-1' })
  })

  it('无待裁决建议时给空态，不留「读取失败」字样', () => {
    setup({ suggestions: [] })
    renderPanel()
    expect(screen.getByTestId('node-map-suggestions').textContent).toContain('无（该节点没有待裁决建议）')
  })

  it('E1 人工判断：ref 指向当前节点，写入成功后清空输入', async () => {
    setup()
    renderPanel()

    const input = screen.getByTestId('e1-summary') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: '我确认这段逻辑已被人工复核' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('e1-submit'))
    })

    const create = useMapStore.getState().createHumanJudgment as unknown as ReturnType<typeof vi.fn>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: 'g-1',
        nodeEntityKey: 'node-1',
        nodeId: 'n-1',
        summary: '我确认这段逻辑已被人工复核',
        ref: { kind: 'node', graphId: 'g-1', nodeEntityKey: 'node-1' },
      }),
    )
    expect((screen.getByTestId('e1-summary') as HTMLInputElement).value).toBe('')
  })

  it('连边：human 来源给删除入口，且删除调用带 projectPath + 当前节点', async () => {
    setup({ links: [makeLink()] })
    renderPanel('/p')

    expect(screen.getByTestId('link-nl-1').textContent).toContain('node-2')
    await act(async () => {
      fireEvent.click(screen.getByTestId('link-nl-1-delete'))
    })
    const del = useMapStore.getState().deleteNodeLink as unknown as ReturnType<typeof vi.fn>
    expect(del).toHaveBeenCalledWith({ id: 'nl-1', projectPath: '/p', entityKey: 'node-1' })
  })

  it('derived 来源不显示删除入口（删了会被巡检重建，主进程也会拒绝）', () => {
    setup({ links: [makeLink({ id: 'nl-2', origin: 'derived' })] })
    renderPanel('/p')

    expect(screen.getByTestId('link-nl-2')).toBeTruthy()
    expect(screen.queryByTestId('link-nl-2-delete')).toBeNull()
  })

  it('没有项目路径时连边区只解释原因，不给新建/删除入口', () => {
    setup({ links: [] })
    renderPanel(null)

    expect(screen.getByTestId('links-no-project')).toBeTruthy()
    expect(screen.queryByTestId('link-create')).toBeNull()
  })

  it('新建关联：选中同图节点后调用 map:link:create（relates_to）', async () => {
    setup({ links: [] })
    useGraphStore.setState({
      nodes: [
        {
          id: 'n-2',
          type: 'module',
          status: 'active',
          title: '节点二',
          graphId: 'g-1',
          graphType: 'online',
          entityKey: 'node-2',
          createdAt: 't',
          updatedAt: 't',
        } as never,
      ],
    })
    renderPanel('/p')

    const select = screen.getByTestId('link-target') as HTMLSelectElement
    await act(async () => {
      fireEvent.change(select, { target: { value: 'node-2' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('link-create'))
    })

    const create = useMapStore.getState().createNodeLink as unknown as ReturnType<typeof vi.fn>
    expect(create).toHaveBeenCalledWith({
      graphId: 'g-1',
      projectPath: '/p',
      entityKey: 'node-1',
      fromEntityKey: 'node-1',
      toEntityKey: 'node-2',
    })
  })
})

/**
 * S7 起草入口（v3.22，I.0 第 1 条闭环）：C1 的唯一数据源。
 *
 * 断言的是用户路径而非通道存在性：起草计划 → 落 plan_drafts（draft 状态）；
 * 修订 → 预填条目原文后产生新 revision。gate 缺失不在客户端复算——创建后
 * 由服务端 previewDraft 投影展示，这正是 C1 契约。
 */
describe('NodeMapPanel S7 起草入口', () => {
  beforeEach(() => {
    useMapStore.setState({ actionErrors: {} })
  })

  function makeDraftView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      draft: {
        id: 'pd-1',
        lineage_id: 'pl-1',
        revision: 1,
        graph_id: 'g-1',
        status: 'draft',
        updated_at: '2026-01-01',
        ...(overrides.draft as Record<string, unknown> | undefined),
      },
      display: {
        subtasks: { count: 0, items: [] },
        scopeFiles: { count: 0, items: [] },
        acceptance: { count: 0, items: [] },
        dependencies: { count: 0, items: [] },
        candidateScore: { count: 0, items: [] },
        gateMissing: { count: 0, items: [] },
        excludedItems: { count: 0, items: [] },
        anchorStates: { count: 0, items: [] },
        ...(overrides.display as Record<string, unknown> | undefined),
      },
    }
  }

  it('无草稿时给空态与起草入口（不再是恒空的面板）', () => {
    setup()
    renderPanel()

    expect(screen.getByTestId('plan-draft-compose-open')).toBeTruthy()
    expect(screen.getByTestId('node-map-plan-drafts').textContent).toContain(
      '无（该图没有未确认的计划草稿',
    )
  })

  it('起草：填子任务与结构化验收后提交，落 plan_drafts 并收起编辑器', async () => {
    setup()
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-draft-compose-open'))
    })
    expect(screen.getByTestId('plan-draft-composer-create')).toBeTruthy()

    const title = screen.getByTestId('composer-item-0-title') as HTMLInputElement
    await act(async () => {
      fireEvent.change(title, { target: { value: '补齐时间线 DTO 测试' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-item-0-acc-add'))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-item-0-acc-0-expected'), {
        target: { value: 'npx vitest run src/main/__tests__/map-read-ipc.test.ts' },
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-submit'))
    })

    const create = useMapStore.getState().createPlanDraft as unknown as ReturnType<typeof vi.fn>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: 'g-1',
        anchorEntityKey: 'node-1',
        anchorNodeId: 'n-1',
        items: [
          expect.objectContaining({
            key: 'item-1',
            title: '补齐时间线 DTO 测试',
            acceptance: [expect.objectContaining({ type: 'manual', expected: 'npx vitest run src/main/__tests__/map-read-ipc.test.ts' })],
          }),
        ],
      }),
    )
    await waitFor(() => {
      expect(screen.queryByTestId('plan-draft-composer-create')).toBeNull()
    })
  })

  it('起草校验：空标题禁用提交；依赖未知键逐条列出（gate 不在客户端复算）', async () => {
    setup()
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-draft-compose-open'))
    })
    // 空标题：提交禁用并给出问题清单
    expect((screen.getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('composer-problems').textContent).toContain('缺标题')

    const title = screen.getByTestId('composer-item-0-title') as HTMLInputElement
    await act(async () => {
      fireEvent.change(title, { target: { value: '任务A' } })
    })
    const deps = screen.getByTestId('composer-item-0-depends') as HTMLInputElement
    await act(async () => {
      fireEvent.change(deps, { target: { value: 'item-9' } })
    })
    expect((screen.getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('composer-problems').textContent).toContain('依赖了不存在的键：item-9')
  })

  it('修订：预填条目原文（plan:draft:get），改后经 plan:draft:revise 产生新 revision', async () => {
    setup({
      planDraftsByGraph: { 'g-1': [makeDraftView({ draft: { status: 'awaiting_confirm' } })] },
    })
    useMapStore.setState({
      getPlanDraftItems: vi.fn(async () => [
        {
          key: 'item-1',
          title: '旧标题',
          goal: '原目标',
          scopeFiles: ['src/a.ts'],
          acceptance: [{ id: 'acc_1', type: 'command', expected: 'npm test' }],
          dependsOn: [],
        },
      ]),
    })
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-draft-pd-1-revise'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('plan-draft-composer-revise')).toBeTruthy()
    })

    // 预填的是服务端原文，不是 display 投影（scopeFiles 逐条还原）
    expect((screen.getByTestId('composer-item-0-title') as HTMLInputElement).value).toBe('旧标题')
    expect((screen.getByTestId('composer-item-0-scope') as HTMLTextAreaElement).value).toContain('src/a.ts')
    expect((screen.getByTestId('composer-item-0-acc-0-expected') as HTMLInputElement).value).toBe('npm test')
    expect((screen.getByTestId('composer-item-0-acc-0-type') as HTMLSelectElement).value).toBe('command')

    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-item-0-title'), { target: { value: '新标题' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-submit'))
    })

    const revise = useMapStore.getState().revisePlanDraft as unknown as ReturnType<typeof vi.fn>
    expect(revise).toHaveBeenCalledWith({
      graphId: 'g-1',
      id: 'pd-1',
      items: [
        expect.objectContaining({
          key: 'item-1',
          title: '新标题',
          scopeFiles: ['src/a.ts'],
          acceptance: [expect.objectContaining({ type: 'command', expected: 'npm test' })],
        }),
      ],
    })
  })

  it('修订预填失败（草稿原文读不到）不打开编辑器，也不吞错误', async () => {
    setup({
      planDraftsByGraph: { 'g-1': [makeDraftView()] },
      actionErrors: { 'plan-draft:pd-1': '草稿不存在或没有条目原文（plan:draft:get 返回空）' },
    })
    useMapStore.setState({ getPlanDraftItems: vi.fn(async () => null) })
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-draft-pd-1-revise'))
    })
    await act(async () => {})
    expect(screen.queryByTestId('plan-draft-composer-revise')).toBeNull()
  })

  it('依赖成环在客户端预检即被拦下（环检测主进程还有一道，双保险）', async () => {
    setup()
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-draft-compose-open'))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-item-0-title'), { target: { value: 'A' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-add-item'))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-item-1-title'), { target: { value: 'B' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-item-0-depends'), { target: { value: 'item-2' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-item-1-depends'), { target: { value: 'item-1' } })
    })

    expect((screen.getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('composer-problems').textContent).toContain('依赖存在环')
  })
})
