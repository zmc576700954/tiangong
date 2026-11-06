/**
 * M1 用量视图。
 *
 * 三条诚实原则（本组件存在的理由）：
 * 1. 无记录 ≠ 0：`totalRows === 0` 一律显示「无记录」，绝不渲染 `$0.00`；
 * 2. 缺价 ≠ 0：`cost_micros = NULL` 的行单独计数，金额只汇总有价行，
 *    全缺价时显示「价格未知」；
 * 3. 后端未上报 ≠ 0：`source = 'unknown'` 显示「后端未上报用量」，token 不补 0。
 *
 * 时区：`day_key` 由主进程 localDayKey() 按 Asia/Shanghai 生成，这里只做字符串展示，
 * 不做任何 Date 解析/二次切日。
 */

import { useEffect, useMemo, useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { useI18n } from '../../i18n/useI18n'
import type {
  AgentUsageRecord,
  GraphUsageView,
  SessionUsageView,
  UsageSummary,
} from '@shared/types/agent-runtime'
import {
  describeUsageMoney,
  formatTokenValue,
  formatUsdFromMicros,
  usageSourceKey,
} from './usageFormat'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string | null
  graphId: string | null
}

function MoneyView({ summary }: { summary: UsageSummary }) {
  const { t } = useI18n()
  const money = describeUsageMoney(summary)
  if (money.kind === 'no-records') {
    return (
      <span className="text-sm text-muted-foreground" data-testid="usage-money-empty">
        {t('agent.usage.noRecords')}
      </span>
    )
  }
  if (money.kind === 'not-reported') {
    return (
      <div className="text-sm" data-testid="usage-money-not-reported">
        <div className="font-medium">{t('agent.usage.notReported')}</div>
        <div className="text-[10px] text-muted-foreground">
          {t('agent.usage.notReportedNote', { count: money.rows })}
        </div>
      </div>
    )
  }
  if (money.kind === 'price-unknown') {
    return (
      <div className="text-sm" data-testid="usage-money-price-unknown">
        <div className="font-medium">{t('agent.usage.priceUnknown')}</div>
        <div className="text-[10px] text-muted-foreground">
          {t('agent.usage.priceUnknownNote', { count: money.rows })}
        </div>
      </div>
    )
  }
  if (money.kind === 'status-unknown') {
    return (
      <div className="text-sm" data-testid="usage-money-status-unknown">
        <div className="font-medium">{t('agent.usage.costStatusUnknown')}</div>
        <div className="text-[10px] text-muted-foreground">
          {t('agent.usage.costStatusUnknownNote', { count: money.rows })}
        </div>
        {money.missingPriceRows > 0 && (
          <div className="text-[10px] text-muted-foreground">
            {t('agent.usage.priceUnknownNote', { count: money.missingPriceRows })}
          </div>
        )}
        {money.notReportedRows > 0 && (
          <div className="text-[10px] text-muted-foreground">
            {t('agent.usage.notReportedNote', { count: money.notReportedRows })}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="text-sm" data-testid="usage-money-amount" title={`${money.micros} micros`}>
      <div className="font-medium">
        {t('agent.usage.costMicros', { usd: money.usd, micros: money.micros.toLocaleString('en-US') })}
      </div>
      {money.unpricedRows > 0 && (
        <div className="text-[10px] text-muted-foreground" data-testid="usage-money-partial-unknown">
          {t('agent.usage.priceUnknownNote', { count: money.unpricedRows })}
        </div>
      )}
      {money.notReportedRows > 0 && (
        <div className="text-[10px] text-muted-foreground" data-testid="usage-money-partial-not-reported">
          {t('agent.usage.notReportedNote', { count: money.notReportedRows })}
        </div>
      )}
      {money.statusUnknownRows > 0 && (
        <div className="text-[10px] text-muted-foreground" data-testid="usage-money-partial-status-unknown">
          {t('agent.usage.costStatusUnknownNote', { count: money.statusUnknownRows })}
        </div>
      )}
    </div>
  )
}

/** Token 分类提示：全部由 tokens_reported 列驱动，不解析 attribution_note。 */
function TokenNotes({ summary }: { summary: UsageSummary }) {
  const { t } = useI18n()
  return (
    <>
      {summary.tokensNotReportedRows > 0 && (
        <div className="text-[10px] text-muted-foreground" data-testid="usage-tokens-partial-unknown">
          {t('agent.usage.tokensPartialUnknown', { count: summary.tokensNotReportedRows })}
        </div>
      )}
      {summary.tokensReportedUnknownRows > 0 && (
        <div className="text-[10px] text-muted-foreground" data-testid="usage-tokens-status-unknown">
          {t('agent.usage.tokensStatusUnknownNote', { count: summary.tokensReportedUnknownRows })}
        </div>
      )}
    </>
  )
}

function TokenBlock({ summary }: { summary: UsageSummary }) {
  const { t } = useI18n()
  // token 全未知时显示占位符：0 是「真的用了 0」，与「后端没报」不是一回事。
  if (summary.totalRows === 0 || summary.unknownTokenRows >= summary.totalRows) {
    return (
      <div className="space-y-1" data-testid="usage-tokens-empty-block">
        <div className="text-sm text-muted-foreground" data-testid="usage-tokens-empty">
          {t('agent.usage.noValue')}
        </div>
        <TokenNotes summary={summary} />
      </div>
    )
  }
  return (
    <div className="space-y-1" data-testid="usage-tokens">
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="text-muted-foreground">{t('agent.usage.input')}</div>
          <div className="font-medium" data-testid="usage-tokens-input">{formatTokenValue(summary.inputTokens, t('agent.usage.noValue'))}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('agent.usage.output')}</div>
          <div className="font-medium" data-testid="usage-tokens-output">{formatTokenValue(summary.outputTokens, t('agent.usage.noValue'))}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('agent.usage.cache')}</div>
          <div className="font-medium" data-testid="usage-tokens-cache">{formatTokenValue(summary.cachedInputTokens, t('agent.usage.noValue'))}</div>
        </div>
      </div>
      <TokenNotes summary={summary} />
    </div>
  )
}

function QualityLine({ summary }: { summary: UsageSummary }) {
  const { t } = useI18n()
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] text-muted-foreground" data-testid="usage-quality">
        {t('agent.usage.quality')} ·{' '}
        {t('agent.usage.qualityLine', {
          total: summary.totalRows,
          provider: summary.providerRows,
          estimated: summary.estimatedRows,
          unknown: summary.unknownRows,
          unpriced: summary.missingPriceRows,
        })}
      </div>
      {/* 定价分类：cost_status 列驱动；NULL 单独计数，不算「已定价」 */}
      <div className="text-[10px] text-muted-foreground" data-testid="usage-cost-quality">
        {t('agent.usage.costQualityLine', {
          priced: summary.pricedRows,
          missing: summary.missingPriceRows,
          notReported: summary.notReportedRows,
          unknown: summary.costStatusUnknownRows,
        })}
      </div>
      {/* Token 上报分类：tokens_reported 列驱动；NULL（无 token 概念/历史行）单独计数 */}
      <div className="text-[10px] text-muted-foreground" data-testid="usage-token-quality">
        {t('agent.usage.tokenQualityLine', {
          reported: summary.tokensReportedRows,
          notReported: summary.tokensNotReportedRows,
          unknown: summary.tokensReportedUnknownRows,
        })}
      </div>
    </div>
  )
}

