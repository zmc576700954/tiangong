/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubagentManager } from '../agent/subagent-manager'
import type { AgentOutput } from '@shared/types'

function createMockAgentManager() {
  const listeners = new Map<string, ((output: AgentOutput) => void)[]>()
  return {
    startSession: vi.fn().mockResolvedValue({
      sessionId: 'child-1',
      adapterUsed: 'mock',
      fallbackHistory: [],
    }),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    terminateSession: vi.fn().mockResolvedValue(undefined),
    broadcastToSession: vi.fn(),
    addSessionOutputListener: vi.fn((sessionId: string, handler: (o: AgentOutput) => void) => {
      const arr = listeners.get(sessionId) ?? []
      arr.push(handler)
      listeners.set(sessionId, arr)
    }),
    removeSessionOutputListener: vi.fn((handler: (o: AgentOutput) => void) => {
      for (const [k, arr] of listeners.entries()) {
        listeners.set(
          k,
          arr.filter((h) => h !== handler),
        )
      }
    }),
    getSessionState: vi.fn().mockReturnValue({
      config: {
        workingDirectory: '/tmp',
        allowedFiles: ['src/a.ts', 'src/b.ts'],
        forbiddenFiles: [],
        invariantRules: [],
        upstreamContext: '',
        downstreamContext: '',
        nodeTitle: '',
        acceptanceCriteria: [],
      },
      broadcastName: 'mock',
      adapterName: 'mock',
      startTime: Date.now(),
    }),
    _emitOutput: (sessionId: string, output: AgentOutput) => {
      for (const h of listeners.get(sessionId) ?? []) h(output)
    },
  }
}

function createMockRepo() {
  const rows = new Map<string, any>()
  let idCounter = 0
  return {
    rows,
    create: vi.fn(async (data: any) => {
      const id = `inv-${++idCounter}`
      rows.set(id, { id, ...data, status: 'queued' })
      return id
    }),
    updateStatus: vi.fn(async (id: string, status: string) => {
      const r = rows.get(id)
      if (r) r.status = status
    }),
    complete: vi.fn(async (id: string, data: any) => {
      const r = rows.get(id)
      if (r) Object.assign(r, data, { status: 'completed' })
    }),
    fail: vi.fn(async (id: string, data: any) => {
      const r = rows.get(id)
      if (r) Object.assign(r, data, { status: 'failed' })
    }),
    cancel: vi.fn(async (id: string, finishedAt: number) => {
      const r = rows.get(id)
      if (r) {
        r.status = 'cancelled'
        r.finishedAt = finishedAt
      }
    }),
    listByParent: vi.fn(),
    get: vi.fn(),
  }
}

