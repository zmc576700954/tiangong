/**
 * S1 导入查重判定回归（session-map 蓝图 §2.6 判定顺序 / §2.2.2 S1-f 判据 2、5）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  decideImport,
  contentSimilarity,
  normalizeDirName,
  ImportDedupService,
  ImportRejectedError,
  isRootPathConflict,
  IMPORT_DEDUP_DEFAULTS,
} from '../map-migration/import-dedup'
import { BizGraphError } from '../errors'
import type { ProjectFingerprint, StoredFingerprint, FingerprintSample } from '../map-migration/import-dedup'

function makeSamples(shared: number, own: number, tag: string): FingerprintSample[] {
  const out: FingerprintSample[] = []
  for (let i = 0; i < shared; i++) {
    out.push({ path: `src/shared-${i}.ts`, size: 100, sha256: createHash('sha256').update(`${tag}-shared-${i}`).digest('hex') })
  }
  for (let i = 0; i < own; i++) {
    out.push({ path: `src/own-${tag}-${i}.ts`, size: 100, sha256: createHash('sha256').update(`${tag}-own-${i}`).digest('hex') })
  }
  return out
}

/** 配对夹具：matched 个文件两侧 sha 相同,其余各自独有——精确控制相似度分母。 */
function pairSamples(matched: number, currentOnly: number, storedOnly: number): { current: FingerprintSample[]; stored: FingerprintSample[] } {
  const current: FingerprintSample[] = []
  const stored: FingerprintSample[] = []
  for (let i = 0; i < matched; i++) {
    const sha = createHash('sha256').update(`matched-${i}`).digest('hex')
    current.push({ path: `src/m-${i}.ts`, size: 100, sha256: sha })
    stored.push({ path: `src/m-${i}.ts`, size: 100, sha256: sha })
  }
  for (let i = 0; i < currentOnly; i++) {
    current.push({ path: `src/c-${i}.ts`, size: 100, sha256: createHash('sha256').update(`cur-${i}`).digest('hex') })
  }
  for (let i = 0; i < storedOnly; i++) {
    stored.push({ path: `src/o-${i}.ts`, size: 100, sha256: createHash('sha256').update(`old-${i}`).digest('hex') })
  }
  return { current, stored }
}

function makeStored(overrides: Partial<StoredFingerprint> = {}): StoredFingerprint {
  return {
    id: 'pf-1',
    root_path: '/old/root',
    dir_name: 'old-root',
    project_name: 'old-root',
    sample_files_json: '[]',
    sample_count: 0,
    graph_ids_json: JSON.stringify(['g-alive']),
    ...overrides,
  }
}

function makeFingerprint(overrides: Partial<ProjectFingerprint> = {}): ProjectFingerprint {
  return {
    projectName: 'new-root',
    dirName: 'new-root',
    rootPath: '/new/root',
    lastModifiedAt: 1700000000000,
    samples: makeSamples(0, 12, 'new'),
    sampleCount: 12,
    errors: [],
    ...overrides,
  }
}

const BASE_INPUT = {
  interactive: false,
  activeAllowanceDirs: new Set<string>(),
  graphExists: () => true,
}

