import { describe, it, expect } from 'vitest'
import { clusterCommunities, buildCommunitySummaryPrompt, toCommunitySummary } from '../community/clustering'
import type { ScanModule } from '@shared/types'

const mockModules: ScanModule[] = [
  {
    name: 'Auth',
    description: 'Authentication module',
    processes: [
      {
        name: 'Login',
        description: 'User login process',
        features: [
          { name: 'Login Form', description: 'Login form UI' },
          { name: 'Token Validation', description: 'Validate JWT tokens' },
        ],
      },
    ],
  },
  {
    name: 'Payment',
    description: 'Payment processing',
    processes: [
      {
        name: 'Checkout',
        description: 'Checkout process',
        features: [
          { name: 'Cart Review', description: 'Review cart items' },
        ],
      },
    ],
  },
]

describe('clusterCommunities', () => {
  it('creates level 0 project cluster', async () => {
    const clusters = await clusterCommunities('/project', mockModules)
    const level0 = clusters.filter((c) => c.level === 0)
    expect(level0.length).toBe(1)
    expect(level0[0].title).toContain('project')
  })

  it('creates level 1 module clusters', async () => {
    const clusters = await clusterCommunities('/project', mockModules)
    const level1 = clusters.filter((c) => c.level === 1)
    expect(level1.length).toBe(2)
    expect(level1.some((c) => c.title.includes('Auth'))).toBe(true)
    expect(level1.some((c) => c.title.includes('Payment'))).toBe(true)
  })

  it('creates level 2 process clusters', async () => {
    const clusters = await clusterCommunities('/project', mockModules)
    const level2 = clusters.filter((c) => c.level === 2)
    expect(level2.length).toBe(2)
    expect(level2.some((c) => c.title.includes('Login'))).toBe(true)
    expect(level2.some((c) => c.title.includes('Checkout'))).toBe(true)
  })

  it('returns empty array for no modules', async () => {
    const clusters = await clusterCommunities('/project', [])
    expect(clusters.length).toBe(1) // only level 0
  })
})

describe('buildCommunitySummaryPrompt', () => {
  it('generates level 0 prompt', () => {
    const prompt = buildCommunitySummaryPrompt(
      { id: 'c1', title: 'Project', nodeIds: [], filePaths: [], level: 0 },
      'context',
    )
    expect(prompt).toContain('业务架构分析师')
    expect(prompt).toContain('项目架构摘要')
  })

  it('generates level 1 prompt', () => {
    const prompt = buildCommunitySummaryPrompt(
      { id: 'c1', title: 'Auth Module', nodeIds: [], filePaths: [], level: 1 },
      'context',
    )
    expect(prompt).toContain('模块摘要')
    expect(prompt).toContain('Auth Module')
  })

  it('generates level 2 prompt', () => {
    const prompt = buildCommunitySummaryPrompt(
      { id: 'c1', title: 'Auth > Login', nodeIds: [], filePaths: [], level: 2 },
      'context',
    )
    expect(prompt).toContain('流程摘要')
    expect(prompt).toContain('Auth > Login')
  })
})

describe('toCommunitySummary', () => {
  it('converts cluster to CommunitySummary', () => {
    const cluster = { id: 'c1', title: 'Test', nodeIds: ['n1'], filePaths: [], level: 1 }
    const result = toCommunitySummary(cluster, 'summary text', ['finding1'])
    expect(result.id).toBe('c1')
    expect(result.title).toBe('Test')
    expect(result.summary).toBe('summary text')
    expect(result.keyFindings).toEqual(['finding1'])
    expect(result.level).toBe(1)
    expect(result.nodeIds).toEqual(['n1'])
  })

  it('uses empty findings by default', () => {
    const cluster = { id: 'c1', title: 'Test', nodeIds: [], filePaths: [], level: 0 }
    const result = toCommunitySummary(cluster, 'summary')
    expect(result.keyFindings).toEqual([])
  })
})
