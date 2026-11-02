import { describe, it, expect } from 'vitest'
import { resolveReadonly } from '../readonly'
import {
  getReadonlySupport,
  listReadonlyCapableAdapters,
} from '../readonly-support'

describe('resolveReadonly', () => {
  it('allowedFiles 为空且未显式指定 → 只读', () => {
    expect(resolveReadonly({ allowedFiles: [] })).toBe(true)
  })

  it('allowedFiles 非空 → 可写', () => {
    expect(resolveReadonly({ allowedFiles: ['/tmp/a.ts'] })).toBe(false)
  })

  it('显式 readOnly: false 覆盖推导（允许强制放开）', () => {
    expect(resolveReadonly({ allowedFiles: [], readOnly: false })).toBe(false)
  })

  it('显式 readOnly: true 覆盖推导（即使有文件范围也只读）', () => {
    expect(resolveReadonly({ allowedFiles: ['/tmp/a.ts'], readOnly: true })).toBe(true)
  })
})

describe('getReadonlySupport', () => {
  it('claude-code / codex / mcp / mindmap-internal 保证只读', () => {
    expect(getReadonlySupport('claude-code')).toBe('enforced')
    expect(getReadonlySupport('codex')).toBe('enforced')
    expect(getReadonlySupport('mcp')).toBe('enforced')
    expect(getReadonlySupport('mindmap-internal')).toBe('enforced')
  })

  it('其余 CLI 适配器无法保证只读', () => {
    for (const name of ['cline', 'kilo-code', 'kimi-code', 'codebuddy', 'qoder', 'qwen-code', 'cursor', 'opencode']) {
      expect(getReadonlySupport(name)).toBe('unsupported')
    }
  })

  it('未注册的适配器一律视为不支持（未知不能被信任为只读）', () => {
    expect(getReadonlySupport('some-unknown-adapter')).toBe('unsupported')
    expect(getReadonlySupport('')).toBe('unsupported')
  })
})

describe('listReadonlyCapableAdapters', () => {
  it('只保留支持只读的，保持原顺序', () => {
    expect(listReadonlyCapableAdapters(['claude-code', 'cline', 'codex', 'mcp', 'qwen-code']))
      .toEqual(['claude-code', 'codex', 'mcp'])
  })

  it('全都不支持时返回空数组', () => {
    expect(listReadonlyCapableAdapters(['cline', 'cursor'])).toEqual([])
  })
})
