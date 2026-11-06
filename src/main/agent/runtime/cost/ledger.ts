/**
 * M1 成本账本：reportUsage() 的订阅落库点。
 *
 * 职责：
 * - 计价：按 (executor, model) 查价格表，整数 micros 计算；
 *   缺价 → cost_micros=NULL + attribution_note 记 missing_price，**不产生错误金额**；
 * - 幂等：dedupeKey 命中时——已有 provider 行直接返回（重复上报不重复计费）；
 *   已有 estimated/unknown 行被 provider 真实用量「升级」覆盖（同一物理 turn
 *   可能先落 unknown/estimated、后到真实 usage）；
 * - source 语义：provider=后端真实用量 / estimated=估算 / unknown=后端未上报。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { AgentRepository, type AgentUsageRow, type GraphDayUsageSummary, type UsageSummary } from '../db/repository'
import { localDayKey } from '../util'
import { costMicrosOf, loadPricing, resolvePrice, type PriceEntry, type PricingTable } from './pricing'
import type { UsageCostStatus } from '@shared/types/agent-runtime'

export type UsageSource = 'provider' | 'estimated' | 'unknown'

export interface UsageRecordInput {
  /** kernel 路径有 turn；legacy 路径为 null（不瞎猜归属） */
  turnId?: string | null
  sessionId: string
  executor: string
  graphId?: string | null
  nodeId?: string | null
  model?: string | null
  source: UsageSource
  inputTokens?: number | null
  outputTokens?: number | null
  cachedInputTokens?: number | null
  /** 缓存写入 token（Claude cache_creation_input_tokens），账本单列、不与读取缓存合并 */
  cacheCreationInputTokens?: number | null
  /**
   * false = 该调用没有 token 概念（例如按次计费）：
   * tokens_reported 写 NULL，区别于「有 token 概念但后端未上报」的 0。
   */
  tokensApplicable?: boolean
  /** 归属/缺价原因的人类可读说明（thread_not_bound / missing_price:* ...），不参与分类 */
  attributionNote?: string | null
  /** 幂等键：`turn:<id>`（kernel）或 `bev:<adapter>:<eventId>`（后端事件去重） */
  dedupeKey?: string | null
  recordedAt?: number
}

export class UsageLedger {
  private readonly repo: AgentRepository
  private readonly pricing: PricingTable
  /** settings.agentRuntime.costRates 转换后的条目，优先级高于 pricing（内置/环境表） */
  private readonly overrides: PriceEntry[]

  constructor(db: BetterSqlite3.Database, pricing?: PricingTable, overrides: PriceEntry[] = []) {
    this.repo = new AgentRepository(db)
    this.pricing = pricing ?? loadPricing()
    this.overrides = overrides
  }

  get pricingVersion(): string {
    return this.pricing.version
  }

  record(input: UsageRecordInput): AgentUsageRow {
    if (input.dedupeKey) {
      const existing = this.repo.findUsageByDedupeKey(input.dedupeKey)
      if (existing) {
        if (existing.source === 'provider') return existing
        if (input.source === 'provider') {
          return this.repo.updateUsage(existing.id, this.pricedFields(input))
        }
        return existing
      }
    }
    const priced = this.priceFor(input)
    const classification = this.classify(input, priced.costMicros)
    return this.repo.recordUsage({
      turnId: input.turnId ?? null,
      sessionId: input.sessionId,
      executor: input.executor,
      graphId: input.graphId ?? null,
      nodeId: input.nodeId ?? null,
      model: input.model ?? null,
      inputTokens: input.source === 'unknown' ? null : (input.inputTokens ?? null),
      outputTokens: input.source === 'unknown' ? null : (input.outputTokens ?? null),
      cachedInputTokens: input.source === 'unknown' ? null : (input.cachedInputTokens ?? null),
      cacheCreationInputTokens: input.source === 'unknown' ? null : (input.cacheCreationInputTokens ?? null),
      ...priced,
      ...classification,
      isEstimate: input.source !== 'provider',
      source: input.source,
      attributionNote: this.noteFor(input),
      dedupeKey: input.dedupeKey ?? null,
      recordedAt: input.recordedAt,
    })
  }

