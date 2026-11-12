/**
 * ProjectSettingsRepository 的真实库测试。
 *
 * 用真实 better-sqlite3（而非 mock db）—— 这里要验的是「写进哪一行」、
 * 「读回来是什么」，mock 掉 prepare 之后测不出任何真实行为。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-project-settings-test-' + process.pid)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? TEST_USER_DATA : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../../database'
import { ProjectSettingsRepository, normalizeProjectPath } from '../project-settings-repository'

describe('ProjectSettingsRepository', () => {
  let db: ReturnType<typeof getClient>
  let repo: ProjectSettingsRepository

  beforeAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
    initDatabase()
    db = getClient()
    repo = new ProjectSettingsRepository(db)
  })

  afterAll(() => {
    closeDatabase()
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM project_settings').run()
  })

  it('set 后 get 读回同样的内容', () => {
    repo.set('/work/alpha', {
      defaultAdapter: 'codex',
      defaultModel: 'gpt-5',
      allowedFiles: ['src/a.ts', 'src/b.ts'],
    })

    expect(repo.get('/work/alpha')).toEqual({
      defaultAdapter: 'codex',
      defaultModel: 'gpt-5',
      allowedFiles: ['src/a.ts', 'src/b.ts'],
    })
  })

  it('不存在的项目返回 undefined', () => {
    expect(repo.get('/work/never-set')).toBeUndefined()
  })

  it('再次 set 按字段合并（两个窗口各改各的字段，互不覆盖）', () => {
    // 整条替换会让「最后写者赢」：窗口 A 改了 allowedFiles、窗口 B 改了
    // defaultAdapter，B 会把 A 的改动悄悄丢掉。
    repo.set('/work/alpha', { defaultAdapter: 'codex', allowedFiles: ['a.ts'] })
    repo.set('/work/alpha', { allowedFiles: ['b.ts'] })

    const got = repo.get('/work/alpha')
    expect(got?.allowedFiles).toEqual(['b.ts'])
    // 另一个窗口改的字段仍在
    expect(got?.defaultAdapter).toBe('codex')
  })

  it('显式清空 allowedFiles 会真的清空（合并语义对数组不成立）', () => {
    repo.set('/work/alpha', { allowedFiles: ['a.ts'] })
    repo.set('/work/alpha', { allowedFiles: [] })
    expect(repo.get('/work/alpha')?.allowedFiles).toEqual([])
  })

  it('clear 删除该项目的设置', () => {
    repo.set('/work/alpha', { defaultAdapter: 'codex' })
    repo.clear('/work/alpha')
    expect(repo.get('/work/alpha')).toBeUndefined()
  })

  it('路径写法不同也命中同一行（尾斜杠 / . / .. 段）', () => {
    repo.set('/work/alpha', { defaultAdapter: 'codex' })

    expect(repo.get('/work/alpha/')?.defaultAdapter).toBe('codex')
    expect(repo.get('/work/./alpha')?.defaultAdapter).toBe('codex')
    expect(repo.get('/work/b/../alpha')?.defaultAdapter).toBe('codex')
  })

  it('脏数据（非法 JSON）不让读取抛异常，返回 undefined', () => {
    db.prepare(
      'INSERT INTO project_settings (project_path, defaults_json, updated_at) VALUES (?, ?, ?)',
    ).run('/work/broken', '{ not json', new Date().toISOString())

    expect(() => repo.get('/work/broken')).not.toThrow()
    expect(repo.get('/work/broken')).toBeUndefined()
  })

  it('脏数据（结构不对）也返回 undefined', () => {
    db.prepare(
      'INSERT INTO project_settings (project_path, defaults_json, updated_at) VALUES (?, ?, ?)',
    ).run('/work/bad-shape', '{"defaultAdapter": 42}', new Date().toISOString())

    expect(repo.get('/work/bad-shape')).toBeUndefined()
  })
})

describe('normalizeProjectPath', () => {
  it('去掉尾斜杠、解析 . 与 .. 段', () => {
    expect(normalizeProjectPath('/work/alpha/')).toBe('/work/alpha')
    expect(normalizeProjectPath('/work/./alpha')).toBe('/work/alpha')
    expect(normalizeProjectPath('/work/b/../alpha')).toBe('/work/alpha')
  })

  it('Windows 盘符路径保留盘符根', () => {
    // 主进程按平台语义处理：Windows 上 '\' 是分隔符
    expect(normalizeProjectPath('C:\\work\\alpha', true)).toBe('C:/work/alpha')
  })

  it('UNC 路径保留根前缀', () => {
    expect(normalizeProjectPath('\\\\server\\share\\dir', true)).toBe('//server/share/dir')
  })

  it('POSIX 上反斜杠是合法文件名字符，不能与目录分隔符混同', () => {
    // `/work/my\dir` 与 `/work/my/dir` 是**两个不同的目录** ——
    // 归一到同一个键会让 A 项目的范围默认值出现在 B 项目上
    expect(normalizeProjectPath('/work/my\\dir', false)).not.toBe(
      normalizeProjectPath('/work/my/dir', false),
    )
  })

  it('根路径不被吃成空串', () => {
    expect(normalizeProjectPath('/')).toBe('/')
  })

  it('同一个目录的不同写法归一到同一个键', () => {
    const forms = ['/work/alpha', '/work/alpha/', '/work/./alpha', '/work/x/../alpha']
    const keys = new Set(forms.map((f) => normalizeProjectPath(f)))
    expect(keys.size).toBe(1)
  })
})
