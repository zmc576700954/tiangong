/**
 * 适配器健康度面板（D4）
 *
 * 设计哲学：
 * - 数据自洽：内部负责拉取、错误处理、30s 自动刷新；父组件只决定放在哪个容器。
 * - 状态显式：loading / data / error / empty 四态分得清楚，避免空数据时误以为"全是 healthy"。
 * - 零样本显式标注：未调用过的 adapter 不会出现在面板里（AdapterHealthMonitor 内部过滤），
 *   与 health.status === 'unknown'（单条样本为 0 时）的语义分开。
 * - 错误隔离：拉取失败弹 toast + 行内 banner，避免一个 stale 数据导致误导。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '../lib/utils'
import { toastError } from '../lib/toast'
import type { AdapterHealthScore } from '@shared/types'

interface AdapterHealthPanelProps {
  /** 渲染端 IPC 桥；测试可注入 mock */
  api?: { 'agent:getHealth': () => Promise<AdapterHealthScore[]> } | null
  /** 自动刷新间隔（毫秒）；传 0 关闭自动刷新；默认 30000 */
  autoRefreshMs?: number
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'data'; scores: AdapterHealthScore[] }
  | { kind: 'error'; message: string; previous: AdapterHealthScore[] | null }

const STATUS_LABEL: Record<AdapterHealthScore['status'], string> = {
  healthy: '健康',
  degraded: '降级',
  unhealthy: '故障',
  unknown: '未知',
}

/** status -> Tailwind 配色（背景 + 边框 + 文本）。统一这套避免散落 hardcode。 */
const STATUS_STYLE: Record<AdapterHealthScore['status'], string> = {
  healthy: 'bg-green-50 text-green-700 border-green-200',
  degraded: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  unhealthy: 'bg-red-50 text-red-700 border-red-200',
  unknown: 'bg-gray-50 text-gray-500 border-gray-200',
}

/** 简单时间格式化，避免额外 date-fns/dayjs 依赖。 */
function formatTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function AdapterHealthPanel({ api, autoRefreshMs = 30000 }: AdapterHealthPanelProps) {
  // 测试可通过 props.api 注入 mock；否则取真实 window.electronAPI
  const realApi = typeof window !== 'undefined' ? (window as unknown as { electronAPI?: AdapterHealthPanelProps['api'] }).electronAPI : undefined
  const ipc = api ?? realApi ?? null

  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  // ref 闭包用：保存最近一次成功数据，便于 error 时仍然显示
  const lastDataRef = useRef<AdapterHealthScore[] | null>(null)

  const fetchHealth = useCallback(async (mode: 'initial' | 'manual' | 'auto') => {
    if (!ipc) {
      setState({ kind: 'error', message: 'IPC bridge not available', previous: lastDataRef.current })
      return
    }
    if (mode === 'manual') setRefreshing(true)
    try {
      const scores = await ipc['agent:getHealth']()
      lastDataRef.current = scores
      setState({ kind: 'data', scores })
      setUpdatedAt(Date.now())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 手动刷新失败弹 toast；auto 失败只在 banner 上提示，避免被淹没
      if (mode === 'manual') {
        toastError('刷新健康度失败', msg)
      }
      setState({ kind: 'error', message: msg, previous: lastDataRef.current })
    } finally {
      if (mode === 'manual') setRefreshing(false)
    }
  }, [ipc])

  // 初次加载 + 自动刷新
  useEffect(() => {
    void fetchHealth('initial')
    if (!autoRefreshMs || autoRefreshMs <= 0) return undefined
    const id = setInterval(() => { void fetchHealth('auto') }, autoRefreshMs)
    return () => clearInterval(id)
  }, [fetchHealth, autoRefreshMs])

  const isLoading = state.kind === 'loading' || refreshing

  // 统一提取要展示的 scores：data 态用新数据，error 态有 stale 时退回旧数据
  const displayScores: AdapterHealthScore[] | null =
    state.kind === 'data'
      ? state.scores
      : state.kind === 'error' && state.previous
        ? state.previous
        : null

  return (
    <div className="space-y-3" data-testid="adapter-health-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">适配器健康度</h3>
          {updatedAt && (
            <span className="text-[10px] text-muted-foreground" data-testid="adapter-health-updated-at">
              上次刷新 {formatTime(updatedAt)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => { void fetchHealth('manual') }}
          disabled={isLoading}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-xs rounded border bg-background hover:bg-muted transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
          data-testid="adapter-health-refresh"
          aria-label="刷新健康度"
        >
          <RefreshCw className={cn('w-3 h-3', isLoading && 'animate-spin')} />
          刷新
        </button>
      </div>

      {/* 错误 banner：错误态时顶部展示；data 仍可用时（stale）下方表格照常渲染 */}
      {state.kind === 'error' && (
        <div
          className="flex items-start gap-2 px-3 py-2 rounded-md border border-red-200 bg-red-50 text-red-800 text-xs"
          data-testid="adapter-health-error"
          role="alert"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">健康度数据加载失败</div>
            <div className="opacity-90 mt-0.5 break-words">{state.message}</div>
          </div>
        </div>
      )}

      {/* 三态：loading / empty / data（data 包含 stale fallback） */}
      {displayScores === null && !refreshing && state.kind !== 'error' && (
        <div className="flex items-center justify-center py-10 text-xs text-muted-foreground" data-testid="adapter-health-loading">
          <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
          加载中…
        </div>
      )}

      {displayScores !== null && displayScores.length === 0 && (
        <div
          className="rounded-md border border-dashed bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground"
          data-testid="adapter-health-empty"
        >
          暂无适配器健康数据 — 触发任意一次 MCP / CLI 调用即可在此看到统计。
        </div>
      )}

      {displayScores !== null && displayScores.length > 0 && (
        <div className={cn('rounded-md border overflow-hidden', state.kind === 'error' && 'opacity-70')} data-testid="adapter-health-table">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">适配器</th>
                <th className="text-left font-medium px-3 py-2">状态</th>
                <th className="text-right font-medium px-3 py-2">成功率</th>
                <th className="text-right font-medium px-3 py-2">平均延迟</th>
                <th className="text-right font-medium px-3 py-2">总调用</th>
                <th className="text-left font-medium px-3 py-2">最近错误</th>
              </tr>
            </thead>
            <tbody>
              {displayScores.map((s) => (
                <tr
                  key={s.adapterName}
                  className="border-t hover:bg-muted/20"
                  data-testid={`adapter-health-row-${s.adapterName}`}
                  data-status={s.status}
                >
                  <td className="px-3 py-2 font-mono">{s.adapterName}</td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium',
                        STATUS_STYLE[s.status],
                      )}
                      data-testid={`adapter-health-badge-${s.adapterName}`}
                    >
                      {STATUS_LABEL[s.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {Number.isFinite(s.successRate) ? `${s.successRate.toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {Number.isFinite(s.avgResponseTimeMs) ? `${Math.round(s.avgResponseTimeMs)} ms` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.metrics.totalCalls}</td>
                  <td className="px-3 py-2 max-w-[260px]">
                    {s.metrics.recentErrors.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <ul className="space-y-0.5" data-testid={`adapter-health-errors-${s.adapterName}`}>
                        {s.metrics.recentErrors.map((err, idx) => (
                          <li key={idx} className="truncate text-red-700/80" title={err}>
                            {err}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
