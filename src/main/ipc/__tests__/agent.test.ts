import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerAgentHandlers } from '../agent'
import type { AgentManager } from '../../agent/agent-manager'
import type { AgentLogRepository } from '../../repositories/agent-log-repository'
import type { NodeRepository } from '../../repositories/node-repository'
import type { TypedHandle } from '../utils'
import type { GraphNode } from '@shared/types'
import { IpcError } from '../../errors'
import { ipcContext } from '../context'

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

  describe('agent:resolveApproval 归属校验（高优先 5）', () => {
    const decide = vi.fn().mockResolvedValue({
      approvalId: 'appr-1',
      decision: 'allow',
      decidedBy: 'user',
    })

    beforeEach(() => {
      const startSession = vi.fn().mockResolvedValue({ sessionId: 's-owner' })
      ;(agentManager as unknown as { startSession: typeof startSession }).startSession = startSession

      const runtime = {
        approvals: { decide, listPendingPayloads: vi.fn().mockResolvedValue([]) },
        endSession: vi.fn(),
      } as unknown as Parameters<typeof registerAgentHandlers>[4]

      const typedHandle: TypedHandle = (channel, handler) => {
        handlers[channel] = handler as (...args: any[]) => Promise<unknown>
      }
      registerAgentHandlers(agentManager, typedHandle, agentLogRepo, nodeRepo, runtime)
    })

    it('发起窗口不一致 → APPROVAL_NOT_OWNED，且不写决策', async () => {
      await ipcContext.run({ senderId: 1 }, () => handlers['agent:startSession']({}, 'claude-code', {}))

      await expect(
        ipcContext.run({ senderId: 2 }, () =>
          handlers['agent:resolveApproval']({}, { approvalId: 'appr-1', decision: 'allow', argsHash: 'h', sessionId: 's-owner', turnId: 't-1' }),
        ),
      ).rejects.toMatchObject({ code: 'APPROVAL_NOT_OWNED' })
      expect(decide).not.toHaveBeenCalled()
    })

    it('缺少 sessionId / turnId → IPC_INVALID_ARGUMENT（不能只靠 argsHash 下单）', async () => {
      await expect(
        ipcContext.run({ senderId: 1 }, () =>
          handlers['agent:resolveApproval']({}, { approvalId: 'appr-1', decision: 'allow', argsHash: 'h' }),
        ),
      ).rejects.toThrow(/sessionId and turnId/)
      expect(decide).not.toHaveBeenCalled()
    })

    it('同一窗口 + 完整归属信息 → 正常决议', async () => {
      await ipcContext.run({ senderId: 1 }, () => handlers['agent:startSession']({}, 'claude-code', {}))
      await ipcContext.run({ senderId: 1 }, () =>
        handlers['agent:resolveApproval']({}, { approvalId: 'appr-1', decision: 'allow', argsHash: 'h', sessionId: 's-owner', turnId: 't-1' }),
      )
      expect(decide).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'appr-1', sessionId: 's-owner', turnId: 't-1', senderId: 1 }))
    })

    it('P2-2：agent:runNode 不再暴露给 renderer（绕过锁与审批前置的直通口已删除）', () => {
      expect(handlers['agent:runNode']).toBeUndefined()
    })
  })

  describe('窗口绑定生命周期（P2-3）', () => {
    const decide = vi.fn().mockResolvedValue({ approvalId: 'appr-1', decision: 'allow', decidedBy: 'user' })
    let destroyedCallbacks: Map<number, () => void>
    let alive: Set<number>
    let sessionSeq: number

    beforeEach(() => {
      decide.mockClear()
      destroyedCallbacks = new Map()
      alive = new Set()
      sessionSeq = 100
      const startSession = vi.fn().mockImplementation(async () => ({ sessionId: `s-life-${sessionSeq++}` }))
      ;(agentManager as unknown as { startSession: typeof startSession }).startSession = startSession

      const runtime = {
        approvals: { decide, listPendingPayloads: vi.fn().mockResolvedValue([]) },
        endSession: vi.fn(),
      } as unknown as Parameters<typeof registerAgentHandlers>[4]

      const typedHandle: TypedHandle = (channel, handler) => {
        handlers[channel] = handler as (...args: any[]) => Promise<unknown>
      }
      registerAgentHandlers(agentManager, typedHandle, agentLogRepo, nodeRepo, runtime, {
        watchSender: (senderId, onDestroyed) => destroyedCallbacks.set(senderId, onDestroyed),
        isSenderAlive: (senderId) => alive.has(senderId),
      })
    })

    async function startAs(senderId: number): Promise<string> {
      const result = (await ipcContext.run({ senderId }, () =>
        handlers['agent:startSession']({}, 'claude-code', {}),
      )) as { sessionId: string }
      return result.sessionId
    }

    function resolveAs(senderId: number, sessionId: string) {
      return ipcContext.run({ senderId }, () =>
        handlers['agent:resolveApproval']({}, { approvalId: 'appr-1', decision: 'allow', argsHash: 'h', sessionId, turnId: 't-1' }),
      )
    }

    it('窗口销毁后新 sender 决议成功（绑定已随 destroyed 清理）', async () => {
      alive.add(101)
      const sessionId = await startAs(101)
      alive.delete(101)
      destroyedCallbacks.get(101)?.()

      await resolveAs(102, sessionId)
      expect(decide).toHaveBeenCalledWith(expect.objectContaining({ sessionId, senderId: 102 }))
    })

    it('销毁回调尚未触发但窗口已不存在 → 重绑当前 sender，而不是误拒', async () => {
      alive.add(111)
      const sessionId = await startAs(111)
      alive.delete(111) // 模拟 destroyed 回调晚于决议到达

      await resolveAs(112, sessionId)
      expect(decide).toHaveBeenCalledWith(expect.objectContaining({ sessionId, senderId: 112 }))
    })

    it('绑定窗口仍存活时跨窗口决议 → APPROVAL_NOT_OWNED（攻击路径回归）', async () => {
      alive.add(121)
      const sessionId = await startAs(121)

      await expect(resolveAs(122, sessionId)).rejects.toMatchObject({ code: 'APPROVAL_NOT_OWNED' })
      expect(decide).not.toHaveBeenCalled()
    })
  })
})
