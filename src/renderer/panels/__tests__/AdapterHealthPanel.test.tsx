// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { AdapterHealthPanel } from '../AdapterHealthPanel'
import { ToastContainer, useToastStore } from '../../lib/toast'
import type { AdapterHealthScore } from '@shared/types'

function renderWithToast(ui: React.ReactElement) {
  return render(
    <>
      {ui}
      <ToastContainer />
    </>,
  )
}

/** 清空 toast store，避免上一个测试的 toast 影响下一个测试 */
function clearToasts(): void {
  useToastStore.getState().clear()
}

function makeScore(overrides: Partial<AdapterHealthScore> = {}): AdapterHealthScore {
  const adapterName = overrides.adapterName ?? 'mcp'
  return {
    adapterName,
    healthScore: 90,
    successRate: 95,
    avgResponseTimeMs: 1200,
    status: 'healthy',
    metrics: {
      totalCalls: 20,
      successCalls: 19,
      failedCalls: 1,
      avgResponseTimeMs: 1200,
      recentErrors: [],
      lastCalledAt: Date.now() - 5000,
    },
    ...overrides,
  }
}

function makeApiMock(scores: AdapterHealthScore[]) {
  return {
    'agent:getHealth': vi.fn(async () => scores),
  }
}

describe('AdapterHealthPanel — 三态渲染', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    clearToasts()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('initial loading 状态显示 loading 文案', () => {
    // 永不 resolve 让 fetch 一直挂着，便于观察 loading 态
    const api = {
      'agent:getHealth': vi.fn(() => new Promise<AdapterHealthScore[]>(() => { /* pending */ })),
    }
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)
    expect(screen.getByTestId('adapter-health-loading')).toBeTruthy()
    expect(screen.getByText('加载中…')).toBeTruthy()
  })

  it('data 状态渲染表格 + 状态徽章 + 指标', async () => {
    const scores = [
      makeScore({ adapterName: 'mcp', status: 'healthy', successRate: 98, metrics: { totalCalls: 50, successCalls: 49, failedCalls: 1, avgResponseTimeMs: 800, recentErrors: [], lastCalledAt: Date.now() } }),
      makeScore({ adapterName: 'codex', status: 'degraded', successRate: 60, metrics: { totalCalls: 10, successCalls: 6, failedCalls: 4, avgResponseTimeMs: 4500, recentErrors: ['timeout x2'], lastCalledAt: Date.now() } }),
      makeScore({ adapterName: 'opencode', status: 'unhealthy', successRate: 10, metrics: { totalCalls: 20, successCalls: 2, failedCalls: 18, avgResponseTimeMs: 12000, recentErrors: ['ECONNREFUSED', 'pipe broken'], lastCalledAt: Date.now() } }),
    ]
    const api = makeApiMock(scores)

    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)

    await waitFor(() => {
      expect(screen.getByTestId('adapter-health-table')).toBeTruthy()
    })

    // 行存在
    expect(screen.getByTestId('adapter-health-row-mcp')).toBeTruthy()
    expect(screen.getByTestId('adapter-health-row-codex')).toBeTruthy()
    expect(screen.getByTestId('adapter-health-row-opencode')).toBeTruthy()

    // 状态徽章文案（中文映射）
    expect(screen.getByTestId('adapter-health-badge-mcp').textContent).toContain('健康')
    expect(screen.getByTestId('adapter-health-badge-codex').textContent).toContain('降级')
    expect(screen.getByTestId('adapter-health-badge-opencode').textContent).toContain('故障')

    // 指标列
    expect(screen.getByText('98.0%')).toBeTruthy()
    expect(screen.getByText('60.0%')).toBeTruthy()
    expect(screen.getByText('10.0%')).toBeTruthy()

    // recent errors 渲染
    expect(screen.getByText('timeout x2')).toBeTruthy()
    expect(screen.getByText('ECONNREFUSED')).toBeTruthy()
    expect(screen.getByText('pipe broken')).toBeTruthy()
  })

  it('error 状态显示 banner 文案 + toast 错误', async () => {
    const api = {
      'agent:getHealth': vi.fn(async () => { throw new Error('boom — network down') }),
    }

    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)

    const banner = await screen.findByTestId('adapter-health-error')
    expect(banner.textContent).toContain('健康度数据加载失败')
    expect(banner.textContent).toContain('boom — network down')
  })

  it('empty data 状态显示占位文案', async () => {
    const api = makeApiMock([])
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)

    const empty = await screen.findByTestId('adapter-health-empty')
    expect(empty.textContent).toContain('暂无适配器健康数据')
  })

  it('IPC 不可用时直接进入 error 状态', async () => {
    renderWithToast(<AdapterHealthPanel api={null} autoRefreshMs={0} />)

    const banner = await screen.findByTestId('adapter-health-error')
    expect(banner.textContent).toContain('IPC bridge not available')
  })
})