function UsageRow({ row }: { row: AgentUsageRecord }) {
  const { t } = useI18n()
  const sourceLabel = t(usageSourceKey(row.source))
  // 定价文案只看 cost_status：NULL 是「历史行未标注」，不是「已定价」也不是 $0.00。
  const costText =
    row.source === 'unknown'
      ? t('agent.usage.notReported')
      : row.cost_status === 'missing_price'
        ? t('agent.usage.priceUnknown')
        : row.cost_micros !== null && row.cost_micros !== undefined
          ? formatUsdFromMicros(row.cost_micros)
          : row.cost_status === 'priced'
            ? t('agent.usage.priceUnknown')
            : t('agent.usage.costStatusUnknown')
  const unlabeledCost = row.cost_status === null && row.source !== 'unknown'
  return (
    <div className="rounded-md border border-border/60 px-2 py-1.5 text-[11px]" data-testid="usage-row">
      <div className="flex items-center justify-between gap-2">
        <span
          className={
            row.source === 'provider'
              ? 'text-emerald-600'
              : row.source === 'estimated'
                ? 'text-amber-600'
                : 'text-red-500'
          }
          data-testid="usage-row-source"
        >
          {sourceLabel}
        </span>
        <span className="text-muted-foreground">{row.model ?? row.executor}</span>
        <span className="ml-auto font-medium" data-testid="usage-row-cost">
          {costText}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-muted-foreground">
        {row.source === 'unknown' ? (
          <span data-testid="usage-row-not-reported">{t('agent.usage.notReported')}</span>
        ) : row.tokens_reported === 0 ? (
          <span data-testid="usage-row-tokens-not-reported">{t('agent.usage.tokensNotReported')}</span>
        ) : (
          <span>
            {t('agent.usage.input')} {formatTokenValue(row.input_tokens, t('agent.usage.noValue'))} ·{' '}
            {t('agent.usage.output')} {formatTokenValue(row.output_tokens, t('agent.usage.noValue'))} ·{' '}
            {t('agent.usage.cache')} {formatTokenValue(row.cached_input_tokens, t('agent.usage.noValue'))}
            {row.tokens_reported === null && (
              <span data-testid="usage-row-tokens-status-unknown"> · {t('agent.usage.tokensStatusUnknown')}</span>
            )}
          </span>
        )}
        {unlabeledCost && row.cost_micros !== null && (
          <span className="text-[10px]" data-testid="usage-row-cost-status-unknown">
            {t('agent.usage.costStatusUnknown')}
          </span>
        )}
        {row.cost_micros !== null && row.cost_status !== null && (
          <span className="ml-auto" data-testid="usage-row-micros">{row.cost_micros.toLocaleString('en-US')} micros</span>
        )}
      </div>
    </div>
  )
}

