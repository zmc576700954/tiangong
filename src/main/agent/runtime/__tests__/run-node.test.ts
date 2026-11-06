/**
 * D2/D5 验收：runNode（一节点一 turn）、并发 fail-fast、幂等、取消与成本账本。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../runtime'
import { AgentRepository } from '../db/repository'
import { NodeBusyError, SessionBusyError } from '../errors'
import { openTestDb } from './helpers/test-db'
import { listProcesses, ProcessReaper } from '../process/reaper'
import {
  PROC_REGISTRY_DIR_ENV,
  registryRecordPath,
  signProcRegistryRecord,
} from '../../../shared/process-supervisor'
import type {
  BackendDriver,
  DriverCapabilities,
  DriverExecuteContext,
  DriverExecuteRequest,
  DriverExecuteResult,
  NormalizedEventEnvelope,
  RunNodeRequest,
} from '@shared/types/agent-runtime'

const CAPABILITIES: DriverCapabilities = {
  toolEvents: 'exact',
  toolArgs: 'raw',
  toolLifecycle: 'exact',
  approval: 'pre-exec',
  fileChanges: 'hook',
  usage: 'turn-aggregate',
  completion: 'backend-turn-completed',
}

function event(
  request: DriverExecuteRequest,
  seq: number,
  type: NormalizedEventEnvelope['type'],
  payload: Record<string, unknown> = {},
  stepId?: string,
): NormalizedEventEnvelope {
  return {
    eventId: `${request.turnId}-${seq}`,
    runId: request.runId,
    turnId: request.turnId,
    seq,
    type,
    source: 'backend',
    fidelity: 'turn',
    payloadVersion: 1,
    payload,
    timestamp: Date.now(),
    stepId,
  }
}

const spawnedChildren: ChildProcess[] = []

function spawnChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  if (child.pid) spawnedChildren.push(child)
  return child
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
  }
})

/** 真实 spawn + 登记句柄的驱动器：'complete' 延迟完成，'block' 等取消。 */
function makeProcessDriver(): BackendDriver & {
  executions: DriverExecuteRequest[]
  pids: Map<string, number>
  seqs: Map<string, number>
} {
  const executions: DriverExecuteRequest[] = []
  const pids = new Map<string, number>()
  const seqs = new Map<string, number>()
  return {
    name: 'claude',
    capabilities: CAPABILITIES,
    executions,
    pids,
    seqs,
    async execute(request, context) {
      executions.push(request)
      const child = spawnChild()
      if (!child.pid) throw new Error('failed to spawn child')
      pids.set(request.turnId, child.pid)
      context.registerProcess({ pid: child.pid, pgid: child.pid })

      if (request.prompt === 'throw') {
        // 异常退出路径：driver 抛错时本轮已登记的句柄必须被 finally 回收
        throw new Error('driver crashed after spawn')
      }

      let seq = 1
      const emit = () => {
        seq += 1
        seqs.set(request.turnId, seq)
        context.record([event(request, seq, 'message.delta', { text: 'tick' })])
      }
      context.record([event(request, 1, 'tool.requested', { toolName: 'Bash', args: { command: 'sleep 300' } }, 'step-1')])
      const timer = setInterval(emit, 60)

      if (request.prompt === 'complete') {
        await new Promise((resolve) => setTimeout(resolve, 300))
        clearInterval(timer)
        return { status: 'completed', finalText: 'done', completionSignal: 'backend-turn-completed' }
      }
      return new Promise<DriverExecuteResult>((resolve) => {
        context.signal.addEventListener('abort', () => {
          clearInterval(timer)
          resolve({ status: 'cancelled', completionSignal: 'backend-turn-completed' })
        })
      })
    },
    async cancel() {
      /* no-op */
    },
  }
}

/** 立即完成的驱动器：按给定脚本发事件并返回结果。 */
function makeInstantDriver(options?: {
  usage?: { inputTokens: number; outputTokens: number }
  finalText?: string
  resultStatus?: DriverExecuteResult['status']
}): BackendDriver & { executions: DriverExecuteRequest[] } {
  const executions: DriverExecuteRequest[] = []
  return {
    name: 'claude',
    capabilities: CAPABILITIES,
    executions,
    async execute(request, context) {
      executions.push(request)
      context.record([
        event(request, 1, 'message.delta', { text: 'hello' }),
        event(request, 2, 'tool.requested', { toolName: 'Read', args: { path: 'a.txt' } }, 'step-1'),
        event(request, 3, 'tool.result', { ok: true }, 'step-1'),
      ])
      return {
        status: options?.resultStatus ?? 'completed',
        finalText: options?.finalText ?? 'done',
        usage: options?.usage,
        completionSignal: 'backend-turn-completed',
      }
    },
    async cancel() {
      /* no-op */
    },
  }
}