describe('SubagentManager', () => {
  let mockManager: ReturnType<typeof createMockAgentManager>
  let mockRepo: ReturnType<typeof createMockRepo>
  let mgr: SubagentManager

  beforeEach(() => {
    mockManager = createMockAgentManager()
    mockRepo = createMockRepo()
    mgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 5000)
  })

  it('listTypes returns built-in types', () => {
    const types = mgr.listTypes()
    expect(types.length).toBeGreaterThanOrEqual(5)
    expect(types.find((t) => t.name === 'explore')).toBeDefined()
  })

  it('invoke with unknown type throws', async () => {
    await expect(
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'nonexistent',
        description: 'x',
        prompt: 'y',
      }),
    ).rejects.toThrow(/Unknown agent type/)
  })

  it('invoke completes when child emits complete', async () => {
    // Set up the child output flow: when sendCommand is called, emit a complete
    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(
        () =>
          mockManager._emitOutput('child-1', {
            type: 'complete',
            data: 'subagent done',
            timestamp: 0,
          }),
        0,
      )
    })

    const result = await mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'explore',
      description: 'find auth',
      prompt: 'Look in src/auth/',
    })
    expect(result.resultText).toContain('subagent done')
    expect(result.invocationId).toMatch(/^inv-/)
  })

  it('rejects subset strategy when child files not subset of parent', async () => {
    await expect(
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'implement',
        description: 'edit',
        prompt: 'do it',
        allowedFiles: ['src/forbidden.ts'],
      }),
    ).rejects.toThrow(/not subset/)
  })

  it('accepts subset strategy when child files are subset of parent', async () => {
    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(
        () =>
          mockManager._emitOutput('child-1', {
            type: 'complete',
            data: 'done',
            timestamp: 0,
          }),
        0,
      )
    })
    const result = await mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'implement',
      description: 'edit',
      prompt: 'do it',
      allowedFiles: ['src/a.ts'], // subset of parent's ['src/a.ts', 'src/b.ts']
    })
    expect(result.resultText).toBe('done')
  })

  it('throws when concurrency cap exceeded', async () => {
    const limitedMgr = new SubagentManager(mockManager as any, mockRepo as any, 1, 5000)
    // Don't emit complete, so first invoke stays in flight
    const promise1 = limitedMgr.invoke({
      parentSessionId: 'p1',
      agentType: 'explore',
      description: 'd',
      prompt: 'p',
    })
    // Second call should reject immediately
    await expect(
      limitedMgr.invoke({
        parentSessionId: 'p1',
        agentType: 'explore',
        description: 'd2',
        prompt: 'p2',
      }),
    ).rejects.toThrow(/concurrency limit/)
    // Cleanup: emit complete so first finishes
    mockManager._emitOutput('child-1', { type: 'complete', data: 'done', timestamp: 0 })
    await promise1
  })

  it('rejects when child emits error', async () => {
    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(
        () =>
          mockManager._emitOutput('child-1', {
            type: 'error',
            data: 'something broke',
            timestamp: 0,
          }),
        0,
      )
    })
    await expect(
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'explore',
        description: 'd',
        prompt: 'p',
      }),
    ).rejects.toThrow(/something broke/)
    // Failed status recorded
    const row = Array.from(mockRepo.rows.values())[0]
    expect(row.status).toBe('failed')
  })

  it('inherit strategy uses parent allowedFiles', async () => {
    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(
        () =>
          mockManager._emitOutput('child-1', {
            type: 'complete',
            data: 'done',
            timestamp: 0,
          }),
        0,
      )
    })
    await mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'explore', // inherit strategy
      description: 'd',
      prompt: 'p',
    })
    // Check the startSession config received parent's allowedFiles
    const callArg = mockManager.startSession.mock.calls[0][1]
    expect(callArg.allowedFiles).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('cancel terminates active session and updates repo', async () => {
    // Start an invocation that won't complete on its own
    const promise = mgr
      .invoke({
        parentSessionId: 'p1',
        agentType: 'explore',
        description: 'd',
        prompt: 'p',
      })
      .catch(() => {
        /* cancelled */
      })

    // Wait for invocation to register
    await new Promise((r) => setTimeout(r, 10))
    const invocationId = Array.from(mockRepo.rows.keys())[0]
    expect(invocationId).toBeDefined()

    await mgr.cancel(invocationId!)
    expect(mockManager.terminateSession).toHaveBeenCalledWith('child-1', 'user')
    const row = mockRepo.rows.get(invocationId!)
    expect(row.status).toBe('cancelled')

    // Cleanup
    mockManager._emitOutput('child-1', { type: 'error', data: 'cancelled', timestamp: 0 })
    await promise
  })

  it('serialises write-capable subagents with overlapping allowed_files', async () => {
    let resolveFirst: (() => void) | undefined
    const firstReady = new Promise<void>((r) => {
      resolveFirst = r
    })
    let sendCommandCallCount = 0

    mockManager.sendCommand.mockImplementation(async () => {
      sendCommandCallCount++
      const callIndex = sendCommandCallCount
      if (callIndex === 1) {
        // First invocation hangs until manually released
        await firstReady
        setTimeout(
          () =>
            mockManager._emitOutput('child-1', {
              type: 'complete',
              data: 'done1',
              timestamp: 0,
            }),
          0,
        )
      } else {
        // Second invocation completes immediately
        setTimeout(
          () =>
            mockManager._emitOutput('child-1', {
              type: 'complete',
              data: 'done2',
              timestamp: 0,
            }),
          0,
        )
      }
    })

    // Both 'implement' (scopeStrategy='subset') with overlapping files.
    const first = mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'implement',
      description: 'first edit',
      prompt: 'edit a.ts and b.ts',
      allowedFiles: ['src/a.ts', 'src/b.ts'],
    })

    // Wait a tick — first should be in-flight (sendCommand called).
    await new Promise((r) => setTimeout(r, 10))
    expect(sendCommandCallCount).toBe(1)

    // Second overlaps on src/b.ts — should wait at the gate.
    const second = mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'implement',
      description: 'second edit',
      prompt: 'edit b.ts',
      allowedFiles: ['src/b.ts'],
    })

    // Give second a window to start — it should NOT, because of the gate.
    await new Promise((r) => setTimeout(r, 50))
    expect(sendCommandCallCount).toBe(1)

    // Release the first invocation.
    resolveFirst!()
    await first

    // Now the second proceeds.
    const secondResult = await second
    expect(sendCommandCallCount).toBe(2)
    expect(secondResult.resultText).toContain('done2')
  })

  it('does NOT serialise read-only subagents (inherit scope)', async () => {
    let sendCommandCallCount = 0
    mockManager.sendCommand.mockImplementation(async () => {
      sendCommandCallCount++
      setTimeout(
        () =>
          mockManager._emitOutput('child-1', {
            type: 'complete',
            data: 'done',
            timestamp: 0,
          }),
        0,
      )
    })

    // Both 'explore' (scopeStrategy='inherit') — read-only, no serialisation.
    const [r1, r2] = await Promise.all([
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'explore',
        description: 'e1',
        prompt: 'p1',
      }),
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'explore',
        description: 'e2',
        prompt: 'p2',
      }),
    ])
    expect(r1.resultText).toBeDefined()
    expect(r2.resultText).toBeDefined()
    expect(sendCommandCallCount).toBe(2)
  })

  it('does NOT serialise write-capable subagents with disjoint allowed_files', async () => {
    let sendCommandCallCount = 0

    mockManager.sendCommand.mockImplementation(async () => {
      sendCommandCallCount++
      setTimeout(
        () =>
          mockManager._emitOutput('child-1', {
            type: 'complete',
            data: 'done',
            timestamp: 0,
          }),
        0,
      )
    })

    // Both 'implement' with disjoint allowed_files — should proceed in parallel.
    const [r1, r2] = await Promise.all([
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'implement',
        description: 'edit a',
        prompt: 'edit a.ts',
        allowedFiles: ['src/a.ts'],
      }),
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'implement',
        description: 'edit b',
        prompt: 'edit b.ts',
        allowedFiles: ['src/b.ts'],
      }),
    ])
    expect(sendCommandCallCount).toBe(2)
    expect(r1.resultText).toBeDefined()
    expect(r2.resultText).toBeDefined()
  })

  it('onProgress fires for status transitions', async () => {
    const events: any[] = []
    mgr.onProgress((e) => events.push(e))

    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(
        () =>
          mockManager._emitOutput('child-1', {
            type: 'complete',
            data: 'done',
            timestamp: 0,
          }),
        0,
      )
    })
    await mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'explore',
      description: 'd',
      prompt: 'p',
    })
    const statuses = events.map((e) => e.status)
    expect(statuses).toContain('queued')
    expect(statuses).toContain('running')
    expect(statuses).toContain('completed')
  })
})

