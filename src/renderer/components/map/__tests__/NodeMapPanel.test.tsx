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
import type { WorkItemDetail, WorkItemSummary } from '../../../store/mapStore'

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
  workItemErrors?: Record<string, string>
  executionStatus?: { enabled: boolean; adapterName: string | null; disabledReason: string | null } | null
  actionErrors?: Record<string, string>
} = {}): void {
  const items = opts.items ?? [makeItem()]
  useMapStore.setState({
    overlayByGraph: new Map([['g-1', { executionStates: [], workItems: items }]]),
    nodeTimeline: [],
    nodeEvidence: [],
    workItemDetails: opts.details ?? { 'wi-1': makeDetail(items[0]) },
    workItemErrors: opts.workItemErrors ?? {},
    nodeError: null,
    actionErrors: opts.actionErrors ?? {},
    executionStatus:
      opts.executionStatus === undefined
        ? { enabled: true, adapterName: 'claude', disabledReason: null }
        : opts.executionStatus,
    loadingNode: false,
    // 效果与动作在组件测试里不需要真实 IPC
    fetchExecutionStatus: vi.fn(async () => {}),
    fetchOverlay: vi.fn(async () => {}),
    fetchNodeData: vi.fn(async () => {}),
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

  it('有活跃 run 时隐藏任务级取消，提示先取消 run', () => {
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

    expect(screen.queryByTestId('task-wi-1-cancel')).toBeNull()
    expect(screen.getByTestId('task-wi-1-active-run-hint').textContent).toContain('先取消运行中的 run')
    expect(screen.getByTestId('run-run-1-cancel')).toBeTruthy()
  })

  it('展示 run 结果摘要、取消归因与执行器', () => {
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

    expect(screen.getByTestId('run-run-2-result').textContent).toContain('完成一半')
    expect(screen.getByTestId('run-run-2-cancel-reason').textContent).toContain('user')
    expect(screen.getByTestId('run-run-2').textContent).toContain('claude')
  })

  it('未知 needs_input kind 兜底展示原始 JSON', () => {
    const item = makeItem({ status: 'needs_input', gate_status: 'pass', gate_missing_json: null })
    const detail = makeDetail(item)
    detail.steps[0] = {
      ...detail.steps[0],
      status: 'needs_input',
      input_request_json: JSON.stringify({ kind: 'future_kind', payload: { a: 1 } }),
    }
    setup({ items: [item], details: { 'wi-1': detail } })
    renderPanel()

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
})
