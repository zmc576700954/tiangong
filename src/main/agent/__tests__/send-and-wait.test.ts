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
})