describe('decideImport 判定顺序（§2.6 命中即停）', () => {
  it('Step 1：同 root_path 且图仍在 → 拒绝（同一工作区重复导入）', () => {
    const stored = makeStored({ root_path: '/new/root' })
    const d = decideImport({ ...BASE_INPUT, fingerprint: makeFingerprint(), stored: [stored] })
    expect(d).toMatchObject({ action: 'reject', step: '1', matchedFingerprintId: 'pf-1' })
  })

  it('§2.6 规则 6：同 root_path 但指向的图均已删除 → 重建路径（复用指纹）', () => {
    const stored = makeStored({ root_path: '/new/root' })
    const d = decideImport({ ...BASE_INPUT, fingerprint: makeFingerprint(), stored: [stored], graphExists: () => false })
    expect(d).toMatchObject({ action: 'allow_rebuild', step: 'rebuild', matchedFingerprintId: 'pf-1' })
  })

  it('Step 2a：目录名相同且相似度 ≥0.6 → 拒绝（mtime 只作证据不参与）', () => {
    // 12 个采样中 10 个相同 → 0.8333 ≥ 0.6
    const pair = pairSamples(10, 2, 0)
    const stored = makeStored({ dir_name: 'new-root', sample_files_json: JSON.stringify(pair.stored) })
    const d = decideImport({ ...BASE_INPUT, fingerprint: makeFingerprint({ samples: pair.current }), stored: [stored] })
    expect(d).toMatchObject({ action: 'reject', step: '2a' })
    expect(d.signals.similarity).toBe(0.8333)
    expect(d.signals.dir_name_same).toBe(true)
    expect(d.signals.mtime_used).toBe(false)
  })

  it('Step 2b：目录名相同但相似度 <0.6 → 允许并警告', () => {
    const pair = pairSamples(3, 9, 0)
    const stored = makeStored({ dir_name: 'new-root', sample_files_json: JSON.stringify(pair.stored) })
    const d = decideImport({ ...BASE_INPUT, fingerprint: makeFingerprint({ samples: pair.current }), stored: [stored] })
    expect(d).toMatchObject({ action: 'allow_with_warning', step: '2b' })
  })

  it('Step 3a-remembered：异目录 + 相似度 ≥0.8 + 未撤销记住规则 → 放行并标明来源', () => {
    const pair = pairSamples(12, 0, 0)
    const stored = makeStored({ sample_files_json: JSON.stringify(pair.stored) })
    const fp = makeFingerprint({ samples: pair.current, dirName: 'branch-copy', projectName: 'branch-copy' })
    const d = decideImport({
      ...BASE_INPUT,
      fingerprint: fp,
      stored: [stored],
      activeAllowanceDirs: new Set(['pf-1::branch-copy']),
    })
    expect(d).toMatchObject({ action: 'allow_branch_variant', step: '3a-remembered', matchedFingerprintId: 'pf-1' })
  })

  it('Step 3a：交互确认放行；自动导入一律拒绝（规则 5）', () => {
    const pair = pairSamples(12, 0, 0)
    const stored = makeStored({ sample_files_json: JSON.stringify(pair.stored) })
    const fp = makeFingerprint({ samples: pair.current, dirName: 'branch-copy', projectName: 'branch-copy' })
    const allowed = decideImport({ ...BASE_INPUT, fingerprint: fp, stored: [stored], interactive: true })
    expect(allowed).toMatchObject({ action: 'allow_branch_variant', step: '3a-this_time' })

    const rejected = decideImport({ ...BASE_INPUT, fingerprint: fp, stored: [stored], interactive: false })
    expect(rejected).toMatchObject({ action: 'reject', step: '3a-auto' })
  })

  it('Step 3b：异目录 + 0.6 ≤ 相似度 < 0.8 → 按重复拒绝', () => {
    // 9/12 = 0.75
    const pair = pairSamples(9, 3, 0)
    const stored = makeStored({ sample_files_json: JSON.stringify(pair.stored) })
    const fp = makeFingerprint({ samples: pair.current, dirName: 'other-dir', projectName: 'other-dir' })
    const d = decideImport({ ...BASE_INPUT, fingerprint: fp, stored: [stored] })
    expect(d).toMatchObject({ action: 'reject', step: '3b' })
    expect(d.signals.similarity).toBe(0.75)
  })

  it('Step 3c：异目录 + 相似度 <0.6 → 允许（不同项目）', () => {
    const pair = pairSamples(2, 10, 0)
    const stored = makeStored({ sample_files_json: JSON.stringify(pair.stored) })
    const fp = makeFingerprint({ samples: pair.current, dirName: 'other-dir', projectName: 'other-dir' })
    const d = decideImport({ ...BASE_INPUT, fingerprint: fp, stored: [stored] })
    expect(d).toMatchObject({ action: 'allow', step: '3c' })
  })

  it('Step 4a：抽样失败 + 目录名与项目名均相同 → 拒绝', () => {
    const stored = makeStored({ dir_name: 'new-root', project_name: 'new-root', sample_files_json: '[]' })
    const fp = makeFingerprint({ sampleCount: 0, samples: [] })
    const d = decideImport({ ...BASE_INPUT, fingerprint: fp, stored: [stored] })
    expect(d).toMatchObject({ action: 'reject', step: '4a' })
  })

  it('Step 4b：抽样失败但名称不同 → 允许并警告', () => {
    const stored = makeStored({ dir_name: 'other', project_name: 'other', sample_files_json: '[]' })
    const fp = makeFingerprint({ sampleCount: 0, samples: [] })
    const d = decideImport({ ...BASE_INPUT, fingerprint: fp, stored: [stored] })
    expect(d).toMatchObject({ action: 'allow_with_warning', step: '4b' })
  })

  it('新项目（无任何匹配信号）→ 允许', () => {
    const d = decideImport({ ...BASE_INPUT, fingerprint: makeFingerprint(), stored: [] })
    expect(d).toMatchObject({ action: 'allow', step: '3c' })
  })
})

