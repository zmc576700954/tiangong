import { describe, expect, it } from 'vitest'
import { normalizeClaude } from '../src/normalizer/claude'
import { hostOwnedEvents } from '../src/loop/host-owned'
import { RunEngine } from '../src/loop/run-engine'
import { ToolRuntime } from '../src/loop/tool-runtime'
import { BACKEND_DRIVERS } from '../src/loop/backend-driver'
import type { AgentEventEnvelope, ToolResultPayload } from '../src/types'
import {
  checkpointTypes,
  fixturePath,
  loadJsonl,
} from './helpers'

const TOOL_CALL_TEXT =
  'I will inspect src/math.ts.\n<tool_call>{"tool":"read_file","input":{"path":"src/math.ts"}}</tool_call>'

function makeRuntime(): ToolRuntime {
  return new ToolRuntime({
    read_file: async (input) => `contents of ${String(input.path)}: export function add(a, b) { return a - b }`,
  })
}

async function collect(iterable: AsyncIterable<AgentEventEnvelope>): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = []
  for await (const event of iterable) events.push(event)
  return events
}

const backendEvents = normalizeClaude(loadJsonl(fixturePath('claude', 'session-001.jsonl')), {
  runId: 'run-backend',
  turnId: 'turn-backend',
})

describe('V6 循环归属：backend-owned 与 host-owned 产出同一语义序列', () => {
  it('host-owned Kernel 执行工具并回填 tool_result 后，检查点序列与 backend-owned 一致', async () => {
    const hostEvents = await collect(
      hostOwnedEvents({
        runId: 'run-host',
        turnId: 'turn-host',
        firstText: TOOL_CALL_TEXT,
        finalText: 'Done: the add function is broken.',
        runtime: makeRuntime(),
      }),
    )

    expect(checkpointTypes(hostEvents)).toEqual(checkpointTypes(backendEvents))
    expect(checkpointTypes(hostEvents)).toEqual([
      'run.started',
      'message.completed',
      'tool.requested',
      'tool.result',
      'run.completed',
    ])

    const toolResult = hostEvents.find((e) => e.type === 'tool.result')!
    const payload = toolResult.payload as ToolResultPayload
    expect(payload.ok).toBe(true)
    expect(String(payload.output)).toContain('a - b')
    expect(toolResult.source).toBe('kernel')

    // 工具结果之后仍有模型文本，并且以 run.completed 收尾
    const resultIndex = hostEvents.findIndex((e) => e.type === 'tool.result')
    expect(hostEvents.slice(resultIndex).some((e) => e.type === 'message.delta')).toBe(true)
    expect(hostEvents.at(-1)!.type).toBe('run.completed')
  })

  it('两种循环归属在同一状态机中都能从 created 走到 completed', async () => {
    const engine = new RunEngine()
    for (const event of backendEvents) engine.consume(event)
    const hostEvents = await collect(
      hostOwnedEvents({
        runId: 'run-host',
        turnId: 'turn-host',
        firstText: TOOL_CALL_TEXT,
        finalText: 'Done.',
        runtime: makeRuntime(),
      }),
    )
    for (const event of hostEvents) engine.consume(event)

    expect(engine.getTrace('run-backend')).toEqual(['created', 'running', 'completed'])
    expect(engine.getTrace('run-host')).toEqual(['created', 'running', 'completed'])
  })

  it('两者混跑：host-owned 停在 awaiting_approval 时，backend-owned 的状态不受影响', async () => {
    const engine = new RunEngine()

    // backend-owned 先完整跑完
    for (const event of backendEvents) engine.consume(event)
    expect(engine.getState('run-backend')).toBe('completed')

    let allowHost!: () => void
    const hostGate = new Promise<'allow'>((resolve) => (allowHost = () => resolve('allow')))

    const iterator = hostOwnedEvents({
      runId: 'run-host-mixed',
      turnId: 'turn-host-mixed',
      firstText: TOOL_CALL_TEXT,
      finalText: 'Done after approval.',
      runtime: makeRuntime(),
      requireApproval: true,
      waitForApproval: () => hostGate,
    })

    let next = await iterator.next()
    while (!next.done) {
      engine.consume(next.value)
      if (next.value.type === 'tool.approval_required') break
      next = await iterator.next()
    }

    expect(engine.getState('run-host-mixed')).toBe('awaiting_approval')
    // 关键：host-owned 的审批等待没有把 backend-owned 拉回 running / awaiting_approval
    expect(engine.getState('run-backend')).toBe('completed')

    allowHost()
    while (!(next = await iterator.next()).done) engine.consume(next.value)

    expect(engine.getState('run-host-mixed')).toBe('completed')
    expect(engine.getState('run-backend')).toBe('completed')
    expect(engine.getTrace('run-host-mixed')).toEqual([
      'created',
      'running',
      'awaiting_approval',
      'running',
      'completed',
    ])
  })

  it('能力矩阵（BackendCapabilities）：Claude/Codex 为 backend-owned，OpenCode 为 host-owned', () => {
    expect(BACKEND_DRIVERS['claude-code'].capabilities.loopOwnership).toBe('backend')
    expect(BACKEND_DRIVERS.codex.capabilities.loopOwnership).toBe('backend')
    expect(BACKEND_DRIVERS.opencode.capabilities.loopOwnership).toBe('host')
    expect(BACKEND_DRIVERS['claude-code'].capabilities.eventFidelity).toBe('token')
    expect(BACKEND_DRIVERS.codex.capabilities.eventFidelity).toBe('turn')
    expect(BACKEND_DRIVERS.opencode.capabilities.eventFidelity).toBe('session')
  })
})
