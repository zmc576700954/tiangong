/**
 * Git 操作代理
 * 使用 simple-git 进行 Git 操作封装
 */

import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git'
import type { GraphSnapshot } from '@shared/types'

export class GitAgent {
  private gitInstances = new Map<string, SimpleGit>()

  private getGit(path: string): SimpleGit {
    let git = this.gitInstances.get(path)
    if (!git) {
      git = simpleGit(path)
      this.gitInstances.set(path, git)
    }
    return git
  }

  /**
   * 获取仓库状态
   */
  async getStatus(path: string): Promise<{ modified: string[]; untracked: string[] }> {
    const git = this.getGit(path)
    const status: StatusResult = await git.status()
    return {
      modified: status.modified,
      untracked: status.not_added,
    }
  }

  /**
   * 获取 diff
   */
  async getDiff(path: string, filePath?: string): Promise<string> {
    const git = this.getGit(path)
    if (filePath) {
      return git.diff([filePath])
    }
    return git.diff()
  }

  /**
   * 提交变更
   * @param files 指定要提交的文件路径数组，为空则提交所有变更
   */
  async commit(path: string, message: string, files?: string[]): Promise<void> {
    const git = this.getGit(path)
    if (files && files.length > 0) {
      for (const file of files) {
        await git.add(file)
      }
    } else {
      await git.add('.')
    }
    await git.commit(message)
  }

  /**
   * 创建快照对应的 Git tag
   */
  async createSnapshotTag(
    path: string,
    snapshot: GraphSnapshot,
  ): Promise<string | undefined> {
    const git = this.getGit(path)
    const tagName = `bizgraph-snapshot-${snapshot.id}`

    try {
      await git.addTag(tagName)
      const log = await git.log({ maxCount: 1 })
      return log.latest?.hash
    } catch (err) {
      console.warn(`[GitAgent] Failed to create snapshot tag:`, err)
      return undefined
    }
  }

  /**
   * 获取当前分支
   */
  async getCurrentBranch(path: string): Promise<string> {
    const git = this.getGit(path)
    const branches = await git.branch()
    return branches.current
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
      console.warn(`[GitAgent] Not a valid git repo at ${path}:`, err)
      return false
    }
  }
}
