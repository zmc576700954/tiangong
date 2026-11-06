/**
 * C17：异常退出路径回收契约（D5 后补测，真实 AgentRuntime + 真实进程树）。
 *
 * 契约：
 *   C17-a driver 抛错（spawn 后异常）→ 本轮已登记句柄与其进程组必须被回收，
 *         且不得对另一会话 B 发任何信号；
 *   C17-b 正常完成（未抛错）→ 不得触发任何回收（反向对照，防「完成也 reap」回归）；
 *   C17-c residual_risk / recovery_note 必须按实际残留如实落库。
 *
 * 说明：这里直接构造真实 `AgentRuntime` + 真实 `better-sqlite3`（:memory:），
 * driver 内部 spawn 真实探针进程树并调用公开的 `context.registerProcess`；
 * 不使用 mock 状态字段。唯一非生产点是 B 会话用「阻塞 driver」模拟并发会话。
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentRuntime } from '../../../src/main/agent/runtime/runtime'
import { AgentRepository } from '../../../src/main/agent/runtime/db/repository'
import { openTestDb } from '../../../src/main/agent/runtime/__tests__/helpers/test-db'
import { PROC_REGISTRY_DIR_ENV } from '../../../src/main/shared/process-supervisor'
import type {
  BackendDriver,
  DriverCapabilities,
  DriverExecuteResult,
  RunNodeRequest,
} from '@shared/types/agent-runtime'
import { spawnProbe, killTrees, recordEvidence, waitDead, waitMs, type ProbeTree } from '../src/harness'
import { alive, killTap } from '../src/kill-tap'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const ORIGINAL_CWD = process.cwd()
const ORIGINAL_REGISTRY_DIR = process.env[PROC_REGISTRY_DIR_ENV]
let TEMP_REGISTRY_DIR = ''

beforeAll(() => {
  killTap.install()
  // 让 runtime 的 removeProcRegistryRecord 落在独立临时目录
  TEMP_REGISTRY_DIR = mkdtempSync(join(tmpdir(), 'bizgraph-c17-registry-'))
  process.env[PROC_REGISTRY_DIR_ENV] = TEMP_REGISTRY_DIR
  // openTestDb 的 ABI 回退路径基于 process.cwd()：切到仓库根，找到 spikes/agent-core 副本
  process.chdir(REPO_ROOT)
})

afterAll(() => {
  killTap.dispose()
  process.chdir(ORIGINAL_CWD)
  if (ORIGINAL_REGISTRY_DIR === undefined) delete process.env[PROC_REGISTRY_DIR_ENV]
  else process.env[PROC_REGISTRY_DIR_ENV] = ORIGINAL_REGISTRY_DIR
  rmSync(TEMP_REGISTRY_DIR, { recursive: true, force: true })
})

const CAPABILITIES: DriverCapabilities = {
  toolEvents: 'exact',
  toolArgs: 'raw',
  toolLifecycle: 'exact',
  approval: 'pre-exec',
  fileChanges: 'hook',
  usage: 'turn-aggregate',
  completion: 'backend-turn-completed',
}

type Mode = 'spawn-throw' | 'auth-fail' | 'normal' | 'block'

interface ProcessDriver extends BackendDriver {
  trees: ProbeTree[]
  turnIds: Map<string, string>
}

function makeDriver(mode: Mode): ProcessDriver {
  const trees: ProbeTree[] = []
  const turnIds = new Map<string, string>()
  return {
    name: 'claude',
    capabilities: CAPABILITIES,
    trees,
    turnIds,
    async execute(request, context) {
      turnIds.set(request.prompt, request.turnId)
      if (mode === 'auth-fail') {
        throw new Error('authorization failed: 401 invalid api key')
      }
      const tree = await spawnProbe(`C17.${mode}.${request.prompt}`, {
        children: 'long',
        detached: true,
      })
      trees.push(tree)
      // 真实登记本轮句柄（pid + 自有进程组）
      context.registerProcess({ pid: tree.ownerPid, pgid: tree.ownerPid })

      if (mode === 'spawn-throw') {
        throw new Error('driver crashed after spawn')
      }
      if (mode === 'normal') {
        return {
          status: 'completed',
          finalText: 'done',
          completionSignal: 'backend-turn-completed',
        } satisfies DriverExecuteResult
      }
      // block：等待取消
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

function request(
  agentSessionId: string,
  nodeId: string,
  prompt: string,
  executor: string,
): RunNodeRequest {
  return {
    executor,
    prompt,
    workingDirectory: REPO_ROOT,
    nodeId,
    agentSessionId,
  }
}

function signalsTo(pid: number) {
  return killTap.sends().filter((call) => call.pid === pid || call.pid === -pid)
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await waitMs(20)
  }
  throw new Error(`timeout waiting for ${label}`)
}

function setup() {
  const db = openTestDb()
  const repo = new AgentRepository(db)
  const runtime = new AgentRuntime({ db, repo })
  return { db, repo, runtime }
}

it('C17-a driver 异常退出：回收本轮进程组，且不波及并发会话 B', async () => {
  const { repo, runtime } = setup()
  const throwDriver = makeDriver('spawn-throw')
  const blockDriver = makeDriver('block')
  runtime.registerDriver('claude-code', throwDriver)
  runtime.registerDriver('codex-cli', blockDriver)

  let bOutcomePromise: Promise<unknown> | undefined
  try {
    // 先启动 B 会话（真实长驻进程 + 真实登记）
    bOutcomePromise = runtime.runNode(request('sess-B', 'node-B', 'B', 'codex-cli'))
    await waitFor(() => blockDriver.trees.length === 1, 5000, 'B driver spawn')
    const bTree = blockDriver.trees[0]
    const bLong = bTree.pidOf(`${bTree.label}.long`)!

    killTap.reset()
    killTap.start()
    try {
      const aOutcome = await runtime.runNode(request('sess-A', 'node-A', 'A', 'claude-code'))
      expect(aOutcome.status).toBe('failed')

      const aTree = throwDriver.trees[0]
      const aLong = aTree.pidOf(`${aTree.label}.long`)!
      const aOwnerDead = await waitDead(aTree.ownerPid, 4000)
      const aLongDead = await waitDead(aLong, 4000)

      const aSignals = signalsTo(aTree.ownerPid)
      const bSignals = [...signalsTo(bTree.ownerPid), ...signalsTo(bLong), ...signalsTo(bTree.ownerPid)]
      const bOwnerAlive = alive(bTree.ownerPid)
      const bLongAlive = alive(bLong)
      const recovery = repo.getSessionRecovery('sess-A')

      recordEvidence('C17a', {
        abnormal: 'driver throw after spawn',
        aOwnerPid: aTree.ownerPid,
        aLongPid: aLong,
        aOwnerDead,
        aLongDead,
        aSignals,
        bOwnerPid: bTree.ownerPid,
        bLongPid: bLong,
        bSignals,
        bOwnerAlive,
        bLongAlive,
        residualRisk: recovery?.residualRisk,
        recoveryNote: recovery?.recoveryNote,
        recoveryKills: recovery?.recoveryKills,
        note: '真实 AgentRuntime finally 路径；B 会话并发存活',
      })

      expect(aOwnerDead, '本轮组长必须死亡').toBe(true)
      expect(aLongDead, '本轮后代必须随组回收').toBe(true)
      expect(aSignals.length, '本轮应有回收信号').toBeGreaterThan(0)
      expect(bSignals, '不得对 B 会话发任何信号').toHaveLength(0)
      expect(bOwnerAlive, 'B 会话组长必须存活').toBe(true)
      expect(bLongAlive, 'B 会话后代必须存活').toBe(true)
      // 残留为 0：residual_risk=none 如实；kills 未落 note（见 README 观察项）
      expect(recovery?.residualRisk).toBe('none')
    } finally {
      killTap.stop()
    }
  } finally {
    // 清理 B：取消会走 cancelled 路径回收 B 自己
    const bTurnId = blockDriver.turnIds.get('B')
    if (bTurnId) await runtime.cancelTurn(bTurnId, 'test-cleanup')
    if (bOutcomePromise) await bOutcomePromise.catch(() => undefined)
    await killTrees(...throwDriver.trees, ...blockDriver.trees)
    runtime.dispose()
  }
})

it('C17-b 授权/初始化失败（未 spawn）：无句柄可回收，但必须如实标记 unconfirmed', async () => {
  const { repo, runtime } = setup()
  const driver = makeDriver('auth-fail')
  runtime.registerDriver('claude-code', driver)
  try {
    killTap.reset()
    killTap.start()
    try {
      const outcome = await runtime.runNode(request('sess-AUTH', 'node-AUTH', 'AUTH', 'claude-code'))
      expect(outcome.status).toBe('failed')
      const recovery = repo.getSessionRecovery('sess-AUTH')
      recordEvidence('C17b', {
        abnormal: 'auth failure before spawn',
        disposed: 0,
        kills: 0,
        residualRisk: recovery?.residualRisk,
        recoveryNote: recovery?.recoveryNote,
        recoveryKills: recovery?.recoveryKills,
        note: '无句柄路径按 §6.5 标 unconfirmed（无法排除 SDK 隐式子进程）',
      })
      expect(recovery?.residualRisk).toBe('unconfirmed')
      expect(recovery?.recoveryNote).toBeTruthy()
      expect(recovery?.recoveryNote ?? '').toContain('killed=0')
    } finally {
      killTap.stop()
    }
  } finally {
    runtime.dispose()
  }
})

it('C17-c 正常完成（未抛错）：不得触发回收（反向对照）', async () => {
  const { repo, runtime } = setup()
  const driver = makeDriver('normal')
  runtime.registerDriver('claude-code', driver)
  try {
    killTap.reset()
    killTap.start()
    try {
      const outcome = await runtime.runNode(request('sess-OK', 'node-OK', 'OK', 'claude-code'))
      expect(outcome.status).toBe('completed')
      const tree = driver.trees[0]
      const longPid = tree.pidOf(`${tree.label}.long`)!
      const signals = [...signalsTo(tree.ownerPid), ...signalsTo(longPid)]
      const recovery = repo.getSessionRecovery('sess-OK')
      recordEvidence('C17c', {
        normalCompletion: true,
        ownerPid: tree.ownerPid,
        longPid,
        signals,
        ownerAlive: alive(tree.ownerPid),
        longAlive: alive(longPid),
        residualRisk: recovery?.residualRisk,
        recoveryNote: recovery?.recoveryNote,
        note: '正常完成只 forget；进程由适配器/OS 收尾',
      })
      expect(signals, '正常完成不得向任何进程发信号').toHaveLength(0)
      expect(alive(tree.ownerPid), '正常完成后组长仍应存活').toBe(true)
      expect(alive(longPid), '正常完成后后代仍应存活').toBe(true)
      expect(recovery?.residualRisk).toBe('none')
      expect(recovery?.recoveryNote).toBeNull()
    } finally {
      killTap.stop()
    }
  } finally {
    await killTrees(...driver.trees)
    runtime.dispose()
  }
})
