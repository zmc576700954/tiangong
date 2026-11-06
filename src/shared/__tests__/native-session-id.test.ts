import { describe, expect, it } from 'vitest'
import {
  isInternalAgentSessionId,
  isTrustedNativeSessionId,
} from '../native-session-id'

describe('native session id 判据（P1-1）', () => {
  it('内部前缀（claude-/codex-/cursor-/sess_ 等）一律判为内部 id', () => {
    expect(isInternalAgentSessionId('claude-57956f9a-4b79-4c7a-9f67-1e2d3c4b5a69')).toBe(true)
    expect(isInternalAgentSessionId('codex-12345678')).toBe(true)
    expect(isInternalAgentSessionId('cursor-abcdef12')).toBe(true)
    expect(isInternalAgentSessionId('sess-12345678')).toBe(true)
    expect(isInternalAgentSessionId('sess_12345678')).toBe(true)
    expect(isInternalAgentSessionId('opencode-12345678')).toBe(true)
  })

  it('SDK 回报的原生 id（UUID / 长 opaque 串）可信', () => {
    expect(isTrustedNativeSessionId('4d7c5f3e-9a2b-4c1d-8e6f-0a1b2c3d4e5f')).toBe(true)
    expect(isTrustedNativeSessionId('01J8Z9K3QW7R5T6Y8U2I0O9P4A')).toBe(true)
  })

  it('内部 id / 过短 / 非字符串 都不可作为原生 id', () => {
    expect(isTrustedNativeSessionId('claude-57956f9a-4b79-4c7a-9f67-1e2d3c4b5a69')).toBe(false)
    expect(isTrustedNativeSessionId('sess_1')).toBe(false)
    expect(isTrustedNativeSessionId('abc')).toBe(false)
    expect(isTrustedNativeSessionId(null)).toBe(false)
    expect(isTrustedNativeSessionId(12345678)).toBe(false)
  })
})
