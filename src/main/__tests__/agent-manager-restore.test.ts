/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * R1 回归：进程重启后旧会话恢复（Kernel 路径）。
 *
 * 覆盖用户要求：
 *  - 重启后同会话可继续：SessionRouter 为空 → 从 agent_sessions + 最近 turn 快照重建；
 *  - 重建后首次写必须重新弹窗（不继承会话级授权）；
 *  - 已终结 turn 不被复活（恢复只读 turn 快照，不改写 turn 状态）；
 *  - 重建不产生重复 agent_sessions 行；
 *  - 无法续接时给出可读原因 + 「新建会话可继续」，并留痕（不假装续上）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentManager } from '../agent/agent-manager'
import { AdapterRegistry } from '../agent/adapter-registry'
import { SessionRouter } from '../agent/session-router'
import { OutputBroadcaster } from '../agent/output-broadcaster'
import { BaseAdapter } from '../adapters/base'
import { SessionRecoveryManager, setForTesting } from '../agent/session-recovery'
import { AGENT_KERNEL_ENV, AGENT_KERNEL_UNSAFE_ENV } from '../agent/runtime/feature-flags'
import { SessionLockRegistry } from '../agent/runtime/locks/session-lock'
import type { ChatRepository } from '../repositories/chat-repository'
import { ApprovalGateway } from '../agent/runtime/approval/gateway'
import { SessionRestoreError } from '../errors'
import type { AgentRuntime } from '../agent/runtime/runtime'
import type { AgentSessionRow, AgentTurnRow } from '../agent/runtime/db/repository'
import type { AgentCommand, AgentSession, AgentSessionConfig } from '@shared/types'

class RestoreAdapter extends BaseAdapter {
  readonly name: string
  readonly version = '1.0.0'
  lastPrompts: string[] = []
  private readonly native: boolean

  constructor(name = 'claude-code', native = true) {
    super()
    this.name = name
    this.native = native
  }

  async checkInstalled(): Promise<boolean> {
    return true
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session: AgentSession = {
      id: `sess-${Math.random().toString(36).slice(2)}`,
      adapterName: this.name,
      config: structuredClone(config),
      startTime: Date.now(),
    }
    this.registerSession(session)
    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    this.lastPrompts.push(`${session.id}:${command.description}`)
    this.emitOutput({ type: 'stdout', data: `${this.name} output`, timestamp: Date.now() })
  }

  protected async doTerminate(): Promise<void> {
    // no process in restore tests
  }

  supportsNativeResume(): boolean {
    return this.native
  }
}

/** 只读持久化视图的替身：不依赖 better-sqlite3（本环境 ABI 与 Node 不一致）。 */
class FakeRepo {
  sessions = new Map<string, AgentSessionRow>()
  turns: AgentTurnRow[] = []
  backendSessionId: string | null = null
  insertSessionCalls = 0
  insertTurnCalls = 0
  turnStatusWrites: Array<[string, string]> = []
  runtimeSessionUpdates: Array<[string, string]> = []
  statusUpdates: Array<[string, string]> = []
  notes: string[] = []
  residualRisks: string[] = []

  getSession(sessionId: string): AgentSessionRow | null {
    return this.sessions.get(sessionId) ?? null
  }

  listTurnsBySession(sessionId: string): AgentTurnRow[] {
    return this.turns.filter((turn) => turn.session_id === sessionId)
  }

  getLatestBackendSessionId(): string | null {
    return this.backendSessionId
  }

  updateSessionRuntimeSessionId(sessionId: string, runtimeSessionId: string): void {
    this.runtimeSessionUpdates.push([sessionId, runtimeSessionId])
  }

  updateSessionStatus(sessionId: string, status: AgentSessionRow['status']): void {
    const row = this.sessions.get(sessionId)
    if (row) row.status = status
    this.statusUpdates.push([sessionId, status])
  }

  recordSessionRecovery(
    sessionId: string,
    input: { kills: number; note: string; residualRisk?: string },
  ): void {
    this.notes.push(input.note)
    this.residualRisks.push(input.residualRisk ?? 'none')
    const row = this.sessions.get(sessionId)
    if (row) row.recovery_note = input.note
  }

  insertSession(): never {
    this.insertSessionCalls += 1
    throw new Error('restore must not insert a new agent_sessions row')
  }

