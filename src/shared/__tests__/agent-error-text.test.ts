/**
 * P1-3：CLI/SDK 原始错误文本不得直接丢给用户。
 */
import { describe, expect, it } from 'vitest'
import { humanizeAgentErrorText } from '../agent-error-text'

describe('humanizeAgentErrorText', () => {
  it('code 143 / SIGTERM 映射为「已终止、未执行、请重发」', () => {
    const text = humanizeAgentErrorText('SDK error: Claude Code process exited with code 143')
    expect(text).toContain('退出码 143')
    expect(text).toContain('没有执行')
    expect(text).not.toContain('SDK error:')
  })

  it('code 137 / SIGKILL 同样映射为人话', () => {
    expect(humanizeAgentErrorText('process exited with code 137')).toContain('退出码 137')
  })

  it('普通 SDK error 保留原因并补一句解释，非 SDK 文本原样返回', () => {
    expect(humanizeAgentErrorText('Codex SDK error: network timeout')).toContain('network timeout')
    expect(humanizeAgentErrorText('adapter not installed')).toBe('adapter not installed')
  })
})
