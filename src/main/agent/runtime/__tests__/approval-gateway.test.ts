/**
 * D4 验收：审批写前拦截、argsHash 匹配、幂等、超时、重启重放。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApprovalGateway, INTERACTIVE_TIMEOUT_MS, UNATTENDED_TIMEOUT_MS, classifyToolRisk, isPathInside } from '../approval/gateway'
import { AgentRepository } from '../db/repository'
import { AgentRuntimeError } from '../errors'
import { openTestDb } from './helpers/test-db'
import type { ApprovalRequestPayload, ApprovalResolutionPayload } from '@shared/types/agent-runtime'

function setup(options?: { interactive?: number; unattended?: number }) {
  const db = openTestDb()
  const repo = new AgentRepository(db)
  const run = repo.insertRun({ threadId: 't', nodeId: 'n', graphId: 'g', executor: 'claude-code' })
  const session = repo.insertSession({ id: 's1', executor: 'claude-code', status: 'active', workspacePath: '/tmp' })
  const turn = repo.insertTurn({
    runId: run.id,
    sessionId: session.id,
    nodeId: 'n',
    resumeMode: 'native',
    idempotencyKey: `k-${run.id}`,
    input: {},
  })
  const requests: ApprovalRequestPayload[] = []
  const resolved: ApprovalResolutionPayload[] = []
  const gateway = new ApprovalGateway({
    db,
    repo,
    interactiveTimeoutMs: options?.interactive,
    unattendedTimeoutMs: options?.unattended,
    notifier: {
      onRequest: (payload) => requests.push(payload),
      onResolved: (payload) => resolved.push(payload),
    },
  })
  return { db, repo, run, turn, session, gateway, requests, resolved }
}

describe('ApprovalGateway (D4)', () => {
  it('exposes the fixed timeouts (interactive 120s / unattended 30s)', () => {
    expect(INTERACTIVE_TIMEOUT_MS).toBe(120_000)
    expect(UNATTENDED_TIMEOUT_MS).toBe(30_000)
  })

  it('blocks the caller until an allow decision, then resolves', async () => {
    const { gateway, run, turn, requests, resolved } = setup()
    const pending = gateway.request({
      runId: run.id,
      turnId: turn.id,
      stepId: 'step-1',
      toolName: 'Write',
      args: { path: 'a.txt', content: 'x' },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].argsHash).toHaveLength(64)

    const outcome = gateway.decide({ approvalId: requests[0].approvalId, decision: 'allow', argsHash: requests[0].argsHash })
    expect(outcome.decision).toBe('allow')
    expect(outcome.decidedBy).toBe('user')
    await expect(pending).resolves.toMatchObject({ decision: 'allow' })
    expect(resolved).toHaveLength(1)
  })

  it('rejects a decision whose argsHash does not match (TOCTOU)', async () => {
    const { gateway, run, turn, requests } = setup()
    const pending = gateway.request({ runId: run.id, turnId: turn.id, toolName: 'Write', args: { path: 'a.txt' } })
    pending.catch(() => undefined)

    expect(() =>
      gateway.decide({ approvalId: requests[0].approvalId, decision: 'allow', argsHash: 'deadbeef' }),
    ).toThrow(/APPROVAL_ARGS_MISMATCH/)

    // 原请求仍处于 pending，正确 hash 仍可决策
    expect(gateway.decide({ approvalId: requests[0].approvalId, decision: 'deny', argsHash: requests[0].argsHash }).decision).toBe('deny')
    await expect(pending).resolves.toMatchObject({ decision: 'deny' })
  })

  it('is idempotent for repeated decisions (no duplicate resolved event)', async () => {
    const { gateway, run, turn, requests, resolved } = setup()
    const pending = gateway.request({ runId: run.id, turnId: turn.id, toolName: 'Read', args: { path: 'a' } })
    gateway.decide({ approvalId: requests[0].approvalId, decision: 'allow', argsHash: requests[0].argsHash })
    await pending

    const second = gateway.decide({ approvalId: requests[0].approvalId, decision: 'deny', argsHash: requests[0].argsHash })
    expect(second.decision).toBe('allow')
    expect(second.decidedBy).toBe('user')
    expect(resolved).toHaveLength(1)
  })

  it('Bash 审批卡片携带命中规则与按规则的风险等级', async () => {
    const { gateway, run, turn, requests } = setup()
    const pipe = gateway.request({
      runId: run.id,
      turnId: turn.id,
      stepId: 'step-pipe',
      toolName: 'Bash',
      args: { command: 'cat a | tee b' },
    })
    pipe.catch(() => undefined)
    const sudo = gateway.request({
      runId: run.id,
      turnId: turn.id,
      stepId: 'step-sudo',
      toolName: 'Bash',
      args: { command: 'sudo rm -rf /tmp/x' },
    })
    sudo.catch(() => undefined)

    // 不是笼统的「高风险」：规则名 + 按规则给的风险等级都要能在卡片上看到
    expect(requests[0]).toMatchObject({ policyRule: 'pipe', risk: 'high' })
    expect(requests[0].policyReason).toContain('shell 元字符')
    expect(requests[0].argsJson).toContain('tee b')
    expect(requests[1]).toMatchObject({ policyRule: 'shell-escape:sudo', risk: 'critical' })

    gateway.decide({ approvalId: requests[0].approvalId, decision: 'deny', argsHash: requests[0].argsHash })
    gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
    await Promise.all([pipe, sudo])
  })

  it('times out to denied + decided_by=timeout', async () => {
    const { gateway, repo, run, turn, requests } = setup({ interactive: 25 })
    const pending = gateway.request({ runId: run.id, turnId: turn.id, toolName: 'Bash', args: { command: 'rm -rf /tmp/x' } })
    const outcome = await pending

    expect(outcome.decision).toBe('deny')
    expect(outcome.decidedBy).toBe('timeout')
    expect(repo.getApproval(requests[0].approvalId)?.decided_by).toBe('timeout')
    expect(requests[0].risk).toBe('critical')
  })

  it('re-emits pending approvals after restart and re-arms timeout', async () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const run = repo.insertRun({ threadId: 't', nodeId: 'n', executor: 'claude-code' })
    const turn = repo.insertTurn({
      runId: run.id,
      sessionId: 's1',
      nodeId: 'n',
      resumeMode: 'native',
      idempotencyKey: 'k-restart',
      input: {},
    })
    let clock = 1_760_000_000_000
    const firstGateway = new ApprovalGateway({ db, repo, interactiveTimeoutMs: 10_000, now: () => clock })
    const pending = firstGateway.request({ runId: run.id, turnId: turn.id, toolName: 'Write', args: { path: 'a' } })
    pending.catch(() => undefined)
    firstGateway.dispose()

    const list = repo.listPendingApprovals()
    expect(list).toHaveLength(1)

    // 模拟"重启发生在一段时间后"：重启时点相对原请求已过去 5s
    clock += 5_000
    const requests: ApprovalRequestPayload[] = []
    const secondGateway = new ApprovalGateway({
      db,
      repo,
      interactiveTimeoutMs: 10_000,
      now: () => clock,
      notifier: { onRequest: (payload) => requests.push(payload), onResolved: () => undefined },
    })
    const replayed = secondGateway.reconcileStartup().replayed
    expect(replayed).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect(requests[0].expiresAt).toBeGreaterThan(list[0].expires_at)
    // 重启不自动放行：仍是 pending
    expect(repo.getApproval(list[0].id)?.status).toBe('pending')
    secondGateway.dispose()
  })

  it('sweeps expired pending rows to denied/timeout', () => {
    const { gateway, repo, run, turn } = setup()
    repo.insertApproval({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Write',
      argsJson: '{}',
      argsHash: 'h',
      risk: 'high',
      policyDecision: 'ask',
      expiresAt: Date.now() - 10,
      mode: 'unattended',
      timeoutMs: 30_000,
    })
    expect(gateway.sweepExpired()).toBe(1)
    const rows = repo.listApprovalsByTurn(turn.id)
    expect(rows[0].status).toBe('denied')
    expect(rows[0].decided_by).toBe('timeout')
    gateway.dispose()
  })

  it('A2: 「允许本次会话」后同会话同类写操作自动放行，但落库保留 grant_source', async () => {
    const { gateway, repo, run, turn, requests } = setup()
    const cwd = '/tmp/bizgraph-session'
    const first = gateway.request({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Write',
      args: { file_path: `${cwd}/a.txt` },
      cwd,
      sessionId: 's1',
    })
    expect(requests).toHaveLength(1)

    const outcome = gateway.decide({
      approvalId: requests[0].approvalId,
      decision: 'allow',
      argsHash: requests[0].argsHash,
      scope: 'session',
    })
    await first
    expect(outcome.sessionGranted).toBe(true)
    expect(gateway.listSessionGrants()).toEqual([
      {
        sessionId: 's1',
        approvalId: requests[0].approvalId,
        grantedAt: expect.any(Number),
        toolName: 'Write',
        toolScope: 'write',
        cwd,
      },
    ])

    const second = await gateway.request({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Edit',
      args: { file_path: `${cwd}/b.txt` },
      cwd,
      sessionId: 's1',
    })
    // 不再弹窗
    expect(requests).toHaveLength(1)
    expect(second.decision).toBe('allow')
    expect(second.autoGranted).toBe(true)
    expect(second.grantSourceApprovalId).toBe(requests[0].approvalId)

    const row = repo.getApproval(second.approvalId)!
    expect(row.grant_source).toBe(requests[0].approvalId)
    expect(row.status).toBe('allowed')

    // 授权后仍可手动撤销
    expect(gateway.revokeSessionGrant('s1')).toBe(true)
    const third = gateway.request({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Write',
      args: { file_path: `${cwd}/c.txt` },
      cwd,
      sessionId: 's1',
    })
    expect(requests).toHaveLength(2)
    gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
    await third
    gateway.dispose()
  })

  it('A2: 会话级授权不覆盖目录外路径、Bash、或其他会话', async () => {
    const { gateway, run, turn, requests } = setup()
    const cwd = '/tmp/bizgraph-session'
    const first = gateway.request({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Write',
      args: { file_path: `${cwd}/a.txt` },
      cwd,
      sessionId: 's1',
    })
    gateway.decide({ approvalId: requests[0].approvalId, decision: 'allow', argsHash: requests[0].argsHash, scope: 'session' })
    await first

    const outside = gateway.request({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Write',
      args: { file_path: '/tmp/other/d.txt' },
      cwd,
      sessionId: 's1',
    })
    const bash = gateway.request({ runId: run.id, turnId: turn.id, toolName: 'Bash', args: { command: 'ls' }, cwd, sessionId: 's1' })
    const otherSession = gateway.request({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Edit',
      args: { file_path: `${cwd}/e.txt` },
      cwd,
      sessionId: 's2',
    })
    // 三个都必须继续弹窗
    expect(requests).toHaveLength(4)
    for (const payload of requests.slice(1)) {
      gateway.decide({ approvalId: payload.approvalId, decision: 'deny', argsHash: payload.argsHash })
    }
    await Promise.all([outside, bash, otherSession])
    gateway.dispose()
  })

  it('A2: 工作目录存在 symlink 别名（如 /tmp → /private/tmp）时仍能命中授权', async () => {
    const { gateway, run, turn, requests } = setup()
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-grant-'))
    const aliasDir = `${realDir}-alias`
    fs.symlinkSync(realDir, aliasDir)
    try {
      const first = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(realDir, 'a.txt') },
        cwd: aliasDir,
        sessionId: 's1',
      })
      gateway.decide({
        approvalId: requests[0].approvalId,
        decision: 'allow',
        argsHash: requests[0].argsHash,
        scope: 'session',
      })
      await first

      // 目标路径是真实路径，授权里存的是别名路径：realpath 归一后必须命中
      const second = await gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(realDir, 'b.txt') },
        cwd: aliasDir,
        sessionId: 's1',
      })
      expect(requests).toHaveLength(1)
      expect(second.autoGranted).toBe(true)
      expect(second.grantSourceApprovalId).toBe(requests[0].approvalId)
    } finally {
      fs.rmSync(aliasDir, { force: true })
      fs.rmSync(realDir, { recursive: true, force: true })
      gateway.dispose()
    }
  })

  it('A2: session 结束即失效，重启不继承（新网关无授权）', async () => {
    const { db, repo, run, turn, gateway, requests } = setup()
    const cwd = '/tmp/bizgraph-session'
    const first = gateway.request({ runId: run.id, turnId: turn.id, toolName: 'Write', args: { file_path: `${cwd}/a.txt` }, cwd, sessionId: 's1' })
    gateway.decide({ approvalId: requests[0].approvalId, decision: 'allow', argsHash: requests[0].argsHash, scope: 'session' })
    await first
    expect(gateway.endSession('s1')).toBe(true)
    expect(gateway.listSessionGrants()).toHaveLength(0)

    const restarted = new ApprovalGateway({ db, repo })
    expect(restarted.listSessionGrants()).toHaveLength(0)
    expect(restarted.peekSessionGrant({ sessionId: 's1', toolName: 'Write', args: { file_path: `${cwd}/b.txt` } })).toBeNull()
    gateway.dispose()
    restarted.dispose()
  })

  it('A2: 审批 payload 携带 timeoutMs 供 UI 首帧 clamp', async () => {
    const { gateway, run, turn, requests } = setup({ interactive: 4000 })
    const pending = gateway.request({ runId: run.id, turnId: turn.id, toolName: 'Write', args: { file_path: '/tmp/a' } })
    expect(requests[0].timeoutMs).toBe(4000)
    gateway.decide({ approvalId: requests[0].approvalId, decision: 'deny', argsHash: requests[0].argsHash })
    await pending
    gateway.dispose()
  })

  it('classifies tool risk conservatively', () => {
    expect(classifyToolRisk('Bash', { command: 'ls' })).toBe('critical')
    expect(classifyToolRisk('Write', { path: 'a' })).toBe('high')
    expect(classifyToolRisk('Read', { path: 'a' })).toBe('low')
    expect(classifyToolRisk('WebFetch', { url: 'https://example.com' })).toBe('medium')
  })
})

/**
 * P0-1：会话级授权不能退化成「批一次 = 任意写」。
 * 下列用例在修复前会因「只校验首次的工具与路径」而静默放行。
 */
