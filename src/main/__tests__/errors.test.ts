import { describe, it, expect } from 'vitest'
import {
  BizGraphError,
  DatabaseError,
  IpcError,
  SessionNotFoundError,
  AdapterError,
  ScopeGuardError,
  ErrorCode,
} from '../errors'

describe('Error types', () => {
  it('BizGraphError should have correct code and message', () => {
    const err = new BizGraphError('Something went wrong', ErrorCode.UNKNOWN)
    expect(err.message).toBe('Something went wrong')
    expect(err.code).toBe(ErrorCode.UNKNOWN)
    expect(err.name).toBe('BizGraphError')
  })

  it('DatabaseError should default to DB_QUERY_FAILED', () => {
    const err = new DatabaseError('Query failed')
    expect(err.code).toBe(ErrorCode.DB_QUERY_FAILED)
    expect(err.name).toBe('DatabaseError')
  })

  it('IpcError should default to IPC_INVALID_ARGUMENT', () => {
    const err = new IpcError('Bad argument')
    expect(err.code).toBe(ErrorCode.IPC_INVALID_ARGUMENT)
    expect(err.name).toBe('IpcError')
  })

  it('SessionNotFoundError should capture sessionId', () => {
    const err = new SessionNotFoundError('sess-123')
    expect(err.sessionId).toBe('sess-123')
    expect(err.code).toBe(ErrorCode.AGENT_SESSION_NOT_FOUND)
    expect(err.message).toContain('sess-123')
  })

  it('AdapterError should capture adapterName', () => {
    const err = new AdapterError('Failed to start', 'claude-code')
    expect(err.adapterName).toBe('claude-code')
    expect(err.code).toBe(ErrorCode.AGENT_ADAPTER_ERROR)
  })

  it('ScopeGuardError should have correct code', () => {
    const err = new ScopeGuardError('Out of bounds')
    expect(err.code).toBe(ErrorCode.SCOPE_OUT_OF_BOUNDS)
    expect(err.name).toBe('ScopeGuardError')
  })

  it('errors should be instanceof Error', () => {
    const err = new BizGraphError('test')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(BizGraphError)
  })
})
