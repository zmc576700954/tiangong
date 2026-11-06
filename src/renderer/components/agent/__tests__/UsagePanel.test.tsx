// @vitest-environment jsdom
/**
 * M1 用量视图验收（诚实文案）：
 * - 无记录 ≠ $0.00：空数据必须显示「此前无记录」，且 DOM 里不出现金额；
 * - 真实 0 ≠ 无记录：cost_micros=0 的真实行显示 $0.00；
 * - 缺价 ≠ $0.00：全缺价显示「价格未知」，部分缺价提示未计入金额；
 * - unknown ≠ 0：source=unknown 的行显示「后端未上报用量」，token 不补 0。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { UsagePanel } from '../UsagePanel'
import {
  describeUsageMoney,
  formatTokenValue,
  formatUsdFromMicros,
} from '../usageFormat'
import type {
  AgentUsageRecord,
  GraphDayUsageSummary,
  SessionUsageView,
  UsageSummary,
} from '@shared/types/agent-runtime'

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    totalRows: 0,
    knownCostMicros: 0,
    unknownCostRows: 0,
    unpricedRows: 0,
    providerRows: 0,
    estimatedRows: 0,
    unknownRows: 0,
    pricedRows: 0,
    missingPriceRows: 0,
    notReportedRows: 0,
    costStatusUnknownRows: 0,
    unknownTokenRows: 0,
    tokensReportedRows: 0,
    tokensNotReportedRows: 0,
    tokensReportedUnknownRows: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    ...overrides,
  }
}

function usageRow(overrides: Partial<AgentUsageRecord> = {}): AgentUsageRecord {
  return {
    id: 'usage-1',
    turn_id: 'turn-1',
    session_id: 'sess-1',
    executor: 'claude-code',
    graph_id: 'g1',
    node_id: null,
    model: 'claude-sonnet-4-5',
    day_key: '2026-03-04',
    input_tokens: 1000,
    output_tokens: 200,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    currency: 'USD',
    cost_usd: 0.006,
    cost_micros: 6000,
    price_version: 'test-v1',
    is_estimate: 0,
    source: 'provider',
    cost_status: 'priced',
    tokens_reported: 1,
    attribution_note: null,
    dedupe_key: null,
    recorded_at: Date.parse('2026-03-04T04:00:00.000Z'),
    ...overrides,
  }
}

function daySummary(overrides: Partial<GraphDayUsageSummary> = {}): GraphDayUsageSummary {
  return { graphId: 'g1', dayKey: '2026-03-04', ...summary(), ...overrides }
}

function installApi(sessionView: SessionUsageView, graphView: { graphId: string; days: GraphDayUsageSummary[] }) {
  const api = {
    'agent:getUsageBySession': vi.fn().mockResolvedValue(sessionView),
    'agent:getUsageByGraph': vi.fn().mockResolvedValue(graphView),
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
  return api
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('UsagePanel 金额格式化（纯函数）', () => {
  it('micros → USD：真实 0 显示 $0.00，小数不吞成 0', () => {
    expect(formatUsdFromMicros(0)).toBe('$0.00')
    expect(formatUsdFromMicros(3_000_000)).toBe('$3.00')
    expect(formatUsdFromMicros(1_234)).toBe('$0.001234')
    expect(formatUsdFromMicros(1_500_000)).toBe('$1.50')
  })

  it('describeUsageMoney：无记录 / 全部未上报 / 全缺价 / 全未标注 / 部分缺价 五态', () => {
    expect(describeUsageMoney(summary())).toEqual({ kind: 'no-records' })
    expect(describeUsageMoney(summary({ totalRows: 2, notReportedRows: 2 }))).toEqual({
      kind: 'not-reported',
      rows: 2,
    })
    expect(describeUsageMoney(summary({ totalRows: 2, missingPriceRows: 2 }))).toEqual({
      kind: 'price-unknown',
      rows: 2,
    })
    // 迁移前历史行：cost_status 为 NULL，既不是「已定价」也不是「缺价」
    expect(describeUsageMoney(summary({ totalRows: 2, costStatusUnknownRows: 2 }))).toEqual({
      kind: 'status-unknown',
      rows: 2,
      missingPriceRows: 0,
      notReportedRows: 0,
    })
    expect(describeUsageMoney(summary({ totalRows: 3, pricedRows: 2, missingPriceRows: 1, knownCostMicros: 3_000_000 }))).toEqual({
      kind: 'amount',
      usd: '$3.00',
      micros: 3_000_000,
      unpricedRows: 1,
      notReportedRows: 0,
      statusUnknownRows: 0,
    })
  })

  it('formatTokenValue：null 显示占位符而不是 0', () => {
    expect(formatTokenValue(null)).toBe('—')
    expect(formatTokenValue(undefined)).toBe('—')
    expect(formatTokenValue(0)).toBe('0')
  })
})

describe('UsagePanel 诚实的空状态与四类数据', () => {
  it('无记录：显示「此前无记录」，绝不出现 $0.00', async () => {
    installApi(
      { sessionId: 'sess-1', summary: summary(), rows: [] },
      { graphId: 'g1', days: [] },
    )
    render(<UsagePanel open onOpenChange={() => {}} sessionId="sess-1" graphId="g1" />)

    await waitFor(() => {
      expect(screen.getByTestId('usage-session-empty')).toBeTruthy()
      expect(screen.getByTestId('usage-graph-empty')).toBeTruthy()
    })
    // 最基本的一条：空白不能被渲染成 0
    expect(screen.queryByTestId('usage-money-amount')).toBeNull()
    expect(screen.queryByText('$0.00')).toBeNull()
    // 文案要点：此前无记录
    expect(screen.getByTestId('usage-session-empty').textContent).toContain('此前无记录')
    expect(screen.getByTestId('usage-graph-empty').textContent).toContain('此前无记录')
    // 历史空白说明始终可见
    expect(screen.getByTestId('usage-history-note').textContent).toContain('此前的历史没有记录')
  })

  it('真实 0 花费：显示 $0.00，且不是「无记录」', async () => {
    const row = usageRow({ cost_micros: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 })
    installApi(
      { sessionId: 'sess-1', summary: summary({ totalRows: 1, providerRows: 1, pricedRows: 1, tokensReportedRows: 1 }), rows: [row] },
      { graphId: 'g1', days: [daySummary({ totalRows: 1, providerRows: 1, pricedRows: 1, tokensReportedRows: 1 })] },
    )
    render(<UsagePanel open onOpenChange={() => {}} sessionId="sess-1" graphId="g1" />)

    await waitFor(() => {
      expect(screen.getAllByTestId('usage-money-amount')[0].textContent).toContain('$0.00')
    })
    expect(screen.queryByTestId('usage-session-empty')).toBeNull()
    expect(screen.getAllByTestId('usage-quality')[0].textContent).toContain('后端实测 1')
  })

  it('缺价：显示「价格未知」，不混成 $0.00', async () => {
    const row = usageRow({ cost_micros: null, cost_usd: 0, price_version: null, model: 'gpt-99' })
    installApi(
      { sessionId: 'sess-1', summary: summary({ totalRows: 1, providerRows: 1, missingPriceRows: 1, tokensReportedRows: 1, unknownCostRows: 1, unpricedRows: 1 }), rows: [row] },
      { graphId: 'g1', days: [daySummary({ totalRows: 1, providerRows: 1, missingPriceRows: 1, tokensReportedRows: 1, unknownCostRows: 1, unpricedRows: 1 })] },
    )
    render(<UsagePanel open onOpenChange={() => {}} sessionId="sess-1" graphId="g1" />)

    await waitFor(() => {
      expect(screen.getAllByTestId('usage-money-price-unknown')[0].textContent).toContain('价格未知')
    })
    expect(screen.queryByTestId('usage-money-amount')).toBeNull()
    expect(screen.queryByText('$0.00')).toBeNull()
    expect(screen.getByTestId('usage-row-cost').textContent).toContain('价格未知')
  })

  it('unknown source：行内显示「后端未上报用量」，token 不补 0', async () => {
    const row = usageRow({
      source: 'unknown',
      is_estimate: 1,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      cost_micros: null,
      cost_usd: 0,
      model: null,
      attribution_note: 'backend_reports_no_usage',
    })
    installApi(
      {
        sessionId: 'sess-1',
        summary: summary({
          totalRows: 1,
          unknownRows: 1,
          notReportedRows: 1,
          unknownCostRows: 1,
          unknownTokenRows: 1,
          tokensNotReportedRows: 1,
        }),
        rows: [row],
      },
      { graphId: 'g1', days: [] },
    )
    render(<UsagePanel open onOpenChange={() => {}} sessionId="sess-1" graphId="g1" />)

    await waitFor(() => {
      expect(screen.getByTestId('usage-row-not-reported').textContent).toContain('后端未上报用量')
    })
    expect(screen.getByTestId('usage-row-source').textContent).toContain('未上报')
    expect(screen.getAllByTestId('usage-quality')[0].textContent).toContain('未上报 1')
    // token 不得被渲染为 0：全未知时展示占位符
    expect(screen.getByTestId('usage-tokens-empty').textContent).toBe('—')
    // 金额区也不得说成「价格未知」：这行是后端根本没给用量
    expect(screen.getByTestId('usage-money-not-reported').textContent).toContain('后端未上报用量')
    expect(screen.getByTestId('usage-row-cost').textContent).toContain('后端未上报用量')
    expect(screen.getByTestId('usage-row-cost').textContent).not.toContain('价格未知')
  })

  it('四类混合：金额只汇总有价行，缺价行计数与提示都在', async () => {
    installApi(
      {
        sessionId: 'sess-1',
        summary: summary({
          totalRows: 4,
          knownCostMicros: 6_000_000,
          unknownCostRows: 2,
          unpricedRows: 1,
          providerRows: 2,
          estimatedRows: 1,
          unknownRows: 1,
          pricedRows: 2,
          missingPriceRows: 1,
          notReportedRows: 1,
          costStatusUnknownRows: 0,
          unknownTokenRows: 1,
          tokensReportedRows: 3,
          tokensNotReportedRows: 1,
          tokensReportedUnknownRows: 0,
        }),
        rows: [],
      },
      {
        graphId: 'g1',
        days: [daySummary({
          totalRows: 4,
          knownCostMicros: 6_000_000,
          unknownCostRows: 2,
          unpricedRows: 1,
          providerRows: 2,
          estimatedRows: 1,
          unknownRows: 1,
          pricedRows: 2,
          missingPriceRows: 1,
          notReportedRows: 1,
          costStatusUnknownRows: 0,
          unknownTokenRows: 1,
          tokensReportedRows: 3,
          tokensNotReportedRows: 1,
          tokensReportedUnknownRows: 0,
        })],
      },
    )
    render(<UsagePanel open onOpenChange={() => {}} sessionId="sess-1" graphId="g1" />)

    await waitFor(() => {
      expect(screen.getAllByTestId('usage-money-amount')[0].textContent).toContain('$6.00')
      expect(screen.getAllByTestId('usage-money-partial-unknown')[0].textContent).toContain('1 条价格未知')
      expect(screen.getAllByTestId('usage-money-partial-not-reported')[0].textContent).toContain('1 条后端未上报用量')
    })
    const quality = screen.getAllByTestId('usage-quality')[0].textContent ?? ''
    expect(quality).toContain('共 4 条')
    expect(quality).toContain('后端实测 2')
    expect(quality).toContain('估算 1')
    expect(quality).toContain('未上报 1')
    expect(quality).toContain('缺价 1')
    // 部分 token 未知：合计只含有数据的行，并显式提示
    expect(screen.getAllByTestId('usage-tokens-partial-unknown')[0].textContent).toContain('1 条 token 未上报')
    // day_key 原样展示，不做 UTC 二次切日
    expect(screen.getByTestId('usage-day-key').textContent).toBe('2026-03-04')
  })

  it('迁移后的历史行（cost_status/tokens_reported 为 NULL）：不显示「已定价」，也不渲染 0', async () => {
    // 故意把 attribution_note 写成 missing_price：UI 必须按列分类，不能解析 note
    const row = usageRow({
      cost_micros: null,
      cost_usd: 0,
      price_version: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      cost_status: null,
      tokens_reported: null,
      attribution_note: 'missing_price:claude-code/gpt-99',
    })
    installApi(
      {
        sessionId: 'sess-1',
        summary: summary({
          totalRows: 1,
          providerRows: 1,
          unknownCostRows: 1,
          costStatusUnknownRows: 1,
          unknownTokenRows: 1,
          tokensReportedUnknownRows: 1,
        }),
        rows: [row],
      },
      { graphId: 'g1', days: [] },
    )
    render(<UsagePanel open onOpenChange={() => {}} sessionId="sess-1" graphId="g1" />)

    await waitFor(() => {
      expect(screen.getByTestId('usage-money-status-unknown').textContent).toContain('历史行未标注定价状态')
    })
    // 不得被渲染成已定价的金额，也不是 $0.00
    expect(screen.queryByTestId('usage-money-amount')).toBeNull()
    expect(screen.queryByText('$0.00')).toBeNull()
    // 行级：按列显示「未标注」，不解析 note 得出「价格未知」
    const rowCost = screen.getByTestId('usage-row-cost').textContent ?? ''
    expect(rowCost).toContain('历史行未标注定价状态')
    expect(rowCost).not.toContain('价格未知')
    // token：NULL 显示占位符与「未标注」，绝不显示 0
    expect(screen.getByTestId('usage-tokens-empty').textContent).toBe('—')
    expect(screen.getByTestId('usage-tokens-status-unknown').textContent).toContain('历史行未标注 token 上报状态')
    const rowText = screen.getByTestId('usage-row').textContent ?? ''
    expect(rowText).toContain('token 上报状态未标注')
    expect(rowText).not.toContain('输入 0')
    // 分类计数也来自列：未标注单独计数，不算已定价/缺价
    expect(screen.getByTestId('usage-cost-quality').textContent).toContain('未标注 1')
    expect(screen.getByTestId('usage-token-quality').textContent).toContain('未标注 1')
  })

  it('legacy 无 turn_id：显示「未归属 turn」，不伪造 turn id', async () => {
    const row = usageRow({ turn_id: null })
    installApi(
      {
        sessionId: 'sess-1',
        summary: summary({ totalRows: 1, providerRows: 1, pricedRows: 1, tokensReportedRows: 1 }),
        rows: [row],
      },
      { graphId: 'g1', days: [] },
    )
    render(<UsagePanel open onOpenChange={() => {}} sessionId="sess-1" graphId="g1" />)

    await waitFor(() => {
      expect(screen.getByTestId('usage-turn-heading').textContent).toContain('未归属 turn')
    })
    expect(screen.getByTestId('usage-turn-heading').textContent).not.toContain('turn-1')
  })

  it('tokens_reported=0：显示「后端未上报 token」，不把缺失 token 渲染成 0', async () => {
    const row = usageRow({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      tokens_reported: 0,
    })
    installApi(
      {
        sessionId: 'sess-1',
        summary: summary({
          totalRows: 1,
          providerRows: 1,
          pricedRows: 1,
          unknownTokenRows: 1,
          tokensNotReportedRows: 1,
        }),
        rows: [row],
      },
      { graphId: 'g1', days: [] },
    )
    render(<UsagePanel open onOpenChange={() => {}} sessionId="sess-1" graphId="g1" />)

    await waitFor(() => {
      expect(screen.getByTestId('usage-row-tokens-not-reported').textContent).toContain('后端未上报 token')
    })
    expect(screen.getByTestId('usage-tokens-empty').textContent).toBe('—')
    expect(screen.getByTestId('usage-token-quality').textContent).toContain('未上报 1')
    expect(screen.getByTestId('usage-row').textContent).not.toContain('输入 0')
  })
})
