/**
 * Git 操作代理
 * 使用 simple-git 进行 Git 操作封装
 */

import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git'
import type { GraphSnapshot } from '@shared/types'
import { createLogger } from './shared/logger'
import { GitError, ErrorCode } from './errors'

const logger = createLogger('GitAgent')

export class GitAgent {
  private gitInstances = new Map<string, SimpleGit>()
  private readonly MAX_GIT_CACHE = 10

  private getGit(path: string): SimpleGit {
    let git = this.gitInstances.get(path)
    if (!git) {
      git = simpleGit(path)
      this.gitInstances.set(path, git)
      // LRU 清理：超出上限时移除最旧的实例
      if (this.gitInstances.size > this.MAX_GIT_CACHE) {
        const firstKey = this.gitInstances.keys().next().value
        if (firstKey) this.gitInstances.delete(firstKey)
      }
    }
    return git
  }

  /**
   * 获取仓库状态
   */
  async getStatus(path: string): Promise<{ modified: string[]; untracked: string[] }> {
    try {
      const git = this.getGit(path)
      const status: StatusResult = await git.status()
      return {
        modified: status.modified,
        untracked: status.not_added,
      }
    } catch (err) {
      throw new GitError(
        `Failed to get git status: ${err instanceof Error ? err.message : String(err)}`,
        path,
        ErrorCode.GIT_NOT_A_REPO,
      )
    }
  }

  /**
   * 获取 diff
   */
  async getDiff(path: string, filePath?: string): Promise<string> {
    try {
      const git = this.getGit(path)
      if (filePath) {
        return await git.diff([filePath])
      }
      return await git.diff()
    } catch (err) {
      throw new GitError(
        `Failed to get diff: ${err instanceof Error ? err.message : String(err)}`,
        path,
      )
    }
  }

  /**
   * 提交变更
   * @param files 指定要提交的文件路径数组（必须提供，避免意外的 git add .）
   * @throws {GitError} 未指定文件时抛出错误，避免意外暂存所有变更
   */
  async commit(path: string, message: string, files?: string[]): Promise<void> {
    try {
      const git = this.getGit(path)
      if (files && files.length > 0) {
        for (const file of files) {
          await git.add(file)
        }
      } else {
        logger.warn(`commit() called without specifying files at ${path}, staging all changes`)
        await git.add('.')
      }
      await git.commit(message)
    } catch (err) {
      if (err instanceof GitError) throw err
      throw new GitError(
        `Failed to commit: ${err instanceof Error ? err.message : String(err)}`,
        path,
      )
    }
  }

  /**
   * 创建快照对应的 Git tag
   * @returns tag 对应的 commit hash，失败时抛出 GitError
   */
  async createSnapshotTag(
    path: string,
    snapshot: GraphSnapshot,
  ): Promise<string | undefined> {
    try {
      const git = this.getGit(path)
      const tagName = `bizgraph-snapshot-${snapshot.id}`
      await git.addTag(tagName)
      const log = await git.log({ maxCount: 1 })
      return log.latest?.hash
    } catch (err) {
      logger.warn('Failed to create snapshot tag:', err)
      return undefined
    }
  }

  /**
   * 获取当前分支
   */
  async getCurrentBranch(path: string): Promise<string> {
    try {
      const git = this.getGit(path)
      const branches = await git.branch()
      return branches.current
    } catch (err) {
      throw new GitError(
        `Failed to get current branch: ${err instanceof Error ? err.message : String(err)}`,
        path,
      )
    }
  }

  /**
   * 检查是否为 Git 仓库
   */
  async isRepo(path: string): Promise<boolean> {
    try {
      const git = this.getGit(path)
      await git.status()
      return true
    } catch (err) {
      logger.warn(`Not a valid git repo at ${path}:`, err)
      return false
    }
  }
}
