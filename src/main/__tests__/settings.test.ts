import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BizGraphSettings, AdapterPreferences } from '../settings'

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
})
