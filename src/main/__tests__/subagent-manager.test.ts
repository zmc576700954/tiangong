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
    // 只有 claude-code 具备宿主审批能力（与真实适配器一致）。
    getAdapter: vi.fn((name: string) =>
      name === 'claude-code' ? { setTurnApprovalHooks: vi.fn() } : undefined,
    ),
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
    mergePartialResult: vi.fn(async (id: string, data: any) => {
      const r = rows.get(id)
      if (r) Object.assign(r, data)
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

  it('P0-3：无 allowed_files 的写类子代理降级为只读工具（禁写类与 Bash）', async () => {
    const parentState = {
      config: {
        workingDirectory: '/tmp',
        allowedFiles: [],
        forbiddenFiles: [],
        invariantRules: [],
        upstreamContext: '',
        downstreamContext: '',
        nodeTitle: '',
        acceptanceCriteria: [],
      },
      broadcastName: 'mock',
      adapterName: 'claude-code',
      startTime: Date.now(),
    }
    mockManager.getSessionState.mockReturnValue(parentState)
    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(
        () =>
          mockManager._emitOutput('child-1', { type: 'complete', data: 'done', timestamp: 0 }),
        0,
      )
    })

    await mgr.invoke({
      parentSessionId: 'p1',
      agentType: 'general',
      description: 'no scope',
      prompt: 'do something',
    })

    const childConfig = mockManager.startSession.mock.calls[0][1] as {
      subagentAllowedTools: string[] | '*'
    }
    expect(childConfig.subagentAllowedTools).toEqual(['Read', 'Glob', 'Grep', 'WebFetch'])
  })

  it('P0-3：禁止从有宿主审批的后端降级到无审批后端', async () => {
    const parentState = {
      config: {
        workingDirectory: '/tmp',
        allowedFiles: ['src/a.ts'],
        forbiddenFiles: [],
        invariantRules: [],
        upstreamContext: '',
        downstreamContext: '',
        nodeTitle: '',
        acceptanceCriteria: [],
      },
      broadcastName: 'mock',
      adapterName: 'claude-code',
      startTime: Date.now(),
    }
    mockManager.getSessionState.mockImplementation((id: string) =>
      id === 'child-1' ? { ...parentState, adapterName: 'codex' } : parentState,
    )

    await expect(
      mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'general',
        description: 'downgrade',
        prompt: 'do something',
        adapterName: 'codex',
        allowedFiles: ['src/a.ts'],
      }),
    ).rejects.toThrow(/降级/)
    expect(mockManager.terminateSession).toHaveBeenCalledWith('child-1', 'error')
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

  it('子会话继承父会话黑名单（黑名单靠提示词执行，不能在派发时丢掉）', async () => {
    mockManager.getSessionState.mockReturnValue({
      config: {
        workingDirectory: '/tmp',
        allowedFiles: ['src/a.ts', 'src/b.ts'],
        forbiddenFiles: ['src/secret.ts'],
        invariantRules: [],
        upstreamContext: '',
        downstreamContext: '',
        nodeTitle: '',
        acceptanceCriteria: [],
      },
      broadcastName: 'mock',
      adapterName: 'mock',
      startTime: Date.now(),
    })
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
      agentType: 'implement', // subset 策略 + 可写工具
      description: 'd',
      prompt: 'p',
      allowedFiles: ['src/a.ts'],
    })

    const callArg = mockManager.startSession.mock.calls[0][1]
    // 子会话的白名单收敛到父白名单的子集
    expect(callArg.allowedFiles).toEqual(['src/a.ts'])
    // 黑名单必须继承 —— 它唯一的执行手段就是随 prompt 下发
    expect(callArg.forbiddenFiles).toEqual(['src/secret.ts'])
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

  it('F1：子代理 error 拒绝路径收尾子会话', async () => {
    mockManager.startSession.mockResolvedValue({
      sessionId: 'child-f1a',
      adapterUsed: 'mock',
      fallbackHistory: [],
    })
    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(
        () =>
          mockManager._emitOutput('child-f1a', {
            type: 'error',
            data: 'boom',
            timestamp: 0,
          }),
        0,
      )
    })

    await expect(
      mgr.invoke({ parentSessionId: 'p1', agentType: 'explore', description: 'd', prompt: 'p' }),
    ).rejects.toThrow(/boom/)

    expect(mockManager.terminateSession).toHaveBeenCalledWith('child-f1a', 'error')
    const row = Array.from(mockRepo.rows.values())[0]
    expect(row.status).toBe('failed')
  })

  it('F1：超时拒绝路径收尾子会话', async () => {
    mockManager.startSession.mockResolvedValue({
      sessionId: 'child-f1b',
      adapterUsed: 'mock',
      fallbackHistory: [],
    })
    const timeoutMgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 50)

    await expect(
      timeoutMgr.invoke({ parentSessionId: 'p1', agentType: 'explore', description: 'd', prompt: 'p' }),
    ).rejects.toThrow(/timeout/i)

    expect(mockManager.terminateSession).toHaveBeenCalledWith('child-f1b', 'error')
    const row = Array.from(mockRepo.rows.values())[0]
    expect(row.status).toBe('failed')
  })

  it('F1：cancel 已收尾时不重复 terminate', async () => {
    mockManager.startSession.mockResolvedValue({
      sessionId: 'child-f1c',
      adapterUsed: 'mock',
      fallbackHistory: [],
    })
    const promise = mgr
      .invoke({ parentSessionId: 'p1', agentType: 'explore', description: 'd', prompt: 'p' })
      .catch(() => undefined)

    await new Promise((r) => setTimeout(r, 10))
    const invocationId = Array.from(mockRepo.rows.keys())[0]
    await mgr.cancel(invocationId!)
    await promise

    expect(mockManager.terminateSession).toHaveBeenCalledTimes(1)
    expect(mockManager.terminateSession).toHaveBeenCalledWith('child-f1c', 'user')
  })

  it('F1：terminate 失败只告警，不覆写 failed 终态', async () => {
    mockManager.startSession.mockResolvedValue({
      sessionId: 'child-f1d',
      adapterUsed: 'mock',
      fallbackHistory: [],
    })
    mockManager.terminateSession.mockRejectedValue(new Error('scope guard rollback'))
    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(
        () =>
          mockManager._emitOutput('child-f1d', {
            type: 'error',
            data: 'child crashed',
            timestamp: 0,
          }),
        0,
      )
    })

    await expect(
      mgr.invoke({ parentSessionId: 'p1', agentType: 'explore', description: 'd', prompt: 'p' }),
    ).rejects.toThrow(/child crashed/)

    const row = Array.from(mockRepo.rows.values())[0]
    expect(row.status).toBe('failed')
    expect(row.error).toContain('child crashed')
  })

  it('F2：失败路径持久化部分输出与用量，事件携带 partialSummary', async () => {
    mockManager.startSession.mockResolvedValue({
      sessionId: 'child-f2a',
      adapterUsed: 'mock',
      fallbackHistory: [],
    })
    const baseState = mockManager.getSessionState()
    mockManager.getSessionState.mockReturnValue({ ...baseState, tokensUsed: 77 })
    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(() => {
        mockManager._emitOutput('child-f2a', { type: 'stdout', data: 'half work', timestamp: 0 })
        mockManager._emitOutput('child-f2a', {
          type: 'file_change',
          data: '',
          filePath: 'src/a.ts',
          timestamp: 0,
        })
        mockManager._emitOutput('child-f2a', { type: 'error', data: 'boom', timestamp: 0 })
      }, 0)
    })

    const events: any[] = []
    mgr.onProgress((e) => events.push(e))

    await expect(
      mgr.invoke({ parentSessionId: 'p1', agentType: 'explore', description: 'd', prompt: 'p' }),
    ).rejects.toThrow(/boom/)

    expect(mockRepo.fail).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        error: 'boom',
        resultText: 'half work',
        resultFiles: ['src/a.ts'],
        tokensUsed: 77,
      }),
    )
    const failedEvent = events.find((e) => e.status === 'failed')
    expect(failedEvent.partialSummary).toEqual({
      resultTextChars: 'half work'.length,
      resultFilesCount: 1,
      truncated: false,
    })
  })

  it('F2：部分结果按 MAX_OUTPUT_ENTRY_SIZE 截断，不扩展到 1MB', async () => {
    mockManager.startSession.mockResolvedValue({
      sessionId: 'child-f2b',
      adapterUsed: 'mock',
      fallbackHistory: [],
    })
    const longOutput = 'x'.repeat(10_050)
    mockManager.sendCommand.mockImplementation(async () => {
      setTimeout(() => {
        mockManager._emitOutput('child-f2b', { type: 'stdout', data: longOutput, timestamp: 0 })
        mockManager._emitOutput('child-f2b', { type: 'error', data: 'boom', timestamp: 0 })
      }, 0)
    })

    const events: any[] = []
    mgr.onProgress((e) => events.push(e))
    await expect(
      mgr.invoke({ parentSessionId: 'p1', agentType: 'explore', description: 'd', prompt: 'p' }),
    ).rejects.toThrow(/boom/)

    const failData = (mockRepo.fail as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(failData.resultText.length).toBeLessThanOrEqual(10_000 + '\n...[truncated]'.length)
    expect(failData.resultText).toContain('...[truncated]')
    const failedEvent = events.find((e) => e.status === 'failed')
    expect(failedEvent.partialSummary).toEqual({
      resultTextChars: longOutput.length,
      resultFilesCount: 0,
      truncated: true,
    })
  })

  it('F2：取消路径保留部分结果但不改 cancelled 终态', async () => {
    mockManager.startSession.mockResolvedValue({
      sessionId: 'child-f2c',
      adapterUsed: 'mock',
      fallbackHistory: [],
    })
    mockManager.sendCommand.mockImplementation(async () => {
      mockManager._emitOutput('child-f2c', { type: 'stdout', data: 'work in progress', timestamp: 0 })
    })

    const promise = mgr
      .invoke({ parentSessionId: 'p1', agentType: 'explore', description: 'd', prompt: 'p' })
      .catch(() => undefined)
    await new Promise((r) => setTimeout(r, 10))

    const invocationId = Array.from(mockRepo.rows.keys())[0]
    await mgr.cancel(invocationId!)
    await promise

    const row = mockRepo.rows.get(invocationId!)
    expect(row.status).toBe('cancelled')
    expect(row.resultText).toBe('work in progress')
    expect(mockRepo.mergePartialResult).toHaveBeenCalled()
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

  /**
   * 只读父会话**不得**执行 recipe。
   *
   * 背景：recipe 的 shell 步直接 spawn 子进程（recipe-runner.ts 的 runShellStep），
   * 完全在适配器层之外 —— claude-code 的 tools 白名单与 strictMcpConfig 都管不到它。
   * 所以只读会话能被诱导去 dispatch 一个 recipe，然后由 recipe 在真实项目目录里写盘。
   */
  describe('只读父会话不得执行 recipe', () => {
    it('父会话 readOnly → 拒绝执行 recipe，且错误说明了原因', async () => {
      const mockManager = createMockAgentManager()
      // 父会话是只读的
      mockManager.getSessionState.mockReturnValue({
        config: {
          workingDirectory: '/tmp',
          allowedFiles: [],
          readOnly: true,
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
      })

      const mockRepo = createMockRepo()
      const mgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 5000)

      const run = vi.fn().mockResolvedValue({ id: 'r1' })
      mgr.setRecipeRunner({ run } as any)

      await expect(
        mgr.invoke({
          parentSessionId: 'p1',
          agentType: 'recipe:demo',
          description: 'Run demo recipe',
          prompt: 'override prompt',
        }),
      ).rejects.toThrow(/read-only/)

      // 关键：recipe 根本没被执行 —— shell 步没有机会 spawn
      expect(run).not.toHaveBeenCalled()
    })

    it('父会话可写 → recipe 照常执行（守卫不误伤）', async () => {
      const mockManager = createMockAgentManager()
      // 默认 mock 的 config 没有 readOnly → 可写
      const mockRepo = createMockRepo()
      const mgr = new SubagentManager(mockManager as any, mockRepo as any, 5, 5000)

      const run = vi.fn().mockResolvedValue({
        id: 'r1',
        status: 'succeeded',
        steps: [],
        outputs: {},
        error: null,
        started_at: Date.now(),
        finished_at: Date.now(),
      })
      mgr.setRecipeRunner({ run } as any)

      // 不抛错即可 —— 守卫不该拦住可写会话
      await mgr.invoke({
        parentSessionId: 'p1',
        agentType: 'recipe:demo',
        description: 'Run demo recipe',
        prompt: 'override prompt',
      })

      expect(run).toHaveBeenCalled()
    })
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
