/**
 * Git IPC Handlers
 * Git 状态、差异、提交
 */

import type { GitAgent } from '../git-agent'
import type { TypedHandle } from './utils'
import { validateProjectPath } from './utils'

export function registerGitHandlers(gitAgent: GitAgent, typedHandle: TypedHandle): void {
  typedHandle('git:status', async (_, repoPath) => {
    const safePath = validateProjectPath(repoPath)
    return gitAgent.getStatus(safePath)
  })

  typedHandle('git:diff', async (_, repoPath) => {
    const safePath = validateProjectPath(repoPath)
    return gitAgent.getDiff(safePath)
  })

  typedHandle('git:commit', async (_, repoPath, message) => {
    const safePath = validateProjectPath(repoPath)
    return gitAgent.commit(safePath, message)
  })
}
