import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { IpcMainInvokeEvent } from 'electron'
import { registerGitHandlers } from '../ipc/git'
import type { TypedHandle } from '../ipc/utils'
import { IpcError } from '../errors'
import type { GitAgent } from '../git-agent'

describe('registerGitHandlers', () => {
  it('git:commit rejects file paths that escape the repository', async () => {
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as unknown as TypedHandle

    const mockGitAgent = {
      getStatus: vi.fn(),
      getDiff: vi.fn(),
      commit: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitAgent

    registerGitHandlers(mockGitAgent, typedHandle)

    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-handler-'))
    try {
      await fs.writeFile(path.join(repoDir, 'safe.txt'), '')
      const commitHandler = handlers['git:commit']
      expect(commitHandler).toBeDefined()

      // Outside path should be rejected before GitAgent.commit is called.
      await expect(
        commitHandler({} as IpcMainInvokeEvent, repoDir, 'msg', ['safe.txt', '../outside.txt']),
      ).rejects.toThrow(IpcError)
      expect(mockGitAgent.commit).not.toHaveBeenCalled()

      // Inside paths should be accepted.
      await commitHandler({} as IpcMainInvokeEvent, repoDir, 'msg', ['safe.txt'])
      expect(mockGitAgent.commit).toHaveBeenCalledWith(repoDir, 'msg', ['safe.txt'])
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })
})
