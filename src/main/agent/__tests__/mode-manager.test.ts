/**
 * ModeManager 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ModeManager } from '../mode-manager'

describe('ModeManager', () => {
  let manager: ModeManager

  beforeEach(() => {
    manager = new ModeManager()
  })

  describe('getMode / setMode', () => {
    it('returns general as default mode for unknown project', () => {
      expect(manager.getMode('unknown-project')).toBe('general')
    })

    it('sets and retrieves mode per project', () => {
      manager.setMode('project-a', 'security')
      expect(manager.getMode('project-a')).toBe('security')
    })

    it('keeps modes isolated between projects', () => {
      manager.setMode('project-a', 'performance')
      manager.setMode('project-b', 'refactor')
      expect(manager.getMode('project-a')).toBe('performance')
      expect(manager.getMode('project-b')).toBe('refactor')
    })

    it('overwrites existing mode for same project', () => {
      manager.setMode('project-a', 'security')
      manager.setMode('project-a', 'general')
      expect(manager.getMode('project-a')).toBe('general')
    })
  })

  describe('getConfig', () => {
    it('returns full config for general mode', () => {
      const config = manager.getConfig('unknown-project')
      expect(config.name).toBe('general')
      expect(config.investigationFocus).toContain('代码结构')
      expect(config.fixSafety).toBe('standard')
      expect(config.systemPromptSuffix.length).toBeGreaterThan(0)
    })

    it('returns different config for security mode', () => {
      manager.setMode('project-a', 'security')
      const config = manager.getConfig('project-a')
      expect(config.name).toBe('security')
      expect(config.fixSafety).toBe('strict')
      expect(config.investigationFocus).toContain('输入验证')
    })

    it('returns different config for performance mode', () => {
      manager.setMode('project-a', 'performance')
      const config = manager.getConfig('project-a')
      expect(config.name).toBe('performance')
      expect(config.fixSafety).toBe('aggressive')
    })

    it('returns different config for refactor mode', () => {
      manager.setMode('project-a', 'refactor')
      const config = manager.getConfig('project-a')
      expect(config.name).toBe('refactor')
      expect(config.fixSafety).toBe('standard')
    })
  })

  describe('getAvailableModes', () => {
    it('returns all 4 modes', () => {
      const modes = manager.getAvailableModes()
      expect(modes).toHaveLength(4)
      const names = modes.map((m) => m.name)
      expect(names).toContain('general')
      expect(names).toContain('security')
      expect(names).toContain('performance')
      expect(names).toContain('refactor')
    })

    it('each mode has required fields', () => {
      const modes = manager.getAvailableModes()
      for (const mode of modes) {
        expect(mode.name).toBeDefined()
        expect(mode.description.length).toBeGreaterThan(0)
        expect(mode.investigationFocus.length).toBeGreaterThan(0)
        expect(mode.reviewPriorities.length).toBeGreaterThan(0)
        expect(['strict', 'standard', 'aggressive']).toContain(mode.fixSafety)
        expect(mode.systemPromptSuffix.length).toBeGreaterThan(0)
        expect(mode.memoryTypes.length).toBeGreaterThan(0)
      }
    })
  })

  describe('resolvePromptContext', () => {
    it('returns prompt context for given project', () => {
      manager.setMode('project-a', 'security')
      const ctx = manager.resolvePromptContext('project-a')
      expect(ctx.suffix.length).toBeGreaterThan(0)
      expect(ctx.focusAreas.length).toBeGreaterThan(0)
      expect(ctx.safety).toBe('strict')
      expect(ctx.memoryTypes.length).toBeGreaterThan(0)
    })

    it('uses general defaults for unknown project', () => {
      const ctx = manager.resolvePromptContext('unknown')
      expect(ctx.safety).toBe('standard')
    })
  })

  describe('formatModePromptSection', () => {
    it('generates readable prompt text', () => {
      manager.setMode('project-a', 'performance')
      const text = manager.formatModePromptSection('project-a')
      expect(text).toContain('performance')
      expect(text).toContain('调查关注点')
      expect(text).toContain('审查优先级')
      expect(text).toContain('aggressive')
    })
  })

  describe('config overrides', () => {
    it('applies partial override to mode config', () => {
      manager.setConfigOverride('general', {
        fixSafety: 'aggressive',
        systemPromptSuffix: 'Custom suffix',
      })
      const config = manager.getConfig('project-a')
      expect(config.fixSafety).toBe('aggressive')
      expect(config.systemPromptSuffix).toBe('Custom suffix')
      // 未覆盖字段保持默认
      expect(config.name).toBe('general')
      expect(config.investigationFocus.length).toBeGreaterThan(0)
    })

    it('clears override correctly', () => {
      manager.setConfigOverride('general', { fixSafety: 'strict' })
      manager.clearConfigOverride('general')
      const config = manager.getConfig('project-a')
      expect(config.fixSafety).toBe('standard')
    })

    it('merge applies to getAvailableModes', () => {
      manager.setConfigOverride('security', {
        systemPromptSuffix: 'Merged suffix',
      })
      const security = manager.getAvailableModes().find((m) => m.name === 'security')
      expect(security?.systemPromptSuffix).toBe('Merged suffix')
    })
  })

  describe('clearProjectMode', () => {
    it('removes project mode record', () => {
      manager.setMode('project-a', 'security')
      manager.clearProjectMode('project-a')
      expect(manager.getMode('project-a')).toBe('general')
      expect(manager.getCustomizedProjects()).not.toContain('project-a')
    })
  })

  describe('getCustomizedProjects', () => {
    it('returns only projects with non-general mode', () => {
      manager.setMode('project-a', 'security')
      manager.setMode('project-b', 'general')
      manager.setMode('project-c', 'performance')
      const customized = manager.getCustomizedProjects()
      expect(customized).toContain('project-a')
      expect(customized).toContain('project-c')
      expect(customized).not.toContain('project-b')
    })
  })
})
