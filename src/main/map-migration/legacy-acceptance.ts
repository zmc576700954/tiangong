/**
 * v36 / W3 G3-5：存量自由文本 acceptance → 结构化 manual（Option B）。
 *
 * 背景：D1 曾裁决「存量 `[{id,text}]` 不自动迁移」，导致这批行永久
 * `acceptance_item_not_structured` → gate incomplete → blocked。W3 改为
 * 保守自动迁移：把无 `type` 的自由文本条目转成 `type='manual'`。
 *
 * 迁移规则（逐行判定，**非结构化行以外的行一律不动**）：
 *  1. 已是结构化（任一 entry 带 `type`）→ 不动；
 *  2. `acceptance_json` 非法 JSON / 非数组 / 空数组 → 不动；
 *  3. 混合行（部分 entry 有 `type`、部分没有）→ **整行不动**（不做部分改写，
 *     避免把「已结构化项」与推断项混在同一次迁移里）；
 *  4. 终态（done/failed/cancelled/superseded）或已归档（archived_at 非空）行
 *     → 不动（历史事实不重写；迁移只对仍可能进入 gate 的行生效）；
 *  5. 全部条目都是「纯字符串」或「对象且无 type、有 string text」→ 迁移：
 *     每个非空 text 一条 `{id, type:'manual', expected:text, text, provenance}`
 *     （`provenance:'legacy_free_text'` 是可判别来源；`text` 保留原文）；
 *  6. id 保留原值（非空字符串）；缺失 id 用 `acc_<index>`；同 id 重复时
 *     后者加 `_2/_3` 后缀；纯空白 text 丢弃；全部 text 为空则该行不动。
 *
 * 护栏：
 *  - 原文可回滚：迁移前逐行把 `acceptance_json` 原文写进
 *    `map_acceptance_migration_archive`（按 work_item_id/revision 精确定位）；
 *  - 迁移可审计：写一行 `map_migration_reports`
 *    （kind='derivation'、stage='legacy_acceptance'），带行数/版本/判定依据；
 *  - 来源可见：迁移条目内保留 `provenance='legacy_free_text'`，无需加列。
 *
 * 全程在调用方（`runIncrementalMigrations`，已在 migrate 的 SAVEPOINT 中）
 * 的一个事务内完成；任何结构性异常整体回滚，不留下半迁移状态。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import { MapMigrationStore } from './migration-state'

const logger = createLogger('LegacyAcceptanceMigration')

export const LEGACY_ACCEPTANCE_STAGE = 'legacy_acceptance'
export const LEGACY_ACCEPTANCE_KIND = 'derivation' as const
/** 迁移条目的来源标记（数据内可判别；正常 human revise 不会写这个字段）。 */
export const LEGACY_FREE_TEXT_PROVENANCE = 'legacy_free_text'

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'superseded'])

export interface LegacyAcceptanceMigrationStats {
  /** 实际改写 acceptance_json 的行数。 */
  migratedRows: number
  /** 迁移出的 manual 条目总数。 */
  migratedItems: number
  /** 逐类跳过计数——审计行里直接可见「为什么这批行没动」。 */
  alreadyStructuredRows: number
  skippedInvalidJsonRows: number
  skippedEmptyRows: number
  skippedMixedRows: number
  skippedTerminalRows: number
  skippedNoTextRows: number
}

interface WorkItemAcceptanceRow {
  id: string
  lineage_id: string
  revision: number
  status: string
  archived_at: string | null
  acceptance_json: string
}

interface MigratedEntry {
  id: string
  type: 'manual'
  expected: string
  text: string
  provenance: string
}

/** 条目是否为「无 type 的历史自由文本」（对象带 string text，或纯字符串）。 */
function isLegacyFreeTextEntry(entry: unknown): boolean {
  if (typeof entry === 'string') return true
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const record = entry as Record<string, unknown>
  const type = record['type']
  if (type !== undefined && type !== null) return false
  return typeof record['text'] === 'string'
}

function legacyText(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  const record = entry as Record<string, unknown>
  return typeof record['text'] === 'string' ? record['text'] : null
}

function legacyId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const id = (entry as Record<string, unknown>)['id']
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}

/**
 * 把一条「全部条目都是自由文本」的行转成 structured manual。
 * 调用方先用 isLegacyFreeTextEntry 判定整行；空文本条目在这里丢弃。
 */
export function convertLegacyAcceptance(parsed: unknown[]): MigratedEntry[] {
  const entries: MigratedEntry[] = []
  const usedIds = new Set<string>()
  for (let i = 0; i < parsed.length; i += 1) {
    const text = legacyText(parsed[i])
    if (text === null || text.trim() === '') continue
    let id = legacyId(parsed[i]) ?? `acc_${i + 1}`
    if (usedIds.has(id)) {
      let suffix = 2
      while (usedIds.has(`${id}_${suffix}`)) suffix += 1
      id = `${id}_${suffix}`
    }
    usedIds.add(id)
    entries.push({
      id,
      type: 'manual',
      expected: text,
      text,
      provenance: LEGACY_FREE_TEXT_PROVENANCE,
    })
  }
  return entries
}

