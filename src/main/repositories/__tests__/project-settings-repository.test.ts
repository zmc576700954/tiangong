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

  it('再次 set 覆盖旧值（不是追加）', () => {
    repo.set('/work/alpha', { defaultAdapter: 'codex', allowedFiles: ['a.ts'] })
    repo.set('/work/alpha', { defaultAdapter: 'claude-code' })

    const got = repo.get('/work/alpha')
    expect(got?.defaultAdapter).toBe('claude-code')
    expect(got?.allowedFiles).toBeUndefined()
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
  it('统一分隔符、去掉尾斜杠、解析 . 与 .. 段', () => {
    expect(normalizeProjectPath('/work/alpha/')).toBe('/work/alpha')
    expect(normalizeProjectPath('/work/./alpha')).toBe('/work/alpha')
    expect(normalizeProjectPath('/work/b/../alpha')).toBe('/work/alpha')
    expect(normalizeProjectPath('C:\\work\\alpha')).toBe('C:/work/alpha')
  })

  it('保留 UNC 路径的根前缀', () => {
    expect(normalizeProjectPath('\\\\server\\share\\dir')).toBe('//server/share/dir')
  })

  it('根路径不被吃成空串', () => {
    expect(normalizeProjectPath('/')).toBe('/')
  })

  it('同一个目录的不同写法归一到同一个键', () => {
    const forms = ['/work/alpha', '/work/alpha/', '/work/./alpha', '/work/x/../alpha']
    const keys = new Set(forms.map(normalizeProjectPath))
    expect(keys.size).toBe(1)
  })
})
