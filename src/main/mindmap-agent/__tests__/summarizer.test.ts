import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock runClaude
const mockRunClaude = vi.fn()
vi.mock('../claude-runner', () => ({
  runClaude: (...args: unknown[]) => mockRunClaude(...args),
}))

import { generateSummary, mapReduceSummarize } from '../community/summarizer'
import type { CommunityCluster } from '../community/clustering'
import type { ScanModule } from '@shared/types'

describe('generateSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Claude output on success', async () => {
    mockRunClaude.mockResolvedValue({
      exitCode: 0,
      stdout: 'This is the summary',
      stderr: '',
      timedOut: false,
    })

    const cluster: CommunityCluster = {
      id: 'c1',
      title: 'Test Module',
      nodeIds: [],
      filePaths: [],
      level: 1,
    }

    const result = await generateSummary(cluster, 'context', '/project')
    expect(result).toBe('This is the summary')
  })

  it('returns fallback on failure', async () => {
    mockRunClaude.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'error',
      timedOut: false,
    })

    const cluster: CommunityCluster = {
      id: 'c1',
      title: 'Test Module',
      nodeIds: [],
      filePaths: [],
      level: 1,
    }

    const result = await generateSummary(cluster, 'some context text', '/project')
    expect(result).toContain('Test Module')
  })

  it('returns fallback on timeout', async () => {
    mockRunClaude.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: true,
    })

    const cluster: CommunityCluster = {
      id: 'c1',
      title: 'Test Module',
      nodeIds: [],
      filePaths: [],
      level: 1,
    }

    const result = await generateSummary(cluster, 'context', '/project')
    expect(result).toContain('Test Module')
  })

  it('returns fallback on empty output', async () => {
    mockRunClaude.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    })

    const cluster: CommunityCluster = {
      id: 'c1',
      title: 'Test Module',
      nodeIds: [],
      filePaths: [],
      level: 1,
    }

    const result = await generateSummary(cluster, 'context', '/project')
    expect(result).toContain('Test Module')
  })
})

describe('mapReduceSummarize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generates summaries for all modules', async () => {
    mockRunClaude.mockResolvedValue({
      exitCode: 0,
      stdout: 'Module summary',
      stderr: '',
      timedOut: false,
    })

    const modules: ScanModule[] = [
      {
        name: 'Auth',
        description: 'Auth module',
        processes: [{ name: 'Login', description: 'Login', features: [] }],
      },
    ]

    const result = await mapReduceSummarize(modules, '/project', 'TestProject')
    expect(result.has('Auth')).toBe(true)
    expect(result.has('__project__')).toBe(true)
  })
})
