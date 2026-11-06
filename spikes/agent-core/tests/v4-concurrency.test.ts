import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/db'
import { RunRepository } from '../src/db/repository'
import { SessionExecutor } from '../src/concurrency/session-executor'
import { SessionBusyError, NodeBusyError } from '../src/types'
import { normalizeClaude } from '../src/normalizer/claude'
import { normalizeCodex } from '../src/normalizer/codex'
import {
  assertContiguousSeq,
  assertOwnership,
  fixturePath,
  loadJson,
  loadJsonl,
  seedRun,
} from './helpers'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('V4 并发不串台', () => {
  it('同一 run 并发两个 turn：第二个立即 SESSION_BUSY，结束后可再次派发', async () => {
    const executor = new SessionExecutor()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))

    const first = executor.submit('run-lock', 'turn-a', async () => {
      await gate
      return 'first'
    })
    await expect(executor.submit('run-lock', 'turn-b', async () => 'second')).rejects.toBeInstanceOf(
      SessionBusyError,
    )
    release()
    await expect(first).resolves.toBe('first')
    await expect(executor.submit('run-lock', 'turn-c', async () => 'third')).resolves.toBe('third')
  })

  it('防重入：同一调用链里二次加锁不会死锁', async () => {
    const executor = new SessionExecutor()
    const started = Date.now()
    const result = await executor.submit('run-reentrant', 'turn-outer', async () => {
      return executor.submit('run-reentrant', 'turn-inner', async () => 'inner-ok')
    })
    expect(result).toBe('inner-ok')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('同一节点最多一个非终态 run：第二个返回 NODE_BUSY，第一个结束后才可再建', () => {
    const db: Db = openDb(':memory:')
    try {
      const repo = new RunRepository(db)
      seedRun(repo, { runId: 'run-node-1', nodeId: 'node-shared', status: 'running' })

      expect(() =>
        repo.createRun({
          id: 'run-node-2',
          threadId: 'thread-2',
          nodeId: 'node-shared',
          backend: 'claude-code',
          loopOwnership: 'backend',
          idempotencyKey: 'idem-node-2',
          status: 'created',
        }),
      ).toThrowError(NodeBusyError)

      repo.updateRunStatus('run-node-1', 'completed')
      const created = repo.createRun({
        id: 'run-node-3',
        threadId: 'thread-3',
        nodeId: 'node-shared',
        backend: 'claude-code',
        loopOwnership: 'backend',
        idempotencyKey: 'idem-node-3',
        status: 'created',
      })
      expect(created.created).toBe(true)
    } finally {
      db.close()
    }
  })

  it('两个 run 并发产生事件：归属零错误，各自 seq 连续', async () => {
    const db: Db = openDb(':memory:')
    try {
      const repo = new RunRepository(db)
      seedRun(repo, { runId: 'run-a', nodeId: 'node-a', backend: 'claude-code' })
      seedRun(repo, { runId: 'run-b', nodeId: 'node-b', backend: 'codex' })
      const executor = new SessionExecutor()

      const jobA = executor.submit('run-a', 'turn-a', async () => {
        await delay(5)
        return normalizeClaude(loadJsonl(fixturePath('claude', 'session-001.jsonl')), {
          runId: 'run-a',
          turnId: 'turn-a',
        })
      })
      const jobB = executor.submit('run-b', 'turn-b', async () => {
        await delay(1)
        return normalizeCodex(loadJson(fixturePath('codex', 'session-001.json')), {
          runId: 'run-b',
          turnId: 'turn-b',
        })
      })

      const [eventsA, eventsB] = await Promise.all([jobA, jobB])

      assertContiguousSeq(eventsA)
      assertContiguousSeq(eventsB)
      assertOwnership(eventsA, { runId: 'run-a', turnId: 'turn-a', backendName: 'claude-code' })
      assertOwnership(eventsB, { runId: 'run-b', turnId: 'turn-b', backendName: 'codex' })

      for (const event of eventsA) repo.appendEvent(event)
      for (const event of eventsB) repo.appendEvent(event)

      const persistedA = repo.listEvents('run-a')
      const persistedB = repo.listEvents('run-b')
      expect(persistedA).toHaveLength(eventsA.length)
      expect(persistedB).toHaveLength(eventsB.length)
      expect(persistedA.every((e) => e.runId === 'run-a')).toBe(true)
      expect(persistedB.every((e) => e.runId === 'run-b')).toBe(true)
      // 零串台：A 的 turnId 不出现在 B，反之亦然
      expect(persistedA.some((e) => e.turnId === 'turn-b')).toBe(false)
      expect(persistedB.some((e) => e.turnId === 'turn-a')).toBe(false)
    } finally {
      db.close()
    }
  })
})
