/**
 * EmbeddingService 初始化状态测试
 *
 * 通过 mock @xenova/transformers 避免加载真实模型。
 */

import { describe, it, expect, vi } from 'vitest'
import { EmbeddingService, setEmbeddingServiceForTesting } from '../embedding-service'

vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn().mockRejectedValue(new Error('model load failed')),
}))

describe('EmbeddingService init state', () => {
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