function emptyStats(): LegacyAcceptanceMigrationStats {
  return {
    migratedRows: 0,
    migratedItems: 0,
    alreadyStructuredRows: 0,
    skippedInvalidJsonRows: 0,
    skippedEmptyRows: 0,
    skippedMixedRows: 0,
    skippedTerminalRows: 0,
    skippedNoTextRows: 0,
  }
}

/**
 * 执行迁移。调用方必须已在事务中（migrate() 的 SAVEPOINT）。
 * 返回统计供日志/测试断言；审计行写入 `map_migration_reports`。
 */
export function migrateLegacyAcceptance(
  db: BetterSqlite3.Database,
  schemaVersion: number,
  now: () => number = () => Date.now(),
): LegacyAcceptanceMigrationStats {
  const store = new MapMigrationStore(db)
  const reportId = store.startStage({
    kind: LEGACY_ACCEPTANCE_KIND,
    stage: LEGACY_ACCEPTANCE_STAGE,
    schemaVersion,
  })
  const stats = emptyStats()
  try {
    const rows = db
      .prepare(
        `SELECT id, lineage_id, revision, status, archived_at, acceptance_json
           FROM work_items
          WHERE archived_at IS NULL`,
      )
      .all() as WorkItemAcceptanceRow[]

    const migratedAt = new Date(now()).toISOString()
    const archive = db.prepare(
      `INSERT INTO map_acceptance_migration_archive (
         work_item_id, lineage_id, revision, original_acceptance_json,
         migrated_acceptance_json, item_count, schema_version, migrated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const updateAcceptance = db.prepare(
      'UPDATE work_items SET acceptance_json = ? WHERE id = ?',
    )

    const txn = db.transaction(() => {
      for (const row of rows) {
        if (TERMINAL_STATUSES.has(row.status)) {
          stats.skippedTerminalRows += 1
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(row.acceptance_json)
        } catch {
          stats.skippedInvalidJsonRows += 1
          continue
        }
        if (!Array.isArray(parsed)) {
          stats.skippedInvalidJsonRows += 1
          continue
        }
        if (parsed.length === 0) {
          stats.skippedEmptyRows += 1
          continue
        }
        // 非「全自由文本」行一律不动：全结构化记 already_structured，
        // 结构+自由文本混合记 mixed（不做部分改写，交人工重新确认）。
        if (!parsed.every(isLegacyFreeTextEntry)) {
          if (parsed.some(isLegacyFreeTextEntry)) stats.skippedMixedRows += 1
          else stats.alreadyStructuredRows += 1
          continue
        }
        const entries = convertLegacyAcceptance(parsed)
        if (entries.length === 0) {
          stats.skippedNoTextRows += 1
          continue
        }
        const migratedJson = JSON.stringify(entries)
        archive.run(
          row.id,
          row.lineage_id,
          row.revision,
          row.acceptance_json,
          migratedJson,
          entries.length,
          schemaVersion,
          migratedAt,
        )
        updateAcceptance.run(migratedJson, row.id)
        stats.migratedRows += 1
        stats.migratedItems += entries.length
      }

      return stats
    })
    txn()

    store.completeStage(reportId, 'ok', {
      stats: {
        migrated_rows: stats.migratedRows,
        migrated_items: stats.migratedItems,
        already_structured_rows: stats.alreadyStructuredRows,
        skipped_invalid_json_rows: stats.skippedInvalidJsonRows,
        skipped_empty_rows: stats.skippedEmptyRows,
        skipped_mixed_rows: stats.skippedMixedRows,
        skipped_terminal_rows: stats.skippedTerminalRows,
        skipped_no_text_rows: stats.skippedNoTextRows,
        schema_version: schemaVersion,
      },
      details: {
        basis:
          'entries lacking a recognized `type` were treated as human checkpoints: ' +
          'converted to {type:"manual", expected:<original text>, provenance:"legacy_free_text"}; ' +
          'ids preserved (missing → acc_<index>, duplicates → _2/_3 suffix); ' +
          'whitespace-only text dropped; mixed/terminal/archived rows left untouched',
        archive_table: 'map_acceptance_migration_archive',
        provenance_field: LEGACY_FREE_TEXT_PROVENANCE,
        rollback:
          'UPDATE work_items SET acceptance_json = (SELECT a.original_acceptance_json ' +
          'FROM map_acceptance_migration_archive a WHERE a.work_item_id = work_items.id) ' +
          'WHERE id IN (SELECT work_item_id FROM map_acceptance_migration_archive); ' +
          'DELETE FROM map_acceptance_migration_archive WHERE schema_version = ' +
          String(schemaVersion),
      },
    })

    if (stats.migratedRows > 0) {
      logger.info(
        `legacy acceptance migrated: rows=${stats.migratedRows} items=${stats.migratedItems} ` +
          `(terminal=${stats.skippedTerminalRows} mixed=${stats.skippedMixedRows} ` +
          `invalid=${stats.skippedInvalidJsonRows} empty=${stats.skippedEmptyRows} ` +
          `no_text=${stats.skippedNoTextRows})`,
      )
    }
    return stats
  } catch (error) {
    try {
      store.completeStage(reportId, 'failed', { error })
    } catch (reportError) {
      logger.warn('failed to record legacy acceptance migration failure:', reportError)
    }
    throw error
  }
}
