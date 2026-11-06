import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/db'
import { RunRepository } from '../src/db/repository'
import { ApprovalGateway } from '../src/approval/gateway'
import { seedRun, seedRunEvents } from './helpers'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(filePath = ':memory:'): {
  db: Db
  repo: RunRepository
  gateway: ApprovalGateway
  runId: string
} {
  const db = openDb(filePath)
  const repo = new RunRepository(db)
  seedRun(repo, { runId: 'run-ap', nodeId: 'node-ap', status: 'running' })
  seedRunEvents(repo, { runId: 'run-ap', turnId: 'turn-ap' })
  const gateway = new ApprovalGateway(repo, 60_000)
  return { db, repo, gateway, runId: 'run-ap' }
}

/** 打开已存在的库，不重复 seed（重启场景） */
function reopen(filePath: string): {
  db: Db
  repo: RunRepository
  gateway: ApprovalGateway
} {
  const db = openDb(filePath)
  const repo = new RunRepository(db)
  return { db, repo, gateway: new ApprovalGateway(repo, 60_000) }
}

const baseRequest = {
  approvalId: 'approval-1',
  runId: 'run-ap',
  turnId: 'turn-ap',
  toolCallId: 'call-run-ap',
  toolName: 'Write',
  input: { path: 'src/math.ts', content: 'fixed' },
  risk: 'high' as const,
}

function countEvents(repo: RunRepository, type: string): number {
  return repo.listEvents('run-ap').filter((e) => e.type === type).length
}

describe('V7 fail-closed 审批', () => {
  it('重复决定幂等：第二次返回首次 allow，不覆盖、不重记、不重复执行', async () => {
    const { db, repo, gateway } = setup()
    try {
      gateway.request({ ...baseRequest, timeoutMs: 60_000 })

      let executions = 0
      const first = await gateway.decideAndExecute('approval-1', 'allow', async () => {
        executions += 1
        return 'written'
      })
      expect(first.executed).toBe(true)

      const second = await gateway.decideAndExecute('approval-1', 'deny', async () => {
        executions += 1
        return 'should-not-run'
      })
      expect(second.result.idempotent).toBe(true)
      expect(second.result.decision).toBe('allow')
      expect(second.executed).toBe(false)
      expect(executions).toBe(1)

      const row = repo.getApproval('approval-1')!
      expect(row.decision).toBe('allow')
      expect(row.resolvedBy).toBe('user')
      expect(countEvents(repo, 'tool.approved')).toBe(1)
      expect(countEvents(repo, 'tool.denied')).toBe(0)
    } finally {
      gateway.close()
      db.close()
    }
  })

  it('超时默认拒绝：迟到的 allow 不得执行，且拒绝事件已落库', async () => {
    const { db, repo, gateway } = setup()
    try {
      const { waitForDecision } = gateway.request({ ...baseRequest, approvalId: 'approval-timeout', timeoutMs: 30 })
      const timedOut = await waitForDecision
      expect(timedOut.decision).toBe('deny')
      expect(timedOut.resolvedBy).toBe('timeout')

      let executions = 0
      const late = await gateway.decideAndExecute('approval-timeout', 'allow', async () => {
        executions += 1
      })
      expect(late.result.idempotent).toBe(true)
      expect(late.result.decision).toBe('deny')
      expect(late.executed).toBe(false)
      expect(executions).toBe(0)

      expect(repo.getApproval('approval-timeout')!.decision).toBe('deny')
      expect(repo.getApproval('approval-timeout')!.resolvedBy).toBe('timeout')
      expect(countEvents(repo, 'tool.denied')).toBe(1)
      expect(countEvents(repo, 'tool.approved')).toBe(0)
    } finally {
      gateway.close()
      db.close()
    }
  })

  it('拒绝后不得执行：deny 决定下 execute 永不调用', async () => {
    const { db, repo, gateway } = setup()
    try {
      gateway.request({ ...baseRequest, approvalId: 'approval-deny', timeoutMs: 60_000 })
      let executions = 0
      const result = await gateway.decideAndExecute('approval-deny', 'deny', async () => {
        executions += 1
      })
      expect(result.result.decision).toBe('deny')
      expect(result.executed).toBe(false)
      expect(executions).toBe(0)
      expect(countEvents(repo, 'tool.denied')).toBe(1)
      expect(countEvents(repo, 'tool.approved')).toBe(0)
    } finally {
      gateway.close()
      db.close()
    }
  })

  it('重启后未决审批可重放且不自动批准；用户决定与事件同事务落库', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-core-approval-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'state.db')

    let first = setup(filePath)
    first.gateway.request({ ...baseRequest, approvalId: 'approval-restart', timeoutMs: 60_000 })
    first.gateway.close()
    first.db.close()

    const reopened = reopen(filePath)
    try {
      const pending = reopened.gateway.replayPending('run-ap')
      expect(pending).toHaveLength(1)
      expect(pending[0].decision).toBeNull()
      expect(countEvents(reopened.repo, 'tool.approved')).toBe(0)
      expect(countEvents(reopened.repo, 'tool.denied')).toBe(0)

      let executions = 0
      const decided = await reopened.gateway.decideAndExecute('approval-restart', 'allow', async () => {
        executions += 1
      })
      expect(decided.executed).toBe(true)
      expect(executions).toBe(1)

      // 没有「已批准但未记录」：DB 决定与 tool.approved 事件同时存在
      expect(reopened.repo.getApproval('approval-restart')!.decision).toBe('allow')
      expect(countEvents(reopened.repo, 'tool.approved')).toBe(1)
    } finally {
      reopened.gateway.close()
      reopened.db.close()
    }
  })

  it('重启时审批已过期：迟到决定按 deny 处理，不执行、留痕', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-core-approval-expired-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'state.db')

    const db = openDb(filePath)
    try {
      const repo = new RunRepository(db)
      seedRun(repo, { runId: 'run-ap', nodeId: 'node-ap', status: 'awaiting_approval' })
      seedRunEvents(repo, { runId: 'run-ap', turnId: 'turn-ap' })
      const gateway = new ApprovalGateway(repo, 60_000)
      gateway.request({
        ...baseRequest,
        approvalId: 'approval-expired',
        timeoutMs: 0,
        expiresAt: Date.now() - 1_000,
      })
      gateway.close()

      const restartedGateway = new ApprovalGateway(repo, 60_000)
      let executions = 0
      const late = await restartedGateway.decideAndExecute('approval-expired', 'allow', async () => {
        executions += 1
      })
      expect(late.result.decision).toBe('deny')
      expect(late.result.resolvedBy).toBe('timeout')
      expect(late.executed).toBe(false)
      expect(executions).toBe(0)
      expect(repo.getApproval('approval-expired')!.decision).toBe('deny')
      expect(countEvents(repo, 'tool.denied')).toBe(1)
      expect(countEvents(repo, 'tool.approved')).toBe(0)
      restartedGateway.close()
    } finally {
      db.close()
    }
  })
})
