/**
 * W5-A 定向：启动恢复执行层。
 *
 * 验收点：
 * - 只处理可证明归属者；无法证明时 kill 调用数必须为 0（显式断言）；
 * - 复用 planRecovery/applyRecoveryPlan/assertNoDangling；
 * - 启动报告落库（startup.reconcile）；
 * - 真实子进程 SIGKILL 后重启，不留悬空 running。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import type { NormalizedEventEnvelope } from '@shared/types/agent-runtime'
import type { ProcInfo, ReapReport } from '../process/reaper'
import { assertNoDangling } from '../recovery/planner'
import { AgentRepository } from '../db/repository'
import { StartupReconciler } from '../startup-reconciler'
import {
  NODE_SQLITE_FALLBACK,
  buildChildEntry,
  makeTempDir,
  waitForExit,
  waitForStdout,
} from './helpers/cross-process'
import { openTestDb } from './helpers/test-db'

const SCHEMA_MODULE = path.resolve(process.cwd(), 'src/main/agent/runtime/db/schema.ts')
const REPOSITORY_MODULE = path.resolve(process.cwd(), 'src/main/agent/runtime/db/repository.ts')

function emptyReport(overrides: Partial<ReapReport> = {}): ReapReport {
  return {
    discovered: 0,
    killed: 0,
    killedPids: [],
    killedGroups: [],
    unresolved: [],
    missing: [],
    stillAlive: [],
    evidence: [],
    ...overrides,
  }
}

function seedRunningTurn(repo: AgentRepository): void {
  repo.insertRun({ id: 'run-1', threadId: 'thread-1', nodeId: 'node-1', executor: 'fake', status: 'running' })
  repo.insertSession({
    id: 'sess-1',
    graphId: 'graph-1',
    nodeId: 'node-1',
    threadId: 'thread-1',
    executor: 'fake',
    runtimeSessionId: 'adapter-1',
    status: 'active',
  })
  repo.insertTurn({
    id: 'turn-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    nodeId: 'node-1',
    status: 'running',
    resumeMode: 'fresh',
    idempotencyKey: 'idem-1',
    input: { prompt: 'hello' },
  })
  repo.updateSessionProcess('sess-1', { envMarker: 'bizgraph-turn:turn-1' })
}

describe('StartupReconciler (in-memory)', () => {
  let db: BetterSqlite3.Database
  let repo: AgentRepository

  beforeEach(() => {
    db = openTestDb()
    repo = new AgentRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('never kills when ownership cannot be proven (killCalls = 0)', () => {
    seedRunningTurn(repo)
    // 只有裸 pid：没有 command / startedAt，marker 也不在实时命令行里。
    repo.updateSessionProcess('sess-1', { pid: 424242, pgid: 424242, startedAt: null, command: null })

    const killCalls: unknown[][] = []
    const events: NormalizedEventEnvelope[] = []
    const live: ProcInfo[] = [
      { pid: 424242, ppid: 1, pgid: 424242, state: 'S', startedAt: 'Nov 9 10:00:00 2026', command: 'node unrelated.js' },
    ]
    const reconciler = new StartupReconciler({
      repo,
      reaper: {
        killRegistered: (...args: unknown[]) => {
          killCalls.push(args)
          return emptyReport()
        },
      } as never,
      listProcesses: () => live,
      listRegistryRecords: () => [],
      eventSink: (batch) => events.push(...batch),
    })

    const result = reconciler.reconcile()

    expect(result.killCalls).toBe(0)
    expect(killCalls).toHaveLength(0)
    const session = repo.getSession('sess-1')!
    expect(session.residual_risk).toBe('unconfirmed')
    expect(session.executor_pid).toBeNull()
    expect(events.some((event) => event.type === 'process.reclaimed')).toBe(true)
    expect(() => assertNoDangling(repo)).not.toThrow()
  })

  it('Codex 旧路径无句柄无 marker：residual_risk 可见为 unconfirmed 且 kill 调用数=0', () => {
    // 旧路径不写 env marker、也不登记真实句柄：重启后无法证明残留归属。
    repo.insertSession({
      id: 'sess-codex-legacy',
      executor: 'codex',
      status: 'orphaned',
      runtimeSessionId: 'adapter-legacy',
    })

    const killCalls: unknown[][] = []
    let registryReads = 0
    const reconciler = new StartupReconciler({
      repo,
      reaper: {
        killRegistered: (...args: unknown[]) => {
          killCalls.push(args)
          return emptyReport()
        },
      } as never,
      listProcesses: () => [],
      listRegistryRecords: () => {
        registryReads += 1
        return []
      },
      eventSink: () => {},
    })

    const result = reconciler.reconcile()

    expect(result.killCalls).toBe(0)
    expect(killCalls).toHaveLength(0)
    expect(registryReads).toBeGreaterThan(0)
    const session = repo.getSession('sess-codex-legacy')!
    // 关键：不能因为查不到 pid 就报 none，旧路径残留必须可见
    expect(session.residual_risk).toBe('unconfirmed')
    expect(session.recovery_kills).toBe(0)
  })

  it('kills exactly once when pid + command + startedAt prove ownership', () => {
    seedRunningTurn(repo)
    repo.updateSessionProcess('sess-1', {
      pid: 424242,
      pgid: 424242,
      command: 'node /opt/app/worker.js',
      startedAt: 'Nov 9 10:00:00 2026',
    })

    const calls: unknown[][] = []
    const events: NormalizedEventEnvelope[] = []
    const live: ProcInfo[] = [
      {
        pid: 424242,
        ppid: 1,
        pgid: 424242,
        state: 'S',
        startedAt: 'Nov 9 10:00:00 2026',
        command: 'node /opt/app/worker.js',
      },
    ]
    const report = emptyReport({
      discovered: 1,
      killed: 1,
      killedPids: [424242],
      evidence: [{ pid: 424242, matched: ['startedAt', 'command'] }],
    })
    const reconciler = new StartupReconciler({
      repo,
      reaper: {
        killRegistered: (...args: unknown[]) => {
          calls.push(args)
          return report
        },
      } as never,
      listProcesses: () => live,
      listRegistryRecords: () => [],
      eventSink: (batch) => events.push(...batch),
    })

    const result = reconciler.reconcile()

    expect(result.killCalls).toBe(1)
    expect(calls).toHaveLength(1)
    expect(repo.getSession('sess-1')!.residual_risk).toBe('none')
    const audit = events.find((event) => event.type === 'process.reclaimed')
    expect(audit?.payload.success).toBe(true)
    expect(() => assertNoDangling(repo)).not.toThrow()
  })

  it('refuses registry records without proof (killCalls = 0)', () => {
    seedRunningTurn(repo)
    repo.updateSessionProcess('sess-1', { envMarker: 'bizgraph-turn:turn-1' })

    const killCalls: unknown[][] = []
    const events: NormalizedEventEnvelope[] = []
    const reconciler = new StartupReconciler({
      repo,
      reaper: {
        killRegistered: (...args: unknown[]) => {
          killCalls.push(args)
          return emptyReport()
        },
      } as never,
      listProcesses: () => [
        { pid: 555, ppid: 1, pgid: 555, state: 'S', startedAt: 'Nov 9 10:00:00 2026', command: 'node other.js' },
      ],
      listRegistryRecords: () => [
        {
          marker: 'bizgraph-turn:turn-1',
          pid: 555,
          pgid: 555,
          startedAt: 'Nov 9 10:00:01 2026',
          command: 'node other.js',
          createdAt: Date.now(),
        },
      ],
      verifyRegistryRecord: () => true,
      removeRegistryRecord: () => undefined,
      eventSink: (batch) => events.push(...batch),
    })

    const result = reconciler.reconcile()
    expect(result.killCalls).toBe(0)
    expect(killCalls).toHaveLength(0)
    expect(events.some((event) => event.type === 'process.reclaimed')).toBe(true)
    expect(() => assertNoDangling(repo)).not.toThrow()
  })

  it('persists the startup report as a startup.reconcile system event', () => {
    seedRunningTurn(repo)
    // 默认 eventSink = repo.appendEvents → 直接验证落库，而不是只看内存 spy。
    const reconciler = new StartupReconciler({
      repo,
      reaper: { killRegistered: () => emptyReport() } as never,
      listProcesses: () => [],
      listRegistryRecords: () => [],
    })
    const result = reconciler.reconcile()
    reconciler.persistReport({ ...result, killCalls: result.killCalls })

    const row = db
      .prepare("SELECT run_id, turn_id, seq, payload_json FROM agent_events WHERE type = 'startup.reconcile'")
      .get() as { run_id: string; turn_id: string; seq: number; payload_json: string } | undefined
    expect(row).toBeDefined()
    expect(row!.run_id).toMatch(/^system:startup:/)
    expect(row!.turn_id).toBe(row!.run_id)
    expect(row!.seq).toBe(1)
    const payload = JSON.parse(row!.payload_json) as Record<string, unknown>
    expect(payload.abortedTurns).toBe(result.abortedTurns)
    expect(payload.killCalls).toBe(0)
    expect(payload.planCount).toBe(result.plans.length)
  })
})

describe('StartupReconciler (real SIGKILL restart)', () => {
  let workDir = ''
  let childEntry = ''
  let dbPath = ''

  beforeAll(() => {
    workDir = makeTempDir('w5-crash-')
    dbPath = path.join(workDir, 'crash.db')
    childEntry = buildChildEntry(
      'crash-writer',
      `
import { createRequire } from 'node:module'
import { applyAgentSchema } from ${JSON.stringify(SCHEMA_MODULE)}
import { AgentRepository } from ${JSON.stringify(REPOSITORY_MODULE)}

const req = createRequire(__filename)
const Database = req(process.env.BETTER_SQLITE_PATH)
const db = new Database(process.env.W5_DB_PATH)
applyAgentSchema(db)
const repo = new AgentRepository(db)
const now = Date.now()
repo.insertRun({ id: 'run-crash', threadId: 'thread-crash', nodeId: 'node-crash', executor: 'fake', status: 'running', now })
repo.insertSession({
  id: 'sess-crash',
  graphId: 'graph-crash',
  nodeId: 'node-crash',
  threadId: 'thread-crash',
  executor: 'fake',
  runtimeSessionId: 'adapter-crash',
  status: 'active',
  now,
})
const turn = repo.insertTurn({
  id: 'turn-crash',
  runId: 'run-crash',
  sessionId: 'sess-crash',
  nodeId: 'node-crash',
  status: 'running',
  resumeMode: 'fresh',
  idempotencyKey: 'idem-crash',
  input: { prompt: 'crash me' },
})
repo.updateSessionProcess('sess-crash', { pid: process.pid, envMarker: 'bizgraph-turn:' + turn.id }, now)
console.log('READY ' + process.pid)
setInterval(() => {}, 1000)
`,
      workDir,
    )
  })

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('leaves no dangling running turn after a real SIGKILL restart', async () => {
    const child = spawn(process.execPath, [childEntry], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BETTER_SQLITE_PATH: NODE_SQLITE_FALLBACK,
        W5_DB_PATH: dbPath,
      },
    })
    const output = await waitForStdout(child, /READY (\d+)/)
    expect(Number(output.match(/READY (\d+)/)![1])).toBe(child.pid)

    child.kill('SIGKILL')
    await waitForExit(child)

    // 「重启」：新进程/新连接打开同一个 DB 文件，跑执行层对账。
    const db = openTestDb(false, dbPath)
    try {
      const repo = new AgentRepository(db)
      // 子进程已被 SIGKILL，实时进程表必然查不到它 → 证据 not-found，不调用 kill。
      const killCalls: unknown[][] = []
      const reconciler = new StartupReconciler({
        repo,
        reaper: {
          killRegistered: (...args: unknown[]) => {
            killCalls.push(args)
            return emptyReport()
          },
        } as never,
        listProcesses: () => [],
        listRegistryRecords: () => [],
      })

      const result = reconciler.reconcile()
      expect(result.killCalls).toBe(0)
      expect(killCalls).toHaveLength(0)
      expect(repo.listAllNonTerminalTurns()).toHaveLength(0)
      expect(repo.getSession('sess-crash')!.status).toBe('orphaned')
      expect(repo.getTurn('turn-crash')!.status).toBe('orphaned')
      expect(() => assertNoDangling(repo)).not.toThrow()
    } finally {
      db.close()
    }
  })
})