import Database from 'better-sqlite3'

describe('SubagentManager recipe:<id> dispatch', () => {
  it('routes recipe:<id> agentType to RecipeRunner', async () => {
    const mockManager = createMockAgentManager()
    const mockRepo = createMockRepo()
    const mgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 5000)

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

    // Inject a recipe directly into the in-memory manager cache (bypass file I/O).
    const { RecipeManager } = await import('../recipes/recipe-manager')
    const { RecipeRunner } = await import('../recipes/recipe-runner')
    const mgr_recipes = new RecipeManager({ db })
    ;(mgr_recipes as unknown as { cache: Map<string, unknown> }).cache.set('demo', {
      id: 'demo',
      name: 'Demo',
      version: '1',
      steps: [
        {
          kind: 'agent',
          agent_type: 'explore',
          description: 'Demo step',
          prompt: 'do demo',
        },
      ],
      source: 'user',
    })

    const runner = new RecipeRunner({
      db,
      manager: mgr_recipes,
      subagentManager: {
        invoke: vi.fn().mockResolvedValue({
          invocationId: 'inner',
          resultText: 'inner result',
          resultFiles: [],
          tokensUsed: 0,
          durationMs: 0,
        }),
      } as any,
    })
    mgr.setRecipeRunner(runner)

    const result = await mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'recipe:demo',
      description: 'Run demo recipe',
      prompt: 'override prompt',
    })
    expect(result.invocationId.startsWith('recipe_')).toBe(true)
    expect(result.resultText).toContain('inner result')
  })

  it('throws when recipe runner missing and recipe:<id> invoked', async () => {
    const mockManager = createMockAgentManager()
    const mockRepo = createMockRepo()
    const mgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 5000)
    // intentionally NOT calling setRecipeRunner

    await expect(
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'recipe:missing',
        description: 'x',
        prompt: 'y',
      }),
    ).rejects.toThrow(/Recipe runner is not configured/)
  })

  it('returns failed run when recipe id is unknown', async () => {
    const mockManager = createMockAgentManager()
    const mockRepo = createMockRepo()
    const mgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 5000)

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
    const { RecipeManager } = await import('../recipes/recipe-manager')
    const { RecipeRunner } = await import('../recipes/recipe-runner')
    const recipes = new RecipeManager({ db })
    const runner = new RecipeRunner({ db, manager: recipes })
    mgr.setRecipeRunner(runner)

    const result = await mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'recipe:does-not-exist',
      description: 'x',
      prompt: 'y',
    })
    expect(result.invocationId.startsWith('recipe_')).toBe(true)
    expect(result.resultText).toMatch(/not found/i)
  })
})

