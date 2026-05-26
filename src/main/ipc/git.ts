/**
 * Git IPC Handlers
 * Git 状态、差异、提交
 */

import type { GitAgent } from '../git-agent'
import type { TypedHandle } from './utils'

export function registerGitHandlers(gitAgent: GitAgent, typedHandle: TypedHandle): void {
  typedHandle('git:status', async (_, repoPath) => {
    return gitAgent.getStatus(repoPath)
  })

  typedHandle('git:diff', async (_, repoPath) => {
    return gitAgent.getDiff(repoPath)
  })

  typedHandle('git:commit', async (_, repoPath, message) => {
    return gitAgent.commit(repoPath, message)
  })
}