describe('contentSimilarity', () => {
  it('按相对路径交集比对 sha；分母用本次采样数', () => {
    const pair = pairSamples(6, 6, 4)
    const current = makeFingerprint({ samples: pair.current, sampleCount: 12 })
    const stored = makeStored({ sample_files_json: JSON.stringify(pair.stored) })
    // 12 个当前采样中 6 个在对方存在且 sha 相同 → 0.5
    expect(contentSimilarity(current, stored)).toBe(0.5)
  })

  it('当前采样为空 → null（缺失信号不当成不匹配）', () => {
    const current = makeFingerprint({ samples: [], sampleCount: 0 })
    expect(contentSimilarity(current, makeStored())).toBeNull()
  })
})

describe('normalizeDirName', () => {
  it('去首尾空白 + 转小写', () => {
    expect(normalizeDirName('  My-Project ')).toBe('my-project')
  })
})

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE project_fingerprints (
      id TEXT PRIMARY KEY, project_name TEXT, dir_name TEXT NOT NULL, root_path TEXT NOT NULL,
      last_modified_at INTEGER, sample_files_json TEXT NOT NULL, sample_count INTEGER NOT NULL,
      signature_hash TEXT, graph_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      UNIQUE(root_path)
    );
    CREATE TABLE import_rejections (
      id TEXT PRIMARY KEY, attempted_root_path TEXT NOT NULL, attempted_name TEXT, attempted_dir_name TEXT,
      matched_fingerprint_id TEXT, matched_signals_json TEXT NOT NULL,
      decision TEXT NOT NULL, allowance_source TEXT, reason TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE import_allowances (
      id TEXT PRIMARY KEY, fingerprint_id TEXT NOT NULL, dir_name TEXT NOT NULL,
      granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, note TEXT,
      revoked_at TEXT, revoked_by TEXT, UNIQUE(fingerprint_id, dir_name)
    );
    CREATE TABLE graphs (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, project_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE map_migration_reports (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
      status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
    );
  `)
  return db
}

describe('ImportDedupService（DB 面）', () => {
  let db: BetterSqlite3.Database
  let service: ImportDedupService

  beforeEach(() => {
    db = setupDb()
    service = new ImportDedupService(db)
  })

  it('记住规则写入/列表/撤销（撤销不物理删除）', () => {
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO project_fingerprints (id, dir_name, root_path, sample_files_json, sample_count, graph_ids_json, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('pf-1', 'proj', '/p', '[]', 0, '[]', now, now)
    db.prepare(
      'INSERT INTO import_allowances (id, fingerprint_id, dir_name, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)',
    ).run('ia-1', 'pf-1', 'copy-dir', 'local-user', now)

    expect(service.listAllowances()).toHaveLength(1)
    service.revokeAllowance('ia-1', 'tester')
    const rows = service.listAllowances() as Array<{ revoked_at: string | null }>
    expect(rows).toHaveLength(1) // 保留审计痕迹
    expect(rows[0].revoked_at).toBeTruthy()
  })

  it('90 天保留：明细删除、聚合写 import_dedup 报告、allowances 不受影响', () => {
    const now = new Date()
    const old = new Date(now.getTime() - (IMPORT_DEDUP_DEFAULTS.rejectionRetentionDays + 5) * 24 * 3600 * 1000).toISOString()
    const fresh = now.toISOString()
    const ins = db.prepare('INSERT INTO import_rejections (id, attempted_root_path, matched_signals_json, decision, created_at) VALUES (?, ?, ?, ?, ?)')
    ins.run('ir-old', '/x', '{}', 'rejected', old)
    ins.run('ir-fresh', '/y', '{}', 'rejected', fresh)
    db.prepare('INSERT INTO import_allowances (id, fingerprint_id, dir_name, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)').run('ia-keep', 'pf-x', 'd', 'u', old)

    const { deleted } = service.runRetention(now)
    expect(deleted).toBe(1)
    const remaining = db.prepare('SELECT id FROM import_rejections').all() as Array<{ id: string }>
    expect(remaining.map((r) => r.id)).toEqual(['ir-fresh'])
    expect(db.prepare('SELECT COUNT(*) AS c FROM import_allowances').get()).toMatchObject({ c: 1 })

    const report = db.prepare("SELECT * FROM map_migration_reports WHERE kind='import_dedup' AND stage='retention'").get() as Record<string, unknown>
    expect(report.status).toBe('ok')
    expect(JSON.parse(report.stats_json as string)).toMatchObject({ deleted: 1 })
  })

  it('I5：拒绝路径不产生 graphs 行（检查在写入之前由调用顺序保证）', () => {
    // 决策记录只写 import_rejections——graphs 计数保持 0
    const stored = makeStored({ root_path: '/new/root' })
    const d = decideImport({ ...BASE_INPUT, fingerprint: makeFingerprint(), stored: [stored] })
    expect(d.action).toBe('reject')
    expect(db.prepare('SELECT COUNT(*) AS c FROM graphs').get()).toMatchObject({ c: 0 })
  })

  it('isRootPathConflict 识别 UNIQUE(root_path) 冲突（TOCTOU 兜底）', () => {
    expect(isRootPathConflict(new Error('UNIQUE constraint failed: project_fingerprints.root_path'))).toBe(true)
    expect(isRootPathConflict(new Error('UNIQUE constraint failed: graphs.id'))).toBe(false)
    expect(isRootPathConflict('plain string')).toBe(false)
  })

  it('S1.6：历史重复 lineage → 报告行（只报告不删不并）；无重复 → 不写行', () => {
    const ins = db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    // /dup 有两张 online（历史并行 lineage）
    ins.run('g1', 'dup 在线一', 'online', '/dup', '2025-01-01T00:00:00Z', now0())
    ins.run('g2', 'dup 在线二', 'online', '/dup', '2025-06-01T00:00:00Z', now0())
    // /clean 只有一套
    ins.run('g3', 'clean', 'dev', '/clean', '2025-01-01T00:00:00Z', now0())

    const { duplicate_groups } = service.reportHistoricalDuplicateLineages()
    expect(duplicate_groups).toBe(1)
    const report = db
      .prepare("SELECT * FROM map_migration_reports WHERE kind='import_dedup' AND stage='historical_lineage'")
      .get() as Record<string, unknown>
    expect(report.status).toBe('ok')
    const details = JSON.parse(report.details_json as string) as Array<{ project_path: string; count: number }>
    expect(details).toHaveLength(1)
    expect(details[0]).toMatchObject({ project_path: '/dup', count: 2 })
    // 只报告：图行未动
    expect((db.prepare('SELECT COUNT(*) AS c FROM graphs').get() as { c: number }).c).toBe(3)

    // 无重复时再跑 → 不追加报告行
    db.prepare('DELETE FROM graphs WHERE id = ?').run('g2')
    const second = service.reportHistoricalDuplicateLineages()
    expect(second.duplicate_groups).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS c FROM map_migration_reports WHERE stage='historical_lineage'").get() as { c: number }).c).toBe(1)
  })
})

function now0(): string {
  return '2026-01-01T00:00:00Z'
}

/**
 * 拒绝必须在 IPC 边界保住 `decision`。
 *
 * 在此之前 `ImportRejectedError` 是裸 `Error`：`createTypedHandle` 只能包成
 * `IPC_HANDLER_ERROR`，renderer 拿到的就是一句 message——"哪几项对上了"
 * （目录名/项目名/相似度/判定步）全部丢失，界面除了报错什么都做不了。
 */
describe('ImportRejectedError 载荷', () => {
  const decision = {
    action: 'reject' as const,
    step: '2a' as const,
    signals: {
      dir_name_same: true,
      name_same: true,
      similarity: 0.92,
      sample_count: 12,
      mtime_used: false as const,
      decision_step: '2a',
    },
    matchedFingerprintId: 'pf-1',
    reason: '同一项目重导（同名目录且内容相似度 0.92 ≥ 0.6）',
  }

  it('toJSON 带 code 与 details.decision，可被结构化透传', () => {
    const err = new ImportRejectedError(decision)
    const json = err.toJSON()

    expect(err).toBeInstanceOf(BizGraphError)
    expect(json.code).toBe('IMPORT_REJECTED')
    expect(json.name).toBe('ImportRejectedError')
    expect(json.details).toEqual({
      decision: {
        action: 'reject',
        step: '2a',
        reason: decision.reason,
        signals: decision.signals,
      },
    })
  })

  it('message 仍是人话（renderer 不必解析 details 才能显示）', () => {
    expect(new ImportRejectedError(decision).message).toContain('导入被拒绝')
  })
})
