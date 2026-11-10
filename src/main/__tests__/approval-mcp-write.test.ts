/**
 * G7-5：MCP 写工具纳入写前审批（同一 gateway）单测。
 *
 * 判定层面覆盖 MCP 命名（mcp__server__tool / server.tool / 裸 create_issue）；
 * 适配器层面验证：写类工具调用 canUseTool、被拒即不执行；读类工具不弹审批。
 */

import { describe, it, expect, vi } from 'vitest'
import { McpAdapter } from '../adapters/mcp-adapter'
import { isWriteScopedTool, isMcpToolName } from '../agent/runtime/approval/write-paths'

type Authorize = (
  session: { id: string },
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
) => Promise<{ toolCallId: string; content: string; isError?: boolean } | null>

function authorizer(adapter: McpAdapter): Authorize {
  return (adapter as unknown as { authorizeMcpToolCall: Authorize }).authorizeMcpToolCall.bind(adapter)
}

describe('isWriteScopedTool（MCP 工具名清单）', () => {
  it('识别 Claude MCP 命名风格的写动词', () => {
    expect(isWriteScopedTool('mcp__github__create_issue')).toBe(true)
    expect(isWriteScopedTool('mcp__fs__write_file')).toBe(true)
    expect(isWriteScopedTool('mcp.fs.delete_file')).toBe(true)
    expect(isWriteScopedTool('mcp__db__run_query')).toBe(true)
  })

  it('读类 MCP 工具不误判', () => {
    expect(isWriteScopedTool('mcp__github__get_issue')).toBe(false)
    expect(isWriteScopedTool('mcp__fs__read_file')).toBe(false)
    expect(isWriteScopedTool('read_file')).toBe(false)
  })

  it('裸工具名按写动词前缀判定', () => {
    expect(isWriteScopedTool('create_issue')).toBe(true)
    expect(isWriteScopedTool('update_record')).toBe(true)
    expect(isWriteScopedTool('list_issues')).toBe(false)
  })

  it('isMcpToolName 只认 mcp 前缀', () => {
    expect(isMcpToolName('mcp__x__y')).toBe(true)
    expect(isMcpToolName('mcp.x.y')).toBe(true)
    expect(isMcpToolName('create_issue')).toBe(false)
  })

  it('原有 CLI 写工具行为不变', () => {
    expect(isWriteScopedTool('Write')).toBe(true)
    expect(isWriteScopedTool('Edit')).toBe(true)
    expect(isWriteScopedTool('Bash')).toBe(false)
    expect(isWriteScopedTool('Read')).toBe(false)
  })
})

describe('McpAdapter 写前审批', () => {
  it('写类 MCP 工具被网关拒绝时不执行，返回 isError', async () => {
    const adapter = new McpAdapter()
    const canUseTool = vi.fn(async () => ({ behavior: 'deny' as const, message: '写操作需人工批准' }))
    const onPreToolUse = vi.fn()
    adapter.setTurnApprovalHooks('s1', { canUseTool, onPreToolUse })

    const result = await authorizer(adapter)(
      { id: 's1' },
      { id: 't1', name: 'mcp__fs__write_file', arguments: { path: '/tmp/a' } },
    )

    expect(onPreToolUse).toHaveBeenCalledWith('mcp__fs__write_file', { path: '/tmp/a' }, 't1')
    expect(canUseTool).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ toolCallId: 't1', isError: true })
    expect(result?.content).toContain('写操作需人工批准')
  })

  it('写类 MCP 工具获批时放行（返回 null，交由真实调用）', async () => {
    const adapter = new McpAdapter()
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }))
    adapter.setTurnApprovalHooks('s1', { canUseTool })

    const result = await authorizer(adapter)(
      { id: 's1' },
      { id: 't2', name: 'mcp__github__create_issue', arguments: {} },
    )

    expect(canUseTool).toHaveBeenCalledTimes(1)
    expect(result).toBeNull()
  })

  it('读类 MCP 工具不触发审批', async () => {
    const adapter = new McpAdapter()
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }))
    adapter.setTurnApprovalHooks('s1', { canUseTool })

    const result = await authorizer(adapter)(
      { id: 's1' },
      { id: 't3', name: 'mcp__fs__read_file', arguments: { path: '/tmp/a' } },
    )

    expect(canUseTool).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('未注入钩子时保持旧行为（不审批）', async () => {
    const adapter = new McpAdapter()
    const result = await authorizer(adapter)(
      { id: 'no-hooks' },
      { id: 't4', name: 'mcp__fs__write_file', arguments: {} },
    )
    expect(result).toBeNull()
  })
})
