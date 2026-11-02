import { describe, it, expect, vi } from 'vitest'
import { createAgentSessionForPrompt } from '../send-and-wait'
import type { AgentManager } from '../agent-manager'

describe('createAgentSessionForPrompt', () => {
  it('calls AgentManager.startSession and returns sessionId', async () => {
    const agentManager = {
      startSession: vi.fn().mockResolvedValue({ sessionId: 'sess-123' }),
    } as unknown as AgentManager

    const sessionId = await createAgentSessionForPrompt(
      agentManager,
      '/project/path',
      'generate mind map',
      {
        nodeTitle: '思维导图生成',
        timeoutMs: 300_000,
        adapterName: 'mindmap-internal',
        threadId: 'thread-1',
      },
    )

    expect(agentManager.startSession).toHaveBeenCalledTimes(1)
    expect(agentManager.startSession).toHaveBeenCalledWith(
      'mindmap-internal',
      expect.objectContaining({
        workingDirectory: '/project/path',
        nodeTitle: '思维导图生成',
        timeoutMs: 300_000,
        threadId: 'thread-1',
        allowedFiles: [],
        forbiddenFiles: [],
        invariantRules: [],
        upstreamContext: '',
        downstreamContext: '',
        acceptanceCriteria: [],
      }),
    )
    expect(sessionId).toBe('sess-123')
  })

  it('uses default adapter and title when options are omitted', async () => {
    const agentManager = {
      startSession: vi.fn().mockResolvedValue({ sessionId: 'sess-456' }),
    } as unknown as AgentManager

    const sessionId = await createAgentSessionForPrompt(
      agentManager,
      '/project/path',
      'generate mind map',
    )

    expect(agentManager.startSession).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({
        nodeTitle: '思维导图生成',
      }),
    )
    expect(sessionId).toBe('sess-456')
  })

  /**
   * 内部一次性生成流程必须**显式**退出只读推导。
   *
   * 背景：mindmap-internal 不保证只读（它的 CLI 禁写清单漏了 Bash，且探测失败时
   * fail-open）。而这条路径的 config 是 `allowedFiles: []` —— 只读推导会把它
   * 推成只读，AgentManager 随即抛 ADAPTER_READONLY_UNSUPPORTED，
   * **思维导图生成整个起不来**。
   */
  it('mindmap-internal 显式退出只读推导（否则会被推成只读而启动失败）', async () => {
    const agentManager = {
      startSession: vi.fn().mockResolvedValue({ sessionId: 'sess-789' }),
    } as unknown as AgentManager

    await createAgentSessionForPrompt(
      agentManager,
      '/project/path',
      'generate mind map',
      { adapterName: 'mindmap-internal' },
    )

    expect(agentManager.startSession).toHaveBeenCalledWith(
      'mindmap-internal',
      expect.objectContaining({
        allowedFiles: [],
        readOnly: false,
      }),
    )
  })

  it('普通适配器不退出只读推导（空 allowedFiles 仍推成只读）', async () => {
    const agentManager = {
      startSession: vi.fn().mockResolvedValue({ sessionId: 'sess-abc' }),
    } as unknown as AgentManager

    await createAgentSessionForPrompt(
      agentManager,
      '/project/path',
      'some prompt',
      { adapterName: 'claude-code' },
    )

    const startSession = agentManager.startSession as unknown as {
      mock: { calls: unknown[][] }
    }
    const config = startSession.mock.calls[0][1] as { readOnly?: boolean }
    // 没有显式 readOnly → 由 resolveReadonly 从「空 allowedFiles」推成只读
    expect(config.readOnly).toBeUndefined()
  })
})
