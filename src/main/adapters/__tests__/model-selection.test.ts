import { describe, it, expect } from 'vitest'
import { resolveModelForAdapter } from '../model-selection'

describe('resolveModelForAdapter', () => {
  it('优先取按适配器分开的档位', () => {
    const s = { defaultModels: { claudeCode: 'sonnet-4-5', codex: 'gpt-5' }, defaultModel: 'legacy' }
    expect(resolveModelForAdapter(s, 'claude-code')).toBe('sonnet-4-5')
    expect(resolveModelForAdapter(s, 'codex')).toBe('gpt-5')
  })

  it('claude-code 档位为空时回落到旧的 defaultModel', () => {
    expect(resolveModelForAdapter({ defaultModel: 'legacy' }, 'claude-code')).toBe('legacy')
  })

  it('mcp 档位为空时不回落到 defaultModel（避免 provider 误判）', () => {
    expect(resolveModelForAdapter({ defaultModel: 'claude-3-7-sonnet-20250219' }, 'mcp')).toBeUndefined()
  })

  it('codex 档位为空时回落到 undefined（由 codex SDK 自己决定默认模型）', () => {
    expect(resolveModelForAdapter({ defaultModel: 'legacy' }, 'codex')).toBeUndefined()
    expect(resolveModelForAdapter({ defaultModels: { codex: 'gpt-5' } }, 'codex')).toBe('gpt-5')
  })

  it('mcp 档位有值时用它，且不被 defaultModel 覆盖', () => {
    const s = { defaultModels: { mcp: 'gpt-4o' }, defaultModel: 'claude-3-7-sonnet-20250219' }
    expect(resolveModelForAdapter(s, 'mcp')).toBe('gpt-4o')
  })

  it('没有任何配置时返回 undefined', () => {
    expect(resolveModelForAdapter({}, 'claude-code')).toBeUndefined()
    expect(resolveModelForAdapter({}, 'codex')).toBeUndefined()
    expect(resolveModelForAdapter({}, 'mcp')).toBeUndefined()
  })

  it('空字符串视为未设置', () => {
    const s = { defaultModels: { claudeCode: '', codex: '', mcp: '' }, defaultModel: 'legacy' }
    expect(resolveModelForAdapter(s, 'claude-code')).toBe('legacy')
    expect(resolveModelForAdapter(s, 'codex')).toBeUndefined()
    expect(resolveModelForAdapter(s, 'mcp')).toBeUndefined()
  })

  it('档位值不是字符串时视为未设置（settings.json 可被手改）', () => {
    const s = {
      defaultModels: { claudeCode: 123, codex: {}, mcp: null },
      defaultModel: 'legacy',
    } as unknown as Parameters<typeof resolveModelForAdapter>[0]
    expect(resolveModelForAdapter(s, 'claude-code')).toBe('legacy')
    expect(resolveModelForAdapter(s, 'codex')).toBeUndefined()
    expect(resolveModelForAdapter(s, 'mcp')).toBeUndefined()
  })
})
