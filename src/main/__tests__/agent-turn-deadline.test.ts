/**
 * F3-A：deadline 写入、到期收口与启动对账单测。
 *
 * 不依赖 better-sqlite3：用 mock repo/reaper 驱动 AgentRuntime，重点验证
 *  - insertTurn 把 deadlineMs 落成 deadline_at = now + deadlineMs（0/undefined 不启用）
 *  - expireTimedOutTurn 走专用 CAS：failed + failure_class='timeout' +
 *    DEADLINE_EXCEEDED，不复用 cancelTurn
 *  - 非 running / 未到期 / 终态 turn 拒门
 *  - 启动对账把已过期 running turn 标 failed/'timeout'/DEADLINE_EXPIRED_ON_RESTART
 */

import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../agent/runtime/runtime'
import { AgentRepository, type AgentTurnRow } from '../agent/runtime/db/repository'
import { openTestDb } from '../agent/runtime/__tests__/helpers/test-db'

const NOW = 1_700_000_000_000

function createRuntime() {
  const repo = {
    insertTurn: vi.fn((input: Record<string, unknown>) => ({ id: 'turn-1', ...input })),
    getTurn: vi.fn<(id: string) => AgentTurnRow | undefined>(),
    finalizeTurnStatus: vi.fn(() => true),
    abortOpenSteps: vi.fn(),
    projectRunStatus: vi.fn(),
    listExpiredRunningTurns: vi.fn(() => [] as AgentTurnRow[]),
  }
  const reaper = {
    reap: vi.fn(() => ({
      killedPids: [],
      killedGroups: [],
      missing: [],
      unresolved: [],
      discovered: 0,
    })),
  }
  const runtime = new AgentRuntime({
    db: {} as never,
    repo: repo as never,
    reaper: reaper as never,
    retention: { enabled: false },
    now: () => NOW,
  })
  return { runtime, repo, reaper }
}

function turn(overrides: Partial<AgentTurnRow> = {}): AgentTurnRow {
  return {
    id: 'turn-1',
    run_id: 'run-1',
    session_id: 'sess-1',
    status: 'running',
    deadline_at: NOW - 1,
    ...overrides,
  } as AgentTurnRow
}

describe('F3-A：deadline 写入方', () => {
  it('insertTurn 落 deadline_at = now + deadlineMs', () => {
    const { runtime, repo } = createRuntime()

    ;(runtime as any).insertTurn(
      'run-1',
      'sess-1',
      { prompt: 'p', deadlineMs: 60_000 } as never,
      '',
      1,
      'fresh',
      'key',
      {} as never,
    )

    expect(repo.insertTurn).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineAt: NOW + 60_000 }),
    )
  })

  it('deadlineMs undefined / 0 不启用（落 NULL）', () => {
    const { runtime, repo } = createRuntime()

    ;(runtime as any).insertTurn(
      'run-1',
      'sess-1',
      { prompt: 'p' } as never,
      '',
      1,
      'fresh',
      'key',
      {} as never,
    )
    ;(runtime as any).insertTurn(
      'run-1',
      'sess-1',
      { prompt: 'p', deadlineMs: 0 } as never,
      '',
      1,
      'fresh',
      'key',
      {} as never,
    )

    expect(repo.insertTurn.mock.calls[0][0]).toEqual(expect.objectContaining({ deadlineAt: undefined }))
    expect(repo.insertTurn.mock.calls[1][0]).toEqual(expect.objectContaining({ deadlineAt: undefined }))
  })
})

