/**
 * M1 价格表：按后端/模型计价的可配置价格源。
 *
 * 原则：
 * - 价格不在业务逻辑里硬编码 —— 统一收敛到本模块，支持 env 覆盖整体替换；
 * - **不设通配符兜底价**：查不到价格就返回 undefined，由账本记 cost_micros=NULL
 *   并标注 missing_price，绝不拿别的模型价格瞎算；
 * - 每次计价都带上 price_version，事后可解释「这轮为什么是这个钱」。
 *
 * 覆盖方式（优先级从高到低）：
 * 1. settings.agentRuntime.costRates（用户配置）→ `resolvePrice()` 先查这一层；
 * 2. 环境变量 BIZGRAPH_PRICING_PATH 指向的 JSON 文件，结构为
 *    { "version": "...", "entries": [ { executor, model, inputMicrosPerMillion, ... } ] }
 *    存在且解析成功时整体替换内置表（不合并，避免半新半旧）；
 * 3. 内置表 BUILTIN_PRICING。
 * 三层都没有命中 → undefined，调用方按缺价处理（cost_micros=NULL + missing_price）。
 */

import fs from 'node:fs'
import { createLogger } from '../../../shared/logger'
import type { CostRates } from '@shared/types/agent-runtime'

const logger = createLogger('Pricing')

/** 单条价格：micros = 百万分之一 currency 单位（整数，避免浮点）。 */
export interface PriceEntry {
  /** 后端名（claude-code / codex / mcp 等）；'*' 仅允许来自显式外部配置 */
  executor: string
  /** 模型名；匹配规则：精确 → 前缀（兼容 dated 变体如 claude-sonnet-4-5-20250929） */
  model: string
  /** 每百万输入 token 的 micros */
  inputMicrosPerMillion: number
  /** 每百万输出 token 的 micros */
  outputMicrosPerMillion: number
  /** 每百万缓存命中输入 token 的 micros */
  cachedInputMicrosPerMillion: number
  /** 币种（USD / CNY ...） */
  currency: string
}

export interface PricingTable {
  version: string
  entries: PriceEntry[]
}

export const BUILTIN_PRICING_VERSION = 'builtin-2026-11-05'

const USD = 'USD'
const M = 1_000_000

/**
 * 内置价格（USD / 1M tokens，2026-11 公开牌价换算为 micros）。
 * 只列有公开牌价的模型；未列出的模型一律缺价（NULL），不估算。
 */
export const BUILTIN_PRICING: PricingTable = {
  version: BUILTIN_PRICING_VERSION,
  entries: [
    // Claude（executor 归一化为 claude-code / claude 都匹配）
    { executor: 'claude-code', model: 'claude-sonnet-4-5', inputMicrosPerMillion: 3 * M, outputMicrosPerMillion: 15 * M, cachedInputMicrosPerMillion: 0.3 * M, currency: USD },
    { executor: 'claude-code', model: 'claude-opus-4-1', inputMicrosPerMillion: 15 * M, outputMicrosPerMillion: 75 * M, cachedInputMicrosPerMillion: 1.5 * M, currency: USD },
    { executor: 'claude-code', model: 'claude-haiku-4-5', inputMicrosPerMillion: 1 * M, outputMicrosPerMillion: 5 * M, cachedInputMicrosPerMillion: 0.1 * M, currency: USD },
    { executor: 'claude', model: 'claude-sonnet-4-5', inputMicrosPerMillion: 3 * M, outputMicrosPerMillion: 15 * M, cachedInputMicrosPerMillion: 0.3 * M, currency: USD },
    { executor: 'claude', model: 'claude-opus-4-1', inputMicrosPerMillion: 15 * M, outputMicrosPerMillion: 75 * M, cachedInputMicrosPerMillion: 1.5 * M, currency: USD },
    { executor: 'claude', model: 'claude-haiku-4-5', inputMicrosPerMillion: 1 * M, outputMicrosPerMillion: 5 * M, cachedInputMicrosPerMillion: 0.1 * M, currency: USD },
    // Codex（gpt-5-codex / gpt-5）
    { executor: 'codex', model: 'gpt-5-codex', inputMicrosPerMillion: 1.25 * M, outputMicrosPerMillion: 10 * M, cachedInputMicrosPerMillion: 0.125 * M, currency: USD },
    { executor: 'codex', model: 'gpt-5', inputMicrosPerMillion: 1.25 * M, outputMicrosPerMillion: 10 * M, cachedInputMicrosPerMillion: 0.125 * M, currency: USD },
  ],
}

/**
 * 查找价格：executor 精确匹配（或条目为 '*'），model 精确 → 通配('*') → 前缀。
 * 内置表不含通配条目，因此未知 (executor, model) 一律返回 undefined ——
 * 调用方必须按「缺价」处理，不得自行估算。
 */
export function findPrice(table: PricingTable, executor: string, model: string | undefined): PriceEntry | undefined {
  const candidates = table.entries.filter((e) => e.executor === executor || e.executor === '*')
  if (model) {
    const exact = candidates.find((e) => e.model === model)
    if (exact) return exact
  }
  // 通配条目只允许来自显式外部配置（如 runtime rates 转换），内置表没有
  const wildcard = candidates.find((e) => e.model === '*')
  if (wildcard) return wildcard
  if (!model) return undefined
  // dated 变体：长名找它的前缀条目（claude-sonnet-4-5-20250929 → claude-sonnet-4-5）
  return candidates.find((e) => e.model !== '*' && model.startsWith(`${e.model}-`))
}