  insertTurn(): never {
    this.insertTurnCalls += 1
    throw new Error('restore must not insert a turn')
  }

  updateTurnStatus(turnId: string, status: string): void {
    this.turnStatusWrites.push([turnId, status])
  }
}

function sessionRow(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: 'sess-1',
    graph_id: 'g-1',
    node_id: 'n-row',
    thread_id: 'th-1',
    executor: 'claude-code',
    runtime_session_id: null,
    executor_handle: null,
    executor_pid: null,
    executor_pgid: null,
    executor_started_at: null,
    executor_cmd: null,
    executor_env_marker: null,
    residual_risk: 'none',
    status: 'orphaned',
    workspace_mode: 'shared',
    workspace_path: null,
    last_turn_id: 'turn-1',
    last_recovery_at: null,
    recovery_kills: 0,
    recovery_note: 'startup reclaim: marker=none',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  }
}

function turnRow(overrides: Partial<AgentTurnRow> = {}): AgentTurnRow {
  return {
    id: 'turn-1',
    run_id: 'run-1',
    session_id: 'sess-1',
    graph_id: 'g-1',
    node_id: 'n-snapshot',
    group_id: null,
    parent_turn_id: null,
    branch_key: '',
    attempt: 1,
    status: 'completed',
    resume_mode: 'native',
    idempotency_key: 'k-1',
    input_json: JSON.stringify({
      agentSessionId: 'sess-1',
      adapterSessionId: 'sess-1',
      prompt: 'previous turn',
      commandType: 'implement',
      workingDirectory: '/restored-project',
      executor: 'claude-code',
      nodeId: 'n-snapshot',
      graphId: 'g-1',
    }),
    output_json: null,
    failure_class: null,
    error_code: null,
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_001_000,
    deadline_at: null,
    created_at: 1_700_000_000_000,
    retention_hold: 0,
    ...overrides,
  }
}

