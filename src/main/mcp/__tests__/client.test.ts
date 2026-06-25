import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { validateMcpCommand } from '../client'
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
