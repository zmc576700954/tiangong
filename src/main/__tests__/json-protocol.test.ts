import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  JsonProtocolHandler,
  protocolMessageToAgentOutput,
  type ProtocolOutputMessage,
} from '../adapters/json-protocol'
import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

function createMockProcess(): ChildProcess {
  const stdout = new Readable({ read() {} })
  const stdin = new Writable({ write() {} })
  const proc = {
    stdout,
    stdin,
    kill: vi.fn(),
    killed: false,
  } as unknown as ChildProcess
  return proc
}

describe('JsonProtocolHandler', () => {
  let proc: ChildProcess
  let handler: JsonProtocolHandler

  beforeEach(() => {
    proc = createMockProcess()
    handler = new JsonProtocolHandler(proc)
  })

  it('should parse valid protocol messages from stdout', () => {
    const messages: ProtocolOutputMessage[] = []
    handler.onMessage((msg) => messages.push(msg))
    handler.enable()

    const output = JSON.stringify({
      version: '1.0',
      type: 'progress',
      id: 'msg-1',
      timestamp: Date.now(),
      payload: { message: 'Working...', percent: 50 },
    }) + '\n'

    proc.stdout!.emit('data', Buffer.from(output))

    expect(messages.length).toBe(1)
    expect(messages[0].type).toBe('progress')
    expect(messages[0].payload).toEqual({ message: 'Working...', percent: 50 })
  })

  it('should ignore non-JSON lines', () => {
    const errors: Array<{ err: Error; raw: string }> = []
    handler.onError((err, raw) => errors.push({ err, raw }))
    handler.enable()

    proc.stdout!.emit('data', Buffer.from('Some raw output\n'))

    expect(errors.length).toBe(1)
    expect(errors[0].raw).toBe('Some raw output')
  })

  it('should ignore JSON without version field', () => {
    const messages: ProtocolOutputMessage[] = []
    handler.onMessage((msg) => messages.push(msg))
    handler.onError(() => {})
    handler.enable()

    const output = JSON.stringify({ type: 'progress', payload: {} }) + '\n'
    proc.stdout!.emit('data', Buffer.from(output))

    expect(messages.length).toBe(0)
  })

  it('should handle multiple messages in one chunk', () => {
    const messages: ProtocolOutputMessage[] = []
    handler.onMessage((msg) => messages.push(msg))
    handler.enable()

    const msg1 = JSON.stringify({ version: '1.0', type: 'pong', timestamp: 1, payload: {} })
    const msg2 = JSON.stringify({ version: '1.0', type: 'progress', timestamp: 2, payload: { message: 'ok' } })
    proc.stdout!.emit('data', Buffer.from(msg1 + '\n' + msg2 + '\n'))

    expect(messages.length).toBe(2)
  })

  it('should send structured messages via stdin', () => {
    handler.enable()
    const writeSpy = vi.spyOn(proc.stdin!, 'write')

    const result = handler.send({
      type: 'command',
      id: 'cmd-1',
      timestamp: Date.now(),
      payload: { action: 'implement', description: 'test' },
    })

    expect(result).toBe(true)
    expect(writeSpy).toHaveBeenCalledOnce()
    const written = writeSpy.mock.calls[0][0] as string
    const parsed = JSON.parse(written)
    expect(parsed.version).toBe('1.0')
    expect(parsed.type).toBe('command')
  })

  it('should return false when stdin is not writable', () => {
    handler.enable()
    Object.defineProperty(proc.stdin!, 'writableEnded', { value: true })

    const result = handler.send({
      type: 'command',
      id: 'cmd-1',
      timestamp: Date.now(),
      payload: { action: 'implement', description: 'test' },
    })

    expect(result).toBe(false)
  })

  it('should complete handshake when pong received', async () => {
    const promise = handler.handshake(3000)
    handler.enable()

    const pong = JSON.stringify({ version: '1.0', type: 'pong', timestamp: Date.now(), payload: {} }) + '\n'
    proc.stdout!.emit('data', Buffer.from(pong))

    const result = await promise
    expect(result).toBe(true)
    expect(handler.enabled).toBe(true)
  })

  it('should timeout handshake if no pong received', async () => {
    const promise = handler.handshake(50)
    handler.enable()

    const result = await promise
    expect(result).toBe(false)
    expect(handler.enabled).toBe(false)
  })

  it('should clean up listeners on dispose', () => {
    handler.enable()
    const removeSpy = vi.spyOn(proc.stdout!, 'off')

    handler.dispose()

    expect(removeSpy).toHaveBeenCalled()
    expect(handler.enabled).toBe(false)
  })
})

describe('protocolMessageToAgentOutput', () => {
  it('should convert progress messages', () => {
    const msg: ProtocolOutputMessage = {
      version: '1.0',
      type: 'progress',
      timestamp: 1000,
      payload: { message: 'Loading', percent: 50 },
    }
    const output = protocolMessageToAgentOutput(msg)
    expect(output).not.toBeNull()
    expect(output!.type).toBe('stdout')
    expect(output!.data).toBe('[50%] Loading')
  })

  it('should convert progress without percent', () => {
    const msg: ProtocolOutputMessage = {
      version: '1.0',
      type: 'progress',
      timestamp: 1000,
      payload: { message: 'Done' },
    }
    const output = protocolMessageToAgentOutput(msg)
    expect(output!.data).toBe('Done')
  })

  it('should convert result success', () => {
    const msg: ProtocolOutputMessage = {
      version: '1.0',
      type: 'result',
      timestamp: 1000,
      payload: { content: 'All good', success: true },
    }
    const output = protocolMessageToAgentOutput(msg)
    expect(output!.type).toBe('complete')
    expect(output!.data).toBe('All good')
  })

  it('should convert result failure', () => {
    const msg: ProtocolOutputMessage = {
      version: '1.0',
      type: 'result',
      timestamp: 1000,
      payload: { content: 'Failed', success: false },
    }
    const output = protocolMessageToAgentOutput(msg)
    expect(output!.type).toBe('error')
  })

  it('should convert file_change messages', () => {
    const msg: ProtocolOutputMessage = {
      version: '1.0',
      type: 'file_change',
      timestamp: 1000,
      payload: { path: 'src/index.ts', changeType: 'modify', description: 'Updated' },
    }
    const output = protocolMessageToAgentOutput(msg)
    expect(output!.type).toBe('file_change')
    expect(output!.filePath).toBe('src/index.ts')
    expect(output!.changeType).toBe('modify')
  })

  it('should convert error messages', () => {
    const msg: ProtocolOutputMessage = {
      version: '1.0',
      type: 'error',
      timestamp: 1000,
      payload: { code: 'E404', message: 'Not found', recoverable: true },
    }
    const output = protocolMessageToAgentOutput(msg)
    expect(output!.type).toBe('error')
    expect(output!.data).toBe('[E404] Not found')
  })

  it('should return null for pong messages', () => {
    const msg: ProtocolOutputMessage = {
      version: '1.0',
      type: 'pong',
      timestamp: 1000,
      payload: {},
    }
    const output = protocolMessageToAgentOutput(msg)
    expect(output).toBeNull()
  })
})
