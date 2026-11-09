/**
 * W5-C1：ACP 执行器测试（真实子进程，不用 mock 协议栈）。
 *
 * 用一个临时 Node 脚本扮演 ACP agent，验证：
 * - initialize / session/new / session/prompt 握手；
 * - session/update 的 message.chunk 与 tool_call* 映射成归一化事件；
 * - session/request_permission → ApprovalGateway 写前强制审批（allow / deny）；
 * - 三阶段：approved 写 approvedAt，in_progress 才写 executingAt；
 * - session/cancel → stopReason=cancelled。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  ApprovalOutcome,
  DriverExecuteContext,
  DriverExecuteRequest,
  NormalizedEventEnvelope,
} from '@shared/types/agent-runtime'
import {
  AcpBackendDriver,
  createAcpDriverFromEnv,
  ACP_COMMAND_ENV,
  ACP_ARGS_ENV,
} from '../executors/acp-executor'

const FAKE_AGENT_SOURCE = String.raw`
const readline = require('node:readline')
const mode = process.env.FAKE_ACP_MODE || 'allow'
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const rl = readline.createInterface({ input: process.stdin })
let promptId = null
let sessionId = 'fake-sess'
function finish(stopReason) {
  if (promptId != null) {
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason } })
    promptId = null
  }
}
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
    return
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } })
    return
  }
  if (msg.method === 'session/cancel') {
    finish('cancelled')
    return
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id
    sessionId = msg.params.sessionId
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } })
    if (mode === 'cancel') return
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'edit', title: 'Edit file', status: 'pending', rawInput: { file_path: '/tmp/x' } } } })
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'tc-1', kind: 'edit', title: 'Edit file', rawInput: { file_path: '/tmp/x' } }, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } })
    return
  }
  if (msg.id === 900) {
    const optionId = msg.result && msg.result.outcome && msg.result.outcome.optionId
    if (optionId === 'allow-once') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', kind: 'edit', status: 'in_progress' } } })
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', kind: 'edit', status: 'completed', rawOutput: 'ok' } } })
    } else {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', kind: 'edit', status: 'failed' } } })
    }
    finish('end_turn')
  }
})
`

let fakeAgentPath = ''
const drivers: AcpBackendDriver[] = []

beforeAll(() => {
  fakeAgentPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fake-')), 'agent.cjs')
  fs.writeFileSync(fakeAgentPath, FAKE_AGENT_SOURCE, 'utf8')
})

afterEach(() => {
  while (drivers.length > 0) drivers.pop()!.dispose()
})

afterAll(() => {
  fs.rmSync(path.dirname(fakeAgentPath), { recursive: true, force: true })
})

function makeDriver(mode: 'allow' | 'deny' | 'cancel'): AcpBackendDriver {
  const env = { ...process.env, FAKE_ACP_MODE: mode }
  const driver = new AcpBackendDriver({
    command: process.execPath,
    args: [fakeAgentPath],
    env,
    handshakeTimeoutMs: 10_000,
  })
  drivers.push(driver)
  return driver
}

function baseRequest(): DriverExecuteRequest {
  return {
    runId: 'run-1',
    turnId: 'turn-1',
    nodeId: 'node-1',
    agentSessionId: 'sess-1',
    prompt: 'do it',
    commandType: 'implement',
    workingDirectory: os.tmpdir(),
  }
}

interface StepRecord {
  id: string
  status: string
  executingAt?: number
  approvedAt?: number
}

function makeContext(decision: 'allow' | 'deny') {
  const events: NormalizedEventEnvelope[] = []
  const steps: StepRecord[] = []
  const processes: Array<{ pid?: number; pgid?: number; envMarker?: string }> = []
  const approvals = vi.fn(
    async (_input: unknown): Promise<ApprovalOutcome> => ({
      approvalId: 'appr-1',
      decision,
      decidedBy: 'user',
      argsHash: 'h',
      decidedAt: Date.now(),
    }),
  )
  const context = {
    record: (batch: NormalizedEventEnvelope[]) => {
      for (const event of batch) events.push(event)
    },
    approvals: { request: approvals },
    step: {
      ensure: (id: string, input: { status: string }) => steps.push({ id, status: input.status }),
      update: (
        id: string,
        status: string,
        extra?: { executingAt?: number; approvedAt?: number },
      ) => steps.push({ id, status, ...extra }),
    },
    signal: new AbortController().signal,
    envMarker: 'marker-1',
    registerProcess: (proc: { pid?: number; pgid?: number; envMarker?: string }) => processes.push(proc),
  } as unknown as DriverExecuteContext
  return { events, steps, processes, approvals, context }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('ACP executor（真实子进程）', () => {
  it('allow：握手、消息流、tool_call 与写前审批按语义顺序落事件，且 executingAt 只在 in_progress 写', async () => {
    const driver = makeDriver('allow')
    const { events, steps, processes, approvals, context } = makeContext('allow')

    const result = await driver.execute(baseRequest(), context)

    expect(result.status).toBe('completed')
    expect(result.finalText).toBe('hello')
    // 真进程登记（detached ⇒ pgid=pid），取消/清扫才有句柄可回收。
    expect(processes).toHaveLength(1)
    expect(processes[0].pid).toBeTypeOf('number')
    expect(processes[0].pgid).toBe(processes[0].pid)

    expect(events.map((event) => event.type)).toEqual([
      'message.delta',
      'tool.requested',
      'approval.required',
      'approval.resolved',
      'tool.result',
    ])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    expect(approvals).toHaveBeenCalledTimes(1)
    expect(approvals.mock.calls[0][0]).toMatchObject({ toolName: 'Write' })
    expect(approvals.mock.calls[0][0]).not.toHaveProperty('mode')

    // 三阶段：awaiting_approval → approved(approvedAt) → running(executingAt) → done
    expect(steps).toContainEqual(expect.objectContaining({ id: 'step-tc-1', status: 'awaiting_approval' }))
    const approved = steps.find((step) => step.status === 'approved')
    expect(approved?.approvedAt).toBeTypeOf('number')
    const running = steps.find((step) => step.status === 'running')
    expect(running?.executingAt).toBeTypeOf('number')
    expect(steps.at(-1)).toMatchObject({ id: 'step-tc-1', status: 'done' })
  })

  it('deny：审批发生在工具执行前，step 落 denied，且不会写 executingAt', async () => {
    const driver = makeDriver('deny')
    const { events, steps, context } = makeContext('deny')

    const result = await driver.execute(baseRequest(), context)

    expect(result.status).toBe('completed')
    expect(events.map((event) => event.type)).toEqual([
      'message.delta',
      'tool.requested',
      'approval.required',
      'approval.resolved',
      'tool.failed',
    ])
    expect(events.find((event) => event.type === 'approval.resolved')?.payload).toMatchObject({
      decision: 'deny',
    })
    expect(steps).toContainEqual(expect.objectContaining({ id: 'step-tc-1', status: 'denied' }))
    expect(steps.some((step) => step.executingAt !== undefined)).toBe(false)
  })

  it('cancel：session/cancel 通知后返回 cancelled，并保留已产出的最终文本', async () => {
    const driver = makeDriver('cancel')
    const { events, context } = makeContext('allow')
    const request = baseRequest()

    const running = driver.execute(request, context)
    await waitFor(() => events.some((event) => event.type === 'message.delta'))
    await driver.cancel(request)

    const result = await running
    expect(result.status).toBe('cancelled')
    expect(result.finalText).toBe('hello')
  })

  it('createAcpDriverFromEnv：未配置 command 返回 undefined，不改变默认路径', () => {
    const savedCommand = process.env[ACP_COMMAND_ENV]
    const savedArgs = process.env[ACP_ARGS_ENV]
    delete process.env[ACP_COMMAND_ENV]
    delete process.env[ACP_ARGS_ENV]
    try {
      expect(createAcpDriverFromEnv()).toBeUndefined()
      process.env[ACP_COMMAND_ENV] = process.execPath
      process.env[ACP_ARGS_ENV] = `"${fakeAgentPath}"`
      const driver = createAcpDriverFromEnv()
      expect(driver).toBeInstanceOf(AcpBackendDriver)
      driver?.dispose()
    } finally {
      if (savedCommand === undefined) delete process.env[ACP_COMMAND_ENV]
      else process.env[ACP_COMMAND_ENV] = savedCommand
      if (savedArgs === undefined) delete process.env[ACP_ARGS_ENV]
      else process.env[ACP_ARGS_ENV] = savedArgs
    }
  })
})
