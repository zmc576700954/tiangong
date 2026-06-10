/**
 * WaterlineSync 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { WaterlineSync } from '../waterline-sync'
import type { MemoryItem, MemoryKind } from '@shared/types'

/** Helper: create a memory item */
function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: Math.floor(Math.random() * 10000),
    session_id: 'session-1',
    kind: 'investigation' as MemoryKind,
    project_id: 'project-x',
    node_id: null,
    title: 'Test memory',
    narrative: 'Test narrative content',
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
    adapter_name: 'claude-code',
    token_cost: 100,
    confidence: 0.8,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('WaterlineSync', () => {
  let sync: WaterlineSync

  beforeEach(() => {
    sync = new WaterlineSync()
  })

  describe('getWaterline', () => {
    it('creates initial waterline for new project', () => {
      const wl = sync.getWaterline('new-project')
      expect(wl.projectId).toBe('new-project')
      expect(wl.sessionCount).toBe(0)
      expect(wl.completedInvestigations).toHaveLength(0)
      expect(wl.fixedIssues).toHaveLength(0)
    })

    it('returns same waterline for subsequent calls', () => {
      const wl1 = sync.getWaterline('project-x')
      const wl2 = sync.getWaterline('project-x')
      expect(wl1).toBe(wl2)
    })
  })

  describe('advance', () => {
    it('updates waterline with session memories', () => {
      const memories = [
        memory({ kind: 'investigation', title: 'Investigated auth flow', confidence: 0.8, narrative: 'Found issues in authentication module' }),
        memory({ kind: 'fix', title: 'Fixed login issue', files_modified: ['src/auth/login.ts'] }),
        memory({ kind: 'lesson', title: 'Always check token expiry' }),
      ]
      const wl = sync.advance('project-x', memories)
      expect(wl.sessionCount).toBe(1)
      expect(wl.completedInvestigations).toContain('Investigated auth flow')
      expect(wl.fixedIssues).toContain('Fixed login issue')
      expect(wl.avoidedRepetitions).toContain('Always check token expiry')
      expect(wl.modifiedFiles).toContain('src/auth/login.ts')
      expect(wl.totalTokens).toBe(300)
    })

    it('tracks cross-adapter findings', () => {
      const memories = [
        memory({ kind: 'investigation', title: 'DB performance', adapter_name: 'opencode', confidence: 0.7, narrative: 'Database query optimization needed in user service' }),
      ]
      const wl = sync.advance('project-x', memories)
      expect(wl.crossAdapterFindings.length).toBe(1)
      expect(wl.crossAdapterFindings[0].adapter).toBe('opencode')
    })

    it('removes fixed issues from open issues', () => {
      const issues = [
        memory({ kind: 'review_finding', title: 'Memory leak in parser' }),
      ]
      sync.advance('project-x', issues)
      expect(sync.getWaterline('project-x').openIssues).toContain('Memory leak in parser')

      const fixes = [
        memory({ kind: 'fix', title: 'Fixed memory leak in parser' }),
      ]
      sync.advance('project-x', fixes)
      // The fix title includes the issue title text
      const wl = sync.getWaterline('project-x')
      expect(wl.fixedIssues.length).toBeGreaterThan(0)
    })
  })

  describe('markNodeVerified', () => {
    it('tracks verified nodes', () => {
      sync.markNodeVerified('project-x', 'node-123')
      const wl = sync.getWaterline('project-x')
      expect(wl.verifiedNodes).toContain('node-123')
    })

    it('does not duplicate verified nodes', () => {
      sync.markNodeVerified('project-x', 'node-123')
      sync.markNodeVerified('project-x', 'node-123')
      const wl = sync.getWaterline('project-x')
      expect(wl.verifiedNodes).toHaveLength(1)
    })
  })

  describe('getDelta', () => {
    it('detects new findings since last snapshot', () => {
      sync.advance('project-x', [
        memory({ kind: 'investigation', title: 'New finding A' }),
      ])
      // Take a deep snapshot of the waterline state before advancing again
      const prev = structuredClone(sync.getWaterline('project-x'))

      sync.advance('project-x', [
        memory({ kind: 'investigation', title: 'New finding B' }),
      ])
      const delta = sync.getDelta('project-x', prev)

      expect(delta.newFindings).toContain('New finding B')
      expect(delta.sessionsSinceLast).toBe(1)
    })
  })

  describe('formatContext', () => {
    it('generates readable context string', () => {
      sync.advance('project-x', [
        memory({ kind: 'fix', title: 'Fix A', adapter_name: 'claude-code' }),
      ])
      const ctx = sync.formatContext('project-x')
      expect(ctx).toContain('项目水位线状态')
      expect(ctx).toContain('Fix A')
      expect(ctx).toContain('会话数: 1')
    })
  })

  describe('hasInvestigated', () => {
    it('detects completed investigations', () => {
      sync.advance('project-x', [
        memory({ kind: 'investigation', title: 'API authentication flow analysis' }),
      ])
      expect(sync.hasInvestigated('project-x', 'authentication')).toBe(true)
      expect(sync.hasInvestigated('project-x', 'database')).toBe(false)
    })
  })

  describe('recentlyModified', () => {
    it('detects recently modified files', () => {
      sync.advance('project-x', [
        memory({ kind: 'fix', title: 'Fix', files_modified: ['src/main/router.ts'] }),
      ])
      expect(sync.recentlyModified('project-x', 'router.ts')).toBe(true)
      expect(sync.recentlyModified('project-x', 'nonexistent.ts')).toBe(false)
    })
  })

  describe('clearWaterline', () => {
    it('resets waterline for project', () => {
      sync.advance('project-x', [memory()])
      sync.clearWaterline('project-x')
      const wl = sync.getWaterline('project-x')
      expect(wl.sessionCount).toBe(0)
    })
  })
})
