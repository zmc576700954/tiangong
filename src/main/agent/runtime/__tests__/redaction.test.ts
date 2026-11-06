/**
 * P1 隐私：事件落库脱敏。
 *
 * 覆盖 8 类可识别模式（命令行参数、Authorization、Bearer、URL 凭据、key=value、
 * 环境变量名、供应商 token 前缀、JSON 内嵌），并验证：
 * - 落库行不含原始密钥串；
 * - 脱敏后可审计（保留参数名/字段路径/规则名/长度）；
 * - 实时旁路（审批卡片、onEvent）仍拿到原文。
 */

import { describe, expect, it } from 'vitest'
import { AgentRuntime } from '../runtime'
import { AgentRepository } from '../db/repository'
import { ApprovalGateway } from '../approval/gateway'
import { hashArgs } from '../util'
import { REDACTION_META_KEY, redactPayload } from '../../../shared/redaction'
import { openTestDb } from './helpers/test-db'
import type {
  ApprovalRequestPayload,
  BackendDriver,
  DriverCapabilities,
  DriverExecuteRequest,
  DriverExecuteResult,
  NormalizedEventEnvelope,
  RunNodeRequest,
} from '@shared/types/agent-runtime'

const OPENAI_KEY = 'sk-proj-abcdefghijklmnop1234567890'
const GITHUB_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234567890'
const DB_PASSWORD = 'S3cr3t-Passw0rd!'
const URL_PASSWORD = 'supersecret'

const CAPABILITIES: DriverCapabilities = {
  toolEvents: 'exact',
  toolArgs: 'raw',
  toolLifecycle: 'exact',
  approval: 'pre-exec',
  fileChanges: 'hook',
  usage: 'turn-aggregate',
  completion: 'backend-turn-completed',
}

