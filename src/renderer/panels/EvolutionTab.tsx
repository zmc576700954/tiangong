/**
 * 进化层只读视图（G2-3 命中 / G2-4 归因 / G2-16 校准报告）。
 *
 * 三块数据此前只在库里：`memory_hits`(v44) 写了没人看，`v_memory_attribution`(v46)
 * 与校准报告(v49) 连读取入口都没有。本面板只做展示，所有过滤/聚合都在主进程做，
 * 渲染层不碰 SQL，也没有任何写操作。
 *
 * 三种空态必须分开显示，否则用户无法判断「没数据」还是「这个库还没迁移」还是
 * 「读失败」：
 *  - `available=false` → 该库没有这张表/视图（老库，迁移未跑）；
 *  - `available=true` 且列表空 → 表在，但确实还没写进数据；
 *  - 请求 reject → 读取失败，把错误原文（经 `readIpcError` 还原）显示出来。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { useI18n } from '../i18n/useI18n'
import { readIpcError } from '../lib/ipc-error'
import type {
  AttributionListResult,
  CalibrationReportListResult,
  MemoryHitListResult,
} from '@shared/types/evolution'

const ipc = typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null

/** 展示条数：只读诊断视图，不是完整审计器，一次拉太多反而看不清。 */
const HIT_ROW_LIMIT = 50
const ATTRIBUTION_ROW_LIMIT = 50
const REPORT_LIMIT = 5

interface Loaded {
  hits: MemoryHitListResult | null
  attribution: AttributionListResult | null
  calibration: CalibrationReportListResult | null
}

interface Failure {
  hits?: string
  attribution?: string
  calibration?: string
  /** 整体失败（例如 preload 不存在）。 */
  all?: string
}