/** 阻塞到取消的驱动器：用于并发与取消路径。 */
function makeBlockingDriver(): BackendDriver & {
  executions: DriverExecuteRequest[]
  contexts: Map<string, DriverExecuteContext>
} {
  const executions: DriverExecuteRequest[] = []
  const contexts = new Map<string, DriverExecuteContext>()
  return {
    name: 'claude',
    capabilities: CAPABILITIES,
    executions,
    contexts,
    async execute(request, context) {
      executions.push(request)
      contexts.set(request.turnId, context)
      context.record([event(request, 1, 'tool.requested', { toolName: 'Bash', args: { command: 'sleep 300' } }, 'step-1')])
      return new Promise<DriverExecuteResult>((resolve) => {
        context.signal.addEventListener('abort', () => {
          resolve({ status: 'cancelled', completionSignal: 'backend-turn-completed' })
        })
      })
    },
    async cancel() {
      /* no-op */
    },
  }
}

function reclaimAudits(repo: AgentRepository, turnId: string) {
  return repo
    .listTurnEvents(turnId)
    .filter((event) => event.type === 'process.reclaimed')
    .map((event) => event.payload as {
      sessionId: string
      turnId: string
      reason: string
      method: string
      pids: number[]
      pgids: number[]
      success: boolean
      unresolved: Array<{ pid: number; reason: string; matched: string[] }>
      durationMs: number
      evidence: Array<{ pid: number; matched: string[] }>
    })
}

function allReclaimAudits(db: ReturnType<typeof openTestDb>) {
  return (
    db.prepare("SELECT turn_id, payload_json FROM agent_events WHERE type = 'process.reclaimed'").all() as Array<{
      turn_id: string
      payload_json: string
    }>
  ).map((row) => JSON.parse(row.payload_json) as ReturnType<typeof reclaimAudits>[number])
}

function setup(driver: BackendDriver, options?: {
  rates?: { currency?: string; inputPerMillion: number; outputPerMillion: number }
}) {
  const db = openTestDb()
  const repo = new AgentRepository(db)
  const runtime = new AgentRuntime({
    db,
    repo,
    rates: options?.rates,
  })
  runtime.registerDriver('claude-code', driver)
  return { db, repo, runtime }
}

