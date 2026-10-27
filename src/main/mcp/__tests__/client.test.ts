import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { validateMcpCommand, McpClient } from '../client'
import { AgentError } from '../../errors'

describe('validateMcpCommand', () => {
  it('allows bare whitelist commands', () => {
    expect(() => validateMcpCommand('npx')).not.toThrow()
    expect(() => validateMcpCommand('node')).not.toThrow()
    expect(() => validateMcpCommand('uvx')).not.toThrow()
  })

  it('rejects non-whitelist bare commands', () => {
    expect(() => validateMcpCommand('rm')).toThrow(AgentError)
    expect(() => validateMcpCommand('curl')).toThrow(/MCP command not allowed/)
  })

  it('rejects absolute paths outside project node_modules/.bin', () => {
    expect(() => validateMcpCommand('/usr/bin/npx')).toThrow(AgentError)
    expect(() => validateMcpCommand('C:\\Windows\\System32\\calc.exe')).toThrow(AgentError)
  })

  it('rejects relative node_modules paths (substring bypass)', () => {
    expect(() => validateMcpCommand('node_modules/.bin/evil')).toThrow(AgentError)
    expect(() => validateMcpCommand('./node_modules/.bin/npx')).toThrow(AgentError)
    expect(() => validateMcpCommand('/some/node_modules/path/bin')).toThrow(AgentError)
  })

  it('allows absolute paths within project node_modules/.bin for whitelist basenames', () => {
    const projectBin = path.resolve(process.cwd(), 'node_modules', '.bin')
    expect(() => validateMcpCommand(path.join(projectBin, 'npx'))).not.toThrow()
    expect(() => validateMcpCommand(path.join(projectBin, 'node'))).not.toThrow()
  })

  it('rejects absolute paths within project node_modules/.bin for non-whitelist basenames', () => {
    const projectBin = path.resolve(process.cwd(), 'node_modules', '.bin')
    expect(() => validateMcpCommand(path.join(projectBin, 'evil'))).toThrow(AgentError)
  })
})

/**
 * 一个最小可用的 MCP stdio 服务器：
 * 响应 initialize / tools/list / resources/list；收到 tools/call 时直接退出（模拟崩溃）。
 */
const FAKE_MCP_SERVER = `
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
process.stdout.write('fake-mcp-ready\\n')
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch (e) { return }
  if (!msg || msg.id === undefined) return
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  if (msg.method === 'initialize') send({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } })
  else if (msg.method === 'tools/list') send({ tools: [{ name: 'echo' }] })
  else if (msg.method === 'resources/list') send({ resources: [] })
  else if (msg.method === 'tools/call') process.exit(7)
})
`

describe('McpClient 存活检测', () => {
  it('子进程启动即退出时 connect 立刻失败（不等 2s fallback / 10s 超时）', async () => {
    const client = new McpClient('node', ['-e', 'process.exit(3)'])
    const started = Date.now()
    await expect(client.connect()).rejects.toThrow(/exited with code 3/)
    // 握手 fallback 是 2s、连接超时是 10s —— 失败必须远早于这两个门槛
    expect(Date.now() - started).toBeLessThan(1500)
    expect(client.isReady()).toBe(false)
  })

  it('握手成功后 isReady 为 true，并能取到工具列表', async () => {
    const client = new McpClient('node', ['-e', FAKE_MCP_SERVER])
    await client.connect()
    try {
      expect(client.isReady()).toBe(true)
      expect(client.getTools().map((t) => t.name)).toEqual(['echo'])
    } finally {
      await client.disconnect()
    }
  })

  it('进程中途退出时，在途调用被拒绝且 isReady 变 false', async () => {
    const client = new McpClient('node', ['-e', FAKE_MCP_SERVER])
    await client.connect()
    // tools/call 会让服务器直接 exit(7)，响应永远不会回来
    await expect(client.callTool('echo', {})).rejects.toThrow(/exited with code 7/)
    expect(client.isReady()).toBe(false)
    // 退出之后再调用：立刻被「进程未运行」挡住，不会挂到 30s 超时
    await expect(client.callTool('echo', {})).rejects.toThrow(/MCP process not running/)
  })

  it('disconnect 会终止仍然存活的服务器进程', async () => {
    const client = new McpClient('node', ['-e', FAKE_MCP_SERVER])
    await client.connect()
    const exited = new Promise<void>((resolve) => client.once('exit', () => resolve()))
    await client.disconnect()
    await exited
    expect(client.isReady()).toBe(false)
  })
})