export function EvolutionTab() {
  const { t } = useI18n()
  const [data, setData] = useState<Loaded>({ hits: null, attribution: null, calibration: null })
  const [failure, setFailure] = useState<Failure>({})
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!ipc) {
      setFailure({ all: t('settings.evolution.noBridge') })
      return
    }
    setLoading(true)
    // 三条通道互不依赖：一条失败不该让另外两块空着，所以分别 catch。
    // 用 async 包装取调用：桥没装某条通道时 `ipc['x'](...)` 会**同步抛出**，
    // 直接写进数组会在 allSettled 之前就炸掉整个 load。
    const [hits, attribution, calibration] = await Promise.allSettled([
      (async () => ipc['map:memory:hits:list']({ limit: HIT_ROW_LIMIT }))(),
      (async () => ipc['map:memory:attribution:list']({ limit: ATTRIBUTION_ROW_LIMIT }))(),
      (async () => ipc['map:calibration:report:list'](REPORT_LIMIT))(),
    ])
    const nextFailure: Failure = {}
    setData({
      hits: hits.status === 'fulfilled' ? hits.value : null,
      attribution: attribution.status === 'fulfilled' ? attribution.value : null,
      calibration: calibration.status === 'fulfilled' ? calibration.value : null,
    })
    if (hits.status === 'rejected') nextFailure.hits = readIpcError(hits.reason).message
    if (attribution.status === 'rejected') {
      nextFailure.attribution = readIpcError(attribution.reason).message
    }
    if (calibration.status === 'rejected') {
      nextFailure.calibration = readIpcError(calibration.reason).message
    }
    setFailure(nextFailure)
    setLoading(false)
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-5" data-testid="evolution-tab">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t('settings.evolution.title')}</h3>
        <button
          onClick={() => void load()}
          disabled={loading}
          data-testid="evolution-refresh"
          className="p-1 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
          title={t('settings.evolution.refresh')}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {failure.all && (
        <p className="text-xs text-red-600" data-testid="evolution-bridge-error">
          {failure.all}
        </p>
      )}

      <section data-testid="evolution-hits-section">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          {t('settings.evolution.hits.title')}
        </h4>
        <SectionState
          available={data.hits?.available}
          empty={(data.hits?.rows.length ?? 0) === 0}
          error={failure.hits}
          testId="evolution-hits"
        >
          <div className="text-[11px] text-muted-foreground mb-2">
            {t('settings.evolution.hits.total', { total: String(data.hits?.total ?? 0) })}
            {'　'}
            {data.hits?.byKind.map((row) => `${row.key}=${row.count}`).join(' / ') ?? ''}
          </div>
          <div className="space-y-1">
            {data.hits?.rows.map((row) => (
              <div
                key={row.id}
                className="px-2 py-1.5 rounded border bg-muted/20 text-[11px] leading-relaxed"
              >
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                    {row.hitKind}
                  </span>
                  <span className="text-muted-foreground">
                    {row.sourceOutcome ?? t('settings.evolution.hits.unlabeled')}
                  </span>
                  <span className="ml-auto text-muted-foreground">
                    score {row.score.toFixed(2)}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[10px] break-all">{row.sourceRef}</div>
                <div className="text-[10px] text-muted-foreground break-all">
                  run {row.runId} · {row.createdAt}
                </div>
              </div>
            ))}
          </div>
        </SectionState>
      </section>

      <section data-testid="evolution-attribution-section">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          {t('settings.evolution.attribution.title')}
        </h4>
        <SectionState
          available={data.attribution?.available}
          empty={(data.attribution?.rows.length ?? 0) === 0}
          error={failure.attribution}
          testId="evolution-attribution"
        >
          <div className="grid grid-cols-2 gap-2 mb-2 text-[11px]">
            <Metric
              label={t('settings.evolution.attribution.totalRuns')}
              value={String(data.attribution?.summary.totalRuns ?? 0)}
            />
            <Metric
              label={t('settings.evolution.attribution.hitRate')}
              value={formatRate(data.attribution?.summary.hitRate ?? null, t('settings.evolution.attribution.noSample'))}
            />
            <Metric
              label={t('settings.evolution.attribution.withHit')}
              value={String(data.attribution?.summary.runsWithHit ?? 0)}
            />
            <Metric
              label={t('settings.evolution.attribution.sample')}
              value={t('settings.evolution.attribution.sampleValue', {
                min: String(data.attribution?.summary.minSample ?? 0),
                ok: String(data.attribution?.summary.groupsOk ?? 0),
                thin: String(data.attribution?.summary.groupsInsufficient ?? 0),
              })}
            />
          </div>
          <div className="space-y-1">
            {data.attribution?.rows.map((row) => (
              <div
                key={row.runId}
                className="px-2 py-1.5 rounded border bg-muted/20 text-[11px] flex items-center gap-2"
              >
                <span className="font-mono text-[10px] break-all">{row.runId}</span>
                <span className="text-muted-foreground">{row.adapter ?? '—'}</span>
                <span className="text-muted-foreground">{row.modeId ?? '—'}</span>
                <span className="ml-auto">
                  {t('settings.evolution.attribution.hits', { count: String(row.hitCount) })}
                </span>
                <span
                  className={
                    row.conclusion === 'ok'
                      ? 'text-green-700'
                      : 'text-amber-600'
                  }
                >
                  {t(
                    row.conclusion === 'ok'
                      ? 'settings.evolution.attribution.ok'
                      : 'settings.evolution.attribution.thin',
                  )}
                </span>
              </div>
            ))}
          </div>
        </SectionState>
      </section>

      <section data-testid="evolution-calibration-section">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          {t('settings.evolution.calibration.title')}
        </h4>
        <SectionState
          available={data.calibration?.available}
          empty={(data.calibration?.reports.length ?? 0) === 0}
          error={failure.calibration}
          testId="evolution-calibration"
        >
          <div className="space-y-2">
            {data.calibration?.reports.map((report) => (
              <div
                key={report.id}
                className="px-2 py-1.5 rounded border bg-muted/20 text-[11px] space-y-1"
                data-testid="evolution-calibration-report"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px]">{report.id}</span>
                  <span className="ml-auto text-muted-foreground">
                    {t('settings.evolution.calibration.runs', { count: String(report.runCount) })}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {report.windowStart ?? '—'} → {report.windowEnd ?? '—'}
                </div>
                {report.parseError && (
                  <div className="text-[10px] text-red-600">
                    {t('settings.evolution.calibration.parseError', { error: report.parseError })}
                  </div>
                )}
                {report.groups.map((group) => (
                  <div
                    key={`${group.derivationVersion}|${group.taskType}|${group.agentType ?? ''}`}
                    className="pl-2 border-l text-[10px] text-muted-foreground"
                  >
                    {group.taskType} · {group.derivationVersion} ·{' '}
                    {t('settings.evolution.calibration.groupRuns', { count: String(group.runCount) })}
                    {group.signals.length > 0 ? ` · ${group.signals.join(' / ')}` : ''}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </SectionState>
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 py-1 rounded border bg-muted/20">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-xs font-medium">{value}</div>
    </div>
  )
}

function formatRate(rate: number | null, empty: string): string {
  if (rate === null) return empty
  return `${(rate * 100).toFixed(1)}%`
}

interface SectionStateProps {
  available: boolean | undefined
  empty: boolean
  error?: string
  testId: string
  children: ReactNode
}

/** 把「未加载 / 不可用 / 空 / 失败」四种状态与正常内容分开，避免都渲染成空列表。 */
function SectionState({ available, empty, error, testId, children }: SectionStateProps) {
  const { t } = useI18n()
  if (error) {
    return (
      <p className="text-[11px] text-red-600" data-testid={`${testId}-error`}>
        {t('settings.evolution.loadFailed', { error })}
      </p>
    )
  }
  if (available === undefined) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid={`${testId}-loading`}>
        {t('settings.evolution.loading')}
      </p>
    )
  }
  if (!available) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid={`${testId}-unavailable`}>
        {t('settings.evolution.unavailable')}
      </p>
    )
  }
  if (empty) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid={`${testId}-empty`}>
        {t('settings.evolution.empty')}
      </p>
    )
  }
  return <>{children}</>
}