describe('ApprovalGateway 会话级授权每次重校验（P0-1）', () => {
  function grantDirs(): { ws: string; outside: string; cleanup: () => void } {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-ws-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-out-'))
    return {
      ws,
      outside,
      cleanup: () => {
        fs.rmSync(ws, { recursive: true, force: true })
        fs.rmSync(outside, { recursive: true, force: true })
      },
    }
  }

  async function establishSessionGrant(
    gateway: ReturnType<typeof setup>['gateway'],
    run: ReturnType<typeof setup>['run'],
    turn: ReturnType<typeof setup>['turn'],
    requests: ReturnType<typeof setup>['requests'],
    cwd: string,
  ): Promise<void> {
    const first = gateway.request({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Write',
      args: { file_path: path.join(cwd, 'a.txt') },
      cwd,
      sessionId: 's1',
    })
    expect(requests).toHaveLength(1)
    gateway.decide({ approvalId: requests[0].approvalId, decision: 'allow', argsHash: requests[0].argsHash, scope: 'session' })
    await first
  }

  function grantMissEvents(repo: ReturnType<typeof setup>['repo'], turnId: string) {
    return repo.listTurnEvents(turnId).filter((event) => event.type === 'approval.grant_miss')
  }

  it('批过一次合法写后，写工作区外路径必须重新弹窗（修复前静默放行）', async () => {
    const { gateway, repo, run, turn, requests } = setup()
    const { ws, outside, cleanup } = grantDirs()
    try {
      await establishSessionGrant(gateway, run, turn, requests, ws)

      const pending = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(outside, 'evil.txt') },
        cwd: ws,
        sessionId: 's1',
      })
      // 回归守卫：旧实现只校验单个路径，但工作区外的绝对路径本来就会重新弹窗。
      // 真正修复前会失败的是后面的 symlink / 多路径 / 会话失效用例。
      expect(requests).toHaveLength(2)
      gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
      await pending

      const events = grantMissEvents(repo, turn.id)
      expect(events).toHaveLength(1)
      expect(events[0].payload).toMatchObject({ reason: 'path', toolName: 'Write' })
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('工作区内 symlink 指向外部目录时重新弹窗（中间目录 symlink 逃逸）', async () => {
    const { gateway, repo, run, turn, requests } = setup()
    const { ws, outside, cleanup } = grantDirs()
    fs.symlinkSync(outside, path.join(ws, 'escape'), 'dir')
    try {
      await establishSessionGrant(gateway, run, turn, requests, ws)

      const pending = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(ws, 'escape', 'evil.txt') },
        cwd: ws,
        sessionId: 's1',
      })
      // 修复前会失败：旧实现把「root 内但尚不存在」的目标按词法映射回 root，
      // 中间目录是 symlink 时会把外部目录误判为工作区内 → 静默放行。
      expect(requests).toHaveLength(2)
      gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
      await pending

      expect(grantMissEvents(repo, turn.id)[0].payload).toMatchObject({ reason: 'path' })
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('一次调用带多个路径、其中一个是工作区外 → 重新弹窗', async () => {
    const { gateway, repo, run, turn, requests } = setup()
    const { ws, outside, cleanup } = grantDirs()
    try {
      await establishSessionGrant(gateway, run, turn, requests, ws)

      const pending = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: {
          file_path: path.join(ws, 'ok.txt'),
          paths: [path.join(ws, 'also-ok.txt'), path.join(outside, 'evil.txt')],
        },
        cwd: ws,
        sessionId: 's1',
      })
      // 修复前会失败：旧实现只取第一个路径（file_path 在工作区内）→ 静默放行。
      expect(requests).toHaveLength(2)
      gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
      await pending
      expect(grantMissEvents(repo, turn.id)[0].payload).toMatchObject({ reason: 'path' })
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('授权后删除工作区内文件（写类）仍命中，不弹窗', async () => {
    const { gateway, run, turn, requests } = setup()
    const { ws, cleanup } = grantDirs()
    try {
      await establishSessionGrant(gateway, run, turn, requests, ws)

      const outcome = await gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Delete',
        args: { file_path: path.join(ws, 'old.txt') },
        cwd: ws,
        sessionId: 's1',
      })
      expect(requests).toHaveLength(1)
      expect(outcome).toMatchObject({ decision: 'allow', autoGranted: true })
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('撤销授权后重新弹窗，并留下 revoked 审计事件', async () => {
    const { gateway, repo, run, turn, requests } = setup()
    const { ws, cleanup } = grantDirs()
    try {
      await establishSessionGrant(gateway, run, turn, requests, ws)
      expect(gateway.revokeSessionGrant('s1')).toBe(true)

      const pending = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(ws, 'b.txt') },
        cwd: ws,
        sessionId: 's1',
      })
      expect(requests).toHaveLength(2)
      gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
      await pending
      expect(grantMissEvents(repo, turn.id)[0].payload).toMatchObject({ reason: 'revoked' })
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('会话已关闭后授权失效：重新弹窗并记录 session 原因', async () => {
    const { gateway, repo, run, turn, requests } = setup()
    const { ws, cleanup } = grantDirs()
    try {
      await establishSessionGrant(gateway, run, turn, requests, ws)
      repo.updateSessionStatus('s1', 'closed')

      const pending = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(ws, 'c.txt') },
        cwd: ws,
        sessionId: 's1',
      })
      expect(requests).toHaveLength(2)
      gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
      await pending
      expect(grantMissEvents(repo, turn.id)[0].payload).toMatchObject({ reason: 'session' })
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('Bash 在授权后仍需弹窗（回归），并记录 tool 原因', async () => {
    const { gateway, repo, run, turn, requests } = setup()
    const { ws, cleanup } = grantDirs()
    try {
      await establishSessionGrant(gateway, run, turn, requests, ws)

      const pending = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Bash',
        args: { command: 'cat a.txt' },
        cwd: ws,
        sessionId: 's1',
      })
      expect(requests).toHaveLength(2)
      gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
      await pending
      expect(grantMissEvents(repo, turn.id)[0].payload).toMatchObject({ reason: 'tool', toolName: 'Bash' })
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('大小写变体不绕过作用域（macOS 大小写不敏感）', () => {
    if (process.platform !== 'darwin') return
    expect(isPathInside('/tmp/BizGraph-Ws', '/tmp/bizgraph-ws/a.txt')).toBe(true)
    expect(isPathInside('/tmp/BizGraph-Ws', '/tmp/bizgraph-ws-other/a.txt')).toBe(false)
  })
})

/**
 * 阻断项：会话授权必须与被批准的工具类型绑定。
 *
 * 修复前：在 Bash 卡片上点「允许本次会话」会建立 toolScope='write' 的授权，
 * 之后工作区内 Write/Edit 全部免审——用户批的是「跑这条命令」，拿到的是「随便改文件」。
 */
describe('ApprovalGateway 会话授权与工具类型绑定（阻断项）', () => {
  function workspace(): { ws: string; cleanup: () => void } {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-scope-'))
    return { ws, cleanup: () => fs.rmSync(ws, { recursive: true, force: true }) }
  }

  it('Bash 批准「本会话」后：工作区内 Write 必须仍然弹窗，且未建立任何写类授权', async () => {
    const { gateway, run, turn, requests } = setup()
    const { ws, cleanup } = workspace()
    try {
      const bash = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Bash',
        args: { command: 'npm test' },
        cwd: ws,
        sessionId: 's1',
      })
      // 修复前：Bash 卡片的 payload 没有 sessionGrantable，UI 会显示「允许本次会话」
      expect(requests[0].sessionGrantable).toBe(false)
      gateway.decide({
        approvalId: requests[0].approvalId,
        decision: 'allow',
        argsHash: requests[0].argsHash,
        scope: 'session',
      })
      await bash

      // 修复前会失败：这里已经有一条 toolScope='write' 的授权
      expect(gateway.listSessionGrants()).toHaveLength(0)

      const write = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(ws, 'pwn.txt'), content: 'x' },
        cwd: ws,
        sessionId: 's1',
      })
      // 修复前会失败：requests 长度仍是 1（被静默放行）
      expect(requests).toHaveLength(2)
      expect(requests[1].toolName).toBe('Write')
      gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
      await write
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('Write 批准「本会话」后：同工作区 Write 免弹（回归），但 Bash 仍弹', async () => {
    const { gateway, run, turn, requests } = setup()
    const { ws, cleanup } = workspace()
    try {
      const write = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(ws, 'a.txt'), content: 'x' },
        cwd: ws,
        sessionId: 's1',
      })
      expect(requests[0].sessionGrantable).toBe(true)
      gateway.decide({
        approvalId: requests[0].approvalId,
        decision: 'allow',
        argsHash: requests[0].argsHash,
        scope: 'session',
      })
      await write

      const edit = await gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Edit',
        args: { file_path: path.join(ws, 'b.txt') },
        cwd: ws,
        sessionId: 's1',
      })
      expect(requests).toHaveLength(1)
      expect(edit.autoGranted).toBe(true)

      const bash = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Bash',
        args: { command: 'rm -rf .' },
        cwd: ws,
        sessionId: 's1',
      })
      expect(requests).toHaveLength(2)
      gateway.decide({ approvalId: requests[1].approvalId, decision: 'deny', argsHash: requests[1].argsHash })
      await bash
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('撤销后 Write 与 Bash 都恢复弹窗', async () => {
    const { gateway, run, turn, requests } = setup()
    const { ws, cleanup } = workspace()
    try {
      const write = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(ws, 'a.txt') },
        cwd: ws,
        sessionId: 's1',
      })
      gateway.decide({
        approvalId: requests[0].approvalId,
        decision: 'allow',
        argsHash: requests[0].argsHash,
        scope: 'session',
      })
      await write
      expect(gateway.revokeSessionGrant('s1')).toBe(true)

      const writeAgain = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Write',
        args: { file_path: path.join(ws, 'b.txt') },
        cwd: ws,
        sessionId: 's1',
      })
      const bash = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Bash',
        args: { command: 'ls' },
        cwd: ws,
        sessionId: 's1',
      })
      expect(requests).toHaveLength(3)
      for (const payload of requests.slice(1)) {
        gateway.decide({ approvalId: payload.approvalId, decision: 'deny', argsHash: payload.argsHash })
      }
      await Promise.all([writeAgain, bash])
    } finally {
      gateway.dispose()
      cleanup()
    }
  })

  it('会话授权只由写类工具建立：Bash 即使带 scope=session 也不会产生授权（直接断言语义映射）', async () => {
    const { gateway, run, turn, requests } = setup()
    const { ws, cleanup } = workspace()
    try {
      const bash = gateway.request({
        runId: run.id,
        turnId: turn.id,
        toolName: 'Bash',
        args: { command: 'npm run build' },
        cwd: ws,
        sessionId: 's1',
      })
      const outcome = gateway.decide({
        approvalId: requests[0].approvalId,
        decision: 'allow',
        argsHash: requests[0].argsHash,
        scope: 'session',
      })
      await bash
      // 决议本身成立（这一次允许），但不产生会话级授权
      expect(outcome.decision).toBe('allow')
      expect(outcome.sessionGranted).toBeUndefined()
      expect(gateway.listSessionGrants()).toEqual([])
      expect(gateway.peekSessionGrant({ sessionId: 's1', toolName: 'Write', args: { file_path: path.join(ws, 'x') } })).toBeNull()
    } finally {
      gateway.dispose()
      cleanup()
    }
  })
})

