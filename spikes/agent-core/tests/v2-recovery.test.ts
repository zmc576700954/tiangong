import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, openExistingDb, type Db } from '../src/db/db'
import { RunRepository } from '../src/db/repository'
import { assertNoDangling, dispositionOf, planRecovery, sweepInterrupted } from '../src/recovery/planner'
import {
  assertContiguousSeq,
  makeEnvelope,
  seedRun,
  SPIKE_ROOT,
} from './helpers'

const CHILD = path.join(SPIKE_ROOT, 'src', 'recovery', 'crash-child.cjs')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTemp(): { dir: string; dbPath: string; workspace: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-core-crash-'))
  tempDirs.push(dir)
  return { dir, dbPath: path.join(dir, 'state.db'), workspace: path.join(dir, 'ws') }
}

async function runCrashChild(mode: string, dbPath: string, workspace: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, mode, dbPath, workspace], {
      cwd: SPIKE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('exit', (code, signal) => {
      if (signal === 'SIGKILL' || code === null) return resolve()
      reject(new Error(`crash child exited unexpectedly code=${code} stderr=${stderr}`))
    })
    child.on('error', reject)
  })
}

function recover(mode: string) {
  const { dir, dbPath, workspace } = makeTemp()
  return runCrashChild(mode, dbPath, workspace).then(() => {
    const db = openExistingDb(dbPath)
    const repo = new RunRepository(db)
    const sweep = sweepInterrupted(db)
    const plans = planRecovery(db, workspace)
    return { db, repo, sweep, plans, dir, workspace }
  })
}

describe('V2 崩溃恢复对账', () => {
  it('写前审批通过但写还没落地时被杀：step 必须判 unknown，不允许标 completed', async () => {
    const { db, repo, sweep, plans, workspace } = await recover('approval-not-landed')
    try {
      expect(sweep.runsMarkedInterrupted).toBe(1)
      expect(sweep.stepsMarkedUnknown).toBeGreaterThanOrEqual(1)
      expect(() => assertNoDangling(db)).not.toThrow()

      const plan = plans.find((p) => p.runId === 'run-crash-1')!
      expect(plan).toBeDefined()
      expect(plan.strategy).toBe('replay')
      expect(plan.requiresUserConfirmation).toBe(true)
      expect(dispositionOf(plan, 'step-1')).toBe('completed')
      expect(dispositionOf(plan, 'step-2')).toBe('unknown-needs-rerun')
      expect(plan.reason).toContain('重放')

      // 审批已 allow，但磁盘仍是原内容：不能把「批准」等同于「已执行」
      const approval = repo.getApproval('approval-crash-1')!
      expect(approval.decision).toBe('allow')
      expect(approval.resolvedBy).toBe('user')
      expect(readFileSync(path.join(workspace, 'math.ts'), 'utf8')).toContain('a - b')

      assertContiguousSeq(repo.listEvents('run-crash-1'))
    } finally {
      db.close()
    }
  })

  it('写已落地且 hash 对账一致：step 可判 completed，可 native resume', async () => {
    const { db, repo, sweep, plans, workspace } = await recover('approval-landed')
    try {
      expect(sweep.runsMarkedInterrupted).toBe(1)
      expect(() => assertNoDangling(db)).not.toThrow()
      const plan = plans.find((p) => p.runId === 'run-crash-1')!
      expect(dispositionOf(plan, 'step-2')).toBe('completed')
      expect(plan.strategy).toBe('resume-native')
      expect(repo.getRun('run-crash-1')!.backend_session_id).toBe('claude-session-crash-1')
      expect(readFileSync(path.join(workspace, 'math.ts'), 'utf8')).toContain('a + b')
      assertContiguousSeq(repo.listEvents('run-crash-1'))
    } finally {
      db.close()
    }
  })

  it('写后记录与磁盘 hash 不一致：必须转人工（abandon），不得静默重跑', async () => {
    const { db, plans, workspace } = await recover('approval-mismatch')
    try {
      const plan = plans.find((p) => p.runId === 'run-crash-1')!
      expect(dispositionOf(plan, 'step-2')).toBe('needs-human')
      expect(plan.strategy).toBe('abandon')
      expect(plan.reason).toContain('人工')
      // 磁盘内容与 afterHash 确实不一致
      expect(readFileSync(path.join(workspace, 'math.ts'), 'utf8')).not.toContain('a + b')
    } finally {
      db.close()
    }
  })

  it('RecoveryPlan 是确定的：连续调用两次结果完全一致', async () => {
    const { db, plans, workspace } = await recover('approval-not-landed')
    try {
      expect(planRecovery(db, workspace)).toEqual(plans)
    } finally {
      db.close()
    }
  })

  it('事件日志 seq 校验：断号写入必须抛 EVENT_LOG_CORRUPT', () => {
    const db: Db = openDb(':memory:')
    try {
      const repo = new RunRepository(db)
      seedRun(repo, { runId: 'run-seq', nodeId: 'node-seq' })
      repo.appendEvent(
        makeEnvelope({ runId: 'run-seq', turnId: 'turn-seq', seq: 1, type: 'run.started' }),
      )
      expect(() =>
        repo.appendEvent(
          makeEnvelope({ runId: 'run-seq', turnId: 'turn-seq', seq: 3, type: 'run.completed' }),
        ),
      ).toThrowError(/EVENT_LOG_CORRUPT/)
      repo.appendEvent(
        makeEnvelope({ runId: 'run-seq', turnId: 'turn-seq', seq: 2, type: 'run.completed' }),
      )
      assertContiguousSeq(repo.listEvents('run-seq'))
    } finally {
      db.close()
    }
  })
})