export function UsagePanel({ open, onOpenChange, sessionId, graphId }: Props) {
  const { t } = useI18n()
  const [sessionView, setSessionView] = useState<SessionUsageView | null>(null)
  const [graphView, setGraphView] = useState<GraphUsageView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setSessionView(null)
    setGraphView(null)
    const api = window.electronAPI
    const sessionPromise = sessionId
      ? api['agent:getUsageBySession'](sessionId)
      : Promise.resolve(null)
    const graphPromise = graphId
      ? api['agent:getUsageByGraph'](graphId)
      : Promise.resolve(null)
    void Promise.allSettled([sessionPromise, graphPromise]).then(([s, g]) => {
      if (cancelled) return
      if (s.status === 'fulfilled') setSessionView(s.value)
      if (g.status === 'fulfilled') setGraphView(g.value)
      const failure = s.status === 'rejected' ? s : g.status === 'rejected' ? g : null
      if (failure) {
        const reason = failure.reason as unknown
        setError(reason instanceof Error ? reason.message : String(reason))
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, sessionId, graphId])

  // 明细按 turn 分组（行序已按 recorded_at 倒序，Map 保序即最近 turn 在前）。
  const turnGroups = useMemo(() => {
    const groups = new Map<string, AgentUsageRecord[]>()
    for (const row of sessionView?.rows ?? []) {
      const key = row.turn_id ?? ''
      const list = groups.get(key)
      if (list) list.push(row)
      else groups.set(key, [row])
    }
    return Array.from(groups.entries())
  }, [sessionView])

  const dayRows = graphView?.days ?? []
  const sessionEmpty = sessionView !== null && sessionView.summary.totalRows === 0
  const graphEmpty = graphView !== null && dayRows.length === 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[460px] sm:max-w-[460px] overflow-y-auto" closeLabel={t('common.close')} data-testid="usage-panel">
        <SheetHeader>
          <SheetTitle>{t('agent.usage.title')}</SheetTitle>
        </SheetHeader>

        {/* 最关键的一句：上线前无记录，空白不等于 0 */}
        <div
          className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300"
          data-testid="usage-history-note"
        >
          {t('agent.usage.historyNote')}
        </div>

        {loading && (
          <div className="mt-3 text-xs text-muted-foreground" data-testid="usage-loading">{t('agent.usage.loading')}</div>
        )}
        {error && (
          <div className="mt-3 text-xs text-red-500" data-testid="usage-error">
            {t('agent.usage.loadFailed', { message: error })}
          </div>
        )}

        {/* —— 会话级 —— */}
        <section className="mt-4 space-y-2" data-testid="usage-session-section">
          <h3 className="text-xs font-medium">{t('agent.usage.session')}</h3>
          {!sessionId && (
            <div className="text-xs text-muted-foreground" data-testid="usage-no-session">{t('agent.usage.noSession')}</div>
          )}
          {sessionId && sessionEmpty && (
            <div className="text-xs text-muted-foreground" data-testid="usage-session-empty">
              {t('agent.usage.sessionEmpty')}
            </div>
          )}
          {sessionId && sessionView && !sessionEmpty && (
            <div className="rounded-md border border-border px-2.5 py-2 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <MoneyView summary={sessionView.summary} />
                <span className="text-[10px] text-muted-foreground">{t('agent.usage.cost')}</span>
              </div>
              <TokenBlock summary={sessionView.summary} />
              <QualityLine summary={sessionView.summary} />
            </div>
          )}

          {sessionId && !sessionEmpty && turnGroups.length > 1 && (
            <div className="text-[10px] text-muted-foreground">{t('agent.usage.detail')}</div>
          )}
          {sessionId && !sessionEmpty && turnGroups.map(([turnId, rows]) => (
            <div key={turnId || 'no-turn'} className="space-y-1">
              <div className="text-[10px] text-muted-foreground" data-testid="usage-turn-heading">
                {t('agent.usage.turn')}: {turnId || t('agent.usage.noTurn')}
              </div>
              {rows.map((row) => <UsageRow key={row.id} row={row} />)}
            </div>
          ))}
        </section>

        {/* —— 项目/图级按日 —— */}
        <section className="mt-5 space-y-2" data-testid="usage-graph-section">
          <h3 className="text-xs font-medium">{t('agent.usage.graphDays')}</h3>
          {!graphId && (
            <div className="text-xs text-muted-foreground" data-testid="usage-no-graph">{t('agent.usage.noGraph')}</div>
          )}
          {graphId && graphEmpty && (
            <div className="text-xs text-muted-foreground" data-testid="usage-graph-empty">
              {t('agent.usage.graphEmpty')}
            </div>
          )}
          {graphId && dayRows.length > 0 && (
            <div className="space-y-1.5">
              {/* day_key 原样展示：主进程已按 Asia/Shanghai 切日，渲染层不再二次换算 */}
              {dayRows.map((day) => (
                <div key={day.dayKey} className="rounded-md border border-border px-2.5 py-2 space-y-1.5" data-testid="usage-day-row">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium" data-testid="usage-day-key">{day.dayKey}</span>
                    <span className="text-[10px] text-muted-foreground">{t('agent.usage.day')}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <MoneyView summary={day} />
                    <TokenBlock summary={day} />
                  </div>
                  <QualityLine summary={day} />
                </div>
              ))}
            </div>
          )}
        </section>
      </SheetContent>
    </Sheet>
  )
}