describe('SubagentManager — a2a: prefix', () => {
  /**
   * Phase D9 C5: dispatch_subagent(agent_type='a2a:<name>') routes to
   * A2AClient.call() (not to AgentManager / subagent_invocations table).
   * Three behaviors tested:
   *   - routes to the right client by name
   *   - abort signal propagated to A2AClient.call()
   *   - unknown a2a name → AgentError (no client for that name)
   */

  function createMockA2AClient(impl?: (msg: unknown, opts: unknown) => Promise<unknown>) {
    return {
      call: vi.fn().mockImplementation(impl ?? (async () => ({
        resultText: 'remote says hi',
        resultFiles: [],
        finalStatus: { state: 'completed' },
      }))),
      destroy: vi.fn(),
      name: vi.fn().mockReturnValue('peer-1'),
      testConnection: vi.fn(),
    } as any
  }

  it('routes a2a:<name> to the matching A2AClient', async () => {
    const mockManager = createMockAgentManager()
    const mockRepo = createMockRepo()
    const mgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 5000)
    const client = createMockA2AClient()
    mgr.setA2AClient('peer-1', client)

    const result = await mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'a2a:peer-1',
      description: 'Ask peer',
      prompt: 'hello remote',
    })

    expect(result.invocationId.startsWith('a2a_')).toBe(true)
    expect(result.resultText).toBe('remote says hi')
    expect(client.call).toHaveBeenCalledOnce()
    const [msg, opts] = (client.call as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(msg).toEqual({ role: 'user', parts: [{ type: 'text', text: 'hello remote' }] })
    expect(opts).toMatchObject({ signal: expect.anything() })
    // Crucially: should NOT have created a local AgentManager session.
    expect(mockManager.startSession).not.toHaveBeenCalled()
  })

  it('throws AgentError when no A2AClient matches the name', async () => {
    const mockManager = createMockAgentManager()
    const mockRepo = createMockRepo()
    const mgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 5000)

    await expect(
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'a2a:not-registered',
        description: 'x',
        prompt: 'y',
      }),
    ).rejects.toThrow(/a2a remote 'not-registered' is not configured/i)
  })

  it('clearA2AClients destroys all registered clients', () => {
    const mockManager = createMockAgentManager()
    const mockRepo = createMockRepo()
    const mgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 5000)
    const c1 = createMockA2AClient()
    const c2 = createMockA2AClient()
    mgr.setA2AClient('p1', c1)
    mgr.setA2AClient('p2', c2)

    mgr.clearA2AClients()

    expect(c1.destroy).toHaveBeenCalledOnce()
    expect(c2.destroy).toHaveBeenCalledOnce()
  })
})
