/**
 * OpenCode 结构化流归一化（v3.30）。
 *
 * 夹具直接取自实机：`opencode run --format json -m opencode/deepseek-v4.1-flash-free`
 * 一个真实回合（写文件 → 回话）与一个被权限拒绝的回合。手写夹具在这里没意义 ——
 * 上半年的 `[tool] …` 文本协议就是因为「按想象写夹具」而一直假绿。
 */

import { describe, expect, it } from 'vitest'
import { OpenCodeStreamNormalizer, type OpenCodeEvent } from '../normalize/opencode'

const META = { runId: 'run-1', turnId: 'turn-1', sessionId: 'sess-1', baseTimestamp: 1_000 }

function expectContinuous(events: Array<{ seq: number }>): void {
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
}

/** 实机回合一：step_start → tool_use(write, completed) → step_finish → step_start → text → step_finish */
const REAL_WRITE_TURN: OpenCodeEvent[] = [
  {
    type: 'step_start',
    part: { id: 'prt_1', type: 'step-start', messageID: 'msg_1', sessionID: 'ses_1' },
  },
  {
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'write',
      callID: 'call-write-1',
      state: {
        status: 'completed',
        input: { filePath: '/tmp/probe/hi.txt', content: 'ok\n' },
        output: 'Wrote file successfully.',
        metadata: { filepath: '/tmp/probe/hi.txt', exists: false },
      },
    },
  },
  {
    type: 'step_finish',
    part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 6053, output: 66 }, cost: 0 },
  },
  { type: 'step_start', part: { id: 'prt_2', type: 'step-start' } },
  { type: 'text', part: { type: 'text', text: 'DONE' } },
  {
    type: 'step_finish',
    part: { type: 'step-finish', reason: 'stop', tokens: { input: 118, output: 4 }, cost: 0 },
  },
]

describe('OpenCodeStreamNormalizer', () => {
  it('把 write 工具还原成 requested + result + file.change', () => {
    const normalizer = new OpenCodeStreamNormalizer(META)
    for (const event of REAL_WRITE_TURN) normalizer.feed(event)
    const events = normalizer.finish(0)

    expectContinuous(events)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'turn.started',
      'tool.requested',
      'tool.result',
      'file.change',
      'message.completed',
      'usage.updated',
      'run.completed',
    ])

    const requested = events.find((event) => event.type === 'tool.requested')
    expect(requested?.payload).toMatchObject({ toolCallId: 'call-write-1', toolName: 'write', risk: 'medium' })
    // 同一个 stepId 是硬要求：审批与审计都按它归并
    const result = events.find((event) => event.type === 'tool.result')
    expect(result?.stepId).toBe(requested?.stepId)

    expect(events.find((event) => event.type === 'file.change')?.payload).toMatchObject({
      path: '/tmp/probe/hi.txt',
    })
    expect(events.at(-1)?.payload).toMatchObject({ status: 'completed', summary: 'DONE' })
  })

  it('token 取真实值：input 只认首个非零步，output 累加', () => {
    const normalizer = new OpenCodeStreamNormalizer(META)
    for (const event of REAL_WRITE_TURN) normalizer.feed(event)
    const usage = normalizer.finish(0).find((event) => event.type === 'usage.updated')
    // 6053 是提示词规模；第二步的 118 是增量，累加会把缓存命中读成真实增长
    expect(usage?.payload).toEqual({ inputTokens: 6053, outputTokens: 70 })
  })

  it('工具被权限拒绝时发 tool.failed，而不是「成功但输出像错误」', () => {
    // 实机：permission.bash = ask 时无头 run 会 auto-reject
    const events: OpenCodeEvent[] = [
      { type: 'step_start', part: { type: 'step-start' } },
      {
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call-bash-1',
          state: {
            status: 'error',
            input: { command: 'echo ask-probe' },
            output: null,
            error: 'The user rejected permission to use this specific tool call.',
          },
        },
      },
      { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 900, output: 20 } } },
    ]

    const normalizer = new OpenCodeStreamNormalizer(META)
    for (const event of events) normalizer.feed(event)
    const normalized = normalizer.finish(0)

    const failed = normalized.find((event) => event.type === 'tool.failed')
    expect(failed).toBeDefined()
    expect(failed?.payload).toMatchObject({
      toolCallId: 'call-bash-1',
      toolName: 'bash',
      ok: false,
      output: 'The user rejected permission to use this specific tool call.',
    })
    expect(normalized.some((event) => event.type === 'tool.result')).toBe(false)
  })

  it('同一 callID 的重复上报不重复开 step', () => {
    const tool = REAL_WRITE_TURN[1]
    const normalizer = new OpenCodeStreamNormalizer(META)
    normalizer.feed(tool)
    normalizer.feed(tool)
    const events = normalizer.finish(0)
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'tool.result')).toHaveLength(1)
  })

  it('被信号杀掉（exitCode=null）判失败，不假装完成', () => {
    const normalizer = new OpenCodeStreamNormalizer(META)
    for (const event of REAL_WRITE_TURN) normalizer.feed(event)
    const events = normalizer.finish(null)
    expect(events.at(-1)?.type).toBe('run.failed')
    expect(events.at(-1)?.payload).toMatchObject({ status: 'failed' })
  })

  it('非零退出码判失败', () => {
    const normalizer = new OpenCodeStreamNormalizer(META)
    normalizer.feed({ type: 'text', part: { type: 'text', text: 'partial' } })
    expect(normalizer.finish(1).at(-1)?.type).toBe('run.failed')
  })

  it('空流也给出 run/turn 起始与终态（不产生空快照）', () => {
    const events = new OpenCodeStreamNormalizer(META).finish(0)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'turn.started',
      'usage.updated',
      'run.completed',
    ])
  })
})
