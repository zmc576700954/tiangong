/**
 * D8 回归：自由聊天（无节点、无 agent_turns）也必须走写前审批。
 *
 * 旧路径没有 turn 行，审批用可反解的 legacy 标识落 `agent_approvals`；
 * 这里验证落库、兑现、会话授权、归属校验与重启不可兑现。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalGateway } from '../approval/gateway'
import { AgentRepository } from '../db/repository'
import { legacyRunId, legacyTurnId, legacySessionIdOf } from '../approval/legacy-ids'
import { buildLegacyApprovalHooks } from '../approval/legacy-hooks'
import { AgentRuntimeError } from '../errors'
import { openTestDb } from './helpers/test-db'
import type { ApprovalRequestPayload, ApprovalResolutionPayload } from '@shared/types/agent-runtime'

function setup() {
  const db = openTestDb()
  const repo = new AgentRepository(db)
  const requests: ApprovalRequestPayload[] = []
  const resolved: ApprovalResolutionPayload[] = []
  const gateway = new ApprovalGateway({
    db,
    repo,
    notifier: {
      onRequest: (payload) => requests.push(payload),
      onResolved: (payload) => resolved.push(payload),
    },
  })
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-free-chat-'))
  return { db, repo, gateway, requests, resolved, cwd }
}

function legacyIds(sessionId: string): { runId: string; turnId: string } {
  return { runId: legacyRunId(sessionId), turnId: legacyTurnId(sessionId) }
}

describe('旧路径审批标识', () => {
  it('run/turn 前缀可反解出唯一 sessionId；不匹配则拒绝反解', () => {
    expect(legacySessionIdOf(legacyRunId('free-1'), legacyTurnId('free-1'))).toBe('free-1')
    expect(legacySessionIdOf(legacyRunId('a'), legacyTurnId('b'))).toBeUndefined()
    expect(legacySessionIdOf('run-1', legacyTurnId('free-1'))).toBeUndefined()
    expect(legacySessionIdOf(legacyRunId(''), legacyTurnId(''))).toBeUndefined()
  })
})

describe('buildLegacyApprovalHooks', () => {
  it('把 legacy 标识与 session 交给同一个网关；允许 → allow，拒绝 → deny（带原因）', async () => {
    const request = vi.fn(async () => ({
      approvalId: 'appr-1',
      decision: 'deny' as const,
      decidedBy: 'user' as const,
      argsHash: 'h',
      decidedAt: 1,
      reason: '用户拒绝写文件',
    }))
    const hooks = buildLegacyApprovalHooks({
      approvals: { request } as unknown as ApprovalGateway,
      sessionId: 'free-1',
      cwd: '/tmp',
    })

    const denied = await hooks.canUseTool!('Write', { file_path: '/tmp/a.ts' }, {} as never)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: legacyRunId('free-1'),
        turnId: legacyTurnId('free-1'),
        sessionId: 'free-1',
        cwd: '/tmp',
      }),
    )
    expect(denied).toMatchObject({ behavior: 'deny' })
    expect((denied as { message: string }).message).toContain('用户拒绝写文件')

    request.mockResolvedValueOnce({
      approvalId: 'appr-2',
      decision: 'allow',
      decidedBy: 'user',
      argsHash: 'h',
      decidedAt: 1,
    } as never)
    const allowed = await hooks.canUseTool!('Write', { file_path: '/tmp/a.ts' }, {} as never)
    expect(allowed).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/a.ts' } })
  })
})

describe('自由聊天（无 turn）审批走同一网关', () => {
  it('写类请求落 agent_approvals（legacy run/turn），批准后真正兑现', async () => {
    const { gateway, repo, requests, cwd } = setup()
    const sessionId = 'free-chat-1'
    const pending = gateway.request({
      ...legacyIds(sessionId),
      sessionId,
      toolName: 'Write',
      args: { file_path: path.join(cwd, 'a.txt'), content: 'x' },
      cwd,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      sessionId,
      turnId: legacyTurnId(sessionId),
      toolName: 'Write',
      sessionGrantable: true,
    })
    const row = repo.getApproval(requests[0].approvalId)!
    expect(row.run_id).toBe(legacyRunId(sessionId))
    expect(row.turn_id).toBe(legacyTurnId(sessionId))
    expect(row.status).toBe('pending')

    gateway.decide({
      approvalId: row.id,
      decision: 'allow',
      argsHash: row.args_hash,
      sessionId,
      turnId: legacyTurnId(sessionId),
    })
    await expect(pending).resolves.toMatchObject({ decision: 'allow', decidedBy: 'user' })
    expect(repo.getApproval(row.id)?.status).toBe('allowed')
    gateway.dispose()
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('会话授权语义不变：写类可建（后续同类写免弹），Bash 不可建', async () => {
    const { gateway, requests, cwd } = setup()
    const sessionId = 'free-chat-2'
    const first = gateway.request({
      ...legacyIds(sessionId),
      sessionId,
      toolName: 'Write',
      args: { file_path: path.join(cwd, 'a.txt') },
      cwd,
    })
    gateway.decide({
      approvalId: requests[0].approvalId,
      decision: 'allow',
      argsHash: requests[0].argsHash,
      scope: 'session',
      sessionId,
    })
    await first
    expect(gateway.listSessionGrants()).toHaveLength(1)

    const edit = await gateway.request({
      ...legacyIds(sessionId),
      sessionId,
      toolName: 'Edit',
      args: { file_path: path.join(cwd, 'b.txt') },
      cwd,
    })
    expect(requests).toHaveLength(1)
    expect(edit).toMatchObject({ decision: 'allow', autoGranted: true })

    // 清空授权后，Bash 仍只能逐次允许，且不会建立写类授权
    gateway.endSession(sessionId)
    const bash = gateway.request({
      ...legacyIds(sessionId),
      sessionId,
      toolName: 'Bash',
      args: { command: 'ls' },
      cwd,
    })
    expect(requests).toHaveLength(2)
    expect(requests[1].sessionGrantable).toBe(false)
    gateway.decide({
      approvalId: requests[1].approvalId,
      decision: 'allow',
      argsHash: requests[1].argsHash,
      scope: 'session',
      sessionId,
    })
    await bash
    expect(gateway.listSessionGrants()).toHaveLength(0)
    gateway.dispose()
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('endSession 立即失效 legacy 会话授权', async () => {
    const { gateway, requests, cwd } = setup()
    const sessionId = 'free-chat-3'
    const first = gateway.request({
      ...legacyIds(sessionId),
      sessionId,
      toolName: 'Write',
      args: { file_path: path.join(cwd, 'a.txt') },
      cwd,
    })
    gateway.decide({
      approvalId: requests[0].approvalId,
      decision: 'allow',
      argsHash: requests[0].argsHash,
      scope: 'session',
      sessionId,
    })
    await first
    expect(gateway.listSessionGrants()).toHaveLength(1)

    gateway.endSession(sessionId)
    const again = gateway.request({
      ...legacyIds(sessionId),
      sessionId,
      toolName: 'Write',
      args: { file_path: path.join(cwd, 'a.txt') },
      cwd,
    })
    expect(requests).toHaveLength(2)
    gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
    await again
    gateway.dispose()
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('归属校验按 legacy 标识反解：别的会话不能替它下单', async () => {
    const { gateway, repo, requests, cwd } = setup()
    const sessionId = 'free-chat-4'
    const pending = gateway.request({
      ...legacyIds(sessionId),
      sessionId,
      toolName: 'Write',
      args: { file_path: path.join(cwd, 'a.txt') },
      cwd,
    })
    pending.catch(() => undefined)

    let err: unknown
    try {
      gateway.decide({
        approvalId: requests[0].approvalId,
        decision: 'allow',
        argsHash: requests[0].argsHash,
        sessionId: 'other-session',
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AgentRuntimeError)
    expect((err as AgentRuntimeError).code).toBe('APPROVAL_NOT_OWNED')
    expect(repo.getApproval(requests[0].approvalId)?.status).toBe('pending')

    gateway.decide({
      approvalId: requests[0].approvalId,
      decision: 'deny',
      argsHash: requests[0].argsHash,
      sessionId,
    })
    await expect(pending).resolves.toMatchObject({ decision: 'deny' })
    gateway.dispose()
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('重启后残留的 legacy pending 不可兑现 → startup 对账 deny（不静默写 allowed）', async () => {
    const { db, repo, cwd } = setup()
    const sessionId = 'free-chat-5'
    const firstGateway = new ApprovalGateway({ db, repo })
    const pending = firstGateway.request({
      ...legacyIds(sessionId),
      sessionId,
      toolName: 'Write',
      args: { file_path: path.join(cwd, 'a.txt') },
      cwd,
    })
    pending.catch(() => undefined)
    const approvalId = repo.listPendingApprovals()[0].id
    firstGateway.dispose()

    const restarted = new ApprovalGateway({ db, repo })
    const result = restarted.reconcileStartup()
    expect(result.denied).toBe(1)
    expect(result.replayed).toHaveLength(0)
    const row = repo.getApproval(approvalId)!
    expect(row.status).toBe('denied')
    expect(row.decided_by).toBe('startup')
    restarted.dispose()
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})
