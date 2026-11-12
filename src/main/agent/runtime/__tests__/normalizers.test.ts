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

  /**
   * 夹具来自实机：codex-cli 0.162.0-alpha.17.2 跑
   * `codex exec --json -s workspace-write -c approval_policy="on-request"` 的真实输出。
   * 该 CLI 在 exec（非交互）下把审批策略钉成 never，MCP 工具调用因此被拒；
   * 事件里 `status:"failed"` + `error.message`，而旧实现按类型一律 `ok:true`。
   */
  const REAL_MCP_DENIED_ITEM = {
    id: 'item_12',
    type: 'mcp_tool_call',
    server: 'xcodebuildmcp',
    tool: 'debug_lldb_command',
    arguments: { command: 'version' },
    result: null,
    error: { message: 'MCP tool call requires approval, but approval policy is never' },
    status: 'failed',
  }

  it('MCP 调用被判失败时必须发 tool.failed，不能报 observed 成功', () => {
    const normalizer = new CodexStreamNormalizer(META)
    normalizer.feed({ type: 'item.started', item: { ...REAL_MCP_DENIED_ITEM, status: undefined, error: undefined } })
    normalizer.feed({ type: 'item.completed', item: REAL_MCP_DENIED_ITEM })
    normalizer.feed({ type: 'turn.completed' })
    const events = normalizer.finish()
    expectContinuous(events)

    expect(events.some((event) => event.type === 'tool.result')).toBe(false)
    const failed = events.find((event) => event.type === 'tool.failed')
    expect(failed).toBeDefined()
    expect(failed?.payload.ok).toBe(false)
    expect(String(failed?.payload.output)).toContain('requires approval')
    // MCP 工具名带 server/tool，否则审计里所有 MCP 调用都叫 mcp_tool_call
    expect(failed?.payload.toolName).toBe('mcp:xcodebuildmcp/debug_lldb_command')
  })

  it('MCP 调用成功时仍发 tool.result，并保留 server/tool 身份', () => {
    const normalizer = new CodexStreamNormalizer(META)
    normalizer.feed({
      type: 'item.completed',
      item: { id: 'item_3', type: 'mcp_tool_call', server: 'node_repl', tool: 'js', status: 'completed' },
    })
    normalizer.feed({ type: 'turn.completed' })
    const events = normalizer.finish()
    const result = events.find((event) => event.type === 'tool.result')
    expect(result?.payload.ok).toBe(true)
    expect(result?.payload.toolName).toBe('mcp:node_repl/js')
    const requested = events.find((event) => event.type === 'tool.requested')
    expect(requested?.payload.input).toMatchObject({ server: 'node_repl', tool: 'js' })
  })

  it('阻塞 run() 路径同样不把失败的 MCP 调用记成成功', () => {
    const events = normalizeCodexResult(
      {
        thread_id: 't',
        items: [REAL_MCP_DENIED_ITEM],
        final_response: 'done',
      },
      META,
    )
    expectContinuous(events)
    expect(events.some((event) => event.type === 'tool.result')).toBe(false)
    expect(events.find((event) => event.type === 'tool.failed')?.payload.ok).toBe(false)
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
