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

  it('should fall back to defaults when decryption format is invalid', async () => {
    const { readSettings } = await import('../settings')

    const malformed = {
      version: 1,
      cliTools: [],
      apiKeys: [{ provider: 'anthropic', key: 'fbk:invalid-no-colon' }],
      mcpServers: [],
    }
    mockFsData.set(`${mockUserDataPath}/settings.json`, JSON.stringify(malformed))

    const read = await readSettings()
    // Decryption errors are caught and defaults are returned
    expect(read.apiKeys).toEqual([])
    expect(read.version).toBe(1)
  })

  it('should fall back to defaults when IV length is invalid', async () => {
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
    // Decryption errors are caught and defaults are returned
    expect(read.apiKeys).toEqual([])
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
