import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerMindmapHandlers } from '../mindmap'
import type { AgentManager } from '../../agent/agent-manager'
import type { TypedHandle } from '../utils'
import { IpcError } from '../../errors'

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock('../../agent/send-and-wait', () => ({
  sendPromptViaAgent: vi.fn().mockResolvedValue(''),
}))

vi.mock('../../mindmap-agent/claude-runner', () => ({
  extractJson: vi.fn(),
}))

describe('registerMindmapHandlers', () => {
  let handlers: Record<string, (...args: any[]) => Promise<unknown>>
  let agentManager: AgentManager
  let sendPromptViaAgent: any
  let extractJson: any

  beforeEach(async () => {
    handlers = {}
    agentManager = {
      startSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendCommand: vi.fn().mockResolvedValue(undefined),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager

    const typedHandle: TypedHandle = (channel, handler) => {
      handlers[channel] = handler as (...args: any[]) => Promise<unknown>
    }

    registerMindmapHandlers(typedHandle, agentManager)

    const sendModule = await import('../../agent/send-and-wait')
    sendPromptViaAgent = sendModule.sendPromptViaAgent
    const runnerModule = await import('../../mindmap-agent/claude-runner')
    extractJson = runnerModule.extractJson
  })

  describe('mindmap:generateModule', () => {
    it('returns parsed children when AI response is valid', async () => {
      extractJson.mockReturnValue({
        children: [
          { title: 'Child 1', description: 'Description 1' },
          { title: 'Child 2' },
        ],
      })
      sendPromptViaAgent.mockResolvedValue(JSON.stringify({ children: [{ title: 'Child 1' }] }))

      const result = await handlers['mindmap:generateModule']({}, '/tmp/project', 'parent-1', 'Parent', 'module') as { childType: string; children: Array<{ title: string; description?: string }> }
      expect(result.children).toHaveLength(2)
      expect(result.children[0].title).toBe('Child 1')
      expect(result.children[0].description).toBe('Description 1')
      expect(result.children[1].description).toBeUndefined()
    })

    it('throws when AI response lacks children array', async () => {
      extractJson.mockReturnValue({ notChildren: [] })
      sendPromptViaAgent.mockResolvedValue('bad')

      await expect(handlers['mindmap:generateModule']({}, '/tmp/project', 'parent-1', 'Parent', 'module'))
        .rejects.toThrow(IpcError)
    })

    it('throws when a child lacks title', async () => {
      extractJson.mockReturnValue({
        children: [{ description: 'Missing title' }],
      })
      sendPromptViaAgent.mockResolvedValue('bad')

      await expect(handlers['mindmap:generateModule']({}, '/tmp/project', 'parent-1', 'Parent', 'module'))
        .rejects.toThrow(IpcError)
    })

    it('throws when a child has non-string title', async () => {
      extractJson.mockReturnValue({
        children: [{ title: 123 }],
      })
      sendPromptViaAgent.mockResolvedValue('bad')

      await expect(handlers['mindmap:generateModule']({}, '/tmp/project', 'parent-1', 'Parent', 'module'))
        .rejects.toThrow(IpcError)
    })

    it('throws when a child has non-string description', async () => {
      extractJson.mockReturnValue({
        children: [{ title: 'Child', description: 123 }],
      })
      sendPromptViaAgent.mockResolvedValue('bad')

      await expect(handlers['mindmap:generateModule']({}, '/tmp/project', 'parent-1', 'Parent', 'module'))
        .rejects.toThrow(IpcError)
    })

    it('throws when a child is not an object', async () => {
      extractJson.mockReturnValue({
        children: ['not an object'],
      })
      sendPromptViaAgent.mockResolvedValue('bad')

      await expect(handlers['mindmap:generateModule']({}, '/tmp/project', 'parent-1', 'Parent', 'module'))
        .rejects.toThrow(IpcError)
    })
  })
})
