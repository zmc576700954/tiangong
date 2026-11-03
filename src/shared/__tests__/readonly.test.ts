import { describe, it, expect } from 'vitest'
import { resolveReadonly } from '../readonly'
import {
  getReadonlySupport,
  listReadonlyCapableAdapters,
  isReadonlyOptOutAdapter,
} from '../readonly-support'

describe('resolveReadonly', () => {
  it('allowedFiles 为空且未显式指定 → 只读', () => {
    expect(resolveReadonly({ allowedFiles: [] })).toBe(true)
  })

  it('allowedFiles 非空 → 可写', () => {
    expect(resolveReadonly({ allowedFiles: ['/tmp/a.ts'] })).toBe(false)
  })

  it('空的 allowedFiles 一律只读 —— 即使显式 readOnly:false 也不行', () => {
    // 空范围 ⇒ 主进程**不建 ScopeGuard 沙箱**（沙箱只在 allowedFiles 非空时建）
    // —— 放行「空范围 + 可写」等于给出一个完全不受限的可写会话。
    expect(resolveReadonly({ allowedFiles: [], readOnly: false })).toBe(true)
  })

  it('optOut：适配器自带写保护 ⇒ 退出只读推导', () => {
    // mindmap-internal 靠 CLI 的 --disallowedTools、verifyOnly 靠空名单沙箱 ——
    // 它们的写保护不靠 ScopeGuard，所以要显式退出推导。
    expect(resolveReadonly({ allowedFiles: [], optOut: true })).toBe(false)
  })

  it('显式 readOnly: true 覆盖推导（即使有文件范围也只读）', () => {
    expect(resolveReadonly({ allowedFiles: ['/tmp/a.ts'], readOnly: true })).toBe(true)
  })
})

describe('getReadonlySupport', () => {
  it('claude-code / codex / mcp 保证只读', () => {
    expect(getReadonlySupport('claude-code')).toBe('enforced')
    expect(getReadonlySupport('codex')).toBe('enforced')
    expect(getReadonlySupport('mcp')).toBe('enforced')
  })

  it('mindmap-internal **不**保证只读（它的禁写清单漏了 Bash，且探测失败时 fail-open）', () => {
    // 它 spawn 的是 claude CLI，写工具靠 CLI 的 --disallowedTools 挡，
    // 而那个黑名单既漏了 Bash / MultiEdit，探测失败时还会一个禁用参数都不加。
    // 保证名单里不能有它。
    expect(getReadonlySupport('mindmap-internal')).toBe('unsupported')
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

describe('isReadonlyOptOutAdapter', () => {
  it('mindmap-internal 需要显式退出只读推导', () => {
    // 内部一次性生成流程的写保护由适配器自己负责，
    // 不能让它从「空的 allowedFiles」偶然推导出只读（那样会直接抛错、生成起不来）
    expect(isReadonlyOptOutAdapter('mindmap-internal')).toBe(true)
  })

  it('用户会话用的适配器不退出（它们必须服从只读推导）', () => {
    expect(isReadonlyOptOutAdapter('claude-code')).toBe(false)
    expect(isReadonlyOptOutAdapter('codex')).toBe(false)
    expect(isReadonlyOptOutAdapter('mcp')).toBe(false)
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
