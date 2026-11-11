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
import { render, screen, fireEvent, act } from '@testing-library/react'
import { NodeMapPanel } from '../NodeMapPanel'
import { useMapStore } from '../../../store/mapStore'
import type { EvidenceEntry, StepConfirmationView, WorkItemDetail, WorkItemDiffView, WorkItemSummary, WorkRunEntry } from '../../../store/mapStore'

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
} = {}): void {
  const items = opts.items ?? [makeItem()]
  useMapStore.setState({
    overlayByGraph: new Map([['g-1', { executionStates: [], workItems: items }]]),
    nodeTimeline: [],
    nodeEvidence: opts.evidence ?? [],
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

function renderPanel(): void {
  render(<NodeMapPanel graphId="g-1" nodeEntityKey="node-1" nodeId="n-1" />)
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

  it('C1 草稿：无草稿时不渲染区块，也不伪造空卡片', () => {
    setup()
    renderPanel()
    expect(screen.queryByTestId('node-map-plan-drafts')).toBeNull()
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