describe('F3-A：expireTimedOutTurn', () => {
  it('已过期 running turn → failed/timeout/DEADLINE_EXCEEDED，不复用 cancelled', async () => {
    const { runtime, repo } = createRuntime()
    repo.getTurn.mockReturnValue(turn())

    const applied = await runtime.expireTimedOutTurn('turn-1')

    expect(applied).toBe(true)
    expect(repo.finalizeTurnStatus).toHaveBeenCalledWith(
      'turn-1',
      'failed',
      expect.objectContaining({
        failureClass: 'timeout',
        errorCode: 'DEADLINE_EXCEEDED',
      }),
      NOW,
    )
    expect(repo.abortOpenSteps).toHaveBeenCalledWith('turn-1', NOW)
    expect(repo.projectRunStatus).toHaveBeenCalledWith('run-1', NOW)
  })

  it('未到期的 turn 不处理', async () => {
    const { runtime, repo } = createRuntime()
    repo.getTurn.mockReturnValue(turn({ deadline_at: NOW + 60_000 }))

    expect(await runtime.expireTimedOutTurn('turn-1')).toBe(false)
    expect(repo.finalizeTurnStatus).not.toHaveBeenCalled()
  })

  it('waiting_approval / 终态 / deadline 为空 一律拒门', async () => {
    const { runtime, repo } = createRuntime()

    for (const row of [
      turn({ status: 'waiting_approval' }),
      turn({ status: 'failed' }),
      turn({ deadline_at: null }),
      turn({ deadline_at: 0 }),
    ]) {
      repo.getTurn.mockReturnValue(row)
      expect(await runtime.expireTimedOutTurn('turn-1')).toBe(false)
    }
    expect(repo.finalizeTurnStatus).not.toHaveBeenCalled()
  })

  it('CAS 被完成/取消抢先时返回 false，不执行后续收口', async () => {
    const { runtime, repo } = createRuntime()
    repo.getTurn.mockReturnValue(turn())
    repo.finalizeTurnStatus.mockReturnValueOnce(false)

    expect(await runtime.expireTimedOutTurn('turn-1')).toBe(false)
    expect(repo.abortOpenSteps).not.toHaveBeenCalled()
    expect(repo.projectRunStatus).not.toHaveBeenCalled()
  })
})

describe('F3-A：repo 扫描与终态 CAS（真库）', () => {
  function insertTurn(
    repo: AgentRepository,
    id: string,
    status: AgentTurnRow['status'],
    deadlineAt: number | undefined,
  ) {
    repo.insertTurn({
      id,
      runId: 'run-1',
      sessionId: 'sess-1',
      nodeId: id,
      status,
      deadlineAt,
      resumeMode: 'fresh',
      idempotencyKey: id,
      input: {},
    })
  }

  it('listExpiredRunningTurns 只返回 running 且 deadline 已过期的 turn', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)

    insertTurn(repo, 'expired', 'running', NOW - 1)
    insertTurn(repo, 'future', 'running', NOW + 60_000)
    insertTurn(repo, 'approval', 'waiting_approval', NOW - 1)
    insertTurn(repo, 'no-deadline', 'running', undefined)
    insertTurn(repo, 'zero-deadline', 'running', 0)

    expect(repo.listExpiredRunningTurns(NOW).map((t) => t.id)).toEqual(['expired'])
    db.close()
  })

  it('终态 CAS 唯一：cancelTurn 先写 cancelled 后，超时的 failed 写不进去', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    insertTurn(repo, 'turn-1', 'running', NOW - 1)

    // cancelTurn 的路径：finalizeTurnStatus('cancelled')
    expect(repo.finalizeTurnStatus('turn-1', 'cancelled', { endedAt: NOW }, NOW)).toBe(true)
    // 超时收口再走 failed：第二次 CAS 返回 false（这正是不能复用 cancelTurn 的原因）
    expect(
      repo.finalizeTurnStatus(
        'turn-1',
        'failed',
        { endedAt: NOW, failureClass: 'timeout', errorCode: 'DEADLINE_EXCEEDED' },
        NOW,
      ),
    ).toBe(false)
    expect(repo.getTurn('turn-1')!.status).toBe('cancelled')
    db.close()
  })
})

describe('F3-A：启动对账处置已过期 deadline', () => {
  it('已过期 running turn 标 failed/timeout/DEADLINE_EXPIRED_ON_RESTART，不续跑', () => {
    const { runtime, repo } = createRuntime()
    repo.listExpiredRunningTurns.mockReturnValue([
      turn({ id: 't1', run_id: 'r1' }),
      turn({ id: 't2', run_id: 'r2' }),
    ])
    repo.finalizeTurnStatus
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)

    const applied = (runtime as any).expireOverdueTurnsOnStartup() as number

    expect(applied).toBe(1)
    expect(repo.finalizeTurnStatus).toHaveBeenNthCalledWith(
      1,
      't1',
      'failed',
      expect.objectContaining({
        failureClass: 'timeout',
        errorCode: 'DEADLINE_EXPIRED_ON_RESTART',
      }),
      NOW,
    )
    expect(repo.abortOpenSteps).toHaveBeenCalledTimes(1)
    expect(repo.abortOpenSteps).toHaveBeenCalledWith('t1', NOW)
    expect(repo.projectRunStatus).toHaveBeenCalledWith('r1', NOW)
    // 不续跑：启动路径只落终态，不调用 runNode / driver。
    expect(repo.insertTurn).not.toHaveBeenCalled()
  })
})