describe('AdapterHealthPanel — 颜色映射', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); clearToasts() })
  afterEach(() => { vi.useRealTimers() })

  it('healthy 状态使用 green 配色类', async () => {
    const api = makeApiMock([makeScore({ adapterName: 'a', status: 'healthy' })])
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)
    await waitFor(() => screen.getByTestId('adapter-health-table'))
    const badge = screen.getByTestId('adapter-health-badge-a')
    expect(badge.className).toContain('bg-green-50')
    expect(badge.className).toContain('text-green-700')
  })

  it('degraded 状态使用 yellow 配色类', async () => {
    const api = makeApiMock([makeScore({ adapterName: 'b', status: 'degraded' })])
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)
    await waitFor(() => screen.getByTestId('adapter-health-table'))
    const badge = screen.getByTestId('adapter-health-badge-b')
    expect(badge.className).toContain('bg-yellow-50')
    expect(badge.className).toContain('text-yellow-700')
  })

  it('unhealthy 状态使用 red 配色类', async () => {
    const api = makeApiMock([makeScore({ adapterName: 'c', status: 'unhealthy' })])
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)
    await waitFor(() => screen.getByTestId('adapter-health-table'))
    const badge = screen.getByTestId('adapter-health-badge-c')
    expect(badge.className).toContain('bg-red-50')
    expect(badge.className).toContain('text-red-700')
  })

  it('unknown 状态使用 gray 配色类', async () => {
    const api = makeApiMock([makeScore({ adapterName: 'd', status: 'unknown', healthScore: 0, successRate: 0 })])
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)
    await waitFor(() => screen.getByTestId('adapter-health-table'))
    const badge = screen.getByTestId('adapter-health-badge-d')
    expect(badge.className).toContain('bg-gray-50')
    expect(badge.className).toContain('text-gray-500')
  })
})

describe('AdapterHealthPanel — 刷新按钮与自动刷新', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); clearToasts() })
  afterEach(() => { vi.useRealTimers() })

  it('点击刷新按钮触发 IPC 调用', async () => {
    const api = makeApiMock([makeScore({ adapterName: 'mcp' })])
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)

    // 初次加载
    await waitFor(() => screen.getByTestId('adapter-health-table'))
    expect(api['agent:getHealth']).toHaveBeenCalledTimes(1)

    // 点击刷新
    const btn = screen.getByTestId('adapter-health-refresh')
    await act(async () => {
      fireEvent.click(btn)
    })

    await waitFor(() => {
      expect(api['agent:getHealth']).toHaveBeenCalledTimes(2)
    })
  })

  it('autoRefreshMs > 0 时自动触发再次拉取', async () => {
    const api = makeApiMock([makeScore({ adapterName: 'mcp' })])
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={1000} />)

    // 初次
    await waitFor(() => screen.getByTestId('adapter-health-table'))
    expect(api['agent:getHealth']).toHaveBeenCalledTimes(1)

    // 推进 1s — 触发 auto refresh
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })

    await waitFor(() => {
      expect(api['agent:getHealth']).toHaveBeenCalledTimes(2)
    })
  })

  it('autoRefreshMs = 0 时不自动刷新', async () => {
    const api = makeApiMock([makeScore({ adapterName: 'mcp' })])
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)

    await waitFor(() => screen.getByTestId('adapter-health-table'))
    expect(api['agent:getHealth']).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    // 仍只有初次调用
    expect(api['agent:getHealth']).toHaveBeenCalledTimes(1)
  })

  it('手动刷新失败时弹 toast 错误', async () => {
    const api = {
      'agent:getHealth': vi.fn()
        .mockResolvedValueOnce([makeScore({ adapterName: 'mcp' })])   // initial 成功
        .mockRejectedValueOnce(new Error('boom — manual fail')),       // manual 失败
    }
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)

    await waitFor(() => screen.getByTestId('adapter-health-table'))

    const btn = screen.getByTestId('adapter-health-refresh')
    await act(async () => {
      fireEvent.click(btn)
    })

    // toast.error 容器出现
    await waitFor(() => {
      expect(screen.getByTestId('toast-error')).toBeTruthy()
    })
  })
})

describe('AdapterHealthPanel — stale data', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); clearToasts() })
  afterEach(() => { vi.useRealTimers() })

  it('error + stale data 时保留旧数据展示', async () => {
    const stale: AdapterHealthScore[] = [
      makeScore({ adapterName: 'mcp', status: 'healthy', successRate: 92 }),
    ]
    const api = {
      'agent:getHealth': vi.fn()
        .mockResolvedValueOnce(stale)            // initial OK
        .mockRejectedValueOnce(new Error('flaky')), // manual fail
    }
    renderWithToast(<AdapterHealthPanel api={api} autoRefreshMs={0} />)

    await waitFor(() => screen.getByTestId('adapter-health-table'))

    const btn = screen.getByTestId('adapter-health-refresh')
    await act(async () => {
      fireEvent.click(btn)
    })

    await waitFor(() => {
      // error banner 出现，且旧数据行仍可见
      expect(screen.getByTestId('adapter-health-error')).toBeTruthy()
      expect(screen.getByTestId('adapter-health-row-mcp')).toBeTruthy()
    })
  })
})
