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
import type { EvidenceEntry, WorkItemDetail, WorkItemSummary, WorkRunEntry } from '../../../store/mapStore'

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
  workItemErrors?: Record<string, string>
  executionStatus?: { enabled: boolean; adapterName: string | null; disabledReason: string | null } | null
  actionErrors?: Record<string, string>
  proposals?: Array<Record<string, unknown>>
  proposalDiffs?: Record<string, Record<string, unknown>>
  proposalErrors?: Record<string, string>
} = {}): void {
  const items = opts.items ?? [makeItem()]
  useMapStore.setState({
    overlayByGraph: new Map([['g-1', { executionStates: [], workItems: items }]]),
    nodeTimeline: [],
    nodeEvidence: opts.evidence ?? [],
    workItemDetails: opts.details ?? { 'wi-1': makeDetail(items[0]) },
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
  })
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
