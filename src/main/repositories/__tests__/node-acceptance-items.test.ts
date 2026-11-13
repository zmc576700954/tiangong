/**
 * `nodes.acceptance_items` —— FR-S1-02 存储层往返。
 *
 * 为什么必须跑真实库：列是否真的加上了、旧行是否能读回 undefined、写入是否被
 * `isAcceptanceItemArray` 校验拦下，都只有在真 schema 上才成立。手搓最小表会把
 * 「列漏了」和「校验没生效」一起掩盖掉。
 *
 * 断言重点：
 *  1. 列存在且在 createSql 里（否则任何一次 nodes 重建都会丢值）；
 *  2. 写入 → 读回原样（含 command/file_check 的专属键）；
 *  3. 旧行（无该列值）读回 undefined，不炸、不变成 []；
 *  4. 库里存了坏 JSON / 形状不符时整体退回 undefined（不拿半坏数据去判定）。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const electronPaths = vi.hoisted(() => ({ userData: '' }))
const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-acceptance-items-test-' + process.pid)
electronPaths.userData = TEST_USER_DATA

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? electronPaths.userData : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../../database'
import { NodeRepository } from '../node-repository'
import type { AcceptanceItem } from '@shared/acceptance'

describe('nodes.acceptance_items 存储层', () => {
  let db: ReturnType<typeof getClient>
  let nodeRepo: NodeRepository

  beforeAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
    initDatabase()
    db = getClient()
    nodeRepo = new NodeRepository(db)
  })

  afterAll(() => {
    closeDatabase()
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
  })

  const base = {
    type: 'feature' as const,
    status: 'draft' as const,
    graphId: 'g1',
    graphType: 'online' as const,
    position: { x: 0, y: 0 },
  }

  it('列已存在（initDatabase 补列生效）', () => {
    const cols = db.prepare("PRAGMA table_info('nodes')").all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('acceptance_items')
  })

  it('create 写入结构化条目并能原样读回', () => {
    const items: AcceptanceItem[] = [
      { type: 'command', expected: 'npm test', stdout_contains: 'passed', timeout_ms: 60_000 },
      { type: 'file_check', expected: 'src/feature.ts', content_contains: 'export' },
      { type: 'manual', expected: '产品确认文案', id: 'acc_0', text: '文案无误' },
    ]
    const created = nodeRepo.create({ ...base, title: '带结构化验收', acceptanceItems: items })

    const reloaded = nodeRepo.findById(created.id)
    expect(reloaded?.acceptanceItems).toEqual(items)
  })

  it('只给字符串验收的旧节点，读回 acceptanceItems 为 undefined', () => {
    const created = nodeRepo.create({
      ...base,
      title: '只有字符串验收',
      acceptanceCriteria: ['页面能打开', '列表出现新记录'],
    })
    const reloaded = nodeRepo.findById(created.id)
    expect(reloaded?.acceptanceCriteria).toEqual(['页面能打开', '列表出现新记录'])
    expect(reloaded?.acceptanceItems).toBeUndefined()
  })

  it('update 可单独改结构化条目，且不影响 acceptanceCriteria', () => {
    const created = nodeRepo.create({
      ...base,
      title: '先有字符串再有结构化',
      acceptanceCriteria: ['人读摘要'],
    })
    const next: AcceptanceItem[] = [{ type: 'command', expected: 'npm run lint' }]
    nodeRepo.update(created.id, { acceptanceItems: next })

    const reloaded = nodeRepo.findById(created.id)
    expect(reloaded?.acceptanceItems).toEqual(next)
    expect(reloaded?.acceptanceCriteria).toEqual(['人读摘要'])

    // undefined = 本次不改动，必须保持原值
    nodeRepo.update(created.id, { title: '改名' })
    expect(nodeRepo.findById(created.id)?.acceptanceItems).toEqual(next)
  })

  it('清空用 []，读回空数组（不是 undefined）', () => {
    const created = nodeRepo.create({
      ...base,
      title: '清空结构化',
      acceptanceItems: [{ type: 'command', expected: 'npm test' }],
    })
    nodeRepo.update(created.id, { acceptanceItems: [] })
    expect(nodeRepo.findById(created.id)?.acceptanceItems).toEqual([])
  })

  it('库里是坏 JSON 时整体退回 undefined，不抛错', () => {
    const created = nodeRepo.create({ ...base, title: '坏 JSON' })
    db.prepare('UPDATE nodes SET acceptance_items = ? WHERE id = ?').run('{not json', created.id)
    expect(nodeRepo.findById(created.id)?.acceptanceItems).toBeUndefined()
  })

  it('库里是形状不符的数组时整体退回 undefined（不拿半坏数据判定）', () => {
    const created = nodeRepo.create({ ...base, title: '形状不符' })
    db.prepare('UPDATE nodes SET acceptance_items = ? WHERE id = ?').run(
      JSON.stringify([
        { type: 'command', expected: 'npm test' },
        { type: 'bogus', expected: '不许通过' },
      ]),
      created.id,
    )
    expect(nodeRepo.findById(created.id)?.acceptanceItems).toBeUndefined()
  })

  it('旧写入语句（不含该列）留下的行可正常读取', () => {
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run('legacy_row', 'feature', 'draft', '旧行', 'g1', 'online', 0, 0, now, now)

    const legacy = nodeRepo.findById('legacy_row')
    expect(legacy?.title).toBe('旧行')
    expect(legacy?.acceptanceItems).toBeUndefined()
    expect(legacy?.acceptanceCriteria).toEqual([])
  })
})
