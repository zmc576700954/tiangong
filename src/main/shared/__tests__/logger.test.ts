import { describe, it, expect, vi, afterEach } from 'vitest'
import { createLogger, setLogLevel } from '../logger'

describe('createLogger', () => {
  afterEach(() => {
    setLogLevel('debug')
  })

  it('creates a logger with module name', () => {
    const logger = createLogger('TestModule')
    expect(logger).toBeDefined()
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
  })

  it('debug logs when level is debug', () => {
    setLogLevel('debug')
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const logger = createLogger('Test')

    logger.debug('test message')

    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('debug does not log when level is info', () => {
    setLogLevel('info')
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const logger = createLogger('Test')

    logger.debug('test message')

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('warn logs when level is warn', () => {
    setLogLevel('warn')
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = createLogger('Test')

    logger.warn('warning message')

    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('warn does not log when level is error', () => {
    setLogLevel('error')
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = createLogger('Test')

    logger.warn('warning message')

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('error always logs', () => {
    setLogLevel('error')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createLogger('Test')

    logger.error('error message')

    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('写入前脱敏：Authorization / --password 不落原文，错误码与路径保留', () => {
    const token = 'sk-proj-abcdefghijklmnop1234567890'
    const password = 'S3cr3t-Passw0rd!'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createLogger('Test')

    logger.error(
      'command failed: EACCES',
      `curl -H "Authorization: Bearer ${token}" --password=${password} /tmp/work`,
      { code: 'EACCES', path: '/tmp/work', command: `deploy --token=${token}` },
    )

    const line = spy.mock.calls[0]
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ')
    expect(line).not.toContain(token)
    expect(line).not.toContain(password)
    expect(line).toContain('***REDACTED(')
    // 排障信息保留：错误码、路径仍可读
    expect(line).toContain('EACCES')
    expect(line).toContain('/tmp/work')
    spy.mockRestore()
  })
})
