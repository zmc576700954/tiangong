/**
 * Tests for recipe IPC handlers
 *
 * 覆盖：list / get / run / cancel / refresh / listRuns / getRun。
 */

import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { RecipeManager } from '../../recipes/recipe-manager'
import { RecipeRunner } from '../../recipes/recipe-runner'
import { parseRecipe } from '../../recipes/yaml-loader'
import { registerRecipeHandlers } from '../recipe'
import { createTypedHandle } from '../utils'
import type { RecipeDefinition } from '@shared/types/recipe'
import type { SubagentManager } from '../../agent/subagent-manager'
import type { IpcMain } from 'electron'
import type * as NodeFs from 'node:fs'

const mockUserDataPath = '/tmp/bizgraph-test-ipc'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mockUserDataPath),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

vi.mock('node:fs', async () => {
  const actual: typeof NodeFs = await vi.importActual('node:fs')
  return {
    promises: {
      ...actual.promises,
      readdir: vi.fn(async () => {
        const err = new Error('ENOENT') as Error & { code: string }
        err.code = 'ENOENT'
        throw err
      }),
      readFile: vi.fn(async () => {
        const err = new Error('ENOENT') as Error & { code: string }
        err.code = 'ENOENT'
        throw err
      }),
    },
  }
})

function setupDb(): Database.Database {
  const db = new Database(':memory:')
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

function makeMockSubagent(): SubagentManager {
  return {
    invoke: vi.fn().mockResolvedValue({
      invocationId: 'mock',
      resultText: 'mock result',
      resultFiles: [],
      tokensUsed: 0,
      durationMs: 0,
    }),
  } as unknown as SubagentManager
}

function setupHandlers() {
  const db = setupDb()
  const manager = new RecipeManager({ db })
  // Inject one recipe directly into the cache to bypass filesystem
  const def = parseRecipe(`
id: hello
name: Hello
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: Hi
    prompt: Say hi
`)
  ;(manager as unknown as { cache: Map<string, RecipeDefinition> }).cache.set('hello', {
    ...def,
    source: 'user',
    sourcePath: '/tmp/hello.yaml',
  })
  const runner = new RecipeRunner({ db, manager, subagentManager: makeMockSubagent() })
  const handlers: Record<string, (event: unknown, ...args: unknown[]) => Promise<unknown>> = {}
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = fn
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  } as unknown as IpcMain
  const typedHandle = createTypedHandle(ipcMain)
  registerRecipeHandlers({ manager, runner }, typedHandle)
  return { handlers, manager, runner, db }
}

const fakeEvent = { sender: { id: 1 } } as unknown as Parameters<NonNullable<ReturnType<typeof setupHandlers>['handlers'][string]>>[0]

describe('recipe IPC handlers', () => {
  it('recipes:list returns recipe definitions', async () => {
    const { handlers } = setupHandlers()
    const result = (await handlers['recipes:list']!(fakeEvent, undefined)) as RecipeDefinition[]
    expect(result.find((r) => r.id === 'hello')).toBeDefined()
  })

  it('recipes:get returns a single recipe or null', async () => {
    const { handlers } = setupHandlers()
    const def = (await handlers['recipes:get']!(fakeEvent, 'hello')) as RecipeDefinition
    expect(def?.id).toBe('hello')
    const missing = await handlers['recipes:get']!(fakeEvent, 'missing')
    expect(missing).toBeNull()
  })

  it('recipes:run returns a RecipeRun (success path)', async () => {
    const { handlers } = setupHandlers()
    const run = (await handlers['recipes:run']!(
      fakeEvent,
      { recipeId: 'hello', inputs: { foo: 'bar' } },
    )) as { id: string; status: string }
    expect(run.id).toMatch(/^recipe-/)
    expect(run.status).toBe('succeeded')
  })

  it('recipes:run validates args', async () => {
    const { handlers } = setupHandlers()
    await expect(handlers['recipes:run']!(fakeEvent, null)).rejects.toThrow(/requires a request object/)
    await expect(
      handlers['recipes:run']!(fakeEvent, { recipeId: 123 }),
    ).rejects.toThrow(/recipeId must be a string/)
  })

  it('recipes:cancel returns boolean', async () => {
    const { handlers, runner } = setupHandlers()
    // Insert an active run id manually
    ;(runner as unknown as { activeRuns: Map<string, AbortController> }).activeRuns.set(
      'run-fake',
      new AbortController(),
    )
    const result = await handlers['recipes:cancel']!(fakeEvent, 'run-fake')
    expect(result).toBe(true)
    const resultMissing = await handlers['recipes:cancel']!(fakeEvent, 'no-such-run')
    expect(resultMissing).toBe(false)
  })

  it('recipes:refresh returns the count of recipes after rescan', async () => {
    const { handlers } = setupHandlers()
    // The injected cache recipe is wiped by refresh since no filesystem files exist;
    // count should reflect only what the filesystem load yielded (0 in this mocked env).
    const count = (await handlers['recipes:refresh']!(fakeEvent, undefined)) as number
    expect(count).toBe(0)
  })

  it('recipes:listRuns returns the run history for a recipe', async () => {
    const { handlers } = setupHandlers()
    await handlers['recipes:run']!(fakeEvent, { recipeId: 'hello' })
    const runs = (await handlers['recipes:listRuns']!(fakeEvent, 'hello')) as Array<{ status: string }>
    expect(runs.length).toBeGreaterThanOrEqual(1)
    expect(runs[0]!.status).toBe('succeeded')
  })

  it('recipes:getRun returns a single run', async () => {
    const { handlers } = setupHandlers()
    const run = (await handlers['recipes:run']!(
      fakeEvent,
      { recipeId: 'hello' },
    )) as { id: string }
    const fetched = await handlers['recipes:getRun']!(fakeEvent, run.id)
    expect(fetched).not.toBeNull()
    const missing = await handlers['recipes:getRun']!(fakeEvent, 'no-such-run')
    expect(missing).toBeNull()
  })
})