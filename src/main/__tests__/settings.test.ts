import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BizGraphSettings, AdapterPreferences } from '../settings'
import type { A2AServerConfig, A2ARemoteAgent, A2AAgentCard } from '@shared/types/a2a'

const mockUserDataPath = '/tmp/bizgraph-test'
const mockFsData = new Map<string, string>()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/tmp/${name}`
    }),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((plain: string) => Buffer.from(`mock-enc-${plain}`)),
    decryptString: vi.fn((buf: Buffer) => {
      const str = buf.toString('utf8')
      return str.replace('mock-enc-', '')
    }),
  },
}))

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async (filePath: string) => {
      const normalized = filePath.replace(/\\/g, '/')
      if (mockFsData.has(normalized)) return mockFsData.get(normalized)!
      const err = new Error('ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    }),
    writeFile: vi.fn(async (filePath: string, data: string) => {
      const normalized = filePath.replace(/\\/g, '/')
      mockFsData.set(normalized, data)
    }),
  },
}))

describe('Settings - Encryption', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('should encrypt and decrypt API key round-trip (fallback)', async () => {
    const { writeSettings, readSettings } = await import('../settings')

    const settings = {
      version: 1,
      cliTools: [],
      apiKeys: [{ provider: 'anthropic', key: 'sk-test-key-12345' }],
      defaultModel: 'claude-3-7-sonnet-20250219',
      mcpServers: [],
    }

    await writeSettings(settings as BizGraphSettings)
    const read = await readSettings()

    expect(read.apiKeys).toHaveLength(1)
    expect(read.apiKeys[0].key).toBe('sk-test-key-12345')
  })

  it('keeps the rest of the settings when one API key cannot be decrypted', async () => {
    const { readSettings } = await import('../settings')

    const malformed = {
      version: 1,
      cliTools: [],
      apiKeys: [{ provider: 'anthropic', key: 'fbk:invalid-no-colon' }],
      mcpServers: [],
    }
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify(malformed))

    const read = await readSettings()
    // 单个 key 解不开只降级这个 key（空串）。整份配置不能回退到默认值：
    // 下一次 writeSettings 会把默认值覆盖到 settings.json —— 用户的
    // MCP server / 自定义 agent 类型会跟着一起丢。
    expect(read.apiKeys).toEqual([{ provider: 'anthropic', key: '' }])
    expect(read.version).toBe(1)
  })

  it('keeps the rest of the settings when the fallback IV length is invalid', async () => {
    const { readSettings } = await import('../settings')

    const shortIv = Buffer.from('ab').toString('base64')
    const fakeEncrypted = Buffer.from('fake').toString('base64')
    const malformed = {
      version: 1,
      cliTools: [],
      apiKeys: [{ provider: 'anthropic', key: `fbk:${shortIv}:${fakeEncrypted}` }],
      mcpServers: [],
    }
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify(malformed))

    const read = await readSettings()
    expect(read.apiKeys).toEqual([{ provider: 'anthropic', key: '' }])
    expect(read.version).toBe(1)
  })

  it('should handle backward-compatible plain: prefix', async () => {
    const { readSettings } = await import('../settings')

    const legacyKey = Buffer.from('legacy-key-value').toString('base64')
    const legacy = {
      version: 1,
      cliTools: [],
      apiKeys: [{ provider: 'openai', key: `plain:${legacyKey}` }],
      mcpServers: [],
    }
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify(legacy))

    const read = await readSettings()
    expect(read.apiKeys[0].key).toBe('legacy-key-value')
  })

  it('should handle unencrypted plain text (backward compatibility)', async () => {
    const { readSettings } = await import('../settings')

    const legacy = {
      version: 1,
      cliTools: [],
      apiKeys: [{ provider: 'deepseek', key: 'plain-text-key' }],
      mcpServers: [],
    }
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify(legacy))

    const read = await readSettings()
    expect(read.apiKeys[0].key).toBe('plain-text-key')
  })

  it('should merge default settings with saved settings', async () => {
    const { readSettings } = await import('../settings')

    const partial = {
      version: 2,
      apiKeys: [],
    }
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify(partial))

    const read = await readSettings()
    expect(read.version).toBe(2)
    expect(read.cliTools.length).toBeGreaterThan(0)
    expect(read.defaultModel).toBeDefined()
  })

  it('should preserve writeback.enabled false from saved settings', async () => {
    const { readSettings } = await import('../settings')

    const saved = {
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      writeback: { enabled: false },
    }
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify(saved))

    const read = await readSettings()
    expect(read.writeback).toEqual({ enabled: false })
  })

  it('should fall back to defaults when writeback.enabled is not a boolean', async () => {
    const { readSettings } = await import('../settings')

    const saved = {
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      writeback: { enabled: 'false' },
    }
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify(saved))

    const read = await readSettings()
    expect(read.writeback).toEqual({ enabled: true }) // 非法结构整体回退默认
  })

  it('should return defaults when settings file does not exist', async () => {
    const { readSettings } = await import('../settings')

    const read = await readSettings()
    expect(read.version).toBe(1)
    expect(read.cliTools.length).toBeGreaterThan(0)
  })
})

describe('Settings - Locale', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.resetModules()
  })

  it('defaults the locale to zh-CN', async () => {
    const { readSettings } = await import('../settings')
    const settings = await readSettings()
    expect(settings.locale).toBe('zh-CN')
  })

  it('persists a saved locale', async () => {
    const { writeSettings, readSettings } = await import('../settings')
    const current = await readSettings()
    await writeSettings({ ...current, locale: 'en-US' })
    const reread = await readSettings()
    expect(reread.locale).toBe('en-US')
    await writeSettings({ ...reread, locale: 'zh-CN' })
  })

  it('falls back to zh-CN when the saved locale is unknown', async () => {
    const { readSettings } = await import('../settings')

    mockFsData.set(
      `${mockUserDataPath}/settings.json`,
      JSON.stringify({ version: 1, cliTools: [], apiKeys: [], mcpServers: [], locale: 'fr-FR' }),
    )

    const read = await readSettings()
    expect(read.locale).toBe('zh-CN')
  })
})

describe('Settings - API Key Management', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.resetModules()
  })

  it('should set and get API key', async () => {
    const { setApiKey, getApiKey } = await import('../settings')

    await setApiKey('anthropic', 'sk-new-key')
    const key = await getApiKey('anthropic')
    expect(key).toBe('sk-new-key')
  })

  it('should update existing API key', async () => {
    const { setApiKey, getApiKey } = await import('../settings')

    await setApiKey('openai', 'sk-old')
    await setApiKey('openai', 'sk-new')
    const key = await getApiKey('openai')
    expect(key).toBe('sk-new')
  })

  it('should return undefined for missing provider', async () => {
    const { getApiKey } = await import('../settings')

    const key = await getApiKey('nonexistent')
    expect(key).toBeUndefined()
  })
})

describe('Settings - Adapter Preferences', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.resetModules()
  })

  it('should accept valid adapter preferences', async () => {
    const { setAdapterPreferences, getAdapterPreferences } = await import('../settings')

    const prefs = {
      defaultAdapter: 'claude-code',
      fallbackOrder: ['codex', 'opencode', 'mcp'],
    }
    await setAdapterPreferences(prefs)
    const read = await getAdapterPreferences()
    expect(read.defaultAdapter).toBe('claude-code')
    expect(read.fallbackOrder).toEqual(['codex', 'opencode', 'mcp'])
  })

  it('should reject unknown defaultAdapter', async () => {
    const { setAdapterPreferences } = await import('../settings')

    await expect(setAdapterPreferences({
      defaultAdapter: 'unknown-adapter',
      fallbackOrder: ['codex'],
    })).rejects.toThrow('Unknown defaultAdapter')
  })

  it('should reject unknown adapter in fallbackOrder', async () => {
    const { setAdapterPreferences } = await import('../settings')

    await expect(setAdapterPreferences({
      defaultAdapter: 'claude-code',
      fallbackOrder: ['codex', 'unknown-adapter'],
    })).rejects.toThrow('Unknown adapter in fallbackOrder')
  })

  it('should reject non-array fallbackOrder', async () => {
    const { setAdapterPreferences } = await import('../settings')

    await expect(setAdapterPreferences({
      defaultAdapter: 'claude-code',
      fallbackOrder: 'codex',
    } as unknown as AdapterPreferences)).rejects.toThrow('fallbackOrder must be an array')
  })

  it('should reject non-string entries in fallbackOrder', async () => {
    const { setAdapterPreferences } = await import('../settings')

    await expect(setAdapterPreferences({
      defaultAdapter: 'claude-code',
      fallbackOrder: ['codex', 123],
    } as unknown as AdapterPreferences)).rejects.toThrow('Unknown adapter in fallbackOrder')
  })

  it('should keep KNOWN_ADAPTER_NAMES in sync with the adapter registry', async () => {
    const { ADAPTER_REGISTRY } = await import('../adapters/registry')
    const registryNames = new Set(ADAPTER_REGISTRY.map((d) => d.name))
    const { setAdapterPreferences } = await import('../settings')

    // Verify every registry name is accepted
    await expect(setAdapterPreferences({
      defaultAdapter: 'claude-code',
      fallbackOrder: Array.from(registryNames),
    })).resolves.not.toThrow()
  })
})

// ============================================
// Phase D9: A2A config encryption + validation + onChange
// ============================================

const sampleAgentCard: A2AAgentCard = {
  a2aVersion: '0.3.0',
  name: 'bizgraph',
  description: 'BizGraph agent',
  url: 'http://127.0.0.1:8089',
  capabilities: ['streaming'],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [],
}

const sampleServerConfig: A2AServerConfig = {
  enabled: false,
  port: 8089,
  bindAddress: '127.0.0.1',
  apiKey: 'a-secret-key-must-be-at-least-16-chars',
  agentCard: sampleAgentCard,
}

const sampleRemoteAgent: A2ARemoteAgent = {
  name: 'peer-1',
  endpoint: 'https://peer.example.com:8443',
  apiKey: 'peer-secret-key-must-be-long-enough',
  tlsVerify: true,
  timeoutMs: 30000,
}

describe('Settings - A2A encryption', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('encrypts and decrypts a2aServer.apiKey round-trip', async () => {
    const { writeSettings, readSettings } = await import('../settings')

    await writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2aServer: { ...sampleServerConfig, apiKey: 'plain-server-key-1234567890' },
    } as BizGraphSettings)

    const read = await readSettings()
    expect(read.a2aServer?.apiKey).toBe('plain-server-key-1234567890')
    expect(read.a2aServer?.port).toBe(8089)
    expect(read.a2aServer?.bindAddress).toBe('127.0.0.1')
    expect(read.a2aServer?.agentCard.name).toBe('bizgraph')
  })

  it('encrypts and decrypts a2a.remoteAgents[].apiKey round-trip', async () => {
    const { writeSettings, readSettings } = await import('../settings')

    await writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2a: {
        remoteAgents: [
          { ...sampleRemoteAgent, apiKey: 'peer-1-secret-aaaaaaaaaaaaaaaaaaaa' },
          { ...sampleRemoteAgent, name: 'peer-2', endpoint: 'https://peer2.example.com', apiKey: 'peer-2-secret-bbbbbbbbbbbbbbbbbbbb' },
          { name: 'peer-3', endpoint: 'https://peer3.example.com', tlsVerify: true, timeoutMs: 30000 }, // no apiKey
        ],
      },
    } as BizGraphSettings)

    const read = await readSettings()
    expect(read.a2a?.remoteAgents).toHaveLength(3)
    expect(read.a2a?.remoteAgents[0].apiKey).toBe('peer-1-secret-aaaaaaaaaaaaaaaaaaaa')
    expect(read.a2a?.remoteAgents[1].apiKey).toBe('peer-2-secret-bbbbbbbbbbbbbbbbbbbb')
    expect(read.a2a?.remoteAgents[2].apiKey).toBeUndefined()
  })

  it('does not leak plaintext apiKey to disk', async () => {
    const { writeSettings } = await import('../settings')

    const secret = 'this-secret-must-not-appear-in-disk-12345'
    await writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2aServer: { ...sampleServerConfig, apiKey: secret },
    } as BizGraphSettings)

    const onDisk = mockFsData.get(`${mockUserDataPath}/settings.json`)
    expect(onDisk).toBeDefined()
    expect(onDisk).not.toContain(secret)
  })
})

describe('Settings - A2A shape validation', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('rejects invalid a2aServer.port (out of range)', async () => {
    const { writeSettings } = await import('../settings')

    await expect(writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2aServer: { ...sampleServerConfig, port: 99999 },
    } as BizGraphSettings)).rejects.toThrow()
  })

  it('rejects invalid a2aServer.bindAddress (not loopback or all)', async () => {
    const { writeSettings } = await import('../settings')

    await expect(writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2aServer: { ...sampleServerConfig, bindAddress: '0.0.0.1' as never },
    } as BizGraphSettings)).rejects.toThrow()
  })

  it('rejects a2a.remoteAgents[].endpoint that is not a URL', async () => {
    const { writeSettings } = await import('../settings')

    await expect(writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2a: {
        remoteAgents: [{ ...sampleRemoteAgent, endpoint: 'not-a-url' }],
      },
    } as BizGraphSettings)).rejects.toThrow()
  })

  it('rejects a2a.remoteAgents[].name being empty', async () => {
    const { writeSettings } = await import('../settings')

    await expect(writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2a: {
        remoteAgents: [{ ...sampleRemoteAgent, name: '' }],
      },
    } as BizGraphSettings)).rejects.toThrow()
  })

  it('rejects a2a.remoteAgents[].timeoutMs not being a number', async () => {
    const { writeSettings } = await import('../settings')

    await expect(writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2a: {
        remoteAgents: [{ ...sampleRemoteAgent, timeoutMs: '30000' as never }],
      },
    } as BizGraphSettings)).rejects.toThrow()
  })

  it('accepts valid a2aServer and a2a config', async () => {
    const { writeSettings } = await import('../settings')

    await expect(writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2aServer: sampleServerConfig,
      a2a: { remoteAgents: [sampleRemoteAgent] },
    } as BizGraphSettings)).resolves.not.toThrow()
  })

  it('falls back to defaults when saved a2aServer.port is invalid', async () => {
    const { readSettings } = await import('../settings')

    const malformed = {
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2aServer: { ...sampleServerConfig, port: 'not-a-number' as never },
    }
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify(malformed))

    const read = await readSettings()
    // validateSettingsShape rejects → defaults used
    expect(read.a2aServer).toBeUndefined()
  })
})

describe('Settings - A2A defaults merge', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('omitted a2a fields on saved JSON leave BizGraphSettings.a2a undefined', async () => {
    const { writeSettings, readSettings } = await import('../settings')

    await writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
    } as BizGraphSettings)

    const read = await readSettings()
    expect(read.a2aServer).toBeUndefined()
    expect(read.a2a).toBeUndefined()
  })

  it('saved a2a overrides defaults entirely (no deep-merge)', async () => {
    const { writeSettings, readSettings } = await import('../settings')

    await writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2a: { remoteAgents: [sampleRemoteAgent] },
    } as BizGraphSettings)

    const read = await readSettings()
    expect(read.a2a?.remoteAgents).toHaveLength(1)
    expect(read.a2a?.remoteAgents[0].name).toBe('peer-1')
  })
})

describe('Settings - onChange event', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('fires handler after writeSettings with prev and next snapshots', async () => {
    const { writeSettings, readSettings, onChange } = await import('../settings')

    const initial = await readSettings()
    const handler = vi.fn()
    const unsub = onChange(handler)

    await writeSettings({
      ...initial,
      a2aServer: sampleServerConfig,
    } as BizGraphSettings)

    expect(handler).toHaveBeenCalledTimes(1)
    const [prev, next] = handler.mock.calls[0]
    expect(prev.a2aServer).toBeUndefined()
    expect(next.a2aServer?.port).toBe(8089)
    unsub()
  })

  it('unsubscribe stops further handler invocations', async () => {
    const { writeSettings, readSettings, onChange } = await import('../settings')

    const initial = await readSettings()
    const handler = vi.fn()
    const unsub = onChange(handler)

    await writeSettings(initial)
    expect(handler).toHaveBeenCalledTimes(1)

    unsub()

    await writeSettings(initial)
    expect(handler).toHaveBeenCalledTimes(1) // unchanged
  })

  it('handler exception does not block other handlers', async () => {
    const { writeSettings, readSettings, onChange } = await import('../settings')

    const initial = await readSettings()
    const goodHandler = vi.fn()
    const unsub1 = onChange(() => { throw new Error('boom') })
    const unsub2 = onChange(goodHandler)

    await writeSettings(initial)

    expect(goodHandler).toHaveBeenCalledTimes(1)
    unsub1()
    unsub2()
  })
})

describe('Settings - invalidateSettingsCache', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('forces next readSettings to re-read from disk', async () => {
    const { writeSettings, readSettings, invalidateSettingsCache } = await import('../settings')

    await writeSettings({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2aServer: sampleServerConfig,
    } as BizGraphSettings)

    // First read populates cache
    const cached = await readSettings()
    expect(cached.a2aServer?.port).toBe(8089)

    // Mutate disk directly (simulate external change)
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify({
      version: 1,
      cliTools: [],
      apiKeys: [],
      mcpServers: [],
      a2aServer: { ...sampleServerConfig, port: 9999 },
    }))

    // Without invalidation, cache would still serve port=8089
    const stillCached = await readSettings()
    expect(stillCached.a2aServer?.port).toBe(8089)

    // After invalidation, fresh disk read
    invalidateSettingsCache()
    const fresh = await readSettings()
    expect(fresh.a2aServer?.port).toBe(9999)
  })
})

// ============================================
// mergeSettings 通用合并：不得静默丢弃未登记字段
// ============================================

describe('Settings - mergeSettings 通用合并', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('mergeSettings 保留 saved 里未登记到 defaults 的字段（compactModel 不再被丢弃）', async () => {
    const { writeSettings, readSettings, invalidateSettingsCache } = await import('../settings')
    await writeSettings({
      version: 1, cliTools: [], apiKeys: [], defaultModel: 'x', mcpServers: [],
      compactModel: 'claude-haiku-4-5',
    } as unknown as BizGraphSettings)
    // 绕过内存缓存：断言的是「磁盘 → mergeSettings」的结果，而不是刚写入的那个对象
    invalidateSettingsCache()
    const loaded = await readSettings()
    expect(loaded.compactModel).toBe('claude-haiku-4-5')
  })

  it('mergeSettings 是通用合并：类型里还没有的新字段同样被保留', async () => {
    const { writeSettings, readSettings, invalidateSettingsCache } = await import('../settings')
    await writeSettings({
      version: 1, cliTools: [], apiKeys: [], mcpServers: [],
      futureField: 'keep-me',
    } as unknown as BizGraphSettings)
    invalidateSettingsCache()
    const loaded = await readSettings() as unknown as Record<string, unknown>
    expect(loaded.futureField).toBe('keep-me')
  })

  it('contextWaterline 未保存过时也有默认值', async () => {
    const { readSettings } = await import('../settings')
    const loaded = await readSettings()
    expect(loaded.contextWaterline).toEqual({
      autoCompactEnabled: true,
      autoCompactThreshold: 0.75,
      minCompactInterval: 60_000,
    })
  })

  it('defaultModels 未保存过时是空对象（全部走各自回落）', async () => {
    const { readSettings } = await import('../settings')
    const loaded = await readSettings()
    expect(loaded.defaultModels).toEqual({})
  })

  it('defaultModels 存档后原样读回（按适配器分档不丢）', async () => {
    const { writeSettings, readSettings, invalidateSettingsCache } = await import('../settings')
    await writeSettings({
      version: 1, cliTools: [], apiKeys: [], mcpServers: [],
      defaultModels: { claudeCode: 'opus-4-1', codex: 'gpt-5', mcp: 'gpt-4o' },
    } as unknown as BizGraphSettings)
    invalidateSettingsCache()
    const loaded = await readSettings()
    expect(loaded.defaultModels).toEqual({ claudeCode: 'opus-4-1', codex: 'gpt-5', mcp: 'gpt-4o' })
  })

  it('userIdentity 不进默认值：未保存时为 undefined，保存后原样透传', async () => {
    const { writeSettings, readSettings, invalidateSettingsCache } = await import('../settings')
    await writeSettings({
      version: 1, cliTools: [], apiKeys: [], mcpServers: [],
    } as unknown as BizGraphSettings)
    invalidateSettingsCache()
    expect((await readSettings()).userIdentity).toBeUndefined()

    const userIdentity = { userId: 'user-1', userName: 'Tester', colorIndex: 2 }
    await writeSettings({
      version: 1, cliTools: [], apiKeys: [], mcpServers: [], userIdentity,
    } as unknown as BizGraphSettings)
    invalidateSettingsCache()
    expect((await readSettings()).userIdentity).toEqual(userIdentity)
  })
})

// ============================================
// CLI 工具清单：与适配器注册表对齐
// ============================================

/** 从注册表的 npm 安装方式里取出包名（去掉 @latest —— 包名校验不接受它）。 */
function npmPackageOf(descriptor: {
  installMethods: Array<{ type: string; command: string }>
}): string | undefined {
  const npm = descriptor.installMethods.find((m) => m.type === 'npm')
  if (!npm) return undefined
  const parts = npm.command.split(/\s+/)
  const idx = parts.indexOf('-g')
  const raw = idx >= 0 ? parts[idx + 1] : undefined
  if (!raw) return undefined
  return raw.endsWith('@latest') ? raw.slice(0, -'@latest'.length) : raw
}

describe('Settings - CLI 工具清单', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('DEFAULT_SETTINGS.cliTools 覆盖全部真 CLI 适配器', async () => {
    const { readSettings } = await import('../settings')
    const s = await readSettings()
    const names = s.cliTools.map((c) => c.name)
    for (const n of [
      'claude-code', 'codex', 'opencode', 'cline', 'kilo-code',
      'kimi-code', 'codebuddy', 'qoder', 'qwen-code', 'cursor',
    ]) {
      expect(names).toContain(n)
    }
    // mcp 没有 CLI 二进制，mindmap-internal 是内置适配器 —— 两者都不是 CLI 工具
    expect(names).not.toContain('mcp')
    expect(names).not.toContain('mindmap-internal')
  })

  it('cliTools 的 command / npmPackage 与适配器注册表一致', async () => {
    const { ADAPTER_REGISTRY } = await import('../adapters/registry')
    const { readSettings } = await import('../settings')
    const tools = (await readSettings()).cliTools

    for (const d of ADAPTER_REGISTRY) {
      if (d.name === 'mcp' || d.hidden) continue
      const tool = tools.find((t) => t.name === d.name)
      expect(tool, `cliTools 里缺少适配器 ${d.name}`).toBeDefined()
      if (!tool) continue
      if (d.detectCommand) {
        expect(tool.command, `${d.name} 的 detectCommand 不一致`).toBe(d.detectCommand)
      }
      const pkg = npmPackageOf(d)
      if (pkg) {
        expect(tool.npmPackage, `${d.name} 的 npm 包名不一致`).toBe(pkg)
        // validateNpmPackageName 不接受 @latest —— 直接抄注册表会装不上
        expect(tool.npmPackage).not.toContain('@latest')
      } else {
        // 没有 npm 安装方式（cursor 走官网下载）：不能给一个会失败的包名
        expect(tool.npmPackage, `${d.name} 没有 npm 安装方式，npmPackage 应为空`).toBe('')
      }
    }
  })

  it('mergeCliTools 保留 defaults 里没有但用户装过的条目', async () => {
    const { writeSettings, readSettings, invalidateSettingsCache } = await import('../settings')
    const base = await readSettings()
    await writeSettings({
      ...base,
      cliTools: [
        ...base.cliTools,
        { name: 'some-new-cli', npmPackage: 'some-new-cli', command: 'some-new-cli', installed: true },
      ],
    })
    // 绕过内存缓存：断言的是「磁盘 → mergeSettings」的结果
    invalidateSettingsCache()
    const reread = await readSettings()
    const names = reread.cliTools.map((c) => c.name)
    expect(names).toContain('some-new-cli')
    // 默认清单里的条目一个都不能少
    expect(names).toContain('claude-code')
    expect(names).toContain('cursor')
  })

  it('mergeCliTools 用注册表的 command / npmPackage 纠正存档里的旧值', async () => {
    const { writeSettings, readSettings, invalidateSettingsCache } = await import('../settings')
    const base = await readSettings()
    // 模拟老版本存档：opencode 的 npmPackage 曾误写成 'opencode'，installed 是真实状态
    const stale = base.cliTools.map((c) =>
      c.name === 'opencode'
        ? { ...c, npmPackage: 'opencode', installed: true, version: '0.5.0' }
        : c,
    )
    await writeSettings({ ...base, cliTools: stale })
    invalidateSettingsCache()
    const reread = await readSettings()
    const opencode = reread.cliTools.find((c) => c.name === 'opencode')
    expect(opencode?.npmPackage).toBe('opencode-ai')
    // 用户机器上的真实状态不能被默认值抹掉
    expect(opencode?.installed).toBe(true)
    expect(opencode?.version).toBe('0.5.0')
  })
})

describe('Settings - API Key 的删除语义', () => {
  beforeEach(() => {
    mockFsData.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('setApiKey 传空串时删除该 provider 的条目（而不是写入一个空 key）', async () => {
    const { setApiKey, getApiKey, readSettings } = await import('../settings')

    await setApiKey('anthropic', 'sk-real-key')
    expect(await getApiKey('anthropic')).toBe('sk-real-key')

    await setApiKey('anthropic', '')
    expect(await getApiKey('anthropic')).toBeUndefined()
    const s = await readSettings()
    expect(s.apiKeys.find((k) => k.provider === 'anthropic')).toBeUndefined()
  })

  it('setApiKey 传空串只删该 provider，其它 provider 不受影响', async () => {
    const { setApiKey, getApiKey } = await import('../settings')

    await setApiKey('anthropic', 'sk-anthropic')
    await setApiKey('openai', 'sk-openai')
    await setApiKey('anthropic', '')

    expect(await getApiKey('anthropic')).toBeUndefined()
    expect(await getApiKey('openai')).toBe('sk-openai')
  })

  it('setApiKey 删一个不存在的 provider 不报错', async () => {
    const { setApiKey, getApiKey } = await import('../settings')
    await expect(setApiKey('deepseek', '')).resolves.toBeUndefined()
    expect(await getApiKey('deepseek')).toBeUndefined()
  })
})
