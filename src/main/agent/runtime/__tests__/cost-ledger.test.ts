/**
 * M1 成本账本验收：
 * 1. 真实 usage（provider）写入且维度齐全、整数 micros 计价、price_version 可溯
 * 2. 后端未上报 → source=unknown，tokens/cost 全 NULL，报表可区分
 * 3. 估算 → source=estimated、is_estimate=1
 * 4. 缺价 → cost_micros=NULL + missing_price 标注，不产生错误金额
 * 5. (graph_id, day_key) 汇总正确；day_key 固定 Asia/Shanghai，跨日按本地日切分
 * 6. 同一 dedupeKey 重复上报不重复计费；estimated/unknown 可被 provider 升级
 * 7. 迁移：旧 DDL（source='executor'）重建后新列齐全、source 映射 provider、数据保留
 */

import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'

// database.ts 依赖 electron app.getPath；沿用 database-migration.test.ts 的 mock 模式
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { UsageLedger } from '../cost/ledger'
import { BUILTIN_PRICING, costRatesToEntries, findPrice, type PricingTable } from '../cost/pricing'
import { AgentRepository } from '../db/repository'
import { AGENT_TABLE_SCHEMAS } from '../db/schema'
import { rebuildTableIfNeeded } from '../../../database'
import { localDayKey } from '../util'
import { openTestDb } from './helpers/test-db'

const TEST_PRICING: PricingTable = {
  version: 'test-v1',
  entries: [
    {
      executor: 'claude-code',
      model: 'claude-sonnet-4-5',
      inputMicrosPerMillion: 3_000_000,
      outputMicrosPerMillion: 15_000_000,
      cachedInputMicrosPerMillion: 300_000,
      currency: 'USD',
    },
  ],
}

function makeLedger(pricing: PricingTable = TEST_PRICING) {
  const db = openTestDb()
  return { db, repo: new AgentRepository(db), ledger: new UsageLedger(db, pricing) }
}