describe('redactPayload（事件 payload 落库前脱敏）', () => {
  it('命令行参数：--token / --password 保留参数名，值替换为长度标记', () => {
    const command = `curl https://api.example.com --token=${GITHUB_TOKEN} --password=${DB_PASSWORD}`
    const { payload, meta } = redactPayload({ command })
    const text = payload.command as string

    expect(text).toContain(`--token=***REDACTED(${GITHUB_TOKEN.length} chars)`)
    expect(text).toContain(`--password=***REDACTED(${DB_PASSWORD.length} chars)`)
    expect(text).not.toContain(GITHUB_TOKEN)
    expect(text).not.toContain(DB_PASSWORD)

    const field = meta?.fields.find((item) => item.path === '$.command')
    expect(field).toMatchObject({ path: '$.command', occurrences: 2 })
    expect(field?.rules).toContain('flag-secret')
  })

  it('Authorization 头：保留认证方案，只脱凭证', () => {
    const raw = `curl -H "Authorization: Bearer ${OPENAI_KEY}" https://api.example.com`
    const { payload } = redactPayload({ command: raw })
    const text = payload.command as string
    expect(text).toContain(`Authorization: Bearer ***REDACTED(${OPENAI_KEY.length} chars)`)
    expect(text).not.toContain(OPENAI_KEY)
  })

  it('独立 Bearer token', () => {
    const { payload } = redactPayload({ header: `Bearer ${GITHUB_TOKEN}` })
    expect(payload.header).toBe(`Bearer ***REDACTED(${GITHUB_TOKEN.length} chars)`)
  })

  it('URL 里的 user:pass@：保留用户名与主机，只脱密码', () => {
    const raw = `postgres://app:${URL_PASSWORD}@db.internal:5432/app`
    const { payload } = redactPayload({ command: `psql ${raw}` })
    const text = payload.command as string
    expect(text).toContain(`postgres://app:***REDACTED(${URL_PASSWORD.length} chars)@db.internal:5432/app`)
    expect(text).not.toContain(URL_PASSWORD)
  })

  it('key=value 文本与环境变量：password= / api_key= / AWS_SECRET_ACCESS_KEY=', () => {
    const raw =
      `DB_PASSWORD=${DB_PASSWORD} OPENAI_API_KEY=${OPENAI_KEY} ` +
      'api_key=plain-secret password="quoted-secret"'
    const { payload, meta } = redactPayload({ command: raw })
    const text = payload.command as string
    expect(text).not.toContain(DB_PASSWORD)
    expect(text).not.toContain(OPENAI_KEY)
    expect(text).not.toContain('plain-secret')
    expect(text).not.toContain('quoted-secret')
    // 键名保留，能看出是哪个变量被脱敏
    expect(text).toContain('DB_PASSWORD=***REDACTED(')
    expect(text).toContain('OPENAI_API_KEY=***REDACTED(')
    const field = meta?.fields.find((item) => item.path === '$.command')
    expect(field?.rules).toContain('secret-assignment')
  })

  it('JSON 内嵌：{"password":"..."} 与对象键名整体脱敏', () => {
    const embedded = JSON.stringify({ password: DB_PASSWORD, token: OPENAI_KEY })
    const { payload } = redactPayload({ command: `echo '${embedded}'` })
    const text = payload.command as string
    expect(text).not.toContain(DB_PASSWORD)
    expect(text).not.toContain(OPENAI_KEY)
    expect(text).toContain('password')
    expect(text).toContain('token')

    // 对象形态：敏感键名整值替换；环境变量对象按键名识别
    const structured = redactPayload({
      input: { password: DB_PASSWORD, env: { AWS_SECRET_ACCESS_KEY: DB_PASSWORD, AWS_REGION: 'us-east-1' } },
    })
    expect((structured.payload.input as Record<string, unknown>).password).toBe(
      `***REDACTED(${DB_PASSWORD.length} chars)`,
    )
    const env = (structured.payload.input as Record<string, Record<string, unknown>>).env
    expect(env.AWS_SECRET_ACCESS_KEY).toBe(`***REDACTED(${DB_PASSWORD.length} chars)`)
    expect(env.AWS_REGION).toBe('us-east-1')
    expect(structured.meta?.fields.map((field) => field.path)).toEqual(
      expect.arrayContaining(['$.input.password', '$.input.env.AWS_SECRET_ACCESS_KEY']),
    )
  })

  it('供应商 token 前缀：sk- / ghp_ 裸串也识别', () => {
    const { payload } = redactPayload({ message: `leaked ${OPENAI_KEY} and ${GITHUB_TOKEN}` })
    const text = payload.message as string
    expect(text).not.toContain(OPENAI_KEY)
    expect(text).not.toContain(GITHUB_TOKEN)
    expect(text).toContain(`***REDACTED(${OPENAI_KEY.length} chars)`)
    expect(text).toContain(`***REDACTED(${GITHUB_TOKEN.length} chars)`)
  })

  it('数组参数：逐项脱敏，路径能定位到具体下标', () => {
    const { payload, meta } = redactPayload({ input: { args: ['-H', `--token=${GITHUB_TOKEN}`, 'https://x'] } })
    const args = (payload.input as Record<string, string[]>).args
    expect(args[1]).toBe(`--token=***REDACTED(${GITHUB_TOKEN.length} chars)`)
    expect(meta?.fields).toEqual([{ path: '$.input.args[1]', rules: ['flag-secret'], occurrences: 1 }])
  })

  it('无可识别内容时不改动 payload（不引入空元数据）', () => {
    const payload = { command: 'git status', reason: '只读白名单命中' }
    const result = redactPayload(payload)
    expect(result.meta).toBeNull()
    expect(result.payload).toBe(payload)
  })

  it('不修改入参对象（审批卡片/onEvent 需要原文）', () => {
    const payload = { command: `curl --token=${GITHUB_TOKEN}` }
    redactPayload(payload)
    expect(payload.command).toBe(`curl --token=${GITHUB_TOKEN}`)
  })
})

