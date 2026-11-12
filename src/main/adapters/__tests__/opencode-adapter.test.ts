/**
 * OpenCode 适配器的 stdout 处理。
 *
 * 背景：1.0 时代适配器发的是 `-q`，1.19 把这个参数当成未知选项 —— CLI 打一页
 * 帮助然后 exit 0，宿主于是把帮助文本当成模型输出返回给用户。这是**静默的
 * 错误输出**，比崩溃更难发现。这里的用例守的就是这条护栏。
 */

import { describe, expect, it } from 'vitest'
import { looksLikeHelpPage, parseEventStream } from '../opencode'

const HELP_PAGE = `⠀
█▀▀█ █▀▀█ █▀▀█
Commands:
  opencode run [message..]     run opencode with a message
  opencode [project]           start opencode tui
`

describe('looksLikeHelpPage', () => {
  it('识别「参数被拒 → 打帮助页」的输出', () => {
    expect(looksLikeHelpPage(HELP_PAGE)).toBe(true)
  })

  it('真实事件流不会被误判', () => {
    expect(
      looksLikeHelpPage('{"type":"text","part":{"type":"text","text":"DONE"}}\n'),
    ).toBe(false)
  })

  it('只是一句提到 Commands: 的普通输出也不算', () => {
    expect(looksLikeHelpPage('Commands: none\n')).toBe(false)
  })
})

describe('parseEventStream', () => {
  it('逐行解析 JSONL，跳过噪声行与半行 JSON', () => {
    const stdout = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      'update available: 1.20.0', // CLI 偶尔插的提示
      '{"type":"text","part":{"type":"text","text":"hi"}}',
      '{"type":"tool_use","part":', // 进程被杀留下的半行
      '',
    ].join('\n')

    const events = parseEventStream(stdout)
    expect(events.map((event) => event.type)).toEqual(['step_start', 'text'])
  })

  it('空输出得到空数组', () => {
    expect(parseEventStream('')).toEqual([])
  })
})
