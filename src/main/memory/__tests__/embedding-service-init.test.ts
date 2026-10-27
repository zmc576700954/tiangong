/**
 * EmbeddingService 初始化状态测试
 *
 * 通过 mock @xenova/transformers 避免加载真实模型。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EmbeddingService, setEmbeddingServiceForTesting } from '../embedding-service'

const { pipelineMock } = vi.hoisted(() => ({ pipelineMock: vi.fn() }))

vi.mock('@xenova/transformers', () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}))

/** 一个假的特征提取器，形状对齐 Xenova pipeline 的返回值 */
function fakeExtractor() {
  return vi.fn(async () => ({ data: new Float32Array(384) }))
}

describe('EmbeddingService init state', () => {
  beforeEach(() => {
    pipelineMock.mockReset()
    pipelineMock.mockRejectedValue(new Error('model load failed'))
  })

  it('sets initAttempted at the start of initialize()', async () => {
    const service = new EmbeddingService()
    setEmbeddingServiceForTesting(service)

    expect(service.isInitAttempted()).toBe(false)

    try {
      await service.initialize()
    } catch {
      // expected to fail because pipeline is mocked to reject
    }

    expect(service.isInitAttempted()).toBe(true)
  })

  it('sets initAttempted at the start of initializeWithTimeout()', async () => {
    const service = new EmbeddingService()
    setEmbeddingServiceForTesting(service)

    expect(service.isInitAttempted()).toBe(false)

    const ok = await service.initializeWithTimeout(1_000)

    expect(ok).toBe(false)
    expect(service.isInitAttempted()).toBe(true)
    expect(service.isFailed()).toBe(true)
  })
})

describe('EmbeddingService ensureInitialized', () => {
  beforeEach(() => {
    pipelineMock.mockReset()
    pipelineMock.mockRejectedValue(new Error('model load failed'))
  })

  it('加载失败后不再重试（模型加载只在会话结束时触发，不能每次都重下一次）', async () => {
    const service = new EmbeddingService()
    setEmbeddingServiceForTesting(service)

    expect(await service.ensureInitialized(1_000)).toBe(false)
    expect(await service.ensureInitialized(1_000)).toBe(false)

    expect(pipelineMock).toHaveBeenCalledTimes(1)
  })

  it('并发调用只触发一次模型加载', async () => {
    pipelineMock.mockImplementation(async () => fakeExtractor())
    const service = new EmbeddingService()
    setEmbeddingServiceForTesting(service)

    const results = await Promise.all([
      service.ensureInitialized(1_000),
      service.ensureInitialized(1_000),
      service.ensureInitialized(1_000),
    ])

    expect(results).toEqual([true, true, true])
    expect(pipelineMock).toHaveBeenCalledTimes(1)
    expect(service.isReady()).toBe(true)
  })

  it('已就绪时直接返回 true，不再触碰模型加载', async () => {
    pipelineMock.mockImplementation(async () => fakeExtractor())
    const service = new EmbeddingService()
    setEmbeddingServiceForTesting(service)

    expect(await service.ensureInitialized(1_000)).toBe(true)
    expect(await service.ensureInitialized(1_000)).toBe(true)
    expect(pipelineMock).toHaveBeenCalledTimes(1)
  })

  it('模型加载卡住时按自己的超时返回 false，不把调用方一起挂死', async () => {
    pipelineMock.mockImplementation(() => new Promise(() => { /* 永远不 settle */ }))
    const service = new EmbeddingService()
    setEmbeddingServiceForTesting(service)

    expect(await service.ensureInitialized(50)).toBe(false)
    expect(service.isTimedOut()).toBe(true)
    // 超时后不再重试
    expect(await service.ensureInitialized(50)).toBe(false)
    expect(pipelineMock).toHaveBeenCalledTimes(1)
  })
})
