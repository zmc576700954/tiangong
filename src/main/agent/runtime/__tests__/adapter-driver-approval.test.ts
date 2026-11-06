/**
 * B3：审批事件必须在语义发生点入序（不能等 turn 结束批量追加到 run.completed 之后），
 * 且 seq 连续无断号。A2 的会话级授权自动放行也要留痕（grantSourceApprovalId）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { AgentAdapter } from '@shared/types'
import type {
  ApprovalOutcome,
  DriverExecuteContext,
  NormalizedEventEnvelope,
} from '@shared/types/agent-runtime'
import { AdapterBackendDriver } from '../executors/adapter-driver'

function baseRequest() {
  return {
    runId: 'run-1',
    turnId: 'turn-1',
    nodeId: 'node-1',
    agentSessionId: 'sess-1',
    prompt: 'do it',
    commandType: 'implement',
    workingDirectory: '/project',
  }
}

interface BashDecision {
  decision: 'allow' | 'ask' | 'blocked-empty'
  rule: string
  reason: string
  command: string
  risk: 'low' | 'medium' | 'high' | 'critical'
}

interface ClaudeHooks {
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ) => Promise<{ behavior: string }>
  onBashPolicy?: (decision: BashDecision, toolUseId?: string) => void | Promise<void>
}

interface RawEvent {
  sessionId: string
  vendor: 'claude'
  receivedAt: number
  payload: unknown
}

function makeAdapter(onSend: (hooks: ClaudeHooks) => Promise<void>) {
  let hooks: ClaudeHooks | null = null
  let rawHandler: ((event: RawEvent) => void) | null = null
  const adapter = {
    name: 'claude-code',
    setTurnApprovalHooks: vi.fn((_sessionId: string, next: ClaudeHooks) => {
      hooks = next
    }),
    onRawEvent: (handler: (event: RawEvent) => void) => {
      rawHandler = handler
    },
    offRawEvent: () => {
      rawHandler = null
    },
    onOutput: () => undefined,
    offOutput: () => undefined,
    sendCommand: async () => {
      if (!hooks) throw new Error('approval hooks not installed')
      await onSend(hooks)
      rawHandler?.({
        sessionId: 'sess-1',
        vendor: 'claude',
        receivedAt: Date.now(),
        payload: { type: 'result', is_error: false, result: 'done' },
      })
    },
  }
  return adapter as unknown as AgentAdapter
}

function makeContext(overrides: {
  peek?: DriverExecuteContext['approvals']['peek']
  request: DriverExecuteContext['approvals']['request']
}) {
  const events: NormalizedEventEnvelope[] = []
  const steps: Array<{ id: string; status: string }> = []
  // 复刻 Runtime.record 的序号分配：调用顺序即 turn 内语义顺序。
  let seq = 0
  const context = {
    record: (batch: NormalizedEventEnvelope[]) => {
      for (const event of batch) {
        seq += 1
        events.push({ ...event, seq, eventId: `evt-${seq}` })
      }
    },
    approvals: { request: overrides.request, peek: overrides.peek },
    step: {
      ensure: (id: string) => steps.push({ id, status: 'awaiting_approval' }),
      update: (id: string, status: string) => steps.push({ id, status }),
    },
    signal: new AbortController().signal,
    envMarker: 'marker-1',
    registerProcess: () => undefined,
  } as unknown as DriverExecuteContext
  return { events, steps, context }
}

describe('AdapterBackendDriver approval event ordering (B3)', () => {
  it('approval.required 与 approval.resolved 发生在 run.completed 之前，seq 连续', async () => {
    const adapter = makeAdapter(async (hooks) => {
      await hooks.canUseTool('Write', { file_path: '/project/a.txt' }, { signal: new AbortController().signal, toolUseID: 'tool-1' })
    })
    const { events, context } = makeContext({
      request: async (): Promise<ApprovalOutcome> => ({
        approvalId: 'appr-1',
        decision: 'allow',
        decidedBy: 'user',
        argsHash: 'h',
        decidedAt: Date.now(),
      }),
    })

    await new AdapterBackendDriver({ adapter, executor: 'claude-code', skipHealthCheck: true }).execute(
      baseRequest(),
      context,
    )

    expect(events.map((event) => event.type)).toEqual(['approval.required', 'approval.resolved', 'run.completed'])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(events.every((event) => event.timestamp > 1_760_000_000_000)).toBe(true)
  })

  it('Bash 策略决策落 bash.policy 审计事件，并同步 step 状态（allow/ask/blocked-empty）', async () => {
    const adapter = makeAdapter(async (hooks) => {
      await hooks.onBashPolicy!(
        { decision: 'allow', rule: 'git:status', reason: '只读白名单命中', command: 'git status', risk: 'low' },
        'tool-3',
      )
      await hooks.onBashPolicy!(
        { decision: 'ask', rule: 'pipe', reason: '含管道', command: 'cat a | tee b', risk: 'high' },
        'tool-4',
      )
      await hooks.onBashPolicy!(
        { decision: 'blocked-empty', rule: 'empty-command', reason: '空命令不放行', command: '', risk: 'low' },
        'tool-5',
      )
    })
    const { events, steps, context } = makeContext({
      request: async (): Promise<ApprovalOutcome> => ({
        approvalId: 'appr-3',
        decision: 'allow',
        decidedBy: 'user',
        argsHash: 'h',
        decidedAt: Date.now(),
      }),
    })

    await new AdapterBackendDriver({ adapter, executor: 'claude-code', skipHealthCheck: true }).execute(
      baseRequest(),
      context,
    )

    const bashEvents = events.filter((event) => event.type === 'bash.policy')
    expect(bashEvents).toHaveLength(3)
    expect(bashEvents.map((event) => event.payload.decision)).toEqual(['allow', 'ask', 'blocked-empty'])
    expect(bashEvents.map((event) => event.payload.rule)).toEqual(['git:status', 'pipe', 'empty-command'])
    expect(bashEvents.map((event) => event.payload.risk)).toEqual(['low', 'high', 'low'])
    expect(bashEvents[0].stepId).toBe('step-tool-3')
    // 免弹放行走 running；待审停在 awaiting_approval；空命令（唯一例外）直接终态
    expect(steps).toContainEqual({ id: 'step-tool-3', status: 'running' })
    expect(steps).toContainEqual({ id: 'step-tool-4', status: 'awaiting_approval' })
    expect(steps).toContainEqual({ id: 'step-tool-5', status: 'denied' })
  })

  it('ask 的 bash.policy 与后续 approval 决策可用同一 stepId / 规则关联', async () => {
    const command = 'cat a.txt | tee b.txt'
    const adapter = makeAdapter(async (hooks) => {
      await hooks.onBashPolicy!(
        { decision: 'ask', rule: 'pipe', reason: '含管道', command, risk: 'high' },
        'tool-6',
      )
      // SDK 收到 ask 后回到 canUseTool，toolUseID 不变 —— 这是审计关联的锚点。
      await hooks.canUseTool('Bash', { command }, { signal: new AbortController().signal, toolUseID: 'tool-6' })
    })
    const { events, context } = makeContext({
      request: async (): Promise<ApprovalOutcome> => ({
        approvalId: 'appr-6',
        decision: 'allow',
        decidedBy: 'user',
        argsHash: 'h',
        decidedAt: Date.now(),
      }),
    })

    await new AdapterBackendDriver({ adapter, executor: 'claude-code', skipHealthCheck: true }).execute(
      baseRequest(),
      context,
    )

    const bashEvent = events.find((event) => event.type === 'bash.policy')!
    const required = events.find((event) => event.type === 'approval.required')!
    const resolved = events.find((event) => event.type === 'approval.resolved')!
    expect(bashEvent.stepId).toBe('step-tool-6')
    expect(required.stepId).toBe('step-tool-6')
    expect(resolved.stepId).toBe('step-tool-6')
    // approval.required 里带上命中的规则，卡片与审计都能说明「在批什么」
    expect(required.payload).toMatchObject({ policyRule: 'pipe', risk: 'high' })
    expect((bashEvent.payload as { command: string }).command).toBe(command)
    expect(resolved.payload).toMatchObject({ approvalId: 'appr-6', decision: 'allow' })
  })

  it('会话级授权命中时不产生 approval.required，resolved 事件携带 grantSourceApprovalId', async () => {
    const adapter = makeAdapter(async (hooks) => {
      await hooks.canUseTool('Edit', { file_path: '/project/b.txt' }, { signal: new AbortController().signal, toolUseID: 'tool-2' })
    })
    const { events, context } = makeContext({
      peek: () => ({ grantSourceApprovalId: 'appr-grant' }),
      request: async (): Promise<ApprovalOutcome> => ({
        approvalId: 'appr-2',
        decision: 'allow',
        decidedBy: 'policy',
        argsHash: 'h',
        decidedAt: Date.now(),
        autoGranted: true,
        grantSourceApprovalId: 'appr-grant',
      }),
    })

    await new AdapterBackendDriver({ adapter, executor: 'claude-code', skipHealthCheck: true }).execute(
      baseRequest(),
      context,
    )

    expect(events.map((event) => event.type)).toEqual(['approval.resolved', 'run.completed'])
    expect(events.map((event) => event.seq)).toEqual([1, 2])
    expect(events[0].payload).toMatchObject({ grantSourceApprovalId: 'appr-grant', autoGranted: true })
  })

  it('拒绝时审批事件仍在工具结果事件之前', async () => {
    const adapter = makeAdapter(async (hooks) => {
      await hooks.canUseTool('Write', { file_path: '/project/c.txt' }, { signal: new AbortController().signal, toolUseID: 'tool-3' })
    })
    const { events, context } = makeContext({
      request: async (): Promise<ApprovalOutcome> => ({
        approvalId: 'appr-3',
        decision: 'deny',
        decidedBy: 'user',
        argsHash: 'h',
        decidedAt: Date.now(),
      }),
    })

    await new AdapterBackendDriver({ adapter, executor: 'claude-code', skipHealthCheck: true }).execute(
      baseRequest(),
      context,
    )

    expect(events.map((event) => event.type)).toEqual(['approval.required', 'approval.resolved', 'run.completed'])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3])
  })
})
