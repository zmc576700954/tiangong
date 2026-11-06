/**
 * D3 验收：三后端归一化序列一致、turn 内 seq 从 1 连续、终态事件正确。
 */

import { describe, expect, it } from 'vitest'
import { normalizeClaude } from '../normalize/claude'
import { CodexStreamNormalizer, normalizeCodex, normalizeCodexResult } from '../normalize/codex'
import { normalizeOpenCode } from '../normalize/opencode'

const META = { runId: 'run-1', turnId: 'turn-1', sessionId: 'sess-1', baseTimestamp: 1_000 }

function expectContinuous(events: Array<{ seq: number }>): void {
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
}

describe('Claude normalizer (D3)', () => {
  it('maps SDK messages one-by-one with continuous seq', () => {
    const raws = [
      { type: 'system', subtype: 'init', session_id: 'claude-session' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will read the file.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a.txt' } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file body', is_error: false }] },
      },
      { type: 'result', is_error: false, result: 'done', usage: { input_tokens: 10, output_tokens: 5 } },
    ]

    const events = normalizeClaude(raws, META)
    expectContinuous(events)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.completed',
      'tool.requested',
      'tool.result',
      'usage.updated',
      'run.completed',
    ])
    // 首块只发一次文本（P1-6：delta + completed 重复发送会让同一段文本计两次）
    const textEvents = events.filter(
      (event) => event.type === 'message.delta' || event.type === 'message.completed',
    )
    expect(textEvents).toHaveLength(1)
    expect(textEvents[0].payload.text).toBe('I will read the file.')
    expect(events.find((event) => event.type === 'tool.requested')?.stepId).toBe('step-tool-1')
  })

  it('emits run.failed for an error result', () => {
    const events = normalizeClaude([{ type: 'result', is_error: true, result: 'boom' }], META)
    expectContinuous(events)
    expect(events.at(-1)?.type).toBe('run.failed')
  })

  it('B2: 未注入 baseTimestamp 时使用真实时钟，而不是 1_760_000_000_000 常量', () => {
    const before = Date.now()
    const events = normalizeClaude([{ type: 'result', is_error: false, result: 'done' }], {
      runId: 'run-real',
      turnId: 'turn-real',
      sessionId: 'sess-real',
    })
    const after = Date.now()
    for (const event of events) {
      expect(event.timestamp).toBeGreaterThanOrEqual(before)
      expect(event.timestamp).toBeLessThanOrEqual(after)
    }
    // 显式注入时仍保持确定性（测试夹具行为不变）
    const pinned = normalizeClaude([{ type: 'result', is_error: false, result: 'done' }], META)
    expect(pinned[0].timestamp).toBe(META.baseTimestamp + 1)
  })
})

describe('Codex normalizer (D3, C1–C7)', () => {
  it('uses turn.completed as completion, ignores unknown events, keeps seq continuous', () => {
    const normalizer = new CodexStreamNormalizer(META)
    normalizer.feed({ type: 'thread.started', thread_id: 'thread-x' })
    normalizer.feed({ type: 'turn.started' })
    normalizer.feed({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'ls' } })
    normalizer.feed({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'ls', output: 'a.txt' } })
    normalizer.feed({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'done' } })
    normalizer.feed({ type: 'item.completed', item: { id: 'fc-1', type: 'file_change', path: 'a.txt', change: 'modify' } })
    normalizer.feed({ type: 'unknown.future.event' })
    normalizer.feed({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } })

    const events = normalizer.finish()
    expectContinuous(events)
    expect(events.some((event) => event.type === 'run.completed')).toBe(true)
    expect(events.some((event) => event.type === 'turn.failed')).toBe(false)
    const changes = events.filter((event) => event.type === 'file.change')
    expect(changes).toHaveLength(1)
    expect(changes[0].payload.diffUnavailable).toBe(true)
  })

  it('marks open items aborted when turn ends early', () => {
    const normalizer = new CodexStreamNormalizer(META)
    normalizer.feed({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'sleep 10' } })
    normalizer.feed({ type: 'turn.completed' })
    const events = normalizer.finish()
    expectContinuous(events)
    expect(events.some((event) => event.type === 'tool.aborted')).toBe(true)
  })

  it('does not claim success when the stream ends without turn.completed', () => {
    const events = normalizeCodex([{ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution' } }], META)
    expectContinuous(events)
    expect(events.some((event) => event.type === 'run.completed')).toBe(false)
    expect(events.some((event) => event.type === 'turn.failed')).toBe(true)
    // C2：未闭合 tool 如实标 unknown，不伪装成 failed
    expect(events.some((event) => event.type === 'tool.unknown')).toBe(true)
    expect(events.some((event) => event.type === 'tool.failed')).toBe(false)
  })

  it('still normalizes blocking run() results for legacy fixtures', () => {
    const events = normalizeCodexResult(
      {
        thread_id: 't',
        items: [{ type: 'agent_message', text: 'ok' }, { type: 'file_change', path: 'b.txt', change: 'add' }],
        final_response: 'ok',
      },
      META,
    )
    expectContinuous(events)
    expect(events.at(-1)?.type).toBe('run.completed')
  })
})

describe('OpenCode normalizer (D3)', () => {
  it('maps one-shot stdout with continuous seq', () => {
    const stdout = ['[text] first line', '[tool] Read {"path":"a.txt"}', '[tool-result] file body', 'last line'].join('\n')
    const events = normalizeOpenCode(stdout, META)
    expectContinuous(events)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.completed',
      'tool.requested',
      'tool.result',
      'message.delta',
      'usage.updated',
      'run.completed',
    ])
    expect(events[2].source).toBe('synthetic')
    expect(events[3].source).toBe('synthetic')
  })

  it('produces the same canonical sequence shape as a turn with no tools', () => {
    const events = normalizeOpenCode('just text', META)
    expectContinuous(events)
    expect(events.at(-1)?.type).toBe('run.completed')
  })
})
