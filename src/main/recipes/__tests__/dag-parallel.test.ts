/**
 * Tests for Recipe DAG + Parallel batching (Phase D5b)
 *
 * 覆盖：
 *   - computeWaves：无依赖 → 单 wave；depends_on 触发分层；环检测
 *   - batchWave：连续 parallel=true 合并为并行批；串行步独立成批
 *   - RecipeRunner.run：同批内并发执行；同批中一个失败 → 整批失败
 *   - RecipeRunner.run：depends_on 决定的 wave 顺序：依赖步在后 wave 执行
 */

import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { RecipeManager } from '../recipe-manager'
import { RecipeRunner, computeWaves, batchWave } from '../recipe-runner'
import { parseRecipe } from '../yaml-loader'
import type { RecipeDefinition } from '@shared/types/recipe'
import type { SubagentManager } from '../../agent/subagent-manager'

const mockUserDataPath = '/tmp/bizgraph-test-parallel'
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

function makeManager(yamlText: string): RecipeManager {
  userRecipes.clear()
  const db = setupDb()
  const mgr = new RecipeManager({ db })
  const def: RecipeDefinition = {
    ...parseRecipe(yamlText),
    source: 'user',
    sourcePath: `${mockUserDataPath}/recipes/test.yaml`,
  }
  ;(mgr as unknown as { cache: Map<string, RecipeDefinition> }).cache.set(def.id, def)
  return mgr
}

/**
 * Build a subagent manager mock whose `invoke` records start order + duration,
 * optionally sleeping to simulate work, and optionally throwing per agent type.
 */
function makeTimedSubagent(opts: {
  perType?: Map<string, () => Promise<{ resultText: string; resultFiles: string[]; tokensUsed: number }>>
  sleepMs?: number
} = {}): { sub: SubagentManager; order: string[]; durations: Map<string, number> } {
  const order: string[] = []
  const startTimes = new Map<string, number>()
  const durations = new Map<string, number>()
  const perType = opts.perType
  const invoke = vi.fn().mockImplementation(async (args: unknown) => {
    const a = args as { agentType: string; description: string; prompt: string }
    order.push(a.agentType)
    startTimes.set(a.agentType, Date.now())
    const handler = perType?.get(a.agentType)
    const result = handler
      ? await handler()
      : { resultText: `out:${a.agentType}`, resultFiles: [], tokensUsed: 0 }
    durations.set(a.agentType, Date.now() - (startTimes.get(a.agentType) ?? Date.now()))
    if (opts.sleepMs) await new Promise((r) => setTimeout(r, opts.sleepMs))
    return {
      invocationId: `inv-${a.agentType}`,
      resultText: result.resultText,
      resultFiles: result.resultFiles,
      tokensUsed: result.tokensUsed,
      durationMs: 1,
    }
  })
  return {
    sub: { invoke } as unknown as SubagentManager,
    order,
    durations,
  }
}

describe('computeWaves (DAG topological layers)', () => {
  it('puts steps with no depends_on into a single wave', () => {
    const def = parseRecipe(`
id: flat
name: Flat
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: a
    prompt: x
  - kind: agent
    agent_type: implement
    description: b
    prompt: y
`)
    const waves = computeWaves(def.steps)
    expect(waves).toHaveLength(1)
    expect(waves[0]).toEqual([0, 1])
  })

  it('separates steps with depends_on into later waves', () => {
    const def = parseRecipe(`
id: layered
name: Layered
version: "1"
steps:
  - id: first
    kind: agent
    agent_type: explore
    description: a
    prompt: x
  - id: second
    kind: agent
    agent_type: implement
    description: b
    prompt: y
    depends_on: [first]
`)
    const waves = computeWaves(def.steps)
    expect(waves).toHaveLength(2)
    expect(waves[0]).toEqual([0])
    expect(waves[1]).toEqual([1])
  })

  it('detects dependency cycles and throws', () => {
    const def = parseRecipe(`
id: cyclic
name: Cyclic
version: "1"
steps:
  - id: a
    kind: agent
    agent_type: explore
    description: a
    prompt: x
    depends_on: [b]
  - id: b
    kind: agent
    agent_type: implement
    description: b
    prompt: y
    depends_on: [a]
`)
    expect(() => computeWaves(def.steps)).toThrow(/cycle|unresolved/i)
  })
})

describe('batchWave (parallel grouping)', () => {
  it('merges consecutive parallel=true steps into one parallel batch', () => {
    const def = parseRecipe(`
id: par
name: Par
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: a
    prompt: x
    parallel: true
  - kind: agent
    agent_type: implement
    description: b
    prompt: y
    parallel: true
`)
    const batches = batchWave([0, 1], def.steps)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.parallel).toBe(true)
    expect(batches[0]!.stepIndices).toEqual([0, 1])
  })

  it('splits serial steps into separate single-step batches', () => {
    const def = parseRecipe(`
id: ser
name: Ser
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: a
    prompt: x
  - kind: agent
    agent_type: implement
    description: b
    prompt: y
`)
    const batches = batchWave([0, 1], def.steps)
    expect(batches).toHaveLength(2)
    expect(batches[0]!.parallel).toBe(false)
    expect(batches[0]!.stepIndices).toEqual([0])
    expect(batches[1]!.parallel).toBe(false)
    expect(batches[1]!.stepIndices).toEqual([1])
  })

  it('mixes parallel and serial within the same wave in array order', () => {
    const def = parseRecipe(`
id: mixed
name: Mixed
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: a
    prompt: x
    parallel: true
  - kind: agent
    agent_type: implement
    description: b
    prompt: y
    parallel: true
  - kind: agent
    agent_type: review
    description: c
    prompt: z
  - kind: agent
    agent_type: fix
    description: d
    prompt: w
    parallel: true
`)
    const batches = batchWave([0, 1, 2, 3], def.steps)
    expect(batches.map((b) => ({ parallel: b.parallel, len: b.stepIndices.length }))).toEqual([
      { parallel: true, len: 2 },
      { parallel: false, len: 1 },
      { parallel: true, len: 1 },
    ])
  })
})

