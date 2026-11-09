/**
 * G1-10 / G5-8：evidence_suggestions 写入 → 接受 → node_evidence 落库链路。
 *
 * 覆盖：
 * - 建议写入去重（node + kind + source_ref）；
 * - 接受与证据转写**同事务**，来源字段（run/session/turn/current_hash）完整可追溯；
 * - 重复接受幂等（不产生第二条证据）；
 * - 驳回只改状态、不写证据；已驳回不能再接受；
 * - E3 建议不得由人工点击洗成可复现证据（§3.7.1）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, applyMapS6aSchema } from '../map/schema'
import {
  EvidenceSuggestionService,
  EvidenceValidationError,
  type EvidenceSuggestionRow,
} from '../map/evidence-service'

describe('EvidenceSuggestionService（G1-10/G5-8）', () => {
  let db: BetterSqlite3.Database
  let service: EvidenceSuggestionService

  const RUN_ID = 'run-1'
  const REF = {
    kind: 'agent_turn',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    runId: RUN_ID,
    workItemId: 'wi-1',
    stepId: 'ws-1',
    executedContentHash: 'hash-abc',
    dirtyFiles: ['src/a.ts'],
    acceptanceOutcome: 'succeeded',
  }

  beforeEach(() => {
    db = new Database(':memory:') as unknown as BetterSqlite3.Database
    applyMapS5aSchema(db)
    applyMapS6aSchema(db)
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
        graph_id TEXT NOT NULL, graph_type TEXT NOT NULL, entity_key TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    db.prepare(
      "INSERT INTO nodes (id, type, title, graph_id, graph_type, entity_key, created_at, updated_at) VALUES ('node-1', 'feature', '节点', 'g1', 'dev', 'key-1', 'x', 'x')",
    ).run()
    service = new EvidenceSuggestionService(db)
  })

  function suggestE2(overrides: Partial<Parameters<EvidenceSuggestionService['suggest']>[0]> = {}) {
    return service.suggest({
      graphId: 'g1',
      nodeEntityKey: 'key-1',
      nodeId: 'node-1',
      projectPath: '/p/a',
      level: 'E2',
      evidenceType: 'session_turn',
      ref: REF,
      rationale: 'agent 回合完成（机器验收通过）',
      confidence: 0.8,
      producedByRunId: RUN_ID,
      ...overrides,
    })
  }

  it('建议写入按 node+kind+source_ref 去重：同一 run 重复写入只有一行 pending', () => {
    const first = suggestE2()
    const second = suggestE2()
    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.row.id).toBe(first.row.id)
    expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_suggestions').get() as { n: number }).n).toBe(1)
    expect(first.row.status).toBe('pending')
    expect(first.row.confidence).toBe(0.8)
    // Agent 写建议阶段不产生证据。
    expect((db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get() as { n: number }).n).toBe(0)
  })

  it('接受 → 同事务写 node_evidence，来源字段可从证据与 ref_json 追溯', () => {
    const { row: suggestion } = suggestE2()
    const result = service.accept(suggestion.id, 'local-user')

    expect(result.reused).toBe(false)
    const accepted = result.suggestion as EvidenceSuggestionRow
    expect(accepted.status).toBe('accepted')
    expect(accepted.resolved_by).toBe('local-user')
    expect(accepted.resolved_at).not.toBeNull()

    const ev = result.evidence
    expect(ev.evidence_level).toBe('E2')
    expect(ev.evidence_type).toBe('session_turn')
    // 来源是 agent 回合：produced_by='agent'，接受动作主体在建议表 resolved_by。
    expect(ev.produced_by).toBe('agent')
    expect(ev.work_run_id).toBe(RUN_ID)
    expect(ev.work_item_id).toBe('wi-1')
    expect(ev.session_id).toBe('sess-1')
    expect(ev.turn_id).toBe('turn-1')
    expect(ev.version_binding).toBe('content_hash')
    expect(ev.current_hash).toBe('hash-abc')
    expect(ev.summary).toBe(suggestion.rationale)

    const ref = JSON.parse(ev.ref_json) as Record<string, unknown>
    expect(ref['suggestionId']).toBe(suggestion.id)
    expect(ref['runId']).toBe(RUN_ID)
    expect(ref['executedContentHash']).toBe('hash-abc')
    // 可追溯：按 ref_json.suggestionId 能反查证据。
    const traced = db
      .prepare("SELECT id FROM node_evidence WHERE json_extract(ref_json, '$.suggestionId') = ?")
      .get(suggestion.id) as { id: string } | undefined
    expect(traced?.id).toBe(ev.id)
  })

  it('重复接受幂等：返回既有证据，不产生第二行', () => {
    const { row: suggestion } = suggestE2()
    const first = service.accept(suggestion.id, 'local-user')
    const second = service.accept(suggestion.id, 'local-user')

    expect(second.reused).toBe(true)
    expect(second.evidence.id).toBe(first.evidence.id)
    expect((db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get() as { n: number }).n).toBe(1)
  })

  it('驳回只改状态、不写证据；已驳回不能再接受', () => {
    const { row: suggestion } = suggestE2()
    const dismissed = service.dismiss(suggestion.id, 'local-user')
    expect(dismissed.status).toBe('dismissed')
    expect(dismissed.resolved_by).toBe('local-user')
    expect((db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get() as { n: number }).n).toBe(0)

    // 重复驳回幂等。
    expect(service.dismiss(suggestion.id, 'local-user').status).toBe('dismissed')
    expect(() => service.accept(suggestion.id, 'local-user')).toThrow(EvidenceValidationError)
    expect((db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get() as { n: number }).n).toBe(0)
  })

  it('E3 建议不得由人工接受（只能 TestExecutor 写），且不改建议状态', () => {
    const { row: suggestion } = service.suggest({
      graphId: 'g1',
      nodeEntityKey: 'key-1',
      level: 'E3',
      evidenceType: 'test_run',
      ref: { testRunId: 'tr-1' },
      rationale: '系统推断测试已通过',
      producedByRunId: RUN_ID,
    })
    expect(() => service.accept(suggestion.id, 'local-user')).toThrow(/E3 只能由 TestExecutor/)
    expect(service.get(suggestion.id)?.status).toBe('pending')
    expect((db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get() as { n: number }).n).toBe(0)
  })

  it('写入前校验：端点不可解析 / 缺 rationale / confidence 越界均拒绝', () => {
    expect(() => suggestE2({ nodeEntityKey: 'missing-key' })).toThrow(/端点不可解析/)
    expect(() => suggestE2({ rationale: '  ' })).toThrow(/缺 rationale/)
    expect(() => suggestE2({ confidence: 1.5 })).toThrow(/confidence/)
    expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_suggestions').get() as { n: number }).n).toBe(0)
  })
})