describe('AgentManager — 重启后旧会话恢复（R1）', () => {
  let registry: AdapterRegistry
  let router: SessionRouter
  let broadcaster: OutputBroadcaster
  let manager: AgentManager
  let repo: FakeRepo
  let gateway: ApprovalGateway
  let runNode: ReturnType<typeof vi.fn>
  let previousKernel: string | undefined

  beforeEach(() => {
    previousKernel = process.env[AGENT_KERNEL_ENV]
    process.env[AGENT_KERNEL_ENV] = '1'

    setForTesting(new SessionRecoveryManager())
    registry = new AdapterRegistry()
    router = new SessionRouter(registry)
    broadcaster = new OutputBroadcaster()
    manager = new AgentManager(registry, router, broadcaster)

    repo = new FakeRepo()
    // ApprovalGateway 的会话级授权完全是内存态；构造时传入替身 repo 即可，
    // 本组测试不触碰任何落库路径。
    gateway = new ApprovalGateway({ db: {} as any, repo: {} as any })
    runNode = vi.fn(async () => ({ status: 'completed' as const }))
    manager.setRuntime({
      repo,
      locks: {},
      approvals: gateway,
      getDriver: () => ({}),
      runNode,
    } as unknown as AgentRuntime)
  })

  afterEach(() => {
    manager.destroy()
    setForTesting(null)
    if (previousKernel === undefined) delete process.env[AGENT_KERNEL_ENV]
    else process.env[AGENT_KERNEL_ENV] = previousKernel
  })

  function seedCompletedSession(row: Partial<AgentSessionRow> = {}, turn: Partial<AgentTurnRow> = {}): void {
    repo.sessions.set('sess-1', sessionRow(row))
    repo.turns.push(turnRow(turn))
  }

  it('重启后同一会话可继续：router 为空 → 从 agent_sessions + 最近 turn 重建句柄并走 runNode', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    repo.backendSessionId = 'conv-123'
    // agent_sessions 没有 node 关联时，节点信息必须从最近 turn 快照补齐。
    seedCompletedSession({ node_id: null })

    expect(router.getAdapterName('sess-1')).toBeUndefined()

    const command: AgentCommand = { type: 'implement', description: 'continue me', targetNodeId: '' }
    await manager.sendCommand('sess-1', command)

    // 句柄重建：适配器侧拿到原生续接 id，路由重新绑定。
    expect(adapter.getSessionConfig('sess-1')?.resumeSessionId).toBe('conv-123')
    expect(adapter.getSessionConfig('sess-1')?.workingDirectory).toBe('/restored-project')
    expect(router.getAdapterName('sess-1')).toBe('claude-code')

    // 这一轮真正走 Kernel，数据全部来自持久化状态。
    expect(runNode).toHaveBeenCalledTimes(1)
    expect(runNode).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: 'sess-1',
        executor: 'claude-code',
        prompt: 'continue me',
        workingDirectory: '/restored-project',
        nodeId: 'n-snapshot',
        threadId: 'th-1',
      }),
    )
    expect(repo.notes.join(' | ')).toContain('rebuilt handle from agent_sessions')
  })

  it('重建后首次写必须重新弹窗：会话级授权不继承', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    repo.backendSessionId = 'conv-123'
    seedCompletedSession()

    // 模拟重启前/路由被 TTL 清理时仍然存在的旧授权。
    ;(gateway as any).sessionGrants.set('sess-1', {
      sessionId: 'sess-1',
      approvalId: 'appr-old',
      grantedAt: Date.now(),
      toolScope: 'write',
      cwd: '/restored-project',
    })
    expect(gateway.listSessionGrants()).toHaveLength(1)

    await manager.sendCommand('sess-1', { type: 'implement', description: 'write again', targetNodeId: '' })

    expect(gateway.listSessionGrants()).toHaveLength(0)
    expect(
      gateway.peekSessionGrant({
        sessionId: 'sess-1',
        toolName: 'Write',
        args: { file_path: '/restored-project/a.ts' },
        cwd: '/restored-project',
      }),
    ).toBeNull()
  })

  it('已终结 turn 不被复活：恢复只读 turn 快照，不改写 turn 状态', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    repo.backendSessionId = 'conv-123'
    seedCompletedSession()

    await manager.sendCommand('sess-1', { type: 'implement', description: 'continue', targetNodeId: '' })

    expect(repo.turnStatusWrites).toHaveLength(0)
    expect(repo.insertTurnCalls).toBe(0)
    expect(repo.turns[0].status).toBe('completed')
  })

  it('重建不产生重复 agent_sessions 行（连续两次写也只更新既有行）', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    repo.backendSessionId = 'conv-123'
    seedCompletedSession()

    await manager.sendCommand('sess-1', { type: 'implement', description: 'first', targetNodeId: '' })
    await manager.sendCommand('sess-1', { type: 'implement', description: 'second', targetNodeId: '' })

    expect(repo.insertSessionCalls).toBe(0)
    expect(repo.sessions.size).toBe(1)
    expect(repo.runtimeSessionUpdates).toEqual([['sess-1', 'sess-1']])
    expect(repo.statusUpdates).toEqual([['sess-1', 'active']])
  })

  it('后端不支持原生续接（UNSAFE 强制 kernel）：如实降级，报可读原因并提示新建会话可继续', async () => {
    const previousUnsafe = process.env[AGENT_KERNEL_UNSAFE_ENV]
    process.env[AGENT_KERNEL_UNSAFE_ENV] = '1'
    try {
      // opencode 不在默认白名单：只有显式 UNSAFE 才会被强制走 kernel 恢复路径。
      const adapter = new RestoreAdapter('opencode', false)
      manager.registerAdapter(adapter)
      seedCompletedSession({ executor: 'opencode' })

      const promise = manager.sendCommand('sess-1', {
        type: 'implement',
        description: 'continue',
        targetNodeId: '',
      })

      await expect(promise).rejects.toBeInstanceOf(SessionRestoreError)
      await expect(promise).rejects.toMatchObject({
        code: 'AGENT_SESSION_RESTORE_FAILED',
        canStartNewSession: true,
      })
      await expect(promise).rejects.toThrow(/不支持原生续接/)
      await expect(promise).rejects.toThrow(/新建会话可继续/)
      expect(repo.notes.join(' | ')).toContain('has no native resume')
      expect(repo.residualRisks.at(-1)).toBe('none')
      expect(router.getAdapterName('sess-1')).toBeUndefined()
    } finally {
      if (previousUnsafe === undefined) delete process.env[AGENT_KERNEL_UNSAFE_ENV]
      else process.env[AGENT_KERNEL_UNSAFE_ENV] = previousUnsafe
    }
  })

  it('内部会话 id 绝不作为原生 resume id：没有 run.started session_id 时拒绝续接', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    repo.backendSessionId = null
    seedCompletedSession({ runtime_session_id: 'claude-57956f9a-4b79-4c7a-9f67-1e2d3c4b5a69' })

    const promise = manager.sendCommand('sess-1', {
      type: 'implement',
      description: 'continue',
      targetNodeId: '',
    })
    await expect(promise).rejects.toMatchObject({ code: 'AGENT_SESSION_RESTORE_FAILED' })
    await expect(promise).rejects.toThrow(/内部会话 id/)
    // 没有建立句柄 = 没有把内部 id 传给 CLI 的 resume
    expect(adapter.getSessionConfig('sess-1')).toBeUndefined()
    expect(repo.notes.join(' | ')).toContain('rejected internal session id')
  })

  it('缺少可续接的底层会话 id：不假装续上，记录 note 并提示新建会话', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    repo.backendSessionId = null
    seedCompletedSession()

    const promise = manager.sendCommand('sess-1', {
      type: 'implement',
      description: 'continue',
      targetNodeId: '',
    })
    await expect(promise).rejects.toMatchObject({ code: 'AGENT_SESSION_RESTORE_FAILED' })
    await expect(promise).rejects.toThrow(/没有找到可续接的底层会话 id/)
    expect(repo.notes.join(' | ')).toContain('no persisted backendSessionId')
  })

  it('上一轮未收口（崩溃残留在途 turn）：拒绝自动重放，不复活 turn', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    repo.backendSessionId = 'conv-123'
    seedCompletedSession({}, { status: 'running' })

    await expect(
      manager.sendCommand('sess-1', { type: 'implement', description: 'continue', targetNodeId: '' }),
    ).rejects.toThrow(/尚未结束，不能自动重放/)
    expect(repo.turnStatusWrites).toHaveLength(0)
  })
})