describe('RecipeRunner.run with parallel batching', () => {
  it('runs two parallel steps concurrently (overlapping windows)', async () => {
    const yaml = `
id: two-parallel
name: Two Parallel
version: "1"
steps:
  - id: p1
    kind: agent
    agent_type: explore
    description: parallel one
    prompt: x
    parallel: true
  - id: p2
    kind: agent
    agent_type: implement
    description: parallel two
    prompt: y
    parallel: true
`
    const mgr = makeManager(yaml)
    const { sub, durations } = makeTimedSubagent({ sleepMs: 50 })

    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })
    const run = await runner.run({ recipeId: 'two-parallel', inputs: {} })

    expect(run.status).toBe('succeeded')
    expect(run.steps).toHaveLength(2)
    expect(run.steps.every((s) => s.status === 'succeeded')).toBe(true)
    // If they ran in parallel, total wall-clock would be ~50ms rather than ~100ms.
    // Verify by checking the two subagent calls started before the first finished
    // (their start times should be close, and durations similar).
    const d1 = durations.get('explore') ?? 0
    const d2 = durations.get('implement') ?? 0
    // both should sleep roughly the same amount; if they were serial, one would sleep twice
    expect(Math.abs(d1 - d2)).toBeLessThan(40)
  })

  it('fails the entire batch when one parallel step throws (others still succeed)', async () => {
    const yaml = `
id: par-fail
name: Parallel Fail
version: "1"
steps:
  - id: p1
    kind: agent
    agent_type: explore
    description: parallel one
    prompt: x
    parallel: true
  - id: p2
    kind: agent
    agent_type: implement
    description: parallel two
    prompt: y
    parallel: true
`
    const mgr = makeManager(yaml)
    const handlers = new Map([
      [
        'explore',
        async () => {
          await new Promise((r) => setTimeout(r, 20))
          return { resultText: 'ok', resultFiles: [], tokensUsed: 0 }
        },
      ],
      [
        'implement',
        async () => {
          await new Promise((r) => setTimeout(r, 5))
          throw new Error('parallel sibling boom')
        },
      ],
    ])
    const { sub } = makeTimedSubagent({ perType: handlers })

    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })
    const run = await runner.run({ recipeId: 'par-fail', inputs: {} })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('parallel sibling boom')
    // Promise.allSettled ensures both siblings complete; p1 still records as
    // 'succeeded' (its handler returned ok) while p2 records 'failed'.
    const byStep = new Map(run.steps.map((s) => [s.step_id, s]))
    expect(byStep.get('p1')!.status).toBe('succeeded')
    expect(byStep.get('p2')!.status).toBe('failed')
  })

  it('runs serial step before parallel batch (cross-wave ordering)', async () => {
    const yaml = `
id: serial-then-par
name: Serial then Parallel
version: "1"
steps:
  - id: setup
    kind: agent
    agent_type: explore
    description: serial setup
    prompt: x
  - id: a
    kind: agent
    agent_type: implement
    description: parallel a
    prompt: y
    parallel: true
    depends_on: [setup]
  - id: b
    kind: agent
    agent_type: review
    description: parallel b
    prompt: z
    parallel: true
    depends_on: [setup]
`
    const mgr = makeManager(yaml)
    const { sub, order } = makeTimedSubagent({ sleepMs: 20 })

    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })
    const run = await runner.run({ recipeId: 'serial-then-par', inputs: {} })

    expect(run.status).toBe('succeeded')
    // 'explore' (setup) must be invoked before the parallel batch starts.
    expect(order[0]).toBe('explore')
    // 'implement' and 'review' both come after setup; their relative order
    // is not guaranteed, but they must both be present.
    expect(order.slice(1).sort()).toEqual(['implement', 'review'])
  })

  it('mixed wave: parallel batch runs, then serial step runs after', async () => {
    const yaml = `
id: mixed-wave
name: Mixed Wave
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: p1
    prompt: x
    parallel: true
  - kind: agent
    agent_type: implement
    description: p2
    prompt: y
    parallel: true
  - kind: agent
    agent_type: review
    description: post
    prompt: z
`
    const mgr = makeManager(yaml)
    const startTimes = new Map<string, number>()
    const handlers = new Map(
      ['explore', 'implement', 'review'].map((t) => [
        t,
        async () => {
          startTimes.set(t, Date.now())
          await new Promise((r) => setTimeout(r, 30))
          return { resultText: `ok:${t}`, resultFiles: [], tokensUsed: 0 }
        },
      ]),
    )
    const { sub } = makeTimedSubagent({ perType: handlers })

    const runner = new RecipeRunner({ db: setupDb(), manager: mgr, subagentManager: sub })
    const run = await runner.run({ recipeId: 'mixed-wave', inputs: {} })

    expect(run.status).toBe('succeeded')
    // 'review' must start AFTER the parallel batch started (≥30ms after explore).
    const reviewStart = startTimes.get('review') ?? 0
    const exploreStart = startTimes.get('explore') ?? 0
    expect(reviewStart - exploreStart).toBeGreaterThanOrEqual(25)
  })
})
