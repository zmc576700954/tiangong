/**
 * claude CLI 能力探测测试
 *
 * 探测结果决定 runClaude 会不会给 CLI 传 --disallowedTools：
 * 传了 → 生成流程禁掉写工具；老版本 CLI 不认识这个 flag 会直接退出。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as ChildProcessModule from 'node:child_process'

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  }
})

import { supportsDisallowedTools, resetCliCapabilitiesCache } from '../cli-capabilities'

describe('claude CLI 能力探测', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset()
    resetCliCapabilitiesCache()
  })

  it('help 里出现 --disallowedTools → 支持', () => {
    execFileSyncMock.mockReturnValue('  --disallowedTools, --disallowed-tools <tools...>\n')
    expect(supportsDisallowedTools()).toBe(true)
  })

  it('只有 --disallowed-tools 拼写也算支持', () => {
    execFileSyncMock.mockReturnValue('  --disallowed-tools <tools...>\n')
    expect(supportsDisallowedTools()).toBe(true)
  })

  it('help 里没有 → 不支持', () => {
    execFileSyncMock.mockReturnValue('Usage: claude [options]\n')
    expect(supportsDisallowedTools()).toBe(false)
  })

  it('探测抛错（CLI 没装）→ 不支持，不会因此崩掉生成流程', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('spawn claude ENOENT')
    })
    expect(supportsDisallowedTools()).toBe(false)
  })

  it('结果被缓存，只探测一次', () => {
    execFileSyncMock.mockReturnValue('--disallowedTools')
    supportsDisallowedTools()
    supportsDisallowedTools()
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
  })
})
