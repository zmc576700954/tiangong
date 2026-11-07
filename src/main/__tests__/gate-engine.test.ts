/**
 * G1–G6 gate 引擎单元测试（session-map 蓝图 §5.4 / §14.9 验收断言的实现子集）。
 *
 * 覆盖：六道 gate 的正例与反例、fail-closed 缺失码、G6 写冲突规范化等价、
 * 评估器零写入（§14.9-9）、同输入幂等（§14.9-10）、D7 未裁决时
 * line_estimate_unavailable 的默认行为。
 */

import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
import { createGateEngine, type GateEngineOptions } from '../map/gate-engine'

const TMP_ROOTS: string[] = []
function makeProjectRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-engine-'))
  TMP_ROOTS.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true })
})

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  // G3 需要的最小 nodes 表（真实库由基础迁移建表；引擎只读这三列）。
  db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, graph_type TEXT NOT NULL)')
  return db
}

interface ItemOverrides {
  id?: string
  project_path?: string | null
  graph_id?: string
  anchor_node_id?: string | null
  scope_files?: string
  acceptance_json?: string
  depends_on_json?: string
  status?: string
  is_current?: number
}

function insertItem(db: BetterSqlite3.Database, over: ItemOverrides = {}): string {
  const id = over.id ?? `wi_${Math.random().toString(36).slice(2, 8)}`
  db.prepare(
    `INSERT INTO work_items (id, lineage_id, revision, is_current, project_path, graph_id, anchor_node_id,
       title, scope_files, acceptance_json, depends_on_json, status, origin, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, '任务', ?, ?, ?, ?, 'human', ?, ?)`,
  ).run(
    id,
    `lin_${id}`,
    over.is_current ?? 1,
    over.project_path === undefined ? makeProjectRoot() : over.project_path,
    over.graph_id ?? 'g1',
    over.anchor_node_id === undefined ? 'n1' : over.anchor_node_id,
    over.scope_files ?? JSON.stringify(['src/a.ts']),
    over.acceptance_json ?? JSON.stringify([{ type: 'command', expected: 'npm test' }]),
    over.depends_on_json ?? '[]',
    over.status ?? 'queued',
    new Date().toISOString(),
    new Date().toISOString(),
  )
  return id
}

function insertNode(db: BetterSqlite3.Database, id: string, graphId: string, graphType: string): void {
  db.prepare('INSERT INTO nodes (id, graph_id, graph_type) VALUES (?, ?, ?)').run(id, graphId, graphType)
}

function makeEngine(db: BetterSqlite3.Database, options: GateEngineOptions = {}) {
  return createGateEngine(db, options)
}

/** 除 G4 预估外全部合法的评估场景。 */
function fullPassOptions(): GateEngineOptions {
  return { estimateLines: () => 10 }
}