/**
 * 第 1 项核心：`BIZGRAPH_AGENT_KERNEL=0` 回退后，旧路径也必须能处理重启后的既有会话
 * （能续则续；不能续则明确提示新建，而不是把整个回退变成「所有会话都打不开」）。
 */
describe('AgentManager — BIZGRAPH_AGENT_KERNEL=0 旧路径的会话恢复', () => {
  let registry: AdapterRegistry
  let router: SessionRouter
  let broadcaster: OutputBroadcaster
  let manager: AgentManager
  let repo: FakeRepo
  let previousKernel: string | undefined

  beforeEach(() => {
    previousKernel = process.env[AGENT_KERNEL_ENV]
    process.env[AGENT_KERNEL_ENV] = '0'

    setForTesting(new SessionRecoveryManager())
    registry = new AdapterRegistry()
    router = new SessionRouter(registry)
    broadcaster = new OutputBroadcaster()
    manager = new AgentManager(registry, router, broadcaster)

    repo = new FakeRepo()
    manager.setRuntime({
      repo,
      locks: new SessionLockRegistry(),
      approvals: new ApprovalGateway({ db: {} as any, repo: {} as any }),
      getDriver: () => ({}),
    } as unknown as AgentRuntime)
  })

  afterEach(() => {
    manager.destroy()
    setForTesting(null)
    if (previousKernel === undefined) delete process.env[AGENT_KERNEL_ENV]
    else process.env[AGENT_KERNEL_ENV] = previousKernel
  })

  it('KERNEL=0 + 有 agent_sessions 且原生 id 可信：旧路径续接原会话并继续发送', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    repo.backendSessionId = 'conv-legacy-1'
    repo.sessions.set('sess-1', sessionRow({ executor: 'claude-code' }))
    repo.turns.push(turnRow({ session_id: 'sess-1' }))

    expect(router.getAdapterName('sess-1')).toBeUndefined()
    await manager.sendCommand('sess-1', { type: 'implement', description: 'legacy continue', targetNodeId: '' })

    // 旧路径：适配器直接执行，不经过 runNode / kernel。
    expect(adapter.lastPrompts.join(' | ')).toContain('legacy continue')
    expect(adapter.getSessionConfig('sess-1')?.resumeSessionId).toBe('conv-legacy-1')
    expect(router.getAdapterName('sess-1')).toBe('claude-code')
  })

  it('KERNEL=0 + 既无 agent_sessions 也无 chat_threads：报 AGENT_SESSION_NOT_FOUND 且文案可读', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    const chatRepo = { getThreadBySessionId: vi.fn(() => null) }
    manager.setChatRepo(chatRepo as unknown as ChatRepository)

    const promise = manager.sendCommand('sess-missing', {
      type: 'implement',
      description: 'ghost session',
      targetNodeId: '',
    })

    // 「这个 id 根本不存在」：不是「续接条件不成立」，也不该甩给适配器。
    await expect(promise).rejects.toMatchObject({ code: 'AGENT_SESSION_NOT_FOUND' })
    await expect(promise).rejects.not.toMatchObject({ code: 'AGENT_SESSION_RESTORE_FAILED' })
    // UI 侧拿到的是可读字符串（IPC toJSON 的 message 字段），不是 [object Object]
    const err = (await promise.catch((e: unknown) => e)) as {
      message?: unknown
      toJSON?: () => unknown
    }
    const json = err.toJSON?.() as { code?: string; message?: string } | undefined
    expect(typeof err.message).toBe('string')
    expect(err.message).not.toBe('[object Object]')
    expect(json?.code).toBe('AGENT_SESSION_NOT_FOUND')
    expect(json?.message).toContain('sess-missing')
    expect(json?.message).not.toBe('[object Object]')
    expect(chatRepo.getThreadBySessionId).toHaveBeenCalledWith('sess-missing')
    expect(adapter.getSessionConfig('sess-missing')).toBeUndefined()
  })

  it('KERNEL=0 + 只有 chat_thread 记录（旧路径自建会话）：明确告知不可续接并提示新建', async () => {
    const adapter = new RestoreAdapter('codex', true)
    manager.registerAdapter(adapter)
    const chatRepo = {
      getThreadBySessionId: vi.fn(() => ({
        id: 'th-legacy',
        title: 'legacy thread',
        adapter_name: 'codex',
        node_id: null,
        graph_id: 'g-1',
        session_id: 'sess-legacy',
        status: 'idle',
        created_at: 1,
        updated_at: 1,
        parent_thread_id: null,
        context_tokens_used: 0,
        context_window_max: 0,
        last_compacted_at: null,
      })),
    }
    manager.setChatRepo(chatRepo as unknown as ChatRepository)

    const promise = manager.sendCommand('sess-legacy', {
      type: 'implement',
      description: 'after fallback',
      targetNodeId: '',
    })

    // 不得报 AGENT_SESSION_NOT_FOUND，也不得报误导性的「适配器不可用」。
    await expect(promise).rejects.not.toMatchObject({ code: 'AGENT_SESSION_NOT_FOUND' })
    await expect(promise).rejects.toMatchObject({
      code: 'AGENT_SESSION_RESTORE_FAILED',
      canStartNewSession: true,
    })
    await expect(promise).rejects.toThrow(/原会话不可续接/)
    await expect(promise).rejects.toThrow(/新建会话可继续/)
    expect(chatRepo.getThreadBySessionId).toHaveBeenCalledWith('sess-legacy')
    expect(adapter.getSessionConfig('sess-legacy')).toBeUndefined()
    expect(router.getAdapterName('sess-legacy')).toBeUndefined()
  })

  it('KERNEL=0 + 同进程内仅路由条目丢失：从内存态重新绑定，不重放、不新建', async () => {
    const adapter = new RestoreAdapter('claude-code', true)
    manager.registerAdapter(adapter)
    const started = await manager.startSession('claude-code', {
      workingDirectory: '/project',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Legacy Node',
      acceptanceCriteria: [],
      threadId: 'th-legacy',
    })
    router.unbind(started.sessionId)

    await manager.sendCommand(started.sessionId, {
      type: 'implement',
      description: 'same-process continue',
      targetNodeId: '',
    })

    expect(router.getAdapterName(started.sessionId)).toBe('claude-code')
    expect(adapter.lastPrompts.join(' | ')).toContain('same-process continue')
    // 没有新建会话（旧路径自建会话不写 agent_sessions）。
    expect(repo.sessions.size).toBe(0)
  })
})