const PRICING_PATH_ENV = 'BIZGRAPH_PRICING_PATH'

function isValidEntry(raw: unknown): raw is PriceEntry {
  const e = e2record(raw)
  return (
    typeof e.executor === 'string' &&
    typeof e.model === 'string' &&
    typeof e.inputMicrosPerMillion === 'number' &&
    typeof e.outputMicrosPerMillion === 'number' &&
    typeof e.cachedInputMicrosPerMillion === 'number' &&
    typeof e.currency === 'string'
  )
}

function e2record(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>
}

/**
 * 加载价格表：BIZGRAPH_PRICING_PATH 存在时整体覆盖内置表；
 * 文件缺失/解析失败回退内置表并告警（不因配置错误而丢账本能力）。
 */
export function loadPricing(env: NodeJS.ProcessEnv = process.env): PricingTable {
  const overridePath = env[PRICING_PATH_ENV]
  if (!overridePath) return BUILTIN_PRICING
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath, 'utf-8')) as unknown
    const record = e2record(raw)
    if (typeof record.version === 'string' && Array.isArray(record.entries) && record.entries.every(isValidEntry)) {
      logger.info(`pricing loaded from ${overridePath} (version=${record.version}, entries=${record.entries.length})`)
      return { version: record.version, entries: record.entries as PriceEntry[] }
    }
    logger.warn(`pricing file ${overridePath} has invalid shape, falling back to builtin`)
  } catch (err) {
    logger.warn(`pricing file ${overridePath} unreadable (${String(err)}), falling back to builtin`)
  }
  return BUILTIN_PRICING
}

/**
 * 用户配置层（settings.agentRuntime.costRates）在 price_version 里的标记。
 *
 * price_version 口径：
 * - `builtin-2026-11-05` / 环境文件里的 version —— 来自内置表或 BIZGRAPH_PRICING_PATH；
 * - `settings:rates` —— 命中 settings 里的全局单价（executor/model 均为 *）；
 * - `settings:rates:<executor>:<model>` —— 命中 settings 里的按模型单价。
 *
 * 因此事后看一行 usage 的 price_version 就能知道「这钱是按谁的价格算的」。
 */
export const SETTINGS_PRICING_VERSION = 'settings:rates'

export interface PriceResolution {
  entry: PriceEntry
  /** 命中来源的版本串，直接写入 agent_usage.price_version */
  version: string
}

/** settings 配置 → 价格条目（优先级高于内置表）。 */
export function costRatesToEntries(rates: CostRates): PriceEntry[] {
  const currency = rates.currency ?? 'USD'
  const entries: PriceEntry[] = []
  const flat =
    rates.inputPerMillion !== undefined || rates.outputPerMillion !== undefined || rates.cachedInputPerMillion !== undefined
  if (flat) {
    entries.push({
      executor: '*',
      model: '*',
      inputMicrosPerMillion: Math.round((rates.inputPerMillion ?? 0) * 1_000_000),
      outputMicrosPerMillion: Math.round((rates.outputPerMillion ?? 0) * 1_000_000),
      cachedInputMicrosPerMillion: Math.round((rates.cachedInputPerMillion ?? 0) * 1_000_000),
      currency,
    })
  }
  for (const item of rates.models ?? []) {
    entries.push({
      executor: item.executor,
      model: item.model,
      inputMicrosPerMillion: Math.round((item.inputPerMillion ?? 0) * 1_000_000),
      outputMicrosPerMillion: Math.round((item.outputPerMillion ?? 0) * 1_000_000),
      cachedInputMicrosPerMillion: Math.round((item.cachedInputPerMillion ?? 0) * 1_000_000),
      currency: item.currency ?? currency,
    })
  }
  return entries
}

function versionOfOverride(entry: PriceEntry): string {
  if (entry.executor === '*' && entry.model === '*') return SETTINGS_PRICING_VERSION
  return `${SETTINGS_PRICING_VERSION}:${entry.executor}:${entry.model}`
}

/**
 * 分层查价：用户配置层优先，未命中回落基础表（内置或环境文件），都没有返回 undefined。
 *
 * 用户层内部仍按 精确 → 通配 → 前缀 匹配；因此「只配了某个模型」时，
 * 其它模型会自然回落内置表 —— 不是拿配置价去套所有模型。
 */
export function resolvePrice(
  base: PricingTable,
  overrides: PriceEntry[],
  executor: string,
  model: string | undefined,
): PriceResolution | undefined {
  if (overrides.length > 0) {
    const hit = findPrice({ version: SETTINGS_PRICING_VERSION, entries: overrides }, executor, model)
    if (hit) return { entry: hit, version: versionOfOverride(hit) }
  }
  const fallback = findPrice(base, executor, model)
  return fallback ? { entry: fallback, version: base.version } : undefined
}

/** 计算成本（micros，整数）。任一项 token 为 undefined 时按 0 计。 */
export function costMicrosOf(
  price: PriceEntry,
  usage: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    /** 缓存写入 token：按输入单价计（价格表没有单独的 cache-write 档位） */
    cacheCreationInputTokens?: number
  },
): number {
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const cached = usage.cachedInputTokens ?? 0
  const cacheCreation = usage.cacheCreationInputTokens ?? 0
  return Math.round(
    (input * price.inputMicrosPerMillion +
      output * price.outputMicrosPerMillion +
      cached * price.cachedInputMicrosPerMillion +
      cacheCreation * price.inputMicrosPerMillion) /
      M,
  )
}
