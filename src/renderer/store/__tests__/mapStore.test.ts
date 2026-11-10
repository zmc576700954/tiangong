// @vitest-environment jsdom
/**
 * mapStore 执行入口（G3-3/G8-6）
 *
 * 覆盖：
 *  - startWorkItem 不伪造 gate（不传 gateResult）
 *  - 结构化错误信封 `{ok:false,error}` 解包为 actionError，而不是静默成功
 *  - 任务级取消 / run 级取消的参数契约
 *  - enqueueStep 在执行开关关闭时不发请求
 *  - 读取失败与「无数据」区分
 *  - event:work-item-changed 去抖刷新已缓存明细
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { describeConfirmationError, useMapStore } from '../mapStore'

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function detail(itemRow = item()): Record<string, unknown> {
  return { item: itemRow, steps: [{ id: 'step-1', status: 'pending', step_kind: 'agent' }], runs: [] }
}

function installApi(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api: Record<string, ReturnType<typeof vi.fn>> = {
    'workitem:run:start': vi.fn(async () => item({ status: 'queued', gate_status: 'pass' })),
    'workitem:cancel': vi.fn(async () => item({ status: 'cancelled', cancel_reason: 'user' })),
    'workitem:step:run': vi.fn(async () => ({ runId: 'run-1', stepId: 'step-1', status: 'queued', reused: false })),
    'workitem:run:cancel': vi.fn(async () => ({
      runId: 'run-1',
      status: 'cancelled',
      cancelled: true,
      alreadyTerminal: false,
    })),
    'workitem:get': vi.fn(async () => detail()),
    'workitem:acceptance:confirm': vi.fn(async () => ({ stepId: 'step-1', workItemId: 'wi-1' })),
    'map:confirmation:decide': vi.fn(async () => ({ stepId: 'step-1', decision: 'approve' })),
    'map:execution:status': vi.fn(async () => ({ enabled: true, adapterName: 'claude', disabledReason: null })),
    'map:overlay:get': vi.fn(async () => ({ executionStates: [], workItems: [] })),
    ...overrides,
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
  return api
}

function resetStore(): void {
  useMapStore.setState({
    overlayByGraph: new Map([
      ['g-1', { executionStates: [], workItems: [item()] as never }],
    ]),
    nodeTimeline: [],
    nodeEvidence: [],
    workItemDetails: {},
    workItemErrors: {},
    nodeError: null,
    actionErrors: {},
    executionStatus: null,
    loadingNode: false,
  })
}

describe('mapStore 执行入口', () => {
  beforeEach(() => {
    resetStore()
  })

  it('startWorkItem 只传 id，不伪造 gateResult', async () => {
    const api = installApi()
    await useMapStore.getState().startWorkItem('wi-1')

    expect(api['workitem:run:start']).toHaveBeenCalledWith({ id: 'wi-1' })
    const overlay = useMapStore.getState().overlayByGraph.get('g-1')
    expect(overlay?.workItems[0].status).toBe('queued')
  })

  it('startWorkItem 把结构化错误写入 actionError', async () => {
    installApi({
      'workitem:run:start': vi.fn(async () => ({
        ok: false,
        error: { code: 'GATE_NOT_PASSED', message: 'gate 未通过' },
      })),
    })
    await useMapStore.getState().startWorkItem('wi-1')

    expect(useMapStore.getState().actionErrors['wi-1']).toContain('GATE_NOT_PASSED')
    expect(useMapStore.getState().overlayByGraph.get('g-1')?.workItems[0].status).toBe('draft')
  })

  it('cancelWorkItem 调 workitem:cancel(id) 并更新状态', async () => {
    const api = installApi()
    await useMapStore.getState().cancelWorkItem('wi-1')

    expect(api['workitem:cancel']).toHaveBeenCalledWith('wi-1')
    const row = useMapStore.getState().overlayByGraph.get('g-1')?.workItems[0]
    expect(row?.status).toBe('cancelled')
    expect(row?.cancel_reason).toBe('user')
  })

  it('执行开关关闭时 enqueueStep 不发 IPC，只写提示', async () => {
    const api = installApi()
    useMapStore.setState({
      executionStatus: { enabled: false, adapterName: null, disabledReason: '执行未开启' },
    })

    await useMapStore.getState().enqueueStep({ graphId: 'g-1', workItemId: 'wi-1', stepId: 'step-1' })

    expect(api['workitem:step:run']).not.toHaveBeenCalled()
    expect(useMapStore.getState().actionErrors['step-1']).toBe('执行未开启')
  })

  it('enqueueStep 带 adapterName 调 workitem:step:run', async () => {
    const api = installApi()
    useMapStore.setState({
      executionStatus: { enabled: true, adapterName: 'claude', disabledReason: null },
    })

    await useMapStore.getState().enqueueStep({ graphId: 'g-1', workItemId: 'wi-1', stepId: 'step-1' })

    expect(api['workitem:step:run']).toHaveBeenCalledWith({
      stepId: 'step-1',
      workItemId: 'wi-1',
      adapterName: 'claude',
    })
  })

  it('cancelRun 以字符串 runId 调 workitem:run:cancel', async () => {
    const api = installApi()
    await useMapStore.getState().cancelRun({ graphId: 'g-1', workItemId: 'wi-1', runId: 'run-1' })

    expect(api['workitem:run:cancel']).toHaveBeenCalledWith('run-1')
  })

  it('cancelRun 已终态时给出提示', async () => {
    installApi({
      'workitem:run:cancel': vi.fn(async () => ({
        runId: 'run-1',
        status: 'completed',
        cancelled: false,
        alreadyTerminal: true,
      })),
    })
    await useMapStore.getState().cancelRun({ graphId: 'g-1', workItemId: 'wi-1', runId: 'run-1' })

    expect(useMapStore.getState().actionErrors['run-1']).toContain('已结束')
  })

  it('fetchExecutionStatus 失败时置为关闭并保留原因', async () => {
    installApi({ 'map:execution:status': vi.fn(async () => { throw new Error('boom') }) })
    await useMapStore.getState().fetchExecutionStatus()

    const status = useMapStore.getState().executionStatus
    expect(status?.enabled).toBe(false)
    expect(status?.disabledReason).toContain('读取执行状态失败')
  })

  it('fetchWorkItemDetail 空结果记读取错误，成功清空', async () => {
    installApi({ 'workitem:get': vi.fn(async () => null) })
    await useMapStore.getState().fetchWorkItemDetail('wi-1')
    expect(useMapStore.getState().workItemErrors['wi-1']).toContain('不存在')

    installApi()
    await useMapStore.getState().fetchWorkItemDetail('wi-1')
    expect(useMapStore.getState().workItemErrors['wi-1']).toBeUndefined()
    expect(useMapStore.getState().workItemDetails['wi-1']).toBeTruthy()
  })

  it('confirmAcceptance 遇到结构化错误时抛错并刷新明细', async () => {
    const api = installApi({
      'workitem:acceptance:confirm': vi.fn(async () => ({
        ok: false,
        error: { code: 'ENTRY_NOT_FOUND', message: '条目不存在' },
      })),
    })

    await expect(
      useMapStore.getState().confirmAcceptance({
        graphId: 'g-1',
        workItemId: 'wi-1',
        stepId: 'step-1',
        entryIds: ['e-1'],
      }),
    ).rejects.toThrow('ENTRY_NOT_FOUND')
    expect(api['workitem:get']).toHaveBeenCalledWith('wi-1')
  })

  it('applyWorkItemChanged 按 lineage 刷新已缓存明细', async () => {
    const api = installApi()
    await useMapStore.getState().fetchWorkItemDetail('wi-1')
    await useMapStore.getState().applyWorkItemChanged({ lineageId: 'lin-1' })

    // 首轮 fetchWorkItemDetail + 事件刷新各一次
    expect(api['workitem:get']).toHaveBeenCalledTimes(2)
  })
})

describe('步级确认决策（C3/C4）', () => {
  beforeEach(() => {
    resetStore()
  })

  it('decideStepConfirmation 把 display 原样发给主进程，不本地改确认状态', async () => {
    const api = installApi()
    useMapStore.setState({ confirmationsByItem: { 'wi-1': [{ stepId: 'step-1' } as never] } })
    const display = { planHash: 'hash-1', affectedFiles: ['src/a.ts'] }

    await useMapStore.getState().decideStepConfirmation({
      stepId: 'step-1',
      decision: 'approve',
      display,
      note: '已核对',
    })

    expect(api['map:confirmation:decide']).toHaveBeenCalledWith({
      stepId: 'step-1',
      decision: 'approve',
      display,
      note: '已核对',
    })
    // 成功路径不猜状态：仍等 broadcast → applyWorkItemChanged 重拉
    expect(useMapStore.getState().confirmationsByItem['wi-1']).toHaveLength(1)
    expect(useMapStore.getState().actionErrors['step-1']).toBeUndefined()
  })

  it('四种错误码都翻成中文可读提示，不把码抛给用户', async () => {
    const cases: Array<[string, string, string]> = [
      ['STEP_NOT_WAITING', '该步当前不在确认状态', '该步当前不在确认状态（可能已被处理），请刷新后重试'],
      ['NOT_STEP_CONFIRMATION', '只有 test / human 步需要计划期确认', '只有 test / human 步需要计划期确认；agent 步走逐工具审批'],
      ['ALREADY_DECIDED', '不能重复确认', '该步已有决策，不能重复确认'],
      ['CONFIRMATION_DISPLAY_MISSING', '必填展示项未齐', '必填展示项未齐，无法确认'],
    ]
    for (const [code, fragment, expected] of cases) {
      const text = describeConfirmationError(new Error(`${code}: 原始信息`))
      expect(text).toBe(expected)
      expect(text).not.toContain(code)
      expect(text).toContain(fragment)
    }
  })

  it('展示项缺失时把缺的键名附在中文提示后', () => {
    const text = describeConfirmationError(
      new Error('CONFIRMATION_DISPLAY_MISSING: 缺少必填展示项：commands, planHash'),
    )
    expect(text).toBe('必填展示项未齐，无法确认：commands, planHash')
  })

  it('未知错误保留原文，不吞掉信息', () => {
    expect(describeConfirmationError(new Error('ENOENT: 磁盘不可读'))).toBe('ENOENT: 磁盘不可读')
  })
})
