/**
 * 记忆归属（project_id）回归测试
 *
 * 记忆的 project_id 决定它能否被「同项目」检索命中 —— memory-store 的 FTS
 * 过滤、RAG 少样本检索、prompt-formatter 的近期记忆全都按 project_id 过滤。
 * 管线此前只把 adapterName 传给提取器，所有写入的记忆 project_id 都是空串，
 * 检索层永远匹配不到：记忆写了等于没写。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface CapturedContext {
  projectId?: string
  nodeId?: string
  adapterName: string
}

let captured: CapturedContext | null = null

vi.mock('../memory-extractor', () => ({
  MemoryExtractor: class {
    extract(_sessionId: string, _outputs: unknown[], context: CapturedContext) {
      captured = context
      return []
    }
  },
}))

import { PipelineRunner } from '../pipeline'

describe('PipelineRunner — 记忆归属', () => {
  beforeEach(() => {
    captured = null
    PipelineRunner._executionCount = 0
  })

  it('extract 阶段把 projectId / nodeId 传给提取器', async () => {
    const runner = await PipelineRunner.createDefault()
    await runner.run({
      outputs: [],
      sessionId: 'sess-A',
      adapterName: 'claude-code',
      projectId: '/projects/demo',
      nodeId: 'node-1',
    })

    expect(captured).not.toBeNull()
    expect(captured!.projectId).toBe('/projects/demo')
    expect(captured!.nodeId).toBe('node-1')
    expect(captured!.adapterName).toBe('claude-code')
  })

  it('没有 projectId 时传 undefined，而不是拿空串冒充归属', async () => {
    const runner = await PipelineRunner.createDefault()
    await runner.run({
      outputs: [],
      sessionId: 'sess-B',
      adapterName: 'claude-code',
    })

    expect(captured).not.toBeNull()
    expect(captured!.projectId).toBeUndefined()
  })

  it('没有 adapterName 时兜底成 unknown，不影响归属字段', async () => {
    const runner = await PipelineRunner.createDefault()
    await runner.run({
      outputs: [],
      sessionId: 'sess-C',
      projectId: '/projects/demo',
    })

    expect(captured).not.toBeNull()
    expect(captured!.adapterName).toBe('unknown')
    expect(captured!.projectId).toBe('/projects/demo')
  })
})
