import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeCodeAdapter } from '../claude-code'

describe('ClaudeCodeAdapter', () => {
  let adapter: ClaudeCodeAdapter

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter()
    vi.resetModules()
  })

  it('checkInstalled returns false when SDK is not available', async () => {
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => {
      throw new Error('not installed')
    })
    const installed = await adapter.checkInstalled()
    expect(installed).toBe(false)
    vi.doUnmock('@anthropic-ai/claude-agent-sdk')
  })

  it('startSession creates a session with config', async () => {
    const config = {
      workingDirectory: '/project',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test',
      acceptanceCriteria: [],
    }
    const session = await adapter.startSession(config)
    expect(session.adapterName).toBe('claude-code')
    expect(session.config.nodeTitle).toBe('Test')
  })
})
