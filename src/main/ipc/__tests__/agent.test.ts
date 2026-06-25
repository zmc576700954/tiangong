import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerAgentHandlers } from '../agent'
import type { AgentManager } from '../../agent/agent-manager'
import type { AgentLogRepository } from '../../repositories/agent-log-repository'
import type { NodeRepository } from '../../repositories/node-repository'
import type { TypedHandle } from '../utils'
import type { GraphNode } from '@shared/types'
import { IpcError } from '../../errors'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('registerAgentHandlers', () => {
  let handlers: Record<string, (...args: any[]) => Promise<unknown>>
  let agentManager: AgentManager
  let nodeRepo: NodeRepository
  let agentLogRepo: AgentLogRepository

  beforeEach(() => {
    handlers = {}
    agentManager = {
      resolveAndSendCommand: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager
    nodeRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'node-1' } as GraphNode),
    } as unknown as NodeRepository
    agentLogRepo = {
      listByNode: vi.fn().mockResolvedValue([]),
      listByGraph: vi.fn().mockResolvedValue([]),
    } as unknown as AgentLogRepository

    const typedHandle: TypedHandle = (channel, handler) => {
      handlers[channel] = handler as (...args: any[]) => Promise<unknown>
    }

    registerAgentHandlers(agentManager, typedHandle, agentLogRepo, nodeRepo)
  })

  describe('agent:resolveAndSendCommand', () => {
    it('accepts valid nodeIds array', async () => {
      await handlers['agent:resolveAndSendCommand']({}, 'session-1', { type: 'implement', description: '' }, undefined, ['node-1', 'node-2'])
      expect(nodeRepo.findById).toHaveBeenCalledTimes(2)
      expect(agentManager.resolveAndSendCommand).toHaveBeenCalled()
    })

    it('accepts undefined nodeIds', async () => {
      await handlers['agent:resolveAndSendCommand']({}, 'session-1', { type: 'implement', description: '' })
      expect(nodeRepo.findById).not.toHaveBeenCalled()
      expect(agentManager.resolveAndSendCommand).toHaveBeenCalled()
    })

    it('rejects non-array nodeIds', async () => {
      await expect(handlers['agent:resolveAndSendCommand']({}, 'session-1', { type: 'implement', description: '' }, undefined, 'node-1'))
        .rejects.toThrow(IpcError)
    })

    it('rejects empty string nodeIds', async () => {
      await expect(handlers['agent:resolveAndSendCommand']({}, 'session-1', { type: 'implement', description: '' }, undefined, ['node-1', '']))
        .rejects.toThrow(IpcError)
    })

    it('rejects non-string nodeIds', async () => {
      await expect(handlers['agent:resolveAndSendCommand']({}, 'session-1', { type: 'implement', description: '' }, undefined, ['node-1', 123]))
        .rejects.toThrow(IpcError)
    })
  })
})
