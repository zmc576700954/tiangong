import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerMindmapHandlers } from '../mindmap'
import type { AgentManager } from '../../agent/agent-manager'
import type { TypedHandle } from '../utils'
import type { NodeRepository } from '../../repositories/node-repository'
import type { EdgeRepository } from '../../repositories/edge-repository'
import type { GraphRepository } from '../../repositories/graph-repository'
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

  // 仓储桩：mindmap:buildDevPrompt 只需要 findById / listByGraph / getProjectPath
  const nodeRepo = {
    findById: vi.fn().mockReturnValue(null),
    listByGraph: vi.fn().mockReturnValue([]),
  } as unknown as NodeRepository
  const edgeRepo = {
    listByGraph: vi.fn().mockReturnValue([]),
  } as unknown as EdgeRepository
  const graphRepo = {
    getProjectPath: vi.fn().mockReturnValue(undefined),
  } as unknown as GraphRepository

  beforeEach(async () => {
    handlers = {}
    ;(nodeRepo.findById as any).mockReturnValue(null)
    ;(nodeRepo.listByGraph as any).mockReturnValue([])
    ;(edgeRepo.listByGraph as any).mockReturnValue([])
    ;(graphRepo.getProjectPath as any).mockReturnValue(undefined)
    agentManager = {
      startSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendCommand: vi.fn().mockResolvedValue(undefined),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager

    const typedHandle: TypedHandle = (channel, handler) => {
      handlers[channel] = handler as (...args: any[]) => Promise<unknown>
    }

    registerMindmapHandlers(typedHandle, agentManager, nodeRepo, edgeRepo, graphRepo)

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

  describe('mindmap:buildDevPrompt', () => {
    const mkNode = (over: Record<string, unknown> = {}) => ({
      id: 'node-1',
      type: 'feature',
      status: 'confirmed',
      title: '登录功能',
      description: '用户登录',
      graphId: 'graph-1',
      graphType: 'dev',
      position: { x: 0, y: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    })

    it('用图谱里的真实节点组装上下文（祖先链 / 子节点 / 关联节点）', async () => {
      const parent = mkNode({ id: 'proc-1', type: 'process', title: '认证流程', parentId: 'mod-1' })
      const module = mkNode({ id: 'mod-1', type: 'module', title: '用户中心' })
      const node = mkNode({ id: 'node-1', parentId: 'proc-1' })
      const child = mkNode({ id: 'node-2', title: '二次验证', parentId: 'node-1' })
      const related = mkNode({ id: 'node-3', title: '密码找回' })
      ;(nodeRepo.findById as any).mockReturnValue(node)
      ;(nodeRepo.listByGraph as any).mockReturnValue([parent, module, node, child, related])
      ;(edgeRepo.listByGraph as any).mockReturnValue([
        { id: 'e-1', graphId: 'graph-1', source: 'node-1', target: 'node-3', edgeType: 'depends_on' },
      ])

      const prompt = await handlers['mindmap:buildDevPrompt']({}, 'node-1', '登录功能', 'feature', 'feature', 'graph-1') as string

      expect(prompt).toContain('用户中心')   // 祖先链
      expect(prompt).toContain('认证流程')
      expect(prompt).toContain('二次验证')   // 子节点
      expect(prompt).toContain('密码找回')   // 关联节点
      // 找不到节点时不能退化成「空上下文 prompt」还静默通过
      expect(nodeRepo.findById).toHaveBeenCalledWith('node-1')
      expect(nodeRepo.listByGraph).toHaveBeenCalledWith('graph-1')
    })

    it('没有 project_path 的图不做 RAG 检索（避免把别的项目的历史当成本项目的先例）', async () => {
      ;(nodeRepo.findById as any).mockReturnValue(mkNode())
      ;(graphRepo.getProjectPath as any).mockReturnValue(undefined)

      const prompt = await handlers['mindmap:buildDevPrompt']({}, 'node-1', '登录功能', 'feature', 'feature', 'graph-1') as string

      expect(typeof prompt).toBe('string')
      expect(prompt.length).toBeGreaterThan(0)
      expect(graphRepo.getProjectPath).toHaveBeenCalledWith('graph-1')
    })
  })
})
