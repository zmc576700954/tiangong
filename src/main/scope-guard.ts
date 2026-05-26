/**
 * 范围守卫 (ScopeGuard)
 * 在系统层面强制执行文件变更范围，防止 Agent 越界修改
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { Sandbox, ValidationResult, AgentSessionConfig } from '@shared/types'
import { ScopeGuardError, ErrorCode } from './errors'

function sanitizeAllowedFiles(allowedFiles: string[], workingDir: string): string[] {
  return allowedFiles.map((file) => {
    const resolved = path.resolve(workingDir, file)
    const relative = path.relative(workingDir, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ScopeGuardError(`Path traversal detected: ${file} escapes working directory ${workingDir}`, ErrorCode.SCOPE_PATH_TRAVERSAL)
    }
    return resolved
  })
}

export class ScopeGuard {
  private sandboxes = new Map<string, Sandbox>()
  private watchers = new Map<string, FSWatcher>()

  /**
   * 准备沙箱环境
   * 1. 备份所有 allowedFiles
   * 2. 启动文件系统监控
   */
  async prepareSandbox(
    allowedFiles: string[],
    workingDir: string,
  ): Promise<Sandbox> {
    const sandboxId = `sandbox-${randomUUID().replace(/-/g, '')}`
    const backupDir = path.join(workingDir, '.bizgraph', 'backups', sandboxId)

    await fs.mkdir(backupDir, { recursive: true })

    // TG-007: 消毒 allowedFiles，防止路径遍历
    const sanitizedFiles = sanitizeAllowedFiles(allowedFiles, workingDir)

    // 备份允许修改的文件
    for (const srcPath of sanitizedFiles) {
      const relativePath = path.relative(workingDir, srcPath)
      const backupPath = path.join(backupDir, relativePath)
      await fs.mkdir(path.dirname(backupPath), { recursive: true })
      try {
        const content = await fs.readFile(srcPath, 'utf-8')
        await fs.writeFile(backupPath, content, 'utf-8')
      } catch {
        // 文件可能不存在（新建文件），忽略错误
      }
    }

    // 启动文件监控 — 仅监控 allowedFiles 及其父目录
    // 避免监控整个 workingDir 导致的性能问题（大型项目）
    const watchPaths: string[] = []
    const watchedDirs = new Set<string>()

    for (const filePath of sanitizedFiles) {
      watchPaths.push(filePath)
      const dir = path.dirname(filePath)
      if (!watchedDirs.has(dir)) {
        watchedDirs.add(dir)
        watchPaths.push(dir)
      }
    }

    // 如果白名单为空或路径均不可访问，回退到监控 workingDir
    const watcherPaths = watchPaths.length > 0 ? watchPaths : workingDir

    // P2-7A: WSL/网络 FS 检测，自动启用 usePolling
    const isWsl = process.platform === 'linux' && process.env.WSL_DISTRO_NAME !== undefined
    const isNetworkFs = workingDir.startsWith('\\\\') || workingDir.startsWith('//')

    const watcher = chokidar.watch(watcherPaths, {
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
      usePolling: isWsl || isNetworkFs,
      interval: isWsl || isNetworkFs ? 500 : undefined,
    })

    const allowedSet = new Set(sanitizedFiles)

    const onFileEvent = async (eventPath: string) => {
      const resolved = path.resolve(eventPath)
      if (!allowedSet.has(resolved)) {
        console.warn(`[ScopeGuard] Out-of-bounds write detected: ${eventPath}`)
        const sandbox = this.sandboxes.get(sandboxId)
        if (sandbox) {
          try {
            await this.rollback(sandbox)
          } catch (err) {
            console.error(`[ScopeGuard] Rollback failed for ${sandboxId}:`, err)
          }
        }
      }
    }

    watcher.on('change', onFileEvent)
    watcher.on('add', onFileEvent)

    const sandbox: Sandbox = {
      id: sandboxId,
      workingDir,
      backupDir,
      allowedFiles: sanitizedFiles,
    }

    // TYPE-02: watcher 不放入可序列化的 Sandbox 对象，单独存储
    this.watchers.set(sandboxId, watcher)
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
    // TG-007: 消毒 allowedFiles，防止路径遍历
    const sanitizedFiles = sanitizeAllowedFiles(allowedFiles, workingDir)
    const allowedSet = new Set(sanitizedFiles)
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
    // 停止文件监控（从内部 Map 获取，避免序列化问题）
    const watcher = this.watchers.get(sandbox.id)
    if (watcher) {
      await watcher.close()
      this.watchers.delete(sandbox.id)
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