function request(overrides: Partial<RunNodeRequest> & Pick<RunNodeRequest, 'nodeId' | 'agentSessionId'>): RunNodeRequest {
  return {
    executor: 'claude-code',
    prompt: 'do the thing',
    workingDirectory: process.cwd(),
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timeout waiting for condition')
}

describe('AgentRuntime.runNode (D2/D5)', () => {
  it('persists a turn with continuous run seq and turn seq, then projects run completed', async () => {
    const driver = makeInstantDriver({ usage: { inputTokens: 500, outputTokens: 200 } })
    const { repo, runtime } = setup(driver)

    const outcome = await runtime.runNode(request({ nodeId: 'n1', agentSessionId: 'sess-1' }))
    expect(outcome.status).toBe('completed')
    expect(outcome.finalText).toBe('done')
    expect(outcome.reused).toBe(false)

    const turn = repo.getTurn(outcome.turnId)
    expect(turn?.status).toBe('completed')
    expect(repo.getRun(outcome.runId)?.status).toBe('completed')
    expect(repo.listOpenSteps(outcome.turnId)).toHaveLength(0)

    const runEvents = repo.listEvents(outcome.runId)
    expect(runEvents.map((e) => e.seq)).toEqual(
      Array.from({ length: runEvents.length }, (_, i) => i + 1),
    )
    // 首条是 kernel 的 turn.started，其余为后端事件
    expect(runEvents[0].type).toBe('turn.started')
    expect(runEvents[0].source).toBe('kernel')

    const turnEvents = repo.listTurnEvents(outcome.turnId)
    expect(turnEvents.map((e) => e.turn_seq)).toEqual(
      Array.from({ length: turnEvents.length }, (_, i) => i + 1),
    )

    // P3：driver 给的 local stepId 经 record 作用域化后落库，可按 step 一次查全工具事件
    const stepId = `${outcome.turnId}:step-1`
    const stepEvents = repo.listStepEvents(stepId)
    expect(stepEvents.map((e) => e.type)).toEqual(['tool.requested', 'tool.result'])
    expect(stepEvents.every((e) => e.step_id === stepId)).toBe(true)
    expect(stepEvents.every((e) => e.turn_id === outcome.turnId)).toBe(true)

    // M1：driver 上报了真实用量（source=provider），但未给 model → 缺价，
    // cost_micros=NULL（不产生错误金额），attribution_note 记录 missing_price
    const usage = repo.listUsageByTurn(outcome.turnId)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ input_tokens: 500, output_tokens: 200, cost_micros: null, is_estimate: 0, source: 'provider' })
    expect(usage[0].attribution_note).toContain('missing_price:claude-code/')
    expect(usage[0].graph_id).toBeNull()
    runtime.dispose()
  })

  it('computes cost from configured rates instead of hard-coded prices', async () => {
    const driver = makeInstantDriver({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } })
    const { repo, runtime } = setup(driver, { rates: { currency: 'USD', inputPerMillion: 3, outputPerMillion: 15 } })

    const outcome = await runtime.runNode(request({ nodeId: 'n-cost', agentSessionId: 'sess-cost', graphId: 'g-cost' }))
    const usage = repo.listUsageByTurn(outcome.turnId)[0]
    expect(usage.cost_micros).toBe(18_000_000)
    expect(usage.is_estimate).toBe(0)
    expect(usage.source).toBe('provider')
    expect(usage.price_version).toBe('settings:rates')
    expect(repo.summarizeUsageByGraphDay('g-cost', usage.day_key).knownCostMicros).toBe(18_000_000)
    runtime.dispose()
  })

  it('P3-4: 全 0 usage 不落 0 值行，按 unknown 处理（与 legacy 口径一致）', async () => {
    const driver = makeInstantDriver({ usage: { inputTokens: 0, outputTokens: 0 } })
    const { repo, runtime } = setup(driver)

    const outcome = await runtime.runNode(request({ nodeId: 'n-zero-usage', agentSessionId: 'sess-zero', graphId: 'g-zero' }))
    const usage = repo.listUsageByTurn(outcome.turnId)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      source: 'unknown',
      input_tokens: null,
      output_tokens: null,
      cost_micros: null,
      attribution_note: 'backend_reports_no_usage',
    })
    expect(usage[0].tokens_reported).toBe(0)
    runtime.dispose()
  })

  it('fails fast with SESSION_BUSY when the same session has an in-flight turn', async () => {
    const driver = makeBlockingDriver()
    const { repo, runtime } = setup(driver)

    const first = runtime.runNode(
      request({ nodeId: 'n1', agentSessionId: 'sess-busy', idempotencyKey: 'k-first', prompt: 'first' }),
    )
    await waitFor(() => driver.executions.length === 1)
    const firstTurn = repo.findTurnByIdempotencyKey('sess-busy:k-first')!
    expect(firstTurn.status).toBe('running')

    await expect(
      runtime.runNode(request({ nodeId: 'n1', agentSessionId: 'sess-busy', idempotencyKey: 'k-second', prompt: 'second' })),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    await expect(
      runtime.runNode(request({ nodeId: 'n1', agentSessionId: 'sess-busy', idempotencyKey: 'k-third', prompt: 'third' })),
    ).rejects.toBeInstanceOf(SessionBusyError)
    // P2-1：重叠调用的 finally 不得清掉在途标记——否则 kernel 记账 owner 丢失，
    // 同轮的 legacy 上报会再记一条（2x）。
    expect(runtime.hasActiveTurn('sess-busy')).toBe(true)

    // 释放：取消后会话锁应可用
    await runtime.cancelTurn(firstTurn.id)
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(runtime.locks.isBusy(`session:sess-busy`)).toBe(false)
    expect(runtime.hasActiveTurn('sess-busy')).toBe(false)
    runtime.dispose()
  })

  it('fails fast with NODE_BUSY for concurrent turns on the same node (different sessions)', async () => {
    const driver = makeBlockingDriver()
    const { repo, runtime } = setup(driver)

    const first = runtime.runNode(
      request({ nodeId: 'n-shared', agentSessionId: 'sess-a', idempotencyKey: 'k-node-a', prompt: 'a' }),
    )
    await waitFor(() => repo.countActiveTurnsByNode('n-shared', '') > 0)

    await expect(
      runtime.runNode(request({ nodeId: 'n-shared', agentSessionId: 'sess-b', idempotencyKey: 'k-node-b', prompt: 'b' })),
    ).rejects.toBeInstanceOf(NodeBusyError)
    await expect(
      runtime.runNode(request({ nodeId: 'n-shared', agentSessionId: 'sess-b', idempotencyKey: 'k-node-b2', prompt: 'b2' })),
    ).rejects.toMatchObject({ code: 'NODE_BUSY' })

    const firstTurn = repo.findTurnByIdempotencyKey('sess-a:k-node-a')!
    await runtime.cancelTurn(firstTurn.id)
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    runtime.dispose()
  })

  it('reuses a finished turn for the same idempotency key (no second execution)', async () => {
    const driver = makeInstantDriver()
    const { repo, runtime } = setup(driver)
    const req = request({ nodeId: 'n-idem', agentSessionId: 'sess-idem', idempotencyKey: 'k-idem' })

    const first = await runtime.runNode(req)
    const second = await runtime.runNode(req)

    expect(second.reused).toBe(true)
    expect(second.turnId).toBe(first.turnId)
    expect(driver.executions).toHaveLength(1)
    expect(repo.listTurnsByRun(first.runId)).toHaveLength(1)
    runtime.dispose()
  })

  it('同会话同 prompt 两次发送产生两个 turn（不再静默复用旧 turn）', async () => {
    const driver = makeInstantDriver()
    const { repo, runtime } = setup(driver)

    const first = await runtime.runNode(request({ nodeId: 'n-repeat', agentSessionId: 'sess-repeat' }))
    const second = await runtime.runNode(request({ nodeId: 'n-repeat', agentSessionId: 'sess-repeat' }))

    expect(second.reused).toBe(false)
    expect(second.turnId).not.toBe(first.turnId)
    expect(driver.executions).toHaveLength(2)
    expect(repo.listTurnsByRun(first.runId).length + repo.listTurnsByRun(second.runId).length).toBe(2)
    runtime.dispose()
  })

  it('跨会话同幂等键不命中：不得复用别的会话的 turn', async () => {
    const driver = makeInstantDriver()
    const { runtime } = setup(driver)

    const first = await runtime.runNode(
      request({ nodeId: 'n-x', agentSessionId: 'sess-a', idempotencyKey: 'shared-key' }),
    )
    const second = await runtime.runNode(
      request({ nodeId: 'n-x', agentSessionId: 'sess-b', idempotencyKey: 'shared-key' }),
    )

    expect(second.reused).toBe(false)
    expect(second.turnId).not.toBe(first.turnId)
    expect(driver.executions).toHaveLength(2)
    runtime.dispose()
  })

  it('cancels an in-flight SDK turn: aborted steps + residual_risk unconfirmed (no zero-residual claim)', async () => {
    const driver = makeBlockingDriver()
    const { repo, runtime } = setup(driver)

    const pending = runtime.runNode(request({ nodeId: 'n-cancel', agentSessionId: 'sess-cancel', idempotencyKey: 'k-cancel' }))
    await waitFor(() => driver.contexts.size === 1)
    const turn = repo.findTurnByIdempotencyKey('sess-cancel:k-cancel')!

    const cancelled = await runtime.cancelTurn(turn.id)
    expect(cancelled).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })

    const final = repo.getTurn(turn.id)
    expect(final?.status).toBe('cancelled')
    expect(final?.failure_class).toBe('aborted')
    expect(repo.listOpenSteps(turn.id)).toHaveLength(0)
    expect(repo.listSteps(turn.id).every((step) => step.status === 'aborted' || step.status === 'done')).toBe(true)
    // §5.1：aborted 不宣称成功，必须落未知/待重跑处置
    expect(repo.listSteps(turn.id).find((step) => step.status === 'aborted')?.test_disposition).toBe('unknown-needs-rerun')
    // SDK 路径没有可核对的句柄：只能收敛 + 显式 residual_risk，不得宣称「残留为 0」
    expect(repo.getSession('sess-cancel')?.residual_risk).toBe('unconfirmed')
    runtime.dispose()
  })

  it('keeps step rows from two consecutive turns of the same node (P0-3)', async () => {
    const driver = makeInstantDriver()
    const { repo, runtime } = setup(driver)

    const first = await runtime.runNode(request({ nodeId: 'n-step', agentSessionId: 'sess-step', idempotencyKey: 'k-step-1' }))
    const second = await runtime.runNode(request({ nodeId: 'n-step', agentSessionId: 'sess-step', idempotencyKey: 'k-step-2' }))

    const steps1 = repo.listSteps(first.turnId)
    const steps2 = repo.listSteps(second.turnId)
    expect(steps1.map((step) => step.id)).toEqual([`${first.turnId}:step-1`])
    expect(steps2.map((step) => step.id)).toEqual([`${second.turnId}:step-1`])
    // 第二轮不得覆盖第一轮：两行同时存在且内容不串
    expect(steps1[0].status).toBe('done')
    expect(steps1[0].turn_id).toBe(first.turnId)
    expect(steps2[0].turn_id).toBe(second.turnId)
    // 第一轮的行仍可读取，未被第二轮 upsert 覆盖
    expect(repo.listSteps(first.turnId)[0].id).toBe(`${first.turnId}:step-1`)
    runtime.dispose()
  })

  it('A completing normally must not reap B (same vendor, concurrent sessions) (P0-1)', async () => {
    const driver = makeProcessDriver()
    const { repo, runtime } = setup(driver)

    const a = runtime.runNode(
      request({ nodeId: 'n-a', agentSessionId: 'sess-a1', idempotencyKey: 'k-a1', prompt: 'complete' }),
    )
    await waitFor(() => driver.executions.length === 1)
    const b = runtime.runNode(
      request({ nodeId: 'n-b', agentSessionId: 'sess-b1', idempotencyKey: 'k-b1', prompt: 'block' }),
    )
    await waitFor(() => driver.executions.length === 2)

    const aTurn = repo.findTurnByIdempotencyKey('sess-a1:k-a1')!
    const bTurn = repo.findTurnByIdempotencyKey('sess-b1:k-b1')!
    const aPid = driver.pids.get(aTurn.id)!
    const bPid = driver.pids.get(bTurn.id)!

    await expect(a).resolves.toMatchObject({ status: 'completed' })
    await waitFor(() => repo.getTurn(aTurn.id)?.status === 'completed')
    expect(alive(bPid), 'B 进程必须存活').toBe(true)

    // B 事件在 A 完成后仍持续增加
    const before = repo.listTurnEvents(bTurn.id).length
    await waitFor(() => repo.listTurnEvents(bTurn.id).length > before)

    // 正常完成路径不 reap：A 登记的子进程仍在，由 afterEach 清理
    expect(alive(aPid), '正常完成不得全量 reap').toBe(true)
    // 反向对照：正常完成不得产生任何回收审计
    expect(reclaimAudits(repo, aTurn.id), '正常完成不得产生 process.reclaimed').toHaveLength(0)

    await runtime.cancelTurn(bTurn.id)
    await expect(b).resolves.toMatchObject({ status: 'cancelled' })
    // OpenCode 类真实句柄：取消后 2s 内残留=0，且 residual_risk 为 none
    await waitFor(() => !alive(bPid), 2000)
    expect(repo.getSession('sess-b1')?.residual_risk).toBe('none')
    runtime.dispose()
  })

  it('reclaims this turn\u2019s registered handle when the driver throws (abnormal exit)', async () => {
    const driver = makeProcessDriver()
    const { repo, runtime } = setup(driver)

    const outcome = await runtime.runNode(
      request({ nodeId: 'n-throw', agentSessionId: 'sess-throw', idempotencyKey: 'k-throw', prompt: 'throw' }),
    )
    expect(outcome.status).toBe('failed')
    const pid = driver.pids.get(outcome.turnId)!
    await waitFor(() => !alive(pid))

    const session = repo.getSession('sess-throw')
    expect(session?.executor_pid).toBeNull()
    // C17-a：动作已发生就必须记账，且 residualRisk=none 也要有 audit。
    expect(session?.recovery_kills, 'recoveryKills 必须等于实际回收次数').toBe(1)
    expect(session?.recovery_note, 'note 不得为空').toBeTruthy()
    expect(session?.residual_risk).toBe('none')

    const audits = reclaimAudits(repo, outcome.turnId)
    expect(audits, '异常退出必须恰好产生 1 条审计').toHaveLength(1)
    expect(audits[0].reason).toBe('abnormal-exit')
    expect(audits[0].method).toBe('pgid')
    expect(audits[0].pids).toContain(pid)
    expect(audits[0].pgids).toContain(pid)
    expect(audits[0].success).toBe(true)
    expect(audits[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(audits[0].evidence.find((item) => item.pid === pid)?.matched).toEqual(
      expect.arrayContaining(['startedAt', 'command']),
    )
    // 要求 4：审计不得含命令行/密钥/nonce 等敏感内容。
    const raw = JSON.stringify(audits.map((audit) => audit))
    expect(raw).not.toContain('setTimeout')
    expect(raw).not.toContain(process.execPath)
    expect(raw).not.toMatch(/"command"\s*:|nonce|"sig"|secret/i)
    runtime.dispose()
  })

  it('terminal turns clear persisted handles so a later cancel never reuses the previous pid (P0-A)', async () => {
    const driver = makeBlockingDriver()
    const { repo, runtime } = setup(driver)
    const bystander = spawnChild()
    expect(bystander.pid).toBeGreaterThan(0)

    const first = runtime.runNode(
      request({ nodeId: 'n-c1', agentSessionId: 'sess-c1', idempotencyKey: 'k-c1' }),
    )
    await waitFor(() => driver.contexts.size === 1)
    const t1 = repo.findTurnByIdempotencyKey('sess-c1:k-c1')!
    await runtime.cancelTurn(t1.id)
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(repo.getSession('sess-c1')?.executor_pid, '终态必须清空 pid').toBeNull()

    // 人为写回一个「证据完整」的陈旧句柄：若取消读取落库 pid，就会误杀这个无关进程
    const identity = runtime.reaper.registerProcess('stale-seed', { pid: bystander.pid! })
    repo.updateSessionProcess('sess-c1', {
      pid: bystander.pid,
      command: identity?.command,
      startedAt: identity?.startedAt,
    })

    const second = runtime.runNode(
      request({ nodeId: 'n-c2', agentSessionId: 'sess-c1', idempotencyKey: 'k-c2' }),
    )
    await waitFor(() => driver.contexts.size === 2)
    const t2 = repo.findTurnByIdempotencyKey('sess-c1:k-c2')!
    await runtime.cancelTurn(t2.id)
    await expect(second).resolves.toMatchObject({ status: 'cancelled' })

    expect(alive(bystander.pid!), '取消不得使用上一轮落库的句柄').toBe(true)
    runtime.dispose()
  })

  it('startup reclaim kills a residual whose persisted identity is provable (P0-2)', async () => {
    const driver = makeInstantDriver()
    const { db, repo, runtime } = setup(driver)

    const marker = `bizgraph-turn:stale-${Date.now()}`
    const child = spawnChild()
    expect(child.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === child.pid))
    const identity = new ProcessReaper().registerProcess('seed', { pid: child.pid! })
    expect(identity?.startedAt).toBeTruthy()

    repo.insertSession({ id: 'sess-startup', executor: 'claude-code', status: 'orphaned', executorEnvMarker: marker })
    repo.updateSessionProcess('sess-startup', {
      pid: child.pid,
      command: identity?.command,
      startedAt: identity?.startedAt,
    })

    const report = await runtime.reconcileOnStartup()
    await waitFor(() => !alive(child.pid!))

    const reclaimed = report.reclaimedSessions.find((item) => item.sessionId === 'sess-startup')
    expect(reclaimed?.marker).toBe(marker)
    expect(reclaimed?.killed).toBeGreaterThanOrEqual(1)
    expect(reclaimed?.residualRisk).toBe('none')
    const session = repo.getSession('sess-startup')
    expect(session?.recovery_kills).toBeGreaterThanOrEqual(1)
    expect(session?.recovery_note).toContain(marker)
    expect(session?.executor_pid).toBeNull()

    const audits = allReclaimAudits(db).filter((audit) => audit.sessionId === 'sess-startup')
    expect(audits, '可证明残留必须产生 1 条回收审计').toHaveLength(1)
    expect(audits[0].reason).toBe('startup-reclaim')
    expect(audits[0].success).toBe(true)
    expect(audits[0].pids).toContain(child.pid)
    expect(audits[0].evidence.find((item) => item.pid === child.pid)?.matched.length).toBeGreaterThanOrEqual(2)
    runtime.dispose()
  })

  it('startup reclaim refuses to kill an unrelated process occupying a persisted pid (P0-A)', async () => {
    const driver = makeInstantDriver()
    const { db, repo, runtime } = setup(driver)

    const bystander = spawnChild()
    expect(bystander.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === bystander.pid))

    // 模拟上一轮落库、但 pid 已被无关进程复用的句柄：启动时间与命令行都对不上
    repo.insertSession({
      id: 'sess-reuse',
      executor: 'claude-code',
      status: 'orphaned',
      executorEnvMarker: 'bizgraph-turn:stale-reuse',
    })
    repo.updateSessionProcess('sess-reuse', {
      pid: bystander.pid,
      command: 'previous-turn-cmd --leaked-handle',
      startedAt: 'Jan 1 00:00:00 2024',
    })

    const report = await runtime.reconcileOnStartup()
    expect(alive(bystander.pid!), '证据不足时不得杀').toBe(true)

    const reclaimed = report.reclaimedSessions.find((item) => item.sessionId === 'sess-reuse')
    expect(reclaimed?.killed).toBe(0)
    expect(reclaimed?.residualRisk).toBe('unconfirmed')
    expect(report.residualRiskSessions).toBeGreaterThanOrEqual(1)
    const session = repo.getSession('sess-reuse')
    expect(session?.residual_risk).toBe('unconfirmed')
    expect(session?.recovery_note).toContain('residualRisk=unconfirmed')

    // 不可证明 → 不得产生「已回收」记录，只产生「未回收原因」记录。
    const audits = allReclaimAudits(db).filter((audit) => audit.sessionId === 'sess-reuse')
    expect(audits).toHaveLength(1)
    expect(audits[0].success).toBe(false)
    expect(audits[0].method).toBe('none')
    expect(audits[0].pids).toEqual([])
    expect(audits[0].unresolved.some((item) => item.pid === bystander.pid && item.reason === 'insufficient-proof')).toBe(true)
    runtime.dispose()
  })

  it('SDK sessions without a provable handle report residual_risk instead of claiming zero residual', async () => {
    const driver = makeInstantDriver()
    const { repo, runtime } = setup(driver)

    repo.insertSession({
      id: 'sess-sdk',
      executor: 'codex',
      status: 'orphaned',
      executorEnvMarker: 'bizgraph-turn:sdk-orphan',
    })

    const report = await runtime.reconcileOnStartup()
    const reclaimed = report.reclaimedSessions.find((item) => item.sessionId === 'sess-sdk')
    // Claude/Codex 的隐式子进程无法跨重启证明归属：不得宣称残留为 0
    expect(reclaimed?.killed).toBe(0)
    expect(reclaimed?.residualRisk).toBe('unconfirmed')
    expect(repo.getSession('sess-sdk')?.residual_risk).toBe('unconfirmed')
    runtime.dispose()
  })

  it('maps unresolved tool existence to unknown, not failed (C2)', async () => {
    const driver: BackendDriver = {
      name: 'claude',
      capabilities: CAPABILITIES,
      async execute(req, context) {
        context.record([event(req, 1, 'tool.unknown', { toolName: 'Write', reason: 'stream-ended' }, 'step-u')])
        return { status: 'completed', completionSignal: 'backend-turn-completed' }
      },
      async cancel() {},
    }
    const { repo, runtime } = setup(driver)
    const outcome = await runtime.runNode(request({ nodeId: 'n-unknown', agentSessionId: 'sess-unknown' }))
    const step = repo.listSteps(outcome.turnId).find((item) => item.id.endsWith(':step-u'))
    expect(step?.status).toBe('unknown')
    expect(step?.status).not.toBe('failed')
    expect(step?.test_disposition).toBe('needs-human')
    runtime.dispose()
  })

  it('never rejects a turn for cost, even when a legacy limits config is injected', async () => {
    const driver = makeInstantDriver({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } })
    const db = openTestDb()
    const repo = new AgentRepository(db)
    // 模拟旧 settings 里仍写着 agentRuntime.limits：类型已删除，这里用额外属性注入。
    // 运行时必须完全忽略它，任何情况下都不能因成本拒绝新 turn。
    const legacyOptions = {
      db,
      repo,
      rates: { currency: 'USD', inputPerMillion: 3, outputPerMillion: 15 },
      limits: { perGraph: 1, perDay: 1 },
    }
    const runtime = new AgentRuntime(legacyOptions)
    runtime.registerDriver('claude-code', driver)

    const first = await runtime.runNode(
      request({ nodeId: 'n-no-limit-1', agentSessionId: 'sess-no-limit-1', graphId: 'g-no-limit' }),
    )
    expect(first.status).toBe('completed')
    const usage = repo.listUsageByTurn(first.turnId)[0]
    expect(usage.cost_micros).toBe(18_000_000)
    expect(repo.summarizeUsageByGraphDay('g-no-limit', usage.day_key).knownCostMicros).toBe(18_000_000)

    // 当日已花 18,000,000 micros，远超注入的 perGraph/perDay：第二个 turn 仍必须照常执行。
    const second = await runtime.runNode(
      request({ nodeId: 'n-no-limit-2', agentSessionId: 'sess-no-limit-2', graphId: 'g-no-limit', idempotencyKey: 'k-no-limit-2' }),
    )
    expect(second.status).toBe('completed')
    expect(driver.executions).toHaveLength(2)
    runtime.dispose()
  })

  it('startup sweep reclaims a residual group from the process self-registry (D5)', async () => {
    const driver = makeInstantDriver()
    const { runtime, repo } = setup(driver)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-registry-'))
    const previous = process.env[PROC_REGISTRY_DIR_ENV]
    process.env[PROC_REGISTRY_DIR_ENV] = dir
    try {
      const child = spawnChild()
      await waitFor(() => listProcesses().some((proc) => proc.pid === child.pid))
      const identity = new ProcessReaper().registerProcess('seed', { pid: child.pid! })!
      expect(identity.pgid, 'detached 子进程自成一组').toBe(child.pid)

      // 要求 3：记录 marker 必须能映射到 DB 中已知会话。
      const marker = `bizgraph-turn:registry-${Date.now()}`
      repo.insertSession({ executor: 'codex', executorEnvMarker: marker, status: 'active' })
      writeSignedRecord(marker, dir, identity)

      const report = await runtime.reconcileOnStartup()
      await waitFor(() => !alive(child.pid!))
      expect(report.registryKills, '必须从自注册文件回收').toBeGreaterThanOrEqual(1)
      expect(fs.existsSync(registryRecordPath(marker, dir)), '回收后删除台账').toBe(false)
    } finally {
      if (previous === undefined) delete process.env[PROC_REGISTRY_DIR_ENV]
      else process.env[PROC_REGISTRY_DIR_ENV] = previous
      fs.rmSync(dir, { recursive: true, force: true })
      runtime.dispose()
    }
  })

  it('startup sweep ignores registry records whose marker is unknown to the DB (C12)', async () => {
    const driver = makeInstantDriver()
    const { runtime } = setup(driver)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-registry-unknown-'))
    const previous = process.env[PROC_REGISTRY_DIR_ENV]
    process.env[PROC_REGISTRY_DIR_ENV] = dir
    try {
      const child = spawnChild()
      await waitFor(() => listProcesses().some((proc) => proc.pid === child.pid))
      const identity = new ProcessReaper().registerProcess('seed', { pid: child.pid! })!
      const marker = `bizgraph-turn:unknown-${Date.now()}`
      writeSignedRecord(marker, dir, identity)

      const report = await runtime.reconcileOnStartup()
      expect(report.registryKills, '未知 marker 不得参与回收').toBe(0)
      expect(alive(child.pid!), '目标进程必须存活').toBe(true)
      expect(fs.existsSync(registryRecordPath(marker, dir)), '未处理记录保留以便排查').toBe(true)
    } finally {
      if (previous === undefined) delete process.env[PROC_REGISTRY_DIR_ENV]
      else process.env[PROC_REGISTRY_DIR_ENV] = previous
      fs.rmSync(dir, { recursive: true, force: true })
      runtime.dispose()
    }
  })

  it('cancel reclaims a group recorded only in the self-registry (no in-memory handle)', async () => {
    const driver: BackendDriver = {
      name: 'codex',
      capabilities: CAPABILITIES,
      async execute(_req, context) {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { status: 'cancelled', completionSignal: 'backend-turn-completed' }
      },
      async cancel() {},
    }
    const { repo, runtime } = setup(driver)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-registry-cancel-'))
    const previous = process.env[PROC_REGISTRY_DIR_ENV]
    process.env[PROC_REGISTRY_DIR_ENV] = dir
    try {
      const child = spawnChild()
      await waitFor(() => listProcesses().some((proc) => proc.pid === child.pid))
      const identity = new ProcessReaper().registerProcess('seed', { pid: child.pid! })!

      const running = runtime.runNode(request({ nodeId: 'n-reg', agentSessionId: 'sess-reg', idempotencyKey: 'k-reg' }))
      const turn = await waitForTurn(repo, 'sess-reg:k-reg')
      const marker = `bizgraph-turn:${turn.id}`
      writeSignedRecord(marker, dir, identity)

      await runtime.cancelTurn(turn.id)
      await expect(running).resolves.toMatchObject({ status: 'cancelled' })
      await waitFor(() => !alive(child.pid!))
      expect(repo.getSession('sess-reg')?.executor_pid).toBeNull()
      const session = repo.getSession('sess-reg')
      expect(session?.recovery_kills, '取消路径计数必须等于实际回收次数').toBe(1)
      expect(session?.recovery_note).toBeTruthy()
      const audits = reclaimAudits(repo, turn.id)
      expect(audits, '取消路径必须恰好 1 条审计').toHaveLength(1)
      expect(audits[0].reason).toBe('cancel')
      expect(audits[0].method).toBe('pgid')
      expect(audits[0].pids).toContain(child.pid)
      expect(audits[0].pgids).toContain(child.pid)
      expect(audits[0].success).toBe(true)
      expect(audits[0].evidence.find((item) => item.pid === child.pid)?.matched.length).toBeGreaterThanOrEqual(2)
    } finally {
      if (previous === undefined) delete process.env[PROC_REGISTRY_DIR_ENV]
      else process.env[PROC_REGISTRY_DIR_ENV] = previous
      fs.rmSync(dir, { recursive: true, force: true })
      runtime.dispose()
    }
  })
})

/** 写入一份「像真实 shim 一样」的签名记录（0600 + nonce + HMAC）。 */
function writeSignedRecord(
  marker: string,
  dir: string,
  identity: { pid: number; pgid?: number; startedAt?: string; startedAtHiRes?: string; command?: string },
): void {
  const nonce = crypto.randomBytes(16).toString('hex')
  const base = {
    marker,
    pid: identity.pid,
    pgid: identity.pgid ?? identity.pid,
    startedAt: identity.startedAt ?? '',
    startedAtHiRes: identity.startedAtHiRes,
    command: identity.command ?? '',
    createdAt: Date.now(),
    nonce,
  }
  const sig = signProcRegistryRecord(base)
  fs.writeFileSync(registryRecordPath(marker, dir), JSON.stringify({ ...base, sig }), {
    mode: 0o600,
  })
}

async function waitForTurn(repo: AgentRepository, idempotencyKey: string): Promise<{ id: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const turn = repo.findTurnByIdempotencyKey(idempotencyKey)
    if (turn) return { id: turn.id }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('turn not created')
}