describe('UsageLedger (M1 成本账本)', () => {
  it('records provider usage with full dimensions, integer micros and price_version', () => {
    const { ledger } = makeLedger()
    const row = ledger.record({
      turnId: 'turn-1',
      sessionId: 'sess-1',
      executor: 'claude-code',
      graphId: 'g1',
      nodeId: 'n1',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      dedupeKey: 'turn:turn-1',
    })
    expect(row).toMatchObject({
      turn_id: 'turn-1',
      session_id: 'sess-1',
      executor: 'claude-code',
      graph_id: 'g1',
      node_id: 'n1',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      is_estimate: 0,
      currency: 'USD',
      price_version: 'test-v1',
      cost_status: 'priced',
      tokens_reported: 1,
      // 3 + 15 + 0.3 = 18.3 USD
      cost_micros: 18_300_000,
    })
    expect(row.cost_usd).toBeCloseTo(18.3, 6)
    expect(row.attribution_note).toBeNull()
  })

  it('persists cost_status / tokens_reported for priced / missing_price / not_reported in SQLite', () => {
    const { db, repo, ledger } = makeLedger()
    const priced = ledger.record({
      sessionId: 'sess-c',
      executor: 'claude-code',
      graphId: 'g-c',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      inputTokens: 1_000,
    })
    const missing = ledger.record({
      sessionId: 'sess-c',
      executor: 'claude-code',
      graphId: 'g-c',
      model: 'gpt-99-nonexistent',
      source: 'provider',
      inputTokens: 500,
    })
    const notReported = ledger.record({
      sessionId: 'sess-c',
      executor: 'claude-code',
      graphId: 'g-c',
      source: 'unknown',
    })

    // 真实 SQLite 落库：不是只看内存对象
    const stored = db
      .prepare('SELECT cost_status, tokens_reported FROM agent_usage WHERE id = ?')
      .get(priced.id) as { cost_status: string | null; tokens_reported: number | null }
    expect(stored).toEqual({ cost_status: 'priced', tokens_reported: 1 })
    expect(missing.cost_status).toBe('missing_price')
    expect(notReported.cost_status).toBe('not_reported')
    expect(notReported.tokens_reported).toBe(0)

    // 列驱动聚合
    const day = repo.summarizeUsageByGraphDay('g-c', priced.day_key)
    expect(day.totalRows).toBe(3)
    expect(day.pricedRows).toBe(1)
    expect(day.missingPriceRows).toBe(1)
    expect(day.notReportedRows).toBe(1)
    expect(day.costStatusUnknownRows).toBe(0)
    expect(day.tokensReportedRows).toBe(2)
    expect(day.tokensNotReportedRows).toBe(1)
    expect(day.tokensReportedUnknownRows).toBe(0)
    db.close()
  })

  it('tokensApplicable=false writes tokens_reported=NULL (no token concept, not "not reported")', () => {
    const { db, repo, ledger } = makeLedger()
    const row = ledger.record({
      sessionId: 'sess-n',
      executor: 'claude-code',
      graphId: 'g-n',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      // 按次计费、没有 token 概念：数值 0 也不等于「上报了 token」
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      tokensApplicable: false,
    })
    expect(row.cost_status).toBe('priced')
    expect(row.tokens_reported).toBeNull()
    // 对照：后端上报了 0 token —— 这是「上报了」，不是「无 token 概念」
    const reportedZero = ledger.record({
      sessionId: 'sess-n',
      executor: 'claude-code',
      graphId: 'g-n',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    })
    expect(reportedZero.tokens_reported).toBe(1)
    const day = repo.summarizeUsageByGraphDay('g-n', row.day_key)
    expect(day.tokensReportedRows).toBe(1)
    expect(day.tokensNotReportedRows).toBe(0)
    expect(day.tokensReportedUnknownRows).toBe(1)
    db.close()
  })

  it('column-driven aggregation matches the legacy note-parsing result for newly written rows', () => {
    const { db, repo, ledger } = makeLedger()
    const base = { sessionId: 'sess-r', executor: 'claude-code', graphId: 'g-r' }
    const rows = [
      ledger.record({ ...base, model: 'claude-sonnet-4-5', source: 'provider', inputTokens: 1_000 }),
      ledger.record({ ...base, model: 'claude-sonnet-4-5', source: 'estimated', inputTokens: 1_000 }),
      ledger.record({ ...base, model: 'gpt-99-nonexistent', source: 'provider', inputTokens: 500 }),
      ledger.record({ ...base, model: 'gpt-99-nonexistent', source: 'estimated', inputTokens: 500 }),
      ledger.record({ ...base, source: 'unknown' }),
    ]
    expect(rows.map((r) => r.cost_status)).toEqual([
      'priced',
      'priced',
      'missing_price',
      'missing_price',
      'not_reported',
    ])

    // 旧口径：source + cost_micros + attribution_note 文本（M1 ① 的实现方式）
    const parsedPriced = rows.filter((r) => r.source !== 'unknown' && r.cost_micros !== null).length
    const parsedMissing = rows.filter(
      (r) => r.source !== 'unknown' && r.cost_micros === null && /(^|;)missing_price:/.test(r.attribution_note ?? ''),
    ).length
    const parsedNotReported = rows.filter((r) => r.source === 'unknown').length

    const summary = repo.summarizeUsageBySession('sess-r')
    expect(summary.pricedRows).toBe(parsedPriced)
    expect(summary.missingPriceRows).toBe(parsedMissing)
    expect(summary.notReportedRows).toBe(parsedNotReported)
    expect(summary.costStatusUnknownRows).toBe(0)
    expect(summary.pricedRows + summary.missingPriceRows + summary.notReportedRows).toBe(summary.totalRows)
    db.close()
  })

  it('records unknown rows with NULL tokens/cost when backend reports no usage', () => {
    const { db, ledger } = makeLedger()
    const row = ledger.record({
      sessionId: 'sess-x',
      executor: 'mcp',
      graphId: 'g1',
      source: 'unknown',
      attributionNote: 'backend_reports_no_usage',
    })
    expect(row.source).toBe('unknown')
    expect(row.input_tokens).toBeNull()
    expect(row.output_tokens).toBeNull()
    expect(row.cached_input_tokens).toBeNull()
    expect(row.cost_micros).toBeNull()
    // 报表可区分：unknown 行数 + 缺价行数都统计
    const summary = ledger.summarizeGraphDay('g1', row.day_key)
    expect(summary.unknownRows).toBe(1)
    expect(summary.unknownCostRows).toBe(1)
    expect(summary.knownCostMicros).toBe(0)
    db.close()
  })

  it('marks estimated usage with is_estimate=1 and keeps it distinguishable in summaries', () => {
    const { ledger } = makeLedger()
    const row = ledger.record({
      sessionId: 'sess-e',
      executor: 'claude-code',
      graphId: 'g1',
      model: 'claude-sonnet-4-5',
      source: 'estimated',
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(row.source).toBe('estimated')
    expect(row.is_estimate).toBe(1)
    // 估算也计价（有价格表时），但报表按 source 分列
    expect(row.cost_micros).toBe(3_000_000)
    const summary = ledger.summarizeGraphDay('g1', row.day_key)
    expect(summary.estimatedRows).toBe(1)
    expect(summary.providerRows).toBe(0)
  })

  it('records cost_micros=NULL with missing_price note when model has no price', () => {
    const { ledger } = makeLedger()
    const row = ledger.record({
      sessionId: 'sess-m',
      executor: 'claude-code',
      graphId: 'g1',
      model: 'gpt-99-nonexistent',
      source: 'provider',
      inputTokens: 500,
      outputTokens: 200,
    })
    // 缺价不瞎算：无错误金额
    expect(row.cost_micros).toBeNull()
    expect(row.cost_usd).toBe(0)
    expect(row.price_version).toBeNull()
    expect(row.attribution_note).toContain('missing_price:claude-code/gpt-99-nonexistent')
    const summary = ledger.summarizeGraphDay('g1', row.day_key)
    expect(summary.knownCostMicros).toBe(0)
    expect(summary.unknownCostRows).toBe(1)
    expect(summary.providerRows).toBe(1)
  })

  it('aggregates by (graph_id, day_key) and splits days on the Asia/Shanghai boundary', () => {
    const { ledger } = makeLedger()
    // 2026-11-05T15:59:59.999Z = 上海 2026-11-05 23:59:59 → day 2026-11-05
    const beforeMidnight = Date.parse('2026-11-05T15:59:59.999Z')
    // 2026-11-05T16:00:00.000Z = 上海 2026-11-06 00:00:00 → day 2026-11-06
    const afterMidnight = Date.parse('2026-11-05T16:00:00.000Z')
    expect(localDayKey(beforeMidnight)).toBe('2026-11-05')
    expect(localDayKey(afterMidnight)).toBe('2026-11-06')

    const base = {
      sessionId: 'sess-d',
      executor: 'claude-code',
      graphId: 'g-day',
      model: 'claude-sonnet-4-5',
      source: 'provider' as const,
      inputTokens: 1_000_000,
      outputTokens: 0,
    }
    ledger.record({ ...base, recordedAt: beforeMidnight })
    ledger.record({ ...base, recordedAt: afterMidnight })
    // 另一张图同日：汇总必须按 graph 隔离
    ledger.record({ ...base, graphId: 'g-other', recordedAt: beforeMidnight })

    const day1 = ledger.summarizeGraphDay('g-day', '2026-11-05')
    expect(day1.knownCostMicros).toBe(3_000_000)
    expect(day1.providerRows).toBe(1)
    const day2 = ledger.summarizeGraphDay('g-day', '2026-11-06')
    expect(day2.knownCostMicros).toBe(3_000_000)
    expect(ledger.summarizeGraphDay('g-other', '2026-11-05').knownCostMicros).toBe(3_000_000)
    // turn 明细只读接口
    expect(ledger.listByTurn('turn-nonexistent')).toEqual([])
  })

  it('deduplicates by dedupeKey and lets provider upgrade an estimated/unknown row', () => {
    const { ledger } = makeLedger()
    const first = ledger.record({
      sessionId: 'sess-i',
      executor: 'claude-code',
      graphId: 'g1',
      source: 'unknown',
      attributionNote: 'backend_reports_no_usage',
      dedupeKey: 'turn:t-1',
    })
    // 迟到的真实 usage 升级同一行（不新增）
    const upgraded = ledger.record({
      sessionId: 'sess-i',
      executor: 'claude-code',
      graphId: 'g1',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      inputTokens: 1_000_000,
      dedupeKey: 'turn:t-1',
    })
    expect(upgraded.id).toBe(first.id)
    expect(upgraded.source).toBe('provider')
    expect(upgraded.cost_micros).toBe(3_000_000)
    // 升级时分类列同步更新：unknown → provider 真实用量
    expect(first.cost_status).toBe('not_reported')
    expect(first.tokens_reported).toBe(0)
    expect(upgraded.cost_status).toBe('priced')
    expect(upgraded.tokens_reported).toBe(1)

    // 同 key 重复上报 provider：返回原行，不重复计费
    const again = ledger.record({
      sessionId: 'sess-i',
      executor: 'claude-code',
      graphId: 'g1',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      inputTokens: 1_000_000,
      dedupeKey: 'turn:t-1',
    })
    expect(again.id).toBe(first.id)
    const summary = ledger.summarizeGraphDay('g1', first.day_key)
    expect(summary.knownCostMicros).toBe(3_000_000)
    expect(summary.providerRows).toBe(1)

    // legacy 路径无 turn id：turn 级幂等键同样不重复计费
    const legacy1 = ledger.record({
      sessionId: 'sess-L',
      executor: 'claude-code',
      graphId: 'g1',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      inputTokens: 1_000_000,
      dedupeKey: 'legacy:claude-code:sess-L:0',
    })
    const legacy2 = ledger.record({
      sessionId: 'sess-L',
      executor: 'claude-code',
      graphId: 'g1',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      inputTokens: 1_000_000,
      dedupeKey: 'legacy:claude-code:sess-L:0',
    })
    expect(legacy2.id).toBe(legacy1.id)
    // legacy 路径没有 turn id：不伪造归属
    expect(legacy1.turn_id).toBeNull()
    expect(ledger.summarizeGraphDay('g1', first.day_key).knownCostMicros).toBe(6_000_000)
  })

  it('migrates legacy agent_usage (source=executor) to v21 schema preserving data', () => {
    const db = openTestDb(false)
    db.exec(`
      CREATE TABLE agent_usage (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        executor TEXT NOT NULL,
        graph_id TEXT,
        day_key TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        is_estimate INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL CHECK(source IN ('executor','estimated')),
        recorded_at INTEGER NOT NULL
      )
    `)
    db.prepare(
      `INSERT INTO agent_usage
         (id, turn_id, session_id, executor, graph_id, day_key, input_tokens, output_tokens,
          cached_input_tokens, cost_usd, cost_micros, is_estimate, source, recorded_at)
       VALUES ('u1', 'turn-1', 'sess-1', 'claude-code', 'g1', '2026-11-04', 100, 20, 0, 0.001, 1000, 0, 'executor', 123)`,
    ).run()

    const schema = AGENT_TABLE_SCHEMAS.find((s) => s.name === 'agent_usage')!
    rebuildTableIfNeeded(db, 'agent_usage', schema.createSql, schema.requiredColumns)

    const cols = (db.prepare('PRAGMA table_info(agent_usage)').all() as Array<{ name: string }>).map((c) => c.name)
    for (const col of ['node_id', 'model', 'currency', 'price_version', 'cost_status', 'tokens_reported', 'attribution_note', 'dedupe_key']) {
      expect(cols).toContain(col)
    }
    const row = db.prepare('SELECT * FROM agent_usage WHERE id = ?').get('u1') as Record<string, unknown>
    expect(row.source).toBe('provider')
    expect(row.cost_micros).toBe(1000)
    expect(row.input_tokens).toBe(100)
    expect(row.turn_id).toBe('turn-1')
    expect(row.currency).toBe('USD')
    // v23 新列：历史行不凭空补值，必须保持 NULL（不能从旧 note 推测成 priced）
    expect(row.cost_status).toBeNull()
    expect(row.tokens_reported).toBeNull()
    db.close()
  })

  it('after migration, NULL history rows aggregate into costStatusUnknownRows (never counted as priced)', () => {
    const db = openTestDb(false)
    // v22 结构：有 attribution_note 但还没有 cost_status / tokens_reported
    db.exec(`
      CREATE TABLE agent_usage (
        id TEXT PRIMARY KEY,
        turn_id TEXT,
        session_id TEXT NOT NULL,
        executor TEXT NOT NULL,
        graph_id TEXT,
        node_id TEXT,
        model TEXT,
        day_key TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        currency TEXT NOT NULL DEFAULT 'USD',
        cost_usd REAL NOT NULL DEFAULT 0,
        cost_micros INTEGER,
        price_version TEXT,
        is_estimate INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL CHECK(source IN ('provider','estimated','unknown')),
        attribution_note TEXT,
        dedupe_key TEXT,
        recorded_at INTEGER NOT NULL
      )
    `)
    db.prepare(
      `INSERT INTO agent_usage
         (id, turn_id, session_id, executor, graph_id, day_key, input_tokens, output_tokens,
          cached_input_tokens, cost_usd, cost_micros, is_estimate, source, attribution_note, recorded_at)
       VALUES ('h1', 'turn-1', 'sess-h', 'claude-code', 'g-h', '2026-11-04', 100, 20, 0, 0.001, 1000, 0, 'provider', NULL, 123)`,
    ).run()
    db.prepare(
      `INSERT INTO agent_usage
         (id, turn_id, session_id, executor, graph_id, day_key, input_tokens, output_tokens,
          cached_input_tokens, cost_usd, cost_micros, is_estimate, source, attribution_note, recorded_at)
       VALUES ('h2', NULL, 'sess-h', 'claude-code', 'g-h', '2026-11-04', 0, 0, 0, 0, NULL, 1, 'provider',
               'thread_not_bound;missing_price:claude-code/gpt-99', 124)`,
    ).run()

    const schema = AGENT_TABLE_SCHEMAS.find((s) => s.name === 'agent_usage')!
    rebuildTableIfNeeded(db, 'agent_usage', schema.createSql, schema.requiredColumns)

    const repo = new AgentRepository(db)
    const summary = repo.summarizeUsageByGraphDay('g-h', '2026-11-04')
    expect(summary.totalRows).toBe(2)
    // 两条历史行都没被凭空补成确定值
    expect(summary.pricedRows).toBe(0)
    expect(summary.missingPriceRows).toBe(0)
    expect(summary.notReportedRows).toBe(0)
    expect(summary.costStatusUnknownRows).toBe(2)
    expect(summary.tokensReportedRows).toBe(0)
    expect(summary.tokensNotReportedRows).toBe(0)
    expect(summary.tokensReportedUnknownRows).toBe(2)
    // 金额仍可查（cost_micros 是旧列，保留原值）
    expect(summary.knownCostMicros).toBe(1000)
    db.close()
  })

  it('builtin pricing has no wildcard fallback and matches dated model variants by prefix', () => {
    expect(findPrice(BUILTIN_PRICING, 'claude-code', 'claude-sonnet-4-5')).toBeDefined()
    expect(findPrice(BUILTIN_PRICING, 'claude-code', 'claude-sonnet-4-5-20250929')).toBeDefined()
    expect(findPrice(BUILTIN_PRICING, 'codex', 'gpt-5-codex')).toBeDefined()
    // 无通配兜底：未知模型/未知后端一律缺价
    expect(findPrice(BUILTIN_PRICING, 'claude-code', 'gpt-99')).toBeUndefined()
    expect(findPrice(BUILTIN_PRICING, 'mcp', 'claude-sonnet-4-5')).toBeUndefined()
    expect(findPrice(BUILTIN_PRICING, 'claude-code', undefined)).toBeUndefined()
  })
})

describe('M1 用量读取接口（聚合分类与空数据语义）', () => {
  it('四类混合聚合：缺价行不计金额但计入 totalRows', () => {
    const { repo, ledger } = makeLedger()
    const base = {
      sessionId: 'sess-mixed',
      executor: 'claude-code',
      graphId: 'g-mixed',
      source: 'provider' as const,
    }
    // 1) provider 实测且有价
    const provider = ledger.record({
      ...base, turnId: 'turn-a', model: 'claude-sonnet-4-5', inputTokens: 1_000_000,
    })
    // 2) estimated 有价（估算也计入金额，但按 source 分列）
    ledger.record({ ...base, model: 'claude-sonnet-4-5', source: 'estimated', inputTokens: 1_000_000 })
    // 3) unknown：后端未上报，token/cost 全 NULL
    ledger.record({ ...base, source: 'unknown' })
    // 4) 缺价：provider 实测但价格表无该模型 → cost_micros=NULL
    ledger.record({
      ...base, model: 'gpt-99-nonexistent', inputTokens: 500, outputTokens: 200,
    })

    const day = repo.summarizeUsageByGraphDay('g-mixed', provider.day_key)
    expect(day.totalRows).toBe(4)
    // 缺价 2 行（unknown 行 + 无价格行）不计入金额，只计行数
    expect(day.knownCostMicros).toBe(6_000_000)
    expect(day.unknownCostRows).toBe(2)
    // 真正「缺价」的行只有 1 条：unknown 行是「后端未上报」，不能混进缺价计数
    expect(day.unpricedRows).toBe(1)
    expect(day.providerRows).toBe(2)
    expect(day.estimatedRows).toBe(1)
    expect(day.unknownRows).toBe(1)
    // 列驱动的定价分类：2 已定价 / 1 缺价 / 1 未上报 / 0 历史未标注
    expect(day.pricedRows).toBe(2)
    expect(day.missingPriceRows).toBe(1)
    expect(day.notReportedRows).toBe(1)
    expect(day.costStatusUnknownRows).toBe(0)
    // 列驱动的 token 上报分类：unknown 行是「有 token 概念但没报」，不是「无 token 概念」
    expect(day.tokensReportedRows).toBe(3)
    expect(day.tokensNotReportedRows).toBe(1)
    expect(day.tokensReportedUnknownRows).toBe(0)
    // unknown 行 token 为 NULL：单独计数，合计不把它当 0 混进去
    expect(day.unknownTokenRows).toBe(1)
    // unknown 行 token 为 NULL，不贡献数值；缺价行 token 仍计入
    expect(day.inputTokens).toBe(2_000_500)
    expect(day.outputTokens).toBe(200)

    // 会话级汇总与图级一致（同一批行）
    const session = repo.summarizeUsageBySession('sess-mixed')
    expect(session.totalRows).toBe(4)
    expect(session.knownCostMicros).toBe(6_000_000)
    expect(session.unknownCostRows).toBe(2)
    // turn 明细只汇总该 turn 的行
    const turn = repo.summarizeUsageByTurn('turn-a')
    expect(turn.totalRows).toBe(1)
    expect(turn.providerRows).toBe(1)
    expect(repo.listUsageBySession('sess-mixed')).toHaveLength(4)
  })

  it('空图：totalRows=0 表示「无记录」，不是 $0.00 的真实花费', () => {
    const { repo } = makeLedger()
    const empty = repo.summarizeUsageByGraphDay('g-never-used', '2026-03-04')
    expect(empty.graphId).toBe('g-never-used')
    expect(empty.dayKey).toBe('2026-03-04')
    expect(empty.totalRows).toBe(0)
    expect(empty.knownCostMicros).toBe(0)
    expect(empty.unknownCostRows).toBe(0)
    expect(repo.listUsageDaysByGraph('g-never-used')).toEqual([])
  })

  it('真实 0 花费行：totalRows>0 且 knownCostMicros=0（与「无行」可区分）', () => {
    const { repo, ledger } = makeLedger()
    const zero = ledger.record({
      sessionId: 'sess-zero',
      executor: 'claude-code',
      graphId: 'g-zero',
      model: 'claude-sonnet-4-5',
      source: 'provider',
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    })
    expect(zero.cost_micros).toBe(0)
    const summary = repo.summarizeUsageByGraphDay('g-zero', zero.day_key)
    expect(summary.totalRows).toBe(1)
    expect(summary.knownCostMicros).toBe(0)
    expect(summary.unknownCostRows).toBe(0)
  })

  it('图级按日列表倒序，且只返回有记录的日期（不补 0 行）', () => {
    const { repo, ledger } = makeLedger()
    const base = {
      sessionId: 'sess-days',
      executor: 'claude-code',
      graphId: 'g-days',
      model: 'claude-sonnet-4-5',
      source: 'provider' as const,
      inputTokens: 1_000_000,
    }
    // 上海 2026-11-05 23:59 → day 2026-11-05；上海 2026-11-06 00:01 → day 2026-11-06
    ledger.record({ ...base, recordedAt: Date.parse('2026-11-05T15:59:00.000Z') })
    ledger.record({ ...base, recordedAt: Date.parse('2026-11-05T16:01:00.000Z') })
    const days = repo.listUsageDaysByGraph('g-days')
    expect(days.map((d) => d.dayKey)).toEqual(['2026-11-06', '2026-11-05'])
    expect(days[0].totalRows).toBe(1)
    expect(days[0].knownCostMicros).toBe(3_000_000)
    expect(days[1].totalRows).toBe(1)
    // 中间空隙日期不出现在列表里（09-30 从未有记录）
    expect(days.some((d) => d.dayKey === '2026-09-30')).toBe(false)
  })
})

/**
 * 分层查价：settings.agentRuntime.costRates（用户配置）> 基础表（内置/环境文件）。
 * 关键约束：用户配置优先；未配置的模型回落基础表；两层都没有 → NULL + missing_price。
 */
describe('UsageLedger 分层查价（settings.costRates vs 内置表）', () => {
  const baseRecord = {
    sessionId: 'sess-rates',
    executor: 'claude-code',
    graphId: 'g-rates',
    source: 'provider' as const,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  }

  it('自定义价格生效，并如实记录 price_version=settings:rates', () => {
    const db = openTestDb()
    const ledger = new UsageLedger(
      db,
      TEST_PRICING,
      costRatesToEntries({ currency: 'USD', inputPerMillion: 2, outputPerMillion: 8 }),
    )
    const row = ledger.record({ ...baseRecord, model: 'claude-sonnet-4-5' })
    // 用户价 2 + 8 = 10 USD，而不是内置测试表的 3 + 15 = 18
    expect(row.cost_micros).toBe(10_000_000)
    expect(row.price_version).toBe('settings:rates')
    expect(row.cost_status).toBe('priced')
  })

  it('只配置某个模型时，其它模型回落基础表（价格与 version 都来自基础表）', () => {
    const db = openTestDb()
    const ledger = new UsageLedger(
      db,
      TEST_PRICING,
      costRatesToEntries({
        models: [{ executor: 'claude-code', model: 'my-private-model', inputPerMillion: 1, outputPerMillion: 1 }],
      }),
    )
    const custom = ledger.record({ ...baseRecord, model: 'my-private-model' })
    expect(custom.cost_micros).toBe(2_000_000)
    expect(custom.price_version).toBe('settings:rates:claude-code:my-private-model')

    const builtin = ledger.record({ ...baseRecord, model: 'claude-sonnet-4-5' })
    // 3 + 15 = 18 USD，来自 TEST_PRICING（test-v1）
    expect(builtin.cost_micros).toBe(18_000_000)
    expect(builtin.price_version).toBe('test-v1')
  })

  it('两层都没有价格 → cost_micros=NULL + missing_price，不猜价也不记 0', () => {
    const db = openTestDb()
    const ledger = new UsageLedger(
      db,
      TEST_PRICING,
      costRatesToEntries({ models: [{ executor: 'codex', model: 'gpt-5', inputPerMillion: 1, outputPerMillion: 1 }] }),
    )
    const row = ledger.record({ ...baseRecord, executor: 'codex', model: 'gpt-9-unknown' })
    expect(row.cost_micros).toBeNull()
    expect(row.cost_status).toBe('missing_price')
    expect(row.price_version).toBeNull()
    expect(row.attribution_note).toContain('missing_price')
    // 不是 0：knownCostMicros 不计入这行
    const summary = ledger.summarizeGraphDay('g-rates', row.day_key)
    expect(summary.knownCostMicros).toBe(0)
    expect(summary.missingPriceRows).toBe(1)
  })
})
