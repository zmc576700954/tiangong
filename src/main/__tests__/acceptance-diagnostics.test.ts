/**
 * 验收逐条诊断落库（复用 map_migration_reports）：每次评估一条，
 * 记逐条结果、缺失码、判定来源与耗时；缺表/写失败只告警不阻断。
 */

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import {
  ACCEPTANCE_EVALUATOR_VERSION,
  recordAcceptanceEvaluation,
  verdictOf,
} from '../map/acceptance-diagnostics'
import type { AcceptanceVerdict } from '../map/acceptance-executor'

function makeDb(withReportTable: boolean): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  if (withReportTable) {
    db.exec(`
      CREATE TABLE map_migration_reports (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
        started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
        status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
      );
    `)
  }
  return db
}

const pendingVerdict: AcceptanceVerdict = {
  ok: false,
  missing: [],
  pending: ['acceptance_manual_pending:1'],
  optionalFailures: [],
  items: [
    { index: 0, type: 'command', required: true, outcome: 'pass', codes: [] },
    { index: 1, id: 'm1', type: 'manual', required: true, outcome: 'pending', codes: ['acceptance_manual_pending:1'] },
  ],
  pendingItems: [{ id: 'm1', expected: '人工确认' }],
  checked: 1,
}

describe('recordAcceptanceEvaluation', () => {
  it('写入一条可查记录：来源、耗时、逐条结果与缺失码', () => {
    const db = makeDb(true)
    const record = recordAcceptanceEvaluation(db, {
      workItemId: 'wi_1',
      stepId: 'ws_1',
      source: 'turn_completed',
      durationMs: 12.4,
      verdict: pendingVerdict,
    })
    expect(record).toMatchObject({ verdict: 'pending', durationMs: 12.4 })

    const row = db
      .prepare("SELECT * FROM map_migration_reports WHERE stage = 'acceptance_eval:ws_1'")
      .get() as { kind: string; status: string; stats_json: string; details_json: string }
    expect(row.kind).toBe('integrity_check')
    expect(row.status).toBe('ok')
    const stats = JSON.parse(row.stats_json) as Record<string, unknown>
    expect(stats).toMatchObject({
      work_item_id: 'wi_1',
      step_id: 'ws_1',
      source: 'turn_completed',
      verdict: 'pending',
      missing_count: 0,
      pending_count: 1,
      item_count: 2,
      checked: 1,
      duration_ms: 12,
      evaluator_version: ACCEPTANCE_EVALUATOR_VERSION,
    })
    const details = JSON.parse(row.details_json) as Record<string, unknown>
    expect(details.items).toEqual(pendingVerdict.items)
    expect(details.pending_items).toEqual([{ id: 'm1', expected: '人工确认' }])
  })

  it('人工确认重算：来源与本次已确认条目可查', () => {
    const db = makeDb(true)
    recordAcceptanceEvaluation(db, {
      workItemId: 'wi_1',
      stepId: 'ws_1',
      source: 'manual_confirmation',
      durationMs: 3,
      confirmedEntryIds: ['m1'],
      verdict: {
        ...pendingVerdict,
        ok: true,
        pending: [],
        items: [{ index: 0, id: 'm1', type: 'manual', required: true, outcome: 'pass', codes: [] }],
        pendingItems: [],
      },
    })
    const stats = JSON.parse(
      (
        db.prepare("SELECT stats_json FROM map_migration_reports WHERE stage = 'acceptance_eval:ws_1'").get() as {
          stats_json: string
        }
      ).stats_json,
    ) as Record<string, unknown>
    expect(stats.source).toBe('manual_confirmation')
    expect(stats.confirmed_entry_ids).toEqual(['m1'])
    expect(stats.verdict).toBe('pass')
  })

  it('执行器异常：error 来源单独成档，不阻断', () => {
    const db = makeDb(true)
    const record = recordAcceptanceEvaluation(db, {
      workItemId: 'wi_1',
      stepId: 'ws_1',
      source: 'verifier_error',
      durationMs: 5,
      verifierError: 'engine boom',
    })
    expect(record?.verdict).toBe('error')
    const stats = JSON.parse(
      (
        db.prepare("SELECT stats_json FROM map_migration_reports WHERE stage = 'acceptance_eval:ws_1'").get() as {
          stats_json: string
        }
      ).stats_json,
    ) as Record<string, unknown>
    expect(stats.verifier_error).toBe('engine boom')
    expect(stats.item_count).toBe(0)
  })

  it('表不存在或写入失败：返回 null，不抛错', () => {
    const db = makeDb(false)
    expect(
      recordAcceptanceEvaluation(db, {
        workItemId: 'wi_1',
        stepId: 'ws_1',
        source: 'turn_completed',
        durationMs: 1,
        verdict: pendingVerdict,
      }),
    ).toBeNull()
  })
})

describe('verdictOf', () => {
  it('pass / pending / incomplete / error 归一', () => {
    expect(verdictOf({ ...pendingVerdict, ok: true, pending: [], items: [] })).toBe('pass')
    expect(verdictOf(pendingVerdict)).toBe('pending')
    expect(verdictOf({ ...pendingVerdict, pending: [], items: [{ index: 0, type: 'command', required: true, outcome: 'fail', codes: ['x'] }] })).toBe('incomplete')
    expect(verdictOf(undefined)).toBe('error')
    expect(verdictOf(pendingVerdict, 'boom')).toBe('error')
  })
})
