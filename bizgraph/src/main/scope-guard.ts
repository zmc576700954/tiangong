/**
 * 范围守卫 (ScopeGuard)
 * 在系统层面强制执行文件变更范围，防止 Agent 越界修改
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar from 'chokidar'
import type { Sandbox, ValidationResult, AgentSessionConfig } from '@shared/types'

export class ScopeGuard {
  private sandboxes = new Map<string, Sandbox>()

  /**
   * 准备沙箱环境
   * 1. 备份所有 allowedFiles
   * 2. 启动文件系统监控
   */
  async prepareSandbox(
    allowedFiles: string[],
    workingDir: string,
  ): Promise<Sandbox> {
    const sandboxId = `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const backupDir = path.join(workingDir, '.bizgraph', 'backups', sandboxId)

    await fs.mkdir(backupDir, { recursive: true })

    // 备份允许修改的文件
    for (const file of allowedFiles) {
      const srcPath = path.resolve(workingDir, file)
      const backupPath = path.join(backupDir, file)
      await fs.mkdir(path.dirname(backupPath), { recursive: true })
      try {
        const content = await fs.readFile(srcPath, 'utf-8')
        await fs.writeFile(backupPath, content, 'utf-8')
      } catch {
        // 文件可能不存在（新建文件），忽略错误
      }
    }

    // 启动文件监控
    const watcher = chokidar.watch(workingDir, {
      ignored: [
        /node_modules/,
        /\.git/,
        /\.bizgraph/,
        /dist/,
        /dist-electron/,
        /release/,
      ],
      persistent: true,
      ignoreInitial: true,
    })

    const sandbox: Sandbox = {
      id: sandboxId,
      workingDir,
      backupDir,
      allowedFiles: allowedFiles.map((f) => path.resolve(workingDir, f)),
      watcher,
    }

    this.sandboxes.set(sandboxId, sandbox)
    return sandbox
  }

  /**
   * 验证变更范围
   * 检查实际修改的文件是否都在白名单内
   */
  validateChanges(
    actualChanges: string[],
    allowedFiles: string[],
    workingDir: string,
  ): ValidationResult {
    const allowedSet = new Set(
      allowedFiles.map((f) => path.resolve(workingDir, f)),
    )
    const outOfBoundsFiles: string[] = []
    const validFiles: string[] = []

    for (const changedFile of actualChanges) {
      const resolved = path.resolve(workingDir, changedFile)
      if (allowedSet.has(resolved)) {
        validFiles.push(changedFile)
      } else {
        outOfBoundsFiles.push(changedFile)
      }
    }

    return {
      compliant: outOfBoundsFiles.length === 0,
      outOfBoundsFiles,
      validFiles,
      shouldRollback: outOfBoundsFiles.length > 0,
    }
  }

  /**
   * 强制回滚到备份状态
   */
  async rollback(sandbox: Sandbox): Promise<void> {
    // 从备份恢复文件
    const backupEntries = await fs.readdir(sandbox.backupDir, {
      recursive: true,
      withFileTypes: true,
    })

    for (const entry of backupEntries) {
      if (entry.isFile()) {
        const relativePath = path.relative(sandbox.backupDir, path.join(entry.parentPath, entry.name))
        const backupPath = path.join(sandbox.backupDir, relativePath)
        const targetPath = path.join(sandbox.workingDir, relativePath)

        try {
          const content = await fs.readFile(backupPath, 'utf-8')
          await fs.writeFile(targetPath, content, 'utf-8')
        } catch (err) {
          console.warn(`Failed to rollback ${relativePath}:`, err)
        }
      }
    }

    // 清理沙箱
    await this.cleanupSandbox(sandbox)
  }

  /**
   * 提交变更（确认合规后调用）
   */
  async commitChanges(sandbox: Sandbox): Promise<void> {
    await this.cleanupSandbox(sandbox)
  }

  /**
   * 清理沙箱资源
   */
  private async cleanupSandbox(sandbox: Sandbox): Promise<void> {
    // 停止文件监控
    if (sandbox.watcher) {
      await (sandbox.watcher as chokidar.FSWatcher).close()
    }

    // 删除备份目录
    try {
      await fs.rm(sandbox.backupDir, { recursive: true, force: true })
    } catch {
      // 忽略删除错误
    }

    this.sandboxes.delete(sandbox.id)
  }

  /**
   * 构建范围配置
   * 根据节点上下文自动生成 AgentSessionConfig
   */
  buildScopeConfig(params: {
    workingDirectory: string
    nodeTitle: string
    acceptanceCriteria: string[]
    allowedFiles: string[]
    forbiddenFiles?: string[]
    invariantRules?: string[]
    upstreamContext?: string
    downstreamContext?: string
    bugContext?: AgentSessionConfig['bugContext']
  }): AgentSessionConfig {
    return {
      workingDirectory: params.workingDirectory,
      allowedFiles: params.allowedFiles,
      forbiddenFiles: params.forbiddenFiles ?? [],
      invariantRules: params.invariantRules ?? [],
      upstreamContext: params.upstreamContext ?? '',
      downstreamContext: params.downstreamContext ?? '',
      nodeTitle: params.nodeTitle,
      acceptanceCriteria: params.acceptanceCriteria,
      bugContext: params.bugContext,
    }
  }
}
