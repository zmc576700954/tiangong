/**
 * Tests for RecipeRunner
 *
 * 覆盖：
 *  - 顺序执行多步（agent → agent）
 *  - 步骤失败时整 run 失败并保留前面成功步
 *  - shell 步骤：通过 child_process.spawn 执行
 *  - shell cwd 越界拒绝
 *  - shell 超时
 *  - cancel 取消正在运行的 run
 *  - 持久化到 recipe_runs 表
 *  - 模板替换：${input.x} 生效
 *  - input 缺失（required）抛错
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RecipeManager } from '../recipe-manager'
import { RecipeRunner } from '../recipe-runner'
import { parseRecipe } from '../yaml-loader'
import type { RecipeDefinition } from '@shared/types/recipe'
import type { SubagentManager } from '../../agent/subagent-manager'

const mockUserDataPath = '/tmp/bizgraph-test'
const userRecipes: Map<string, string> = new Map()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mockUserDataPath),
  },
}))

vi.mock('node:fs', async () => {
  const actual: { promises: Record<string, unknown> } = await vi.importActual('node:fs')
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

function makeManager(recipeYaml: string): RecipeManager {
  const db = setupDb()
  userRecipes.clear()
  userRecipes.set(`${mockUserDataPath}/recipes/test.yaml`, recipeYaml)
  const mgr = new RecipeManager({ db })
  // bypass async loadAll by directly populating cache
  const def: RecipeDefinition = {
    ...parseRecipe(recipeYaml),
    source: 'user',
    sourcePath: `${mockUserDataPath}/recipes/test.yaml`,
  }
  ;(mgr as unknown as { cache: Map<string, RecipeDefinition> }).cache.set(def.id, def)
  return mgr
}

function makeMockSubagentManager(impl?: (args: unknown) => Promise<{ resultText: string; resultFiles: string[]; tokensUsed: number }>): SubagentManager {
  const invoke = vi.fn().mockImplementation(async (args: unknown) => {
    if (impl) return impl(args)
    return {
      invocationId: 'mock-inv',
      resultText: 'mock output for ' + ((args as { agentType: string }).agentType ?? '?'),
      resultFiles: [],
      tokensUsed: 10,
      durationMs: 1,
    }
  })
  return { invoke } as unknown as SubagentManager
}

beforeEach(() => {
  userRecipes.clear()
})

describe('RecipeRunner', () => {
  it('runs an agent step sequentially and returns success', async () => {
    const yaml = `
id: two-agents
name: Two Agents
version: "1"
steps:
  - id: first
    kind: agent
    agent_type: explore
    description: First step
    prompt: First
  - id: second
    kind: agent
    agent_type: implement
    description: Second step
    prompt: Second
`
    const mgr = makeManager(yaml)
    const sub = makeMockSubagentManager()
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const run = await runner.run({ recipeId: 'two-agents', inputs: {} })
    expect(run.status).toBe('succeeded')
    expect(run.steps).toHaveLength(2)
    expect(run.steps[0]!.status).toBe('succeeded')
    expect(run.steps[1]!.status).toBe('succeeded')
    expect(sub.invoke).toHaveBeenCalledTimes(2)
  })

  it('marks run as failed when a step throws', async () => {
    const yaml = `
id: fail-mid
name: Fail mid
version: "1"
steps:
  - id: ok
    kind: agent
    agent_type: explore
    description: OK
    prompt: hi
  - id: bad
    kind: agent
    agent_type: implement
    description: Bad
    prompt: boom
`
    const mgr = makeManager(yaml)
    const sub = makeMockSubagentManager(async (args) => {
      const type = (args as { agentType: string }).agentType
      if (type === 'implement') {
        throw new Error('boom')
      }
      return { resultText: 'ok', resultFiles: [], tokensUsed: 0 }
    })
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const run = await runner.run({ recipeId: 'fail-mid', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toContain('boom')
    expect(run.steps[0]!.status).toBe('succeeded')
    expect(run.steps[1]!.status).toBe('failed')
  })

  it('throws RECIPE_NOT_FOUND when recipe id missing', async () => {
    const mgr = new RecipeManager({ db: setupDb() })
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr })
    const run = await runner.run({ recipeId: 'missing', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/not found/i)
  })

  it('substitutes ${input.x} in agent step prompts', async () => {
    const yaml = `
id: templated
name: Templated
version: "1"
inputs:
  - name: greet
    type: string
steps:
  - kind: agent
    agent_type: explore
    description: Greet
    prompt: "Say \${input.greet}"
`
    const mgr = makeManager(yaml)
    const sub = makeMockSubagentManager()
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    await runner.run({ recipeId: 'templated', inputs: { greet: 'hello' } })
    expect(sub.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Say hello' }),
    )
  })

  it('throws when required input is missing', async () => {
    const yaml = `
id: req-input
name: Required Input
version: "1"
inputs:
  - name: needed
    type: string
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: \${input.needed}
`
    const mgr = makeManager(yaml)
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: makeMockSubagentManager() })

    const run = await runner.run({ recipeId: 'req-input', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/required/i)
  })

  it('runs a shell step with cwd inside the working directory', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bizgraph-recipe-'))
    await fs.mkdir(path.join(tmpRoot, 'subdir'), { recursive: true })
    const yaml = `
id: shell-ok
name: Shell OK
version: "1"
steps:
  - kind: shell
    command: ["${process.execPath.replace(/\\/g, '\\\\')}", "-e", "console.log('hi')"]
    cwd: subdir
`
    const mgr = makeManager(yaml)
    const runner = new RecipeRunner({
      db: setupDb(),
      manager: mgr,
      getWorkingDirectory: () => tmpRoot,
    })

    const run = await runner.run({ recipeId: 'shell-ok', inputs: {} })
    expect(run.status).toBe('succeeded')
    expect(run.steps[0]!.status).toBe('succeeded')
    expect(run.steps[0]!.output).toContain('hi')
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('rejects shell step cwd that escapes workingDirectory', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bizgraph-recipe-'))
    const yaml = `
id: shell-escape
name: Shell Escape
version: "1"
steps:
  - kind: shell
    command: ["echo", "x"]
    cwd: ../etc
`
    const mgr = makeManager(yaml)
    const runner = new RecipeRunner({
      db: setupDb(),
      manager: mgr,
      getWorkingDirectory: () => tmpRoot,
    })

    const run = await runner.run({ recipeId: 'shell-escape', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/escapes workingDirectory/)
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('marks shell step as failed when exit code is non-zero', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bizgraph-recipe-'))
    const yaml = `
id: shell-fail
name: Shell Fail
version: "1"
steps:
  - kind: shell
    command: ["${process.execPath.replace(/\\/g, '\\\\')}", "-e", "process.exit(1)"]
`
    const mgr = makeManager(yaml)
    const runner = new RecipeRunner({
      db: setupDb(),
      manager: mgr,
      getWorkingDirectory: () => tmpRoot,
    })

    const run = await runner.run({ recipeId: 'shell-fail', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/exited with code 1/)
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('rejects shell step when no workingDirectory configured', async () => {
    const yaml = `
id: shell-no-wd
name: Shell No WD
version: "1"
steps:
  - kind: shell
    command: ["echo", "x"]
`
    const mgr = makeManager(yaml)
    const runner = new RecipeRunner({
      db: setupDb(),
      manager: mgr,
      // getWorkingDirectory omitted → null
    })

    const run = await runner.run({ recipeId: 'shell-no-wd', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/working directory/i)
  })

  it('cancels an in-flight run', async () => {
    const yaml = `
id: cancel-me
name: Cancel Me
version: "1"
steps:
  - id: slow
    kind: agent
    agent_type: explore
    description: Slow
    prompt: slow
`
    const mgr = makeManager(yaml)
    let resolveInvoke: (v: { resultText: string; resultFiles: string[]; tokensUsed: number }) => void
    const sub = {
      invoke: vi.fn(() => new Promise<{ resultText: string; resultFiles: string[]; tokensUsed: number }>((resolve) => {
        resolveInvoke = resolve
      })),
    } as unknown as SubagentManager
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const promise = runner.run({ recipeId: 'cancel-me', inputs: {} })
    // wait a tick for run to register
    await new Promise((r) => setTimeout(r, 10))
    const cancelled = runner.cancel(Array.from(runner['activeRuns'].keys())[0]!)
    expect(cancelled).toBe(true)
    resolveInvoke!({ resultText: 'late', resultFiles: [], tokensUsed: 0 })
    const run = await promise
    expect(run.status).toBe('cancelled')
  })

  it('persists run rows to recipe_runs table', async () => {
    const yaml = `
id: persist-run
name: persist
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: y
`
    const db = setupDb()
    const mgr = makeManager(yaml)
    const runner = new RecipeRunner({ db, manager: mgr, subagentManager: makeMockSubagentManager() })

    const run = await runner.run({ recipeId: 'persist-run', inputs: { k: 'v' } })
    const row = db.prepare('SELECT * FROM recipe_runs WHERE id = ?').get(run.id) as
      | { status: string; inputs_json: string; steps_json: string; outputs_json: string }
      | undefined
    expect(row).toBeDefined()
    expect(row!.status).toBe('succeeded')
    expect(JSON.parse(row!.inputs_json)).toEqual({ k: 'v' })
    expect(JSON.parse(row!.steps_json)).toHaveLength(1)
    expect(JSON.parse(row!.outputs_json)).toHaveProperty('step_0')
  })

  it('listRuns returns runs ordered by started_at desc', async () => {
    const yaml = `
id: multi-run
name: Multi Run
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: y
`
    const mgr = makeManager(yaml)
    const sub = makeMockSubagentManager()
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    await runner.run({ recipeId: 'multi-run', inputs: {} })
    await new Promise((r) => setTimeout(r, 5))
    await runner.run({ recipeId: 'multi-run', inputs: {} })

    const runs = runner.listRuns('multi-run')
    expect(runs.length).toBe(2)
    // most recent first
    expect(runs[0]!.started_at).toBeGreaterThanOrEqual(runs[1]!.started_at)
  })

  it('getRun returns a single run record', async () => {
    const yaml = `
id: single-run
name: Single
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: y
`
    const mgr = makeManager(yaml)
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: makeMockSubagentManager() })

    const run = await runner.run({ recipeId: 'single-run', inputs: {} })
    const fetched = runner.getRun(run.id)
    expect(fetched?.id).toBe(run.id)
    expect(fetched?.status).toBe('succeeded')
  })

  it('throws BizGraphError when subagentManager missing and agent step runs', async () => {
    const yaml = `
id: no-sub
name: no-sub
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: y
`
    const mgr = makeManager(yaml)
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr })
    const run = await runner.run({ recipeId: 'no-sub', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/SubagentManager is not configured/)
  })
})