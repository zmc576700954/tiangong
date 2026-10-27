/**
 * runClaude 的 CLI 参数组装测试
 *
 * 断言「生成流程不带写工具」这条安全边界 —— 思维导图生成、节点细化、社区摘要
 * 都是「读项目 → 输出 JSON」，CLI 拿到 Write/Edit 就可能被项目里的注入文本带偏。
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../cli-capabilities', () => ({
  supportsDisallowedTools: () => true,
}))

import { buildClaudeArgs } from '../claude-runner'

describe('buildClaudeArgs', () => {
  it('默认禁掉写工具', () => {
    const args = buildClaudeArgs({ cwd: '/tmp/project' })
    expect(args).toContain('--disallowedTools')
    const idx = args.indexOf('--disallowedTools')
    expect(args[idx + 1]).toContain('Write')
    expect(args[idx + 1]).toContain('Edit')
  })

  it('allowWrites=true 时不传禁写参数', () => {
    const args = buildClaudeArgs({ cwd: '/tmp/project', allowWrites: true })
    expect(args).not.toContain('--disallowedTools')
  })

  it('json 输出格式会带上 --output-format', () => {
    const args = buildClaudeArgs({ cwd: '/tmp/project', outputFormat: 'json' })
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('json')
  })

  it('不在白名单里的模型退回 sonnet', () => {
    const args = buildClaudeArgs({ cwd: '/tmp/project', model: 'gpt-4o; rm -rf /' })
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
  })
})