describe('G1–G6 gate 引擎（§5.4 / §14）', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
    insertNode(db, 'n1', 'g1', 'dev')
  })

  it('全满足 → ok:true 且 missing 为空（注入预估来源）', () => {
    const id = insertItem(db, { project_path: makeProjectRoot() })
    const engine = makeEngine(db, fullPassOptions())
    const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
    expect(engine.recheck(row)).toEqual({ ok: true, missing: [] })
  })

  it('D7 默认：无预估来源 → 仅 line_estimate_unavailable，不伪造 pass', () => {
    const id = insertItem(db, { project_path: makeProjectRoot() })
    const engine = makeEngine(db)
    const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
    const result = engine.recheck(row)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['line_estimate_unavailable'])
  })

  it('同输入幂等：两次 recheck 结果完全一致（§14.9-10）', () => {
    const id = insertItem(db, { project_path: makeProjectRoot(), scope_files: JSON.stringify(['../x.ts']) })
    const engine = makeEngine(db, fullPassOptions())
    const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
    expect(engine.recheck(row)).toEqual(engine.recheck(row))
  })

  it('评估器零写入：recheck 前后四张表逐行不变（§14.9-9）', () => {
    const id = insertItem(db, { project_path: makeProjectRoot() })
    insertItem(db, { id: 'wi_run', status: 'running', scope_files: JSON.stringify(['src/b.ts']) })
    const engine = makeEngine(db)
    const snapshot = (): string => {
      const tables = ['work_items', 'work_steps', 'work_runs', 'node_evidence']
      return JSON.stringify(
        tables.map((t) => {
          try {
            return db.prepare(`SELECT * FROM ${t}`).all()
          } catch {
            return [] // node_evidence 可能未建表（S6a 未应用）
          }
        }),
      )
    }
    const before = snapshot()
    const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
    engine.recheck(row)
    expect(snapshot()).toBe(before)
  })

  describe('G1 · scope 非空且在项目根内（§5.4.1）', () => {
    it.each([
      ['空数组', { scope_files: '[]' }, 'scope_files_empty'],
      ['非法 JSON', { scope_files: '{' }, 'scope_files_invalid_json'],
      ['project_path 为空（D4 默认 fail-closed）', { project_path: null }, 'project_path_missing'],
      ['Windows 根（A9）', { project_path: 'C:\\repo' }, 'project_path_non_posix'],
    ])('%s → 缺失码', (_name, over, code) => {
      const id = insertItem(db, { project_path: makeProjectRoot(), ...over })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      expect(engine.recheck(row).missing).toContain(code)
    })

    it('相对路径越界（../）→ scope_file_escape:0', () => {
      const id = insertItem(db, { project_path: makeProjectRoot(), scope_files: JSON.stringify(['../outside.ts']) })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      expect(engine.recheck(row).missing).toContain('scope_file_escape:0')
    })

    it('外部绝对路径 → scope_file_escape:0', () => {
      const id = insertItem(db, {
        project_path: makeProjectRoot(),
        scope_files: JSON.stringify(['/etc/passwd']),
      })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      expect(engine.recheck(row).missing).toContain('scope_file_escape:0')
    })

    it('中间目录 symlink 指向根外 → scope_file_escape（§5.4.1 第 1/5 条）', () => {
      const root = makeProjectRoot()
      const outside = makeProjectRoot()
      symlinkSync(outside, path.join(root, 'link'), 'dir')
      const id = insertItem(db, { project_path: root, scope_files: JSON.stringify(['link/x.txt']) })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      expect(engine.recheck(row).missing).toContain('scope_file_escape:0')
    })

    it('尚不存在的文件（最近已存在祖先 realpath 拼回）→ 通过', () => {
      const root = makeProjectRoot()
      mkdirSync(path.join(root, 'src'))
      const id = insertItem(db, { project_path: root, scope_files: JSON.stringify(['src/new-file.ts']) })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      expect(engine.recheck(row).missing).not.toContain('scope_file_escape:0')
    })

    it('空串条目 → scope_file_empty:0', () => {
      const id = insertItem(db, { project_path: makeProjectRoot(), scope_files: JSON.stringify(['']) })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      expect(engine.recheck(row).missing).toContain('scope_file_empty:0')
    })
  })

  describe('G2 · acceptance 结构化可判定（§5.4 G2 / D1）', () => {
    const run = (acceptance: string): string[] => {
      const id = insertItem(db, { project_path: makeProjectRoot(), acceptance_json: acceptance })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      return engine.recheck(row).missing
    }

    it('空数组 → acceptance_json_empty', () => {
      expect(run('[]')).toContain('acceptance_json_empty')
    })
    it('非法 JSON → acceptance_json_invalid', () => {
      expect(run('not-json')).toContain('acceptance_json_invalid')
    })
    it('存量 [{id,text}] → acceptance_item_not_structured:0（D1 未裁决即此判定）', () => {
      expect(run(JSON.stringify([{ id: 'acc1', text: '必须通过' }]))).toContain('acceptance_item_not_structured:0')
    })
    it('未知 type → acceptance_type_unknown:0', () => {
      expect(run(JSON.stringify([{ type: 'vibes', expected: '感觉对' }]))).toContain('acceptance_type_unknown:0')
    })
    it('expected 为空串 → acceptance_expected_missing:0', () => {
      expect(run(JSON.stringify([{ type: 'command', expected: '  ' }]))).toContain('acceptance_expected_missing:0')
    })
    it('含 1 条合法 command + 若干非结构化补充 → G2 通过', () => {
      expect(
        run(JSON.stringify([{ id: 'acc0', text: '备注' }, { type: 'file_check', expected: 'dist存在' }])),
      ).not.toContain('acceptance_item_not_structured:0')
    })
  })

  describe('G3 · 锚点在 dev 图（§5.4 G3 可判定子集；D5/D6 待决）', () => {
    const run = (over: ItemOverrides): string[] => {
      const id = insertItem(db, { project_path: makeProjectRoot(), ...over })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      return engine.recheck(row).missing
    }

    it('锚点为空 → anchor_node_missing', () => {
      expect(run({ anchor_node_id: null })).toContain('anchor_node_missing')
    })
    it('锚点行不存在 → anchor_node_missing', () => {
      expect(run({ anchor_node_id: 'n-missing' })).toContain('anchor_node_missing')
    })
    it('锚点非 dev 图 → anchor_node_not_dev:online', () => {
      insertNode(db, 'n-online', 'g1', 'online')
      expect(run({ anchor_node_id: 'n-online' })).toContain('anchor_node_not_dev:online')
    })
    it('锚点属于其他图 → anchor_node_graph_mismatch', () => {
      insertNode(db, 'n-g2', 'g2', 'dev')
      expect(run({ anchor_node_id: 'n-g2' })).toContain('anchor_node_graph_mismatch')
    })
  })

  describe('G4 · 规模上限（§5.4 G4 / D7）', () => {
    const manyFiles = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`)
    const run = (options: GateEngineOptions, scope = manyFiles): string[] => {
      const id = insertItem(db, { project_path: makeProjectRoot(), scope_files: JSON.stringify(scope) })
      const engine = makeEngine(db, options)
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      return engine.recheck(row).missing
    }

    it('21 个文件 > 20 → scope_file_count_exceeded', () => {
      expect(run(fullPassOptions())).toContain('scope_file_count_exceeded:21_20')
    })
    it('预估 801 行 > 800 → estimated_lines_exceeded', () => {
      expect(run({ estimateLines: () => 801 })).toContain('estimated_lines_exceeded:801_800')
    })
    it('预估来源返回 null → line_estimate_unavailable（fail-closed）', () => {
      expect(run({ estimateLines: () => null })).toContain('line_estimate_unavailable')
    })
    it('阈值配置非法 → gate_policy_missing', () => {
      expect(run({ ...fullPassOptions(), g4MaxFiles: 0 })).toContain('gate_policy_missing')
    })
  })

  describe('G5 · 依赖闭包（§5.4 G5 / §5.5.1）', () => {
    const run = (deps: unknown): string[] => {
      const id = insertItem(db, { project_path: makeProjectRoot(), depends_on_json: JSON.stringify(deps) })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      return engine.recheck(row).missing
    }

    it('上游不存在 → dep_missing', () => {
      expect(run(['wi-gone'])).toContain('dep_missing:wi-gone')
    })
    it('上游未完成（queued）→ dep_not_done:<id>:queued', () => {
      insertItem(db, { id: 'wi-up', project_path: makeProjectRoot(), status: 'queued' })
      expect(run(['wi-up'])).toContain('dep_not_done:wi-up:queued')
    })
    it('上游 done → 无 dep_not_done', () => {
      insertItem(db, { id: 'wi-up', project_path: makeProjectRoot(), status: 'done' })
      expect(run(['wi-up'])).not.toContain('dep_not_done:wi-up')
    })
    it('传递依赖未完成也拦（闭包）', () => {
      insertItem(db, { id: 'wi-mid', project_path: makeProjectRoot(), status: 'done', depends_on_json: JSON.stringify(['wi-leaf']) })
      insertItem(db, { id: 'wi-leaf', project_path: makeProjectRoot(), status: 'queued' })
      expect(run(['wi-mid'])).toContain('dep_not_done:wi-leaf:queued')
    })
    it('环 a→b→a → dep_cycle', () => {
      insertItem(db, { id: 'wi-a', project_path: makeProjectRoot(), status: 'done', depends_on_json: JSON.stringify(['wi-b']) })
      insertItem(db, { id: 'wi-b', project_path: makeProjectRoot(), status: 'done', depends_on_json: JSON.stringify(['wi-a']) })
      expect(run(['wi-a'])).toContain('dep_cycle:wi-a')
    })
    it('自依赖 → dep_cycle', () => {
      const id = insertItem(db, { project_path: makeProjectRoot() })
      db.prepare('UPDATE work_items SET depends_on_json = ? WHERE id = ?').run(JSON.stringify([id]), id)
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      expect(engine.recheck(row).missing).toContain(`dep_cycle:${id}`)
    })
    it('指向非当前 revision → dep_revision_stale', () => {
      insertItem(db, { id: 'wi-old', project_path: makeProjectRoot(), status: 'done', is_current: 0 })
      expect(run(['wi-old'])).toContain('dep_revision_stale:wi-old')
    })
    it('跨项目依赖 → dep_cross_project', () => {
      insertItem(db, { id: 'wi-up', project_path: '/other/project', status: 'done' })
      expect(run(['wi-up'])).toContain('dep_cross_project:wi-up')
    })
    it('depends_on_json 非法 → depends_invalid_json', () => {
      expect(run('nope')).toContain('depends_invalid_json')
    })
  })

  describe('G6 · 与 running 任务 scope 无交集（§5.4 G6 / D10）', () => {
    const runWithRunning = (runningScope: string, runningProject?: string): string[] => {
      const root = makeProjectRoot()
      insertItem(db, { id: 'wi_me', project_path: root })
      insertItem(db, { id: 'wi_run', project_path: runningProject ?? root, status: 'running', scope_files: runningScope })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare("SELECT * FROM work_items WHERE id = 'wi_me'").get() as never
      return engine.recheck(row).missing
    }

    it('同路径 running → scope_conflict', () => {
      expect(runWithRunning(JSON.stringify(['src/a.ts']))).toContain('scope_conflict:wi_run:src/a.ts')
    })
    it('写法不同但规范化后相同（./ 前缀）→ 仍冲突', () => {
      expect(runWithRunning(JSON.stringify(['./src/a.ts']))).toContain('scope_conflict:wi_run:./src/a.ts')
    })
    it('无交集 → 不冲突', () => {
      expect(runWithRunning(JSON.stringify(['src/other.ts']))).not.toContain('scope_conflict:wi_run')
    })
    it('不同项目 → 不比较（D10 默认）', () => {
      expect(runWithRunning(JSON.stringify(['src/a.ts']), '/another/project')).not.toContain('scope_conflict:wi_run')
    })
    it('running 行 scope 非法 JSON → scope_invalid:<id>（不跳过坏行）', () => {
      expect(runWithRunning('{')).toContain('scope_invalid:wi_run')
    })

    it('NFC 归一（§5.4.1 第 4 条）：NFC 与 NFD 写法（文件尚不存在）→ 仍冲突', () => {
      const root = makeProjectRoot()
      const nfd = 'cafe\u0301.ts' // café 分解形式（e + 组合尖音符）
      const nfc = nfd.normalize('NFC') // 组合形式（é U+00E9）
      expect(nfc).not.toBe(nfd)
      insertItem(db, { id: 'wi_me', project_path: root, scope_files: JSON.stringify([nfc]) })
      insertItem(db, { id: 'wi_run', project_path: root, status: 'running', scope_files: JSON.stringify([nfd]) })
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare("SELECT * FROM work_items WHERE id = 'wi_me'").get() as never
      expect(engine.recheck(row).missing.some((m) => m.startsWith('scope_conflict:wi_run:'))).toBe(true)
    })

    it.skipIf(process.platform !== 'darwin')(
      '大小写折叠（§5.4.1 第 2 条，darwin）：SRC/A.TS 与 src/a.ts → 冲突',
      () => {
        const root = makeProjectRoot()
        insertItem(db, { id: 'wi_me', project_path: root, scope_files: JSON.stringify(['SRC/A.TS']) })
        insertItem(db, { id: 'wi_run', project_path: root, status: 'running', scope_files: JSON.stringify(['src/a.ts']) })
        const engine = makeEngine(db, fullPassOptions())
        const row = db.prepare("SELECT * FROM work_items WHERE id = 'wi_me'").get() as never
        expect(engine.recheck(row).missing).toContain('scope_conflict:wi_run:src/a.ts')
      },
    )
  })

  describe('G4 去重：同一文件重复列入 scope 只计一次（§5.4「去重后」）', () => {
    it('1 个文件重复 25 次 → 不触发 scope_file_count_exceeded', () => {
      const id = insertItem(db, {
        project_path: makeProjectRoot(),
        scope_files: JSON.stringify(Array.from({ length: 25 }, () => 'src/a.ts')),
      })
      const engine = makeEngine(db, {
        estimateLines: (files) => {
          expect(files).toEqual(['src/a.ts'])
          return 10
        },
      })
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      expect(engine.recheck(row).missing).not.toContain('scope_file_count_exceeded')
    })
  })

  describe('人工豁免（§14.4 G2 / §14.6 / §14.9-3）：仅 G2 manual 条目、三字段齐全', () => {
    /** 失败条目可组合的 G2 场景：全部缺失码来自 manual 条目缺 expected。 */
    const manualOnlyAcceptance = JSON.stringify([{ type: 'manual', expected: '' }])

    function runWaived(
      over: ItemOverrides & {
        waivedBy?: string | null
        waivedAt?: number | null
        waiveReason?: string | null
      },
      acceptance = manualOnlyAcceptance,
    ): { ok: boolean; missing: string[]; waived?: unknown } {
      const id = insertItem(db, { project_path: makeProjectRoot(), acceptance_json: acceptance, ...over })
      db.prepare(
        'UPDATE work_items SET gate_waived_by = ?, gate_waived_at = ?, gate_waive_reason = ? WHERE id = ?',
      ).run(
        over.waivedBy === undefined ? 'alice' : over.waivedBy,
        over.waivedAt === undefined ? 1700000000000 : over.waivedAt,
        over.waiveReason === undefined ? '人工确认无需机器判定' : over.waiveReason,
        id,
      )
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      return engine.recheck(row)
    }

    it('manual 失败条目 + 三字段齐全 → ok:true + waived 记录（§14.9-3 正例）', () => {
      const result = runWaived({})
      expect(result.ok).toBe(true)
      expect(result.missing).toEqual([])
      expect(result.waived).toEqual({ by: 'alice', at: 1700000000000, reason: '人工确认无需机器判定' })
    })

    it('豁免缺 reason → incomplete（§14.9-3 反例）', () => {
      const result = runWaived({ waiveReason: null })
      expect(result.ok).toBe(false)
      expect(result.missing).toContain('acceptance_expected_missing:0')
    })

    it('豁免缺 by → incomplete', () => {
      expect(runWaived({ waivedBy: null }).ok).toBe(false)
    })

    it('G1 失败 + 豁免 → 仍 incomplete（G1 不可豁免，§14.9-3）', () => {
      const result = runWaived({ scope_files: JSON.stringify(['../outside.ts']) })
      expect(result.ok).toBe(false)
      expect(result.missing).toContain('scope_file_escape:0')
    })

    it('G4 失败 + 豁免 → 仍 incomplete（超量文件，G4 不可豁免）', () => {
      const id = insertItem(db, {
        project_path: makeProjectRoot(),
        acceptance_json: manualOnlyAcceptance,
        scope_files: JSON.stringify(Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`)),
      })
      db.prepare(
        'UPDATE work_items SET gate_waived_by = ?, gate_waived_at = ?, gate_waive_reason = ? WHERE id = ?',
      ).run('alice', 1700000000000, '人工确认', id)
      const engine = makeEngine(db, fullPassOptions())
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as never
      const result = engine.recheck(row)
      expect(result.ok).toBe(false)
      expect(result.missing).toContain('scope_file_count_exceeded:21_20')
    })

    it('G5 失败 + 豁免 → 仍 incomplete（D9 裁决前 G5 不可豁免）', () => {
      const root = makeProjectRoot()
      insertItem(db, { id: 'wi-up', project_path: root, status: 'queued' })
      const result = runWaived({ project_path: root, depends_on_json: JSON.stringify(['wi-up']) })
      expect(result.ok).toBe(false)
      expect(result.missing).toContain('dep_not_done:wi-up:queued')
    })

    it('command 条目失败 + 豁免 → 仍 incomplete（manual 豁免不覆盖 command，D3）', () => {
      const result = runWaived(
        {},
        JSON.stringify([{ type: 'command', expected: '' }]),
      )
      expect(result.ok).toBe(false)
      expect(result.missing).toContain('acceptance_expected_missing:0')
    })

    it('存量 [{id,text}] + 豁免 → 仍 incomplete（非结构化条目不可豁免）', () => {
      const result = runWaived({}, JSON.stringify([{ id: 'acc1', text: '必须通过' }]))
      expect(result.ok).toBe(false)
      expect(result.missing).toContain('acceptance_item_not_structured:0')
    })

    it('内容本身可判 pass 时，豁免字段不参与：结果不带 waived', () => {
      const result = runWaived(
        {},
        JSON.stringify([{ type: 'command', expected: 'npm test' }]),
      )
      expect(result).toEqual({ ok: true, missing: [] })
    })
  })
})
