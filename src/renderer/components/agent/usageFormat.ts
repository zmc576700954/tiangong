/**
 * M1 用量视图的纯格式化函数（与 React 组件分离，便于单测且不影响 Fast Refresh）。
 *
 * 分类只读列（`cost_status` / `tokens_reported`），绝不解析 `attribution_note` 文本：
 * 1. 无记录 ≠ 0：`totalRows === 0` 由调用方渲染「无记录」，不渲染 `$0.00`；
 * 2. 缺价 ≠ 0：`cost_status = 'missing_price'` 单独计数，金额只汇总有价行；
 * 3. 未标注 ≠ 已定价：迁移前历史行 `cost_status IS NULL`，既不算「已定价」也不算缺价；
 * 4. 后端未上报 ≠ 0：`tokens_reported = 0` 的行没有 token 数值，必须显示占位符。
 */

import type { AgentUsageRecord, UsageSummary } from '@shared/types/agent-runtime'

export type UsageMoneyState =
  | { kind: 'no-records' }
  | { kind: 'not-reported'; rows: number }
  | { kind: 'price-unknown'; rows: number }
  | {
      kind: 'status-unknown'
      rows: number
      missingPriceRows: number
      notReportedRows: number
    }
  | {
      kind: 'amount'
      usd: string
      micros: number
      unpricedRows: number
      notReportedRows: number
      statusUnknownRows: number
    }

/**
 * micros → USD 文本。真实 0 显示 $0.00（与「无记录」在 UI 层区分）。
 * 小于 1 美分时保留有效小数，避免把真实花费显示成 $0.00。
 */
export function formatUsdFromMicros(micros: number): string {
  if (!Number.isFinite(micros)) return '$0.00'
  const usd = micros / 1_000_000
  const fixed = Math.abs(usd) >= 0.01 ? usd.toFixed(2) : usd.toFixed(6)
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '')
  if (!trimmed.includes('.')) return `$${trimmed}.00`
  const decimals = trimmed.split('.')[1] ?? ''
  return `$${decimals.length >= 2 ? trimmed : `${trimmed}${'0'.repeat(2 - decimals.length)}`}`
}

/**
 * 汇总金额的展示状态。分支全部由 `cost_status` 列驱动：
 * 无记录 / 全部未上报 / 全部缺价 / 全部未标注 / 有金额（可能夹带缺价、未上报、未标注行）。
 */
export function describeUsageMoney(summary: UsageSummary): UsageMoneyState {
  if (summary.totalRows === 0) return { kind: 'no-records' }
  // 整批都是 not_reported：不是「缺价」，而是后端根本没给用量
  if (summary.notReportedRows >= summary.totalRows) {
    return { kind: 'not-reported', rows: summary.totalRows }
  }
  if (summary.missingPriceRows >= summary.totalRows) {
    return { kind: 'price-unknown', rows: summary.totalRows }
  }
  if (summary.notReportedRows + summary.missingPriceRows >= summary.totalRows) {
    return { kind: 'price-unknown', rows: summary.missingPriceRows }
  }
  // 一条已定价行都没有、且金额为 0：可能是全部历史行（cost_status IS NULL）。
  // 这种情况既不能说「已定价」，也不能渲染 $0.00。
  if (summary.pricedRows === 0 && summary.knownCostMicros === 0 && summary.costStatusUnknownRows > 0) {
    return {
      kind: 'status-unknown',
      rows: summary.costStatusUnknownRows,
      missingPriceRows: summary.missingPriceRows,
      notReportedRows: summary.notReportedRows,
    }
  }
  return {
    kind: 'amount',
    usd: formatUsdFromMicros(summary.knownCostMicros),
    micros: summary.knownCostMicros,
    unpricedRows: summary.missingPriceRows,
    notReportedRows: summary.notReportedRows,
    statusUnknownRows: summary.costStatusUnknownRows,
  }
}

/** null token 必须显示「—」，不能补 0（未上报/未标注行的 token 是未知而非零）。 */
export function formatTokenValue(value: number | null | undefined, noValue = '—'): string {
  if (value === null || value === undefined) return noValue
  return value.toLocaleString('en-US')
}

export function usageSourceKey(
  source: AgentUsageRecord['source'],
): 'agent.usage.provider' | 'agent.usage.estimated' | 'agent.usage.unknown' {
  if (source === 'provider') return 'agent.usage.provider'
  if (source === 'estimated') return 'agent.usage.estimated'
  return 'agent.usage.unknown'
}