describe('appendEvents 落库脱敏', () => {
  function setup() {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const run = repo.insertRun({ threadId: 't', nodeId: 'n', graphId: 'g', executor: 'claude-code' })
    const session = repo.insertSession({ executor: 'claude-code', status: 'active' })
    const turn = repo.insertTurn({
      runId: run.id,
      sessionId: session.id,
      nodeId: 'n',
      resumeMode: 'native',
      idempotencyKey: `k-${run.id}`,
      input: {},
    })
    return { db, repo, run, turn }
  }

  it('落库行不含原始密钥串，并带 _redaction 元数据（字段路径 + 规则名）', () => {
    const { db, repo, run, turn } = setup()
    const command = `git log --oneline && curl --token=${GITHUB_TOKEN} https://api.example.com`
    const events: NormalizedEventEnvelope[] = [
      {
        eventId: 'evt-1',
        runId: run.id,
        turnId: turn.id,
        seq: 1,
        type: 'bash.policy',
        source: 'kernel',
        fidelity: 'token',
        payloadVersion: 1,
        payload: { decision: 'allow', command },
        timestamp: Date.now(),
      },
    ]
    repo.appendEvents(events)

    const row = db.prepare('SELECT payload_json FROM agent_events WHERE id = ?').get('evt-1') as {
      payload_json: string
    }
    // 真实密钥串断言不存在（不是「只要包含 REDACTED 就算过」）
    expect(row.payload_json.includes(GITHUB_TOKEN)).toBe(false)
    expect(row.payload_json).toContain(`***REDACTED(${GITHUB_TOKEN.length} chars)`)
    const stored = JSON.parse(row.payload_json) as {
      command: string
      _redaction: { fields: Array<{ path: string; rules: string[] }>; total: number }
    }
    expect(stored._redaction.total).toBe(1)
    expect(stored._redaction.fields).toEqual([
      { path: '$.command', rules: ['flag-secret'], occurrences: 1 },
    ])
    // 审计仍能读出「哪个参数、多长」
    expect(stored.command).toBe(`git log --oneline && curl --token=***REDACTED(${GITHUB_TOKEN.length} chars) https://api.example.com`)

    // 内存事件对象未被修改：这正是不经落库、直接发给审批卡片/旁路的那份
    expect(events[0].payload.command).toBe(command)
  })

  it('多个事件各自独立脱敏；无敏感内容的事件不写 _redaction', () => {
    const { repo, run, turn } = setup()
    const events: NormalizedEventEnvelope[] = [
      {
        eventId: 'evt-a',
        runId: run.id,
        turnId: turn.id,
        seq: 1,
        type: 'tool.requested',
        source: 'backend',
        fidelity: 'token',
        payloadVersion: 1,
        payload: { command: `deploy --password=${DB_PASSWORD}` },
        timestamp: Date.now(),
      },
      {
        eventId: 'evt-b',
        runId: run.id,
        turnId: turn.id,
        seq: 2,
        type: 'tool.result',
        source: 'backend',
        fidelity: 'token',
        payloadVersion: 1,
        payload: { ok: true },
        timestamp: Date.now(),
      },
    ]
    repo.appendEvents(events)
    const stored = repo.listEvents(run.id)
    expect((stored[0].payload as Record<string, unknown>)[REDACTION_META_KEY]).toBeTruthy()
    expect(stored[0].payload.command).toContain('--password=***REDACTED(')
    expect(stored[1].payload[REDACTION_META_KEY]).toBeUndefined()
  })
})

describe('实时旁路（审批卡片）拿原文，落库拿脱敏副本', () => {
  function makeDriver(): BackendDriver {
    return {
      name: 'claude',
      capabilities: CAPABILITIES,
      async execute(request: DriverExecuteRequest, context): Promise<DriverExecuteResult> {
        context.record([
          {
            eventId: `${request.turnId}-1`,
            runId: request.runId,
            turnId: request.turnId,
            seq: 1,
            type: 'bash.policy',
            source: 'kernel',
            fidelity: 'token',
            payloadVersion: 1,
            payload: { decision: 'ask', command: `curl --token=${GITHUB_TOKEN} https://api.example.com` },
            timestamp: Date.now(),
            stepId: 'step-1',
          },
        ])
        return { status: 'completed', finalText: 'done', completionSignal: 'backend-turn-completed' }
      },
      async cancel() {
        /* no-op */
      },
    }
  }

  it('onEvent 收到原文；数据库里同一事件已脱敏', async () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const seen: NormalizedEventEnvelope[] = []
    const runtime = new AgentRuntime({ db, repo, retention: { enabled: false }, onEvent: (event) => seen.push(event) })
    runtime.registerDriver('claude-code', makeDriver())

    const request: RunNodeRequest = {
      executor: 'claude-code',
      prompt: 'deploy',
      workingDirectory: process.cwd(),
      nodeId: 'n1',
      agentSessionId: 's1',
    }
    await runtime.runNode(request)

    const bashEvent = seen.find((event) => event.type === 'bash.policy')
    expect(bashEvent?.payload.command).toBe(`curl --token=${GITHUB_TOKEN} https://api.example.com`)

    const raw = db.prepare("SELECT payload_json FROM agent_events WHERE type = 'bash.policy'").get() as {
      payload_json: string
    }
    expect(raw.payload_json.includes(GITHUB_TOKEN)).toBe(false)
    runtime.dispose()
  })
})

