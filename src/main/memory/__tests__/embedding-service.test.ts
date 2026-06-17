/**
 * EmbeddingService 单元测试
 *
 * 首次运行会下载 all-MiniLM-L6-v2 模型（~30MB），
 * 后续测试从本地缓存加载。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { EmbeddingService, setEmbeddingServiceForTesting } from '../embedding-service'

describe('EmbeddingService', () => {
  let service: EmbeddingService

  beforeEach(() => {
    // 每个测试用独立实例，避免 init 状态泄漏
    service = new EmbeddingService()
    setEmbeddingServiceForTesting(service)
  })

  it('generateEmbedding returns 384-dim vector', async () => {
    const vector = await service.generateEmbedding('fix the authentication bug')

    expect(Array.isArray(vector)).toBe(true)
    expect(vector.length).toBe(384)
    // 归一化向量各元素应为有限数值
    for (const v of vector) {
      expect(Number.isFinite(v)).toBe(true)
    }
  }, 30000)

  it('generateEmbedding returns similar vectors for similar text', async () => {
    const similar1 = await service.generateEmbedding('fix auth bug')
    const similar2 = await service.generateEmbedding('resolve auth issue')
    const dissimilar = await service.generateEmbedding('optimize database query')

    const simScore = EmbeddingService.cosineSimilarity(similar1, similar2)
    const dissimScore = EmbeddingService.cosineSimilarity(similar1, dissimilar)

    // 相似文本的余弦相似度应高于不相似文本
    expect(simScore).toBeGreaterThan(dissimScore)
  }, 30000)

  it('cosineSimilarity returns 1 for identical vectors', () => {
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5]
    const score = EmbeddingService.cosineSimilarity(vec, vec)
    expect(score).toBeCloseTo(1.0, 5)
  })

  it('isReady returns false before init, true after', async () => {
    const freshService = new EmbeddingService()
    expect(freshService.isReady()).toBe(false)

    await freshService.initialize()
    expect(freshService.isReady()).toBe(true)
  }, 30000)
})
