/**
 * runClaude 的 CLI 参数组装测试
 *
 * 断言「生成流程不带写工具」这条安全边界 —— 思维导图生成、节点细化、社区摘要
 * 都是「读项目 → 输出 JSON」，CLI 拿到 Write/Edit 就可能被项目里的注入文本带偏。
 */

import { describe, it, expect, vi } from 'vitest'

const mockSupportsDisallowedTools = vi.fn(() => true)

vi.mock('../cli-capabilities', () => ({
  supportsDisallowedTools: () => mockSupportsDisallowedTools(),
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

  it('禁写名单里必须有 Bash —— 只禁 Write/Edit 挡不住 bash -c 的重定向', () => {
    const args = buildClaudeArgs({ cwd: '/tmp/project' })
    const tools = args[args.indexOf('--disallowedTools') + 1]
    expect(tools).toContain('Bash')
    expect(tools).toContain('MultiEdit')
  })

  it('CLI 不支持 --disallowedTools 时 fail-closed（宁可不跑，也不能带着写权限跑）', () => {
    mockSupportsDisallowedTools.mockReturnValueOnce(false)
    // 探测失败时如果照跑，就是一个禁写参数都不加 ——
    // CLI 默认带着 Write/Edit/Bash，被扫描到的项目文本能借模型的工具写进磁盘。
    expect(() => buildClaudeArgs({ cwd: '/tmp/project' })).toThrow(/disallowedTools/)
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