describe('agent_approvals 落库脱敏（重启重放）', () => {
  function approvalSetup() {
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
    const gateway = new ApprovalGateway({
      db,
      repo,
      notifier: { onRequest: (payload) => requests.push(payload), onResolved: () => {} },
    })
    return { db, repo, run, turn, gateway, requests }
  }

  it('insertApproval：args_json 脱敏并保留 _redaction，args_hash 仍基于原文', () => {
    const { repo, run, turn } = approvalSetup()
    const args = { command: `curl --token=${GITHUB_TOKEN} https://api.example.com` }
    const rawHash = hashArgs('Bash', args)
    const row = repo.insertApproval({
      runId: run.id,
      turnId: turn.id,
      stepId: 'step-1',
      toolName: 'Bash',
      argsJson: JSON.stringify(args),
      argsHash: rawHash,
      risk: 'high',
      policyDecision: 'ask',
      status: 'pending',
      expiresAt: Date.now() + 120_000,
      mode: 'interactive',
      timeoutMs: 120_000,
    })

    expect(row.args_json.includes(GITHUB_TOKEN)).toBe(false)
    expect(row.args_json).toContain('***REDACTED(')
    const stored = JSON.parse(row.args_json) as { _redaction: { fields: Array<{ path: string }> } }
    expect(stored._redaction.fields).toEqual([{ path: '$.command', rules: ['flag-secret'], occurrences: 1 }])
    // hash 由原文算出，不随脱敏变化
    expect(row.args_hash).toBe(rawHash)
    expect(hashArgs('Bash', JSON.parse(row.args_json))).not.toBe(rawHash)
  })

  it('实时审批：卡片拿原文、DB 拿脱敏；重启重放给 argsRedacted 且原 hash 仍可决策', () => {
    const { db, repo, run, turn, gateway, requests } = approvalSetup()
    const args = { command: `curl --token=${GITHUB_TOKEN} https://api.example.com` }
    const rawHash = hashArgs('Bash', args)

    const pending = gateway.request({ runId: run.id, turnId: turn.id, stepId: 'step-1', toolName: 'Bash', args })
    pending.catch(() => {}) // 本测试用另一个 gateway 实例决策，原 waiter 由 dispose 拒绝

    expect(requests).toHaveLength(1)
    // 待审批期间（进程未重启）：卡片展示内存原文，不脱敏
    expect(requests[0].argsJson).toContain(GITHUB_TOKEN)
    expect(requests[0].argsRedacted).toBeFalsy()
    expect(requests[0].argsHash).toBe(rawHash)

    // 落库行已脱敏
    const row = repo.getApproval(requests[0].approvalId)!
    expect(row.args_json.includes(GITHUB_TOKEN)).toBe(false)
    expect(row.args_hash).toBe(rawHash)

    // 模拟重启：新 gateway 从 DB 重放，只有脱敏后的参数
    const replayed = new ApprovalGateway({ db, repo })
    const pendingPayloads = replayed.listPendingPayloads()
    expect(pendingPayloads).toHaveLength(1)
    expect(pendingPayloads[0].argsJson.includes(GITHUB_TOKEN)).toBe(false)
    expect(pendingPayloads[0].argsRedacted).toBe(true)
    expect(pendingPayloads[0].argsHash).toBe(rawHash)

    // hash 校验基于原文：用原 hash 仍能决策成功
    const outcome = replayed.decide({
      approvalId: pendingPayloads[0].approvalId,
      decision: 'deny',
      argsHash: pendingPayloads[0].argsHash,
    })
    expect(outcome.decision).toBe('deny')
    gateway.dispose()
  })
})
