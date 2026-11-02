import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSessionConfig } from '@shared/types'

/**
 * MCP 适配器的只读会话测试。
 *
 * 背景：MCP 的工具来自 MCP server，**没有「只读」标记可筛** —— 默认的
 * filesystem server 是能写的。所以只读会话的做法是：
 *   1. startSession 时**不拉起任何 MCP server**（连进程都不起）
 *   2. doSendCommand 时**不给任何工具**，也不允许派生 subagent
 *
 * 与 claude-code 不同，claude-code 能放行 Read/Glob/Grep；MCP 放行不了，
 * 所以只读 MCP 会话退化成纯对话 —— 这是安全侧的取舍。
 */

const mockReadSettings = vi.fn()
const mockConnect = vi.fn()

vi.mock('../../settings', () => ({
  readSettings: (...args: unknown[]) => mockReadSettings(...args),
}))

vi.mock('../../mcp/client', () => ({
  McpClient: class {
    connect = (...args: unknown[]) => mockConnect(...args)
    getTools = () => [{ name: 'write_file', description: '写文件' }]
    close = vi.fn()
  },
}))

import { McpAdapter } from '../mcp-adapter'

function makeConfig(overrides?: Partial<AgentSessionConfig>): AgentSessionConfig {
  return {
    workingDirectory: '/project',
    nodeTitle: 'Test Node',
    acceptanceCriteria: [],
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    ...overrides,
  }
}

describe('McpAdapter — 只读会话', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadSettings.mockResolvedValue({
      defaultModel: 'claude-3-7-sonnet-20250219',
      apiKeys: [],
      defaultModels: {},
      mcpServers: [
        { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], enabled: true },
      ],
    })
  })

  it('只读会话不拉起任何 MCP server（连能写的 filesystem 都不起）', async () => {
    const adapter = new McpAdapter()
    await adapter.startSession(makeConfig({ readOnly: true }))
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('非只读会话照常拉起已启用的 MCP server', async () => {
    const adapter = new McpAdapter()
    await adapter.startSession(makeConfig())
    expect(mockConnect).toHaveBeenCalled()
  })
})
