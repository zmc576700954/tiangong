/**
 * Tests for D5a RecipeRunner.runDAG()
 *
 * 覆盖：
 *  - 顶层 Recipe 含 sub_recipes → 走 runDAG 路径
 *  - 顺序执行（sub_recipes[*] 顺序串行）
 *  - 前置 sub_recipe 的 outputs 注入到后续 sub_recipe 的 inputs（${outputs.x.y}）
 *  - 子 recipe 的 sub_recipe.inputs 渲染模板
 *  - 中间步骤失败 → 整个 DAG 失败
 *  - runDAG 显式调用（绕过 run() 路径选择）
 *  - runSingle 父 signal → 子 run cancel 联动
 *  - Recipe 不存在时 run() 仍返回 failed run 记录
 *  - sub_recipe 引用了不存在的 recipe → DAG 失败
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { RecipeManager } from '../recipe-manager'
import { RecipeRunner } from '../recipe-runner'
import { parseRecipe } from '../yaml-loader'
import type { RecipeDefinition } from '@shared/types/recipe'
import type { SubagentManager } from '../../agent/subagent-manager'

const mockUserDataPath = '/tmp/bizgraph-test-dag'

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

/**
 * Build a RecipeManager that has these recipes pre-loaded into its cache.
 * Bypasses filesystem scanning for deterministic tests.
 */
function makeManagerWith(defs: RecipeDefinition[]): RecipeManager {
  const db = setupDb()
  const mgr = new RecipeManager({ db })
  for (const def of defs) {
    ;(mgr as unknown as { cache: Map<string, RecipeDefinition> }).cache.set(def.id, def)
  }
  return mgr
}

/**
 * Build a mock SubagentManager that resolves prompts from a configured map.
 * Each prompt can be mapped to a resultText; otherwise default echo.
 */
