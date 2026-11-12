// @vitest-environment jsdom
/**
 * 进化层只读页（v3.25）。
 *
 * 这一页最容易出的错是「把三种空态混成一个空列表」，所以断言按状态分：
 * - 表/视图缺失（`available:false`）→ 说「迁移未跑」，不是没有数据；
 * - 表在但没行 → 说「还没有数据」；
 * - 读取失败 → 显示错误原文，不伪装成空；
 * - 正常 → 命中/归因/校准三块内容都上屏。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type {
  AttributionListResult,
  CalibrationReportListResult,
  MemoryHitListResult,
} from '@shared/types/evolution'

const listHits = vi.fn<() => Promise<MemoryHitListResult>>()
const listAttribution = vi.fn<() => Promise<AttributionListResult>>()
const listCalibration = vi.fn<() => Promise<CalibrationReportListResult>>()

let api: Record<string, unknown>

function makeApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'map:memory:hits:list': listHits,
    'map:memory:attribution:list': listAttribution,
    'map:calibration:report:list': listCalibration,
    ...overrides,
  }
}

function emptyHits(available = true): MemoryHitListResult {
  return { available, rows: [], total: 0, byKind: [], byOutcome: [] }
}

function emptyAttribution(available = true): AttributionListResult {
  return {
    available,
    rows: [],
    total: 0,
    summary: {
      totalRuns: 0,
      runsWithHit: 0,
      hitRate: null,
      byOutcome: [],
      minSample: 20,
      groupsOk: 0,
      groupsInsufficient: 0,
    },
  }
}

function emptyCalibration(available = true): CalibrationReportListResult {
  return { available, reports: [] }
}

beforeEach(() => {
  listHits.mockReset().mockResolvedValue(emptyHits())
  listAttribution.mockReset().mockResolvedValue(emptyAttribution())
  listCalibration.mockReset().mockResolvedValue(emptyCalibration())
  api = makeApi()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = api
})

// 模块加载时抓 window.electronAPI —— 必须先 mock 再 import
async function mountTab() {
  const { EvolutionTab } = await import('../EvolutionTab')
  return render(<EvolutionTab />)
}

describe('EvolutionTab 状态区分', () => {
  it('表/视图缺失时说「迁移未跑」，不说「没有数据」', async () => {
    listHits.mockResolvedValue(emptyHits(false))
    listAttribution.mockResolvedValue(emptyAttribution(false))
    listCalibration.mockResolvedValue(emptyCalibration(false))
    await mountTab()

    await waitFor(() => expect(screen.getByTestId('evolution-hits-unavailable')).toBeTruthy())
    expect(screen.getByTestId('evolution-attribution-unavailable')).toBeTruthy()
    expect(screen.getByTestId('evolution-calibration-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('evolution-hits-empty')).toBeNull()
  })

  it('表在但无行时说「还没有数据」', async () => {
    await mountTab()
    await waitFor(() => expect(screen.getByTestId('evolution-hits-empty')).toBeTruthy())
    expect(screen.getByTestId('evolution-attribution-empty')).toBeTruthy()
    expect(screen.getByTestId('evolution-calibration-empty')).toBeTruthy()
  })

  it('三条通道互不牵连：一条失败，另外两条照常显示', async () => {
    listHits.mockRejectedValue(new Error("Error invoking remote method 'map:memory:hits:list': db locked"))
    listAttribution.mockResolvedValue({
      ...emptyAttribution(),
      rows: [
        {
          runId: 'run_ok',
          stepId: null,
          graphId: 'g1',
          adapter: 'claude',
          modeId: 'm1',
          outcome: 'completed',
          hitCount: 2,
          evidenceLevel: 2,
          sampleSize: 3,
          conclusion: 'insufficient_sample',
        },
      ],
      total: 1,
      summary: {
        ...emptyAttribution().summary,
        totalRuns: 1,
        runsWithHit: 1,
        hitRate: 1,
      },
    })
    await mountTab()

    await waitFor(() => expect(screen.getByTestId('evolution-hits-error')).toBeTruthy())
    // 错误原文带通道名前缀已被剥掉
    expect(screen.getByTestId('evolution-hits-error').textContent).toContain('db locked')
    expect(screen.getByTestId('evolution-hits-error').textContent).not.toContain(
      'Error invoking remote method',
    )
    expect(screen.getByText(/run_ok/)).toBeTruthy()
    // 归因正常时不该出现空态
    expect(screen.queryByTestId('evolution-attribution-empty')).toBeNull()
  })

  it('正常数据把三块内容都渲染出来（命中引用、命中率、校准分组）', async () => {
    listHits.mockResolvedValue({
      available: true,
      rows: [
        {
          id: 'h1',
          projectPath: '/p/a',
          graphId: 'g1',
          nodeId: null,
          workItemId: null,
          runId: 'run_1',
          stepId: null,
          hitKind: 'evidence',
          sourceOutcome: null,
          sourceRef: 'node_evidence:ev_1',
          score: 0.8,
          createdAt: '2026-11-12T00:00:00.000Z',
        },
      ],
      total: 1,
      byKind: [{ key: 'evidence', count: 1 }],
      byOutcome: [{ key: 'unknown', count: 1 }],
    })
    listCalibration.mockResolvedValue({
      available: true,
      reports: [
        {
          id: 'cal_1',
          startedAt: '2026-11-10T00:00:00.000Z',
          finishedAt: '2026-11-10T00:00:01.000Z',
          status: 'ok',
          windowStart: '2026-10-27T00:00:00.000Z',
          windowEnd: '2026-11-10T00:00:00.000Z',
          runCount: 24,
          minRuns: 20,
          groups: [
            {
              derivationVersion: 'd1',
              observedRuleVersion: 'd1',
              taskType: 'bugfix',
              agentType: null,
              runCount: 24,
              fileRatio: 1.8,
              subtaskRatio: 1,
              replanMedian: 3,
              reworkCount: 2,
              testFailures: 1,
              scopeViolationRate: 0.125,
              boundaryChangedRate: 0,
              signals: ['file_growth_gt_1_5'],
            },
          ],
          parseError: null,
        },
      ],
    })
    listAttribution.mockResolvedValue({
      ...emptyAttribution(),
      rows: [
        {
          runId: 'run_1',
          stepId: null,
          graphId: 'g1',
          adapter: 'claude',
          modeId: 'm1',
          outcome: 'completed',
          hitCount: 1,
          evidenceLevel: 2,
          sampleSize: 24,
          conclusion: 'ok',
        },
      ],
      total: 1,
      summary: {
        totalRuns: 1,
        runsWithHit: 1,
        hitRate: 1,
        byOutcome: [{ key: 'completed', count: 1 }],
        minSample: 20,
        groupsOk: 1,
        groupsInsufficient: 0,
      },
    })
    await mountTab()

    await waitFor(() => expect(screen.getByText('node_evidence:ev_1')).toBeTruthy())
    expect(screen.getByText('100.0%')).toBeTruthy()
    expect(screen.getByTestId('evolution-calibration-report')).toBeTruthy()
    expect(screen.getByText(/bugfix/)).toBeTruthy()
    expect(screen.getByText(/file_growth_gt_1_5/)).toBeTruthy()
    // 未标注终态要说出来，不能显示成 completed
    expect(screen.getByText('未标注终态')).toBeTruthy()
  })

  it('stats_json 坏掉的报告仍显示，并标出解析失败', async () => {
    listCalibration.mockResolvedValue({
      available: true,
      reports: [
        {
          id: 'cal_broken',
          startedAt: '2026-11-09T00:00:00.000Z',
          finishedAt: null,
          status: 'ok',
          windowStart: null,
          windowEnd: null,
          runCount: 0,
          minRuns: 0,
          groups: [],
          parseError: 'Unexpected token n in JSON',
        },
      ],
    })
    await mountTab()
    await waitFor(() => expect(screen.getByTestId('evolution-calibration-report')).toBeTruthy())
    expect(screen.getByText(/Unexpected token n in JSON/)).toBeTruthy()
  })
})