/**
 * 高优先 5：resolveApproval 只校验 argsHash 时，别的会话/轮次可以替他人下单。
 */
describe('ApprovalGateway 决议归属校验（高优先 5）', () => {
  it('session 不匹配 → APPROVAL_NOT_OWNED，且不写决策（仍为 pending）', async () => {
    const { gateway, repo, run, turn, requests } = setup()
    const pending = gateway.request({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Write',
      args: { file_path: '/tmp/a.txt' },
      cwd: '/tmp',
      sessionId: 's1',
    })
    pending.catch(() => undefined)

    let err: unknown
    try {
      gateway.decide({
        approvalId: requests[0].approvalId,
        decision: 'allow',
        argsHash: requests[0].argsHash,
        sessionId: 's2',
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AgentRuntimeError)
    expect((err as AgentRuntimeError).code).toBe('APPROVAL_NOT_OWNED')
    expect((err as Error).message).toContain('不属于指定会话')
    expect(repo.getApproval(requests[0].approvalId)?.status).toBe('pending')

    // 正确归属仍可决策
    gateway.decide({ approvalId: requests[0].approvalId, decision: 'deny', argsHash: requests[0].argsHash, sessionId: 's1' })
    await expect(pending).resolves.toMatchObject({ decision: 'deny' })
    gateway.dispose()
  })

  it('turn / run 不匹配 → APPROVAL_NOT_OWNED', async () => {
    const { gateway, run, turn, requests } = setup()
    const pending = gateway.request({ runId: run.id, turnId: turn.id, toolName: 'Write', args: { path: 'a' } })
    pending.catch(() => undefined)

    const expectNotOwned = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        expect((e as AgentRuntimeError).code).toBe('APPROVAL_NOT_OWNED')
        return
      }
      throw new Error('expected APPROVAL_NOT_OWNED')
    }
    expectNotOwned(() =>
      gateway.decide({
        approvalId: requests[0].approvalId,
        decision: 'deny',
        argsHash: requests[0].argsHash,
        turnId: 'turn-other',
      }),
    )
    expectNotOwned(() =>
      gateway.decide({
        approvalId: requests[0].approvalId,
        decision: 'deny',
        argsHash: requests[0].argsHash,
        runId: 'run-other',
      }),
    )

    gateway.decide({ approvalId: requests[0].approvalId, decision: 'deny', argsHash: requests[0].argsHash })
    await pending
    gateway.dispose()
  })
})
