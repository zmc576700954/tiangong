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
})
