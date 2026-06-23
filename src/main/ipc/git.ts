/**
 * Git IPC Handlers
 * Git 状态、差异、提交
 */

import path from 'node:path'
import type { GitAgent } from '../git-agent'
import type { TypedHandle } from './utils'
import { validateProjectPath } from './utils'
import { IpcError, ErrorCode } from '../errors'

export function registerGitHandlers(gitAgent: GitAgent, typedHandle: TypedHandle): void {
  typedHandle('git:status', async (_, repoPath) => {
    const safePath = validateProjectPath(repoPath)
    return gitAgent.getStatus(safePath)
  })

  typedHandle('git:diff', async (_, repoPath) => {
    const safePath = validateProjectPath(repoPath)
    return gitAgent.getDiff(safePath)
  })

  typedHandle('git:commit', async (_, repoPath, message, files) => {
    const safePath = validateProjectPath(repoPath)
    if (!Array.isArray(files) || files.length === 0) {
      throw new IpcError('git:commit requires a non-empty files array', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const safeFiles = files.map((file: string) => {
      if (typeof file !== 'string' || !file.trim()) {
        throw new IpcError(`Invalid file path in commit: ${file}`, ErrorCode.IPC_INVALID_ARGUMENT)
      }
      const resolved = path.resolve(safePath, file)
      // Windows: case-insensitive path comparison
      const isWithinRepo = process.platform === 'win32'
        ? resolved.toLowerCase().startsWith(safePath.toLowerCase() + path.sep) || resolved.toLowerCase() === safePath.toLowerCase()
        : (resolved.startsWith(safePath + path.sep) || resolved === safePath)
      if (!isWithinRepo) {
        throw new IpcError(`File path escapes repository: ${file}`, ErrorCode.IPC_ACCESS_DENIED)
      }
      return file
    })
    return gitAgent.commit(safePath, message, safeFiles)
  })
}
