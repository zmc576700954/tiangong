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
    'plan:draft:list': vi.fn(async () => ({
      drafts: [
        {
          draft: { id: 'pd-1', lineage_id: 'pl-1', revision: 1, graph_id: 'g-1', status: 'draft', updated_at: 't' },
          display: { gateMissing: { count: 0, items: [] } },
        },
      ],
    })),
    'plan:draft:submit': vi.fn(async () => ({ draft: { id: 'pd-1', status: 'awaiting_confirm' } })),
    'plan:draft:confirm': vi.fn(async () => ({ draft: { id: 'pd-1', status: 'confirmed' }, workItemIds: ['wi-9'] })),
    'plan:draft:reject': vi.fn(async () => ({ draft: { id: 'pd-1', status: 'rejected' } })),
    'workitem:history': vi.fn(async () => [
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
    'workitem:diff': vi.fn(async () => ({
      lineageId: 'lin-1',
      from: { id: 'wi-1', revision: 1 },
      to: { id: null, revision: 2, stored: false },
      fields: [],
      impact: [],
      gateResult: { status: 'precheck', gateStatus: 'pass', missing: [] },
      reasonTrace: { sink: null, note: '未留痕' },
    })),
    'workitem:revise': vi.fn(async () => ({
      item: item({ id: 'wi-2', revision: 2 }),
      audit: { traced: false, sink: null, note: '未留痕' },
    })),
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
    planDraftsByGraph: {},
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

describe('C1 计划草稿（I.8.F P1）', () => {
  beforeEach(() => {
    installApi()
    resetStore()
  })

  it('fetchPlanDrafts 缓存服务端投影；成功后清掉图级错误', async () => {
    useMapStore.setState({ actionErrors: { 'plan-drafts:g-1': '旧错误' } })
    await useMapStore.getState().fetchPlanDrafts('g-1')

    const cached = useMapStore.getState().planDraftsByGraph['g-1']
    expect(cached).toHaveLength(1)
    expect(cached[0].draft.id).toBe('pd-1')
    expect(cached[0].display).toEqual({ gateMissing: { count: 0, items: [] } })
    expect(useMapStore.getState().actionErrors['plan-drafts:g-1']).toBeUndefined()
  })

  it('confirmPlanDraft 原样回传 display，并在成功后重拉列表（不本地猜状态）', async () => {
    const api = installApi()
    await useMapStore.getState().confirmPlanDraft({
      graphId: 'g-1',
      id: 'pd-1',
      display: { gateMissing: { count: 0, items: [] } },
    })

    expect(api['plan:draft:confirm']).toHaveBeenCalledWith({
      id: 'pd-1',
      display: { gateMissing: { count: 0, items: [] } },
    })
    expect(api['plan:draft:list']).toHaveBeenCalledWith('g-1')
    expect(useMapStore.getState().actionErrors['plan-draft:pd-1']).toBeUndefined()
  })

  it('submitPlanDraft 走提交通道并重拉列表', async () => {
    const api = installApi()
    await useMapStore.getState().submitPlanDraft({ graphId: 'g-1', id: 'pd-1' })

    expect(api['plan:draft:submit']).toHaveBeenCalledWith('pd-1')
    expect(api['plan:draft:list']).toHaveBeenCalledWith('g-1')
    expect(api['plan:draft:confirm']).not.toHaveBeenCalled()
  })

  it('rejectPlanDraft 走驳回通道并重拉列表', async () => {
    const api = installApi()
    await useMapStore.getState().rejectPlanDraft({ graphId: 'g-1', id: 'pd-1' })

    expect(api['plan:draft:reject']).toHaveBeenCalledWith('pd-1')
    expect(api['plan:draft:confirm']).not.toHaveBeenCalled()
    expect(api['plan:draft:list']).toHaveBeenCalledWith('g-1')
  })

  it('失败时把错误码翻成中文（含环），不把码抛给用户', async () => {
    installApi({
      'plan:draft:confirm': vi.fn(async () => {
        throw new Error('计划依赖存在环:item-1 → item-2 → item-1|cycle=["item-1","item-2"]')
      }),
    })
    await useMapStore.getState().confirmPlanDraft({
      graphId: 'g-1',
      id: 'pd-1',
      display: { gateMissing: { count: 0, items: [] } },
    })
    const text = useMapStore.getState().actionErrors['plan-draft:pd-1']
    expect(text).toBe('计划依赖存在环，无法确认（请先调整子任务依赖）')
    expect(text).not.toContain('cycle=')

    installApi({
      'plan:draft:confirm': vi.fn(async () => {
        throw new Error('CONFIRMATION_DISPLAY_MISSING: 缺少必填展示项：subtasks')
      }),
    })
    await useMapStore.getState().confirmPlanDraft({
      graphId: 'g-1',
      id: 'pd-1',
      display: {},
    })
    const displayError = useMapStore.getState().actionErrors['plan-draft:pd-1']
    expect(displayError).toContain('必填展示项未齐')
    expect(displayError).not.toContain('CONFIRMATION_DISPLAY_MISSING')
  })
})

describe('I.8.F P2 C2 修订', () => {
  beforeEach(() => {
    resetStore()
  })

  it('fetchWorkItemHistory 原样返回 lineage 下的 revision 列表', async () => {
    installApi()
    const rows = await useMapStore.getState().fetchWorkItemHistory('lin-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'wi-1', revision: 1, is_current: true })
  })

  it('fetchWorkItemDiff 只解包服务端结果，不本地改口径', async () => {
    installApi()
    const diff = await useMapStore.getState().fetchWorkItemDiff({ lineageId: 'lin-1', from: 1, proposed: {} })
    expect(diff.to).toEqual({ id: null, revision: 2, stored: false })
    expect(diff.reasonTrace).toEqual({ sink: null, note: '未留痕' })
  })

  it('reviseWorkItem 原样回传 display，成功后刷新明细与叠加层', async () => {
    const api = installApi()
    const display = {
      diff: [{ field: 'title', before: 'a', after: 'b', changed: true }],
      impact: [],
      reason: '补验收',
      gateResult: { status: 'precheck', gateStatus: 'pass', missing: [] },
    }
    const audit = await useMapStore.getState().reviseWorkItem({
      graphId: 'g-1',
      id: 'wi-1',
      reason: '补验收',
      display,
    })

    expect(api['workitem:revise']).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wi-1', reason: '补验收', display }),
    )
    expect(api['workitem:get']).toHaveBeenCalledWith('wi-1')
    expect(api['map:overlay:get']).toHaveBeenCalledWith('g-1')
    expect(audit).toEqual({ traced: false, sink: null, note: '未留痕' })
  })

  it('必填展示项缺失时把错误码翻成中文', async () => {
    installApi({
      'workitem:revise': vi.fn(async () => {
        throw new Error('CONFIRMATION_DISPLAY_MISSING: 缺少必填展示项：reason')
      }),
    })
    const audit = await useMapStore.getState().reviseWorkItem({
      graphId: 'g-1',
      id: 'wi-1',
      reason: '',
      display: {},
    })
    expect(audit).toBeNull()
    const text = useMapStore.getState().actionErrors['revision:wi-1']
    expect(text).toContain('必填展示项未齐')
    expect(text).not.toContain('CONFIRMATION_DISPLAY_MISSING')
  })
})
