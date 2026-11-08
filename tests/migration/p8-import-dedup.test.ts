/**
 * P8 — 导入查重判定正确（session-map 蓝图 §8.11 / §2.6）。
 *
 * 断言 6 类样本与 §2.6 Step 表一致：
 *   同路径 → reject(1)；同目录名+高相似 → reject(2a)；异目录名+高相似 → reject/3a；
 *   异目录名+中相似 → reject(3b)；抽样失败 → reject(4a) 或 allow_with_warning(4b)；
 *   不同项目（低相似）→ allow(3c)。
 * 另断言：拒绝时 `graphs`/`nodes` 新增行数为 0，拒绝留痕写 `import_rejections`。
 *
 * 前提缺口：§8.11 的“放行时指纹与建图同事务”属于 GraphService 事务路径，
 * 由既有 `src/main/__tests__/graph-service-import-reject.test.ts` 覆盖；
 * 本脚本只验证判定与拒绝留痕。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { decideImport, ImportDedupService } from '../../src/main/map-migration/import-dedup'
import type { ProjectFingerprint, StoredFingerprint } from '../../src/main/map-migration/import-dedup'

function samples(tag: string, n = 12): Array<{ path: string; size: number; sha256: string }> {
  return Array.from({ length: n }, (_, i) => ({
    path: `src/f-${i}.ts`, size: 100,
    sha256: createHash('sha256').update(`${tag}-${i}`).digest('hex'),
  }))
}

function pair(matched: number, currentOnly: number) {
  const current: ReturnType<typeof samples> = []
  const stored: ReturnType<typeof samples> = []
  for (let i = 0; i < matched; i++) {
    const sha = createHash('sha256').update(`m-${i}`).digest('hex')
    current.push({ path: `src/m-${i}.ts`, size: 100, sha256: sha })
    stored.push({ path: `src/m-${i}.ts`, size: 100, sha256: sha })
  }
  for (let i = 0; i < currentOnly; i++) {
    current.push({ path: `src/c-${i}.ts`, size: 100, sha256: createHash('sha256').update(`c-${i}`).digest('hex') })
  }
  return { current, stored }
}

function fp(overrides: Partial<ProjectFingerprint> = {}): ProjectFingerprint {
  return {
    projectName: 'new-root', dirName: 'new-root', rootPath: '/new/root',
    lastModifiedAt: 1, samples: samples('new'), sampleCount: 12, errors: [],
    ...overrides,
  }
}

function stored(overrides: Partial<StoredFingerprint> = {}): StoredFingerprint {
  return {
    id: 'pf-1', root_path: '/old/root', dir_name: 'old-root', project_name: 'old-root',
    sample_files_json: '[]', sample_count: 0, graph_ids_json: JSON.stringify(['g-alive']),
    ...overrides,
  }
}

const BASE = { interactive: false, activeAllowanceDirs: new Set<string>(), graphExists: () => true }

describe('P8 导入查重判定（6 类样本）', () => {
  it('同路径 → reject(1)', () => {
    const d = decideImport({ ...BASE, fingerprint: fp(), stored: [stored({ root_path: '/new/root' })] })
    expect(d).toMatchObject({ action: 'reject', step: '1' })
  })

  it('同目录名 + 高相似 → reject(2a)', () => {
    const p = pair(10, 2)
    const s = stored({ dir_name: 'new-root', sample_files_json: JSON.stringify(p.stored) })
    const d = decideImport({ ...BASE, fingerprint: fp({ samples: p.current }), stored: [s] })
    expect(d).toMatchObject({ action: 'reject', step: '2a' })
  })

  it('异目录名 + 高相似 → 自动导入 reject(3a-auto)；交互确认放行', () => {
    const p = pair(12, 0)
    const s = stored({ sample_files_json: JSON.stringify(p.stored) })
    const f = fp({ samples: p.current, dirName: 'copy', projectName: 'copy' })
    expect(decideImport({ ...BASE, fingerprint: f, stored: [s] })).toMatchObject({ action: 'reject', step: '3a-auto' })
    expect(decideImport({ ...BASE, fingerprint: f, stored: [s], interactive: true })).toMatchObject({ action: 'allow_branch_variant' })
  })

  it('异目录名 + 中相似 → reject(3b)', () => {
    const p = pair(9, 3)
    const s = stored({ sample_files_json: JSON.stringify(p.stored) })
    const f = fp({ samples: p.current, dirName: 'other', projectName: 'other' })
    expect(decideImport({ ...BASE, fingerprint: f, stored: [s] })).toMatchObject({ action: 'reject', step: '3b' })
  })

  it('抽样失败 → 同名 reject(4a) / 异名 allow_with_warning(4b)', () => {
    const s = stored({ dir_name: 'new-root', project_name: 'new-root', sample_files_json: '[]' })
    const fail = fp({ samples: [], sampleCount: 0 })
    expect(decideImport({ ...BASE, fingerprint: fail, stored: [s] })).toMatchObject({ action: 'reject', step: '4a' })
    const s2 = stored({ dir_name: 'other', project_name: 'other', sample_files_json: '[]' })
    expect(decideImport({ ...BASE, fingerprint: fail, stored: [s2] })).toMatchObject({ action: 'allow_with_warning', step: '4b' })
  })

  it('不同项目（低相似）→ allow(3c)', () => {
    const p = pair(2, 10)
    const s = stored({ sample_files_json: JSON.stringify(p.stored) })
    const f = fp({ samples: p.current, dirName: 'other', projectName: 'other' })
    expect(decideImport({ ...BASE, fingerprint: f, stored: [s] })).toMatchObject({ action: 'allow', step: '3c' })
  })
})

describe('P8 拒绝不产生图/节点行', () => {
  let db: BetterSqlite3.Database
  let tmp: string

  beforeEach(() => {
    db = new Database(':memory:') as unknown as BetterSqlite3.Database
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
      CREATE TABLE nodes (id TEXT PRIMARY KEY, title TEXT NOT NULL, graph_id TEXT NOT NULL);
      CREATE TABLE map_migration_reports (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
        started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
        status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
      );
    `)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-import-'))
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(tmp, `f${i}.ts`), `export const v=${i}`)
    const now = new Date().toISOString()
    // macOS /var → /private/var：指纹用 realpath，夹具同口径
    const realRoot = fs.realpathSync(tmp)
    db.prepare(
      'INSERT INTO project_fingerprints (id, dir_name, root_path, sample_files_json, sample_count, graph_ids_json, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('pf-1', path.basename(realRoot), realRoot, '[]', 0, JSON.stringify(['g-alive']), now, now)
    db.prepare(
      'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('g-alive', 'alive', 'online', realRoot, now, now)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('同路径拒绝 → import_rejections +1，graphs/nodes 0 新增', async () => {
    const service = new ImportDedupService(db)
    const result = await service.check({ projectRoot: tmp })
    expect(result.decision.action).toBe('reject')
    expect((db.prepare('SELECT COUNT(*) AS c FROM import_rejections').get() as { c: number }).c).toBe(1)
    // 夹具里预置了 1 个存活图（用于让指纹存活），拒绝不得新增任何 graph/node
    expect((db.prepare('SELECT COUNT(*) AS c FROM graphs').get() as { c: number }).c).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c).toBe(0)
  })
})