  /** 只读：某图某日汇总（真假用量分列）。 */
  summarizeGraphDay(graphId: string, dayKey: string = localDayKey()): GraphDayUsageSummary {
    return this.repo.summarizeUsageByGraphDay(graphId, dayKey)
  }

  /** 只读：某会话汇总（含缺价行计数，UI 区分「无记录 / 真 0 / 价格未知」）。 */
  summarizeSession(sessionId: string): UsageSummary {
    return this.repo.summarizeUsageBySession(sessionId)
  }

  /** 只读：会话明细（最近优先）。 */
  listBySession(sessionId: string, limit = 200): AgentUsageRow[] {
    return this.repo.listUsageBySession(sessionId, limit)
  }

  /** 只读：图级按日列表（day_key 原样返回，不在渲染层二次切日）。 */
  listGraphDays(graphId: string, limit = 30): GraphDayUsageSummary[] {
    return this.repo.listUsageDaysByGraph(graphId, limit)
  }

  /** 只读：某 turn 的明细行。 */
  listByTurn(turnId: string): AgentUsageRow[] {
    return this.repo.listUsageByTurn(turnId)
  }

  /** 计价结果（record/update 共用）。缺价时 cost_micros=null 且记录缺价原因。 */
  private priceFor(input: UsageRecordInput): {
    currency: string
    costUsd: number
    costMicros: number | null
    priceVersion: string | null
  } {
    if (input.source === 'unknown') {
      return { currency: 'USD', costUsd: 0, costMicros: null, priceVersion: null }
    }
    const price = resolvePrice(this.pricing, this.overrides, input.executor, input.model ?? undefined)
    if (!price) {
      return { currency: 'USD', costUsd: 0, costMicros: null, priceVersion: null }
    }
    const micros = costMicrosOf(price.entry, {
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      cacheCreationInputTokens: input.cacheCreationInputTokens ?? 0,
    })
    return {
      currency: price.entry.currency,
      costUsd: micros / 1_000_000,
      costMicros: micros,
      priceVersion: price.version,
    }
  }

  private pricedFields(input: UsageRecordInput): Parameters<AgentRepository['updateUsage']>[1] {
    const priced = this.priceFor(input)
    const classification = this.classify(input, priced.costMicros)
    return {
      turnId: input.turnId ?? null,
      nodeId: input.nodeId ?? null,
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cachedInputTokens: input.cachedInputTokens ?? null,
      cacheCreationInputTokens: input.cacheCreationInputTokens ?? null,
      currency: priced.currency,
      costUsd: priced.costUsd,
      costMicros: priced.costMicros,
      priceVersion: priced.priceVersion,
      isEstimate: false,
      source: 'provider',
      ...classification,
      attributionNote: this.noteFor(input),
    }
  }

  /**
   * 两个可查分类字段的唯一派生点（provider / estimated / unknown 三条路径共用）。
   *
   * - cost_status：unknown → not_reported；有价 → priced；缺价 → missing_price。
   *   该判断只看 source 与计价结果，不读 attribution_note 文本。
   * - tokens_reported：1=确实上报 token，0=有 token 概念但未上报，
   *   NULL=该调用无 token 概念（tokensApplicable=false）。
   */
  private classify(
    input: UsageRecordInput,
    costMicros: number | null,
  ): { costStatus: UsageCostStatus; tokensReported: number | null } {
    const costStatus: UsageCostStatus =
      input.source === 'unknown' ? 'not_reported' : costMicros === null ? 'missing_price' : 'priced'
    let tokensReported: number | null
    if (input.tokensApplicable === false) {
      tokensReported = null
    } else if (input.source === 'unknown') {
      tokensReported = 0
    } else {
      tokensReported =
        [input.inputTokens, input.outputTokens, input.cachedInputTokens].some(
          (value) => typeof value === 'number' && Number.isFinite(value),
        )
          ? 1
          : 0
    }
    return { costStatus, tokensReported }
  }

  private noteFor(input: UsageRecordInput): string | null {
    const notes: string[] = []
    if (input.attributionNote) notes.push(input.attributionNote)
    if (input.source !== 'unknown') {
      const price = resolvePrice(this.pricing, this.overrides, input.executor, input.model ?? undefined)
      if (!price) notes.push(`missing_price:${input.executor}/${input.model ?? 'unknown-model'}`)
    }
    return notes.length > 0 ? notes.join(';') : null
  }
}
