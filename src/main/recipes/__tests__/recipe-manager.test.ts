/**
 * Tests for RecipeManager
 *
 * 覆盖：
 *  - 从 userData/recipes/ + <projectRoot>/.bizgraph/recipes/ 加载
 *  - 项目级覆盖用户级（同 id）
 *  - 单个坏 YAML 不影响其它加载
 *  - list / get / getOrThrow / refresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { RecipeManager } from '../recipe-manager'
import { BizGraphError, ErrorCode } from '../../errors'
import type { RecipeDefinition } from '@shared/types/recipe'

const mockUserDataPath = '/tmp/bizgraph-test'
const userRecipes: Map<string, string> = new Map()
const projectRecipes: Map<string, string> = new Map()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/tmp/${name}`
    }),
  },
}))

vi.mock('node:fs', () => ({
  promises: {
    readdir: vi.fn(async (dir: string) => {
      const normalized = dir.replace(/\\/g, '/')
      const names: string[] = []
      for (const path of userRecipes.keys()) {
        if (path.startsWith(normalized + '/')) {
          const rest = path.slice(normalized.length + 1)
          if (!rest.includes('/')) names.push(rest)
        }
      }
      for (const path of projectRecipes.keys()) {
        if (path.startsWith(normalized + '/')) {
          const rest = path.slice(normalized.length + 1)
          if (!rest.includes('/')) names.push(rest)
        }
      }
      if (names.length === 0) {
        const err = new Error('ENOENT') as Error & { code: string }
        err.code = 'ENOENT'
        throw err
      }
      return names
    }),
    readFile: vi.fn(async (filePath: string) => {
      const normalized = filePath.replace(/\\/g, '/')
      if (userRecipes.has(normalized)) return userRecipes.get(normalized)!
      if (projectRecipes.has(normalized)) return projectRecipes.get(normalized)!
      const err = new Error('ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    }),
  },
}))

function setupDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      description TEXT,
      tags TEXT,
      source TEXT NOT NULL,
      source_path TEXT NOT NULL,
      yaml_text TEXT NOT NULL,
      inputs_schema TEXT,
      steps_json TEXT NOT NULL,
      default_adapter TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE recipe_runs (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      recipe_version TEXT NOT NULL,
      session_id TEXT,
      graph_id TEXT,
      node_id TEXT,
      status TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      outputs_json TEXT NOT NULL,
      error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
  `)
  return db
}

function validYaml(id: string, extra = ''): string {
  return `
id: ${id}
name: ${id} Recipe
version: "1"
${extra}
steps:
  - kind: agent
    agent_type: explore
    description: Step
    prompt: do something
`
}

beforeEach(() => {
  userRecipes.clear()
  projectRecipes.clear()
})

describe('RecipeManager', () => {
  it('loadAll loads user-level YAML files', async () => {
    userRecipes.set(`${mockUserDataPath}/recipes/a.yaml`, validYaml('a'))
    userRecipes.set(`${mockUserDataPath}/recipes/b.yaml`, validYaml('b'))

    const mgr = new RecipeManager({ db: setupDb() })
    await mgr.loadAll()

    expect(mgr.list().map((r) => r.id).sort()).toEqual(['a', 'b'])
    expect(mgr.get('a')?.source).toBe('user')
  })

  it('loadAll loads project-level YAML files when workingDirectory set', async () => {
    userRecipes.set(`${mockUserDataPath}/recipes/a.yaml`, validYaml('a'))
    projectRecipes.set('/proj/.bizgraph/recipes/p.yaml', validYaml('p'))

    const mgr = new RecipeManager({ db: setupDb() })
    await mgr.loadAll()
    await mgr.setWorkingDirectory('/proj')
    expect(mgr.list().map((r) => r.id).sort()).toEqual(['a', 'p'])
    expect(mgr.get('p')?.source).toBe('project')
  })

  it('project-level overrides user-level for the same id', async () => {
    userRecipes.set(`${mockUserDataPath}/recipes/a.yaml`, validYaml('a', 'description: from user'))
    projectRecipes.set('/proj/.bizgraph/recipes/a.yaml', validYaml('a', 'description: from project'))

    const mgr = new RecipeManager({ db: setupDb() })
    await mgr.setWorkingDirectory('/proj')

    expect(mgr.list()).toHaveLength(1)
    expect(mgr.get('a')?.source).toBe('project')
    expect(mgr.get('a')?.description).toBe('from project')
  })

  it('a single bad YAML does not crash loading', async () => {
    userRecipes.set(`${mockUserDataPath}/recipes/bad.yaml`, 'this is not: : : valid yaml: :')
    userRecipes.set(`${mockUserDataPath}/recipes/good.yaml`, validYaml('good'))

    const mgr = new RecipeManager({ db: setupDb() })
    await mgr.loadAll()

    expect(mgr.list().map((r) => r.id)).toEqual(['good'])
  })

  it('missing userData/recipes dir is fine', async () => {
    const mgr = new RecipeManager({ db: setupDb() })
    await mgr.loadAll()
    expect(mgr.list()).toEqual([])
  })

  it('getOrThrow throws RECIPE_NOT_FOUND', () => {
    const mgr = new RecipeManager({ db: setupDb() })
    expect(() => mgr.getOrThrow('missing')).toThrow(BizGraphError)
    try {
      mgr.getOrThrow('missing')
    } catch (err) {
      expect((err as BizGraphError).code).toBe(ErrorCode.RECIPE_NOT_FOUND)
    }
  })

  it('persists to recipes table', async () => {
    userRecipes.set(`${mockUserDataPath}/recipes/persist.yaml`, validYaml('persist'))
    const db = setupDb()
    const mgr = new RecipeManager({ db })
    await mgr.loadAll()

    const row = db.prepare('SELECT id, source, source_path, yaml_text FROM recipes WHERE id = ?').get('persist') as
      | { id: string; source: string; source_path: string; yaml_text: string }
      | undefined
    expect(row).toBeDefined()
    expect(row!.source).toBe('user')
    expect(row!.source_path.replace(/\\/g, '/')).toBe(`${mockUserDataPath}/recipes/persist.yaml`)
    expect(row!.yaml_text).toContain('id: persist')
  })

  it('refresh re-scans both directories', async () => {
    userRecipes.set(`${mockUserDataPath}/recipes/a.yaml`, validYaml('a'))

    const mgr = new RecipeManager({ db: setupDb() })
    await mgr.loadAll()
    expect(mgr.list().map((r) => r.id)).toEqual(['a'])

    userRecipes.set(`${mockUserDataPath}/recipes/b.yaml`, validYaml('b'))
    await mgr.refresh()
    expect(mgr.list().map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('setWorkingDirectory re-scans project recipes', async () => {
    userRecipes.set(`${mockUserDataPath}/recipes/a.yaml`, validYaml('a'))
    const mgr = new RecipeManager({ db: setupDb() })
    await mgr.loadAll()
    expect(mgr.list().map((r) => r.id)).toEqual(['a'])

    projectRecipes.set('/proj/.bizgraph/recipes/p.yaml', validYaml('p'))
    await mgr.setWorkingDirectory('/proj')
    expect(mgr.list().map((r) => r.id).sort()).toEqual(['a', 'p'])
  })

  it('get / list return enriched source metadata', async () => {
    userRecipes.set(`${mockUserDataPath}/recipes/x.yaml`, validYaml('x'))
    const mgr = new RecipeManager({ db: setupDb() })
    await mgr.loadAll()
    const def: RecipeDefinition = mgr.get('x')!
    expect(def.source).toBe('user')
    expect(def.sourcePath?.replace(/\\/g, '/')).toBe(`${mockUserDataPath}/recipes/x.yaml`)
  })
})