interface MockConfig {
  byAgentType?: Record<string, string>
  failOn?: Record<string, string>
}
function makeMockSubagent(config: MockConfig = {}): {
  manager: SubagentManager
  calls: Array<{ agentType: string; prompt: string }>
} {
  const calls: Array<{ agentType: string; prompt: string }> = []
  const invoke = vi.fn().mockImplementation(async (args: unknown) => {
    const a = args as { agentType: string; prompt: string }
    calls.push({ agentType: a.agentType, prompt: a.prompt })
    if (config.failOn?.[a.agentType]) {
      throw new Error(config.failOn[a.agentType]!)
    }
    const text = config.byAgentType?.[a.agentType] ?? `mock(${a.agentType})`
    return {
      invocationId: 'mock-inv',
      resultText: text,
      resultFiles: [],
      tokensUsed: 1,
      durationMs: 1,
    }
  })
  return {
    manager: { invoke } as unknown as SubagentManager,
    calls,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ============================================
// DAG execution
// ============================================

describe('RecipeRunner.runDAG', () => {
  it('runs sub_recipes sequentially', async () => {
    const childA: RecipeDefinition = {
      ...parseRecipe(`
id: child-a
name: Child A
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: a
    prompt: a
`),
      source: 'user',
      sourcePath: '/tmp/child-a.yaml',
    }
    const childB: RecipeDefinition = {
      ...parseRecipe(`
id: child-b
name: Child B
version: "1"
steps:
  - kind: agent
    agent_type: implement
    description: b
    prompt: b
`),
      source: 'user',
      sourcePath: '/tmp/child-b.yaml',
    }
    const parent: RecipeDefinition = {
      ...parseRecipe(`
id: parent
name: Parent
version: "1"
sub_recipes:
  - name: first
    recipe: child-a
  - name: second
    recipe: child-b
`),
      source: 'user',
      sourcePath: '/tmp/parent.yaml',
    }
    const mgr = makeManagerWith([childA, childB, parent])
    const { manager: sub, calls } = makeMockSubagent({
      byAgentType: { explore: 'A-out', implement: 'B-out' },
    })
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const run = await runner.run({ recipeId: 'parent', inputs: {} })
    expect(run.status).toBe('succeeded')
    expect(run.subRuns).toBeDefined()
    expect(run.subRuns).toHaveLength(2)
    expect(run.subRuns![0]!.recipe_id).toBe('child-a')
    expect(run.subRuns![1]!.recipe_id).toBe('child-b')
    expect(calls.map((c) => c.agentType)).toEqual(['explore', 'implement'])
  })

  it('passes prior sub_recipe outputs into the next sub_recipe inputs', async () => {
    const childA: RecipeDefinition = {
      ...parseRecipe(`
id: scrape
name: Scrape
version: "1"
steps:
  - kind: agent
    agent_type: scrape
    description: scrape
    prompt: scrape
`),
      source: 'user',
      sourcePath: '/tmp/scrape.yaml',
    }
    const childB: RecipeDefinition = {
      ...parseRecipe(`
id: summarize
name: Summarize
version: "1"
inputs:
  - name: topic
    type: string
steps:
  - kind: agent
    agent_type: summarize
    description: summarize
    prompt: "topic=\${input.topic}"
`),
      source: 'user',
      sourcePath: '/tmp/summarize.yaml',
    }
    const parent: RecipeDefinition = {
      ...parseRecipe(`
id: pipeline
name: Pipeline
version: "1"
sub_recipes:
  - name: scrape-step
    recipe: scrape
  - name: summarize-step
    recipe: summarize
    inputs:
      topic: "\${outputs.scrape-step.step_0}"
`),
      source: 'user',
      sourcePath: '/tmp/pipeline.yaml',
    }
    const mgr = makeManagerWith([childA, childB, parent])
    const { manager: sub, calls } = makeMockSubagent({
      byAgentType: { scrape: 'scraped-text', summarize: 'ok' },
    })
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const run = await runner.run({ recipeId: 'pipeline', inputs: {} })
    expect(run.status).toBe('succeeded')
    // second sub_recipe should have received the prior output as input
    expect(calls).toHaveLength(2)
    expect(calls[0]!.prompt).toBe('scrape')
    expect(calls[1]!.prompt).toBe('topic=scraped-text')
  })

  it('fails the entire DAG when a middle sub_recipe fails', async () => {
    const a: RecipeDefinition = {
      ...parseRecipe(`
id: a
name: A
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: a
    prompt: a
`),
      source: 'user',
      sourcePath: '/tmp/a.yaml',
    }
    const b: RecipeDefinition = {
      ...parseRecipe(`
id: b
name: B
version: "1"
steps:
  - kind: agent
    agent_type: review
    description: b
    prompt: b
`),
      source: 'user',
      sourcePath: '/tmp/b.yaml',
    }
    const c: RecipeDefinition = {
      ...parseRecipe(`
id: c
name: C
version: "1"
steps:
  - kind: agent
    agent_type: implement
    description: c
    prompt: c
`),
      source: 'user',
      sourcePath: '/tmp/c.yaml',
    }
    const parent: RecipeDefinition = {
      ...parseRecipe(`
id: parent
name: Parent
version: "1"
sub_recipes:
  - name: first
    recipe: a
  - name: middle
    recipe: b
  - name: last
    recipe: c
`),
      source: 'user',
      sourcePath: '/tmp/parent.yaml',
    }
    const mgr = makeManagerWith([a, b, c, parent])
    const { manager: sub, calls } = makeMockSubagent({
      failOn: { review: 'middle-boom' },
    })
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const run = await runner.run({ recipeId: 'parent', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/middle-boom/)
    // 第三步 c 不应执行
    expect(calls.map((c) => c.agentType)).toEqual(['explore', 'review'])
    // 只有前两步的 subRuns
    expect(run.subRuns).toHaveLength(2)
  })

  it('mixes top-level steps with sub_recipes', async () => {
    const a: RecipeDefinition = {
      ...parseRecipe(`
id: a
name: A
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: a
    prompt: a
`),
      source: 'user',
      sourcePath: '/tmp/a.yaml',
    }
    const parent: RecipeDefinition = {
      ...parseRecipe(`
id: parent
name: Parent
version: "1"
steps:
  - kind: agent
    agent_type: top-step
    description: top
    prompt: top
sub_recipes:
  - name: sub
    recipe: a
`),
      source: 'user',
      sourcePath: '/tmp/parent.yaml',
    }
    const mgr = makeManagerWith([a, parent])
    const { manager: sub, calls } = makeMockSubagent()
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const run = await runner.run({ recipeId: 'parent', inputs: {} })
    expect(run.status).toBe('succeeded')
    // top step + sub_recipe's step
    expect(calls.map((c) => c.agentType)).toEqual(['top-step', 'explore'])
    expect(run.steps).toHaveLength(1) // 顶层 step 1 个
    expect(run.subRuns).toHaveLength(1)
  })

  it('runDAG() explicitly invoked on a top-level Recipe without sub_recipes still runs its steps', async () => {
    const def: RecipeDefinition = {
      ...parseRecipe(`
id: no-sub
name: No Sub
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: a
    prompt: a
`),
      source: 'user',
      sourcePath: '/tmp/no-sub.yaml',
    }
    const mgr = makeManagerWith([def])
    const { manager: sub } = makeMockSubagent()
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const run = await runner.runDAG({ recipeId: 'no-sub', inputs: {} }, def)
    expect(run.status).toBe('succeeded')
    expect(run.subRuns).toEqual([])
  })

  it('cancels the DAG and propagates the abort signal into sub_recipes', async () => {
    const a: RecipeDefinition = {
      ...parseRecipe(`
id: slow-a
name: Slow A
version: "1"
steps:
  - kind: agent
    agent_type: slow
    description: a
    prompt: a
`),
      source: 'user',
      sourcePath: '/tmp/a.yaml',
    }
    const b: RecipeDefinition = {
      ...parseRecipe(`
id: slow-b
name: Slow B
version: "1"
steps:
  - kind: agent
    agent_type: slow
    description: b
    prompt: b
`),
      source: 'user',
      sourcePath: '/tmp/b.yaml',
    }
    const parent: RecipeDefinition = {
      ...parseRecipe(`
id: parent
name: Parent
version: "1"
sub_recipes:
  - name: a
    recipe: slow-a
  - name: b
    recipe: slow-b
`),
      source: 'user',
      sourcePath: '/tmp/parent.yaml',
    }
    const mgr = makeManagerWith([a, b, parent])

    const resolvers: Array<(v: { resultText: string; resultFiles: string[]; tokensUsed: number }) => void> = []
    const rejects: Array<(err: Error) => void> = []
    const invoke = vi.fn().mockImplementation(() =>
      new Promise<{ resultText: string; resultFiles: string[]; tokensUsed: number }>((resolve, reject) => {
        resolvers.push(resolve)
        rejects.push(reject)
      }),
    )
    const sub = { invoke } as unknown as SubagentManager
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const promise = runner.run({ recipeId: 'parent', inputs: {} })
    // 等两个 sub_recipe 都进入 invoke 挂起
    await new Promise((r) => setTimeout(r, 10))
    // 取消顶层 run
    const runId = Array.from(runner['activeRuns'].keys() as IterableIterator<string>)[0]!
    expect(runner.cancel(runId)).toBe(true)
    // 让挂起的 invoke 完成（模拟下游响应）
    resolvers.forEach((res) => res({ resultText: 'late', resultFiles: [], tokensUsed: 0 }))
    rejects.forEach((rej) => rej(new Error('cancelled-by-abort')))

    const run = await promise
    // cancel 触发后 DAG 状态应为 cancelled 或 failed（取决于 invoke 完成时机）
    expect(['cancelled', 'failed']).toContain(run.status)
    // 顶层的 activeRuns 被清空
    expect(runner['activeRuns'].size).toBe(0)
  })
})

describe('RecipeRunner.run — backward compat', () => {
  it('persists a failed run when the recipe id is unknown', async () => {
    const mgr = new RecipeManager({ db: setupDb() })
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: makeMockSubagent().manager })
    const run = await runner.run({ recipeId: 'missing', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/not found/i)
    // 仍返回的 RecipeRun 应该有 runId；调用 listRuns/getRun 不会报错
    expect(run.id).toMatch(/^recipe-/)
  })

  it('rejects a Recipe that references a sub_recipe that cannot be resolved', async () => {
    const parent: RecipeDefinition = {
      ...parseRecipe(`
id: broken-parent
name: Broken Parent
version: "1"
sub_recipes:
  - name: ghost
    recipe: does-not-exist
`),
      source: 'user',
      sourcePath: '/tmp/broken-parent.yaml',
    }
    const mgr = makeManagerWith([parent])
    const { manager: sub } = makeMockSubagent()
    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })

    const run = await runner.run({ recipeId: 'broken-parent', inputs: {} })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/does-not-exist/)
  })
})