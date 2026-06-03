/**
 * 范围守卫 (ScopeGuard)
 * 在系统层面强制执行文件变更范围，防止 Agent 越界修改
 *
 * 三层纵深防护架构：
 * 1. 执行前防御：文件备份
 * 2. 执行中防御：chokidar 监控 + 定时主动扫描（补充 chokidar 延迟）
 * 3. 执行后防御：快照对比验证 + 增强回滚（删除越界新文件）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { Sandbox, ValidationResult, AgentSessionConfig } from '@shared/types'
import { ScopeGuardError, ErrorCode } from './errors'
import { generateId } from './shared/env'

/** 定时扫描间隔（毫秒） */
const ACTIVE_SCAN_INTERVAL_MS = 500
/** 执行后验证时忽略的文件/目录模式 */
const IGNORED_PATTERNS = [
  /node_modules/,
  /\.git/,
  /\.bizgraph/,
  /dist/,
  /dist-electron/,
  /release/,
  /\.next/,
  /build/,
]

function sanitizeAllowedFiles(allowedFiles: string[], workingDir: string): string[] {
  return allowedFiles.map((file) => {
    const resolved = path.resolve(workingDir, file)
    const relative = path.relative(workingDir, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ScopeGuardError(
        `Path traversal detected: ${file} escapes working directory ${workingDir}`,
        ErrorCode.SCOPE_PATH_TRAVERSAL,
      )
    }
    return resolved
  })
}

/** 检查路径是否应被忽略 */
function shouldIgnorePath(filePath: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(filePath))
}

/** 文件系统快照项 */
interface FileSnapshotEntry {
  mtimeMs: number
  size: number
}

export class ScopeGuard {
  private sandboxes = new Map<string, Sandbox>()
  private watchers = new Map<string, FSWatcher>()
  /** 定时主动扫描器：补充 chokidar 的异步延迟 */
  private scanTimers = new Map<string, ReturnType<typeof setInterval>>()
  /** 初始文件系统快照：用于执行后对比验证 */
  private initialSnapshots = new Map<string, Map<string, FileSnapshotEntry>>()

  /**
   * 准备沙箱环境
   * 1. 备份所有 allowedFiles
   * 2. 创建初始文件系统快照
   * 3. 启动文件系统监控（chokidar + 定时扫描）
   */
  async prepareSandbox(allowedFiles: string[], workingDir: string): Promise<Sandbox> {
    const sandboxId = generateId('sandbox')
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

    // 创建初始文件系统快照（用于执行后验证）
    const initialSnapshot = await this.captureFileSnapshot(workingDir)
    this.initialSnapshots.set(sandboxId, initialSnapshot)

    // 启动文件监控 — 仅监控 allowedFiles 及其父目录
    const watchPaths: string[] = []
    const watchedDirs = new Set<string>()

    for (const filePath of sanitizedFiles) {
      const dir = path.dirname(filePath)
      if (!watchedDirs.has(dir)) {
        watchedDirs.add(dir)
        watchPaths.push(dir)
      }
    }

    const watcherPaths = watchPaths.length > 0 ? watchPaths : workingDir

    // P2-7A: WSL/网络 FS 检测，自动启用 usePolling
    const isWsl = process.platform === 'linux' && process.env.WSL_DISTRO_NAME !== undefined
    const isNetworkFs = workingDir.startsWith('\\') || workingDir.startsWith('//')

    const watcher = chokidar.watch(watcherPaths, {
      ignored: IGNORED_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      usePolling: isWsl || isNetworkFs,
      interval: isWsl || isNetworkFs ? 500 : undefined,
    })

    const allowedSet = new Set(sanitizedFiles)

    // chokidar 事件处理器（第一层：快速响应）
    const onFileEvent = async (eventPath: string) => {
      const sandbox = this.sandboxes.get(sandboxId)
      const resolved = sandbox ? path.resolve(sandbox.workingDir, eventPath) : path.resolve(eventPath)

      if (shouldIgnorePath(resolved)) return

      if (!allowedSet.has(resolved)) {
        console.warn(`[ScopeGuard] Out-of-bounds write detected by watcher: ${eventPath}`)
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

    // 启动定时主动扫描（第二层：补充 chokidar 延迟）
    this.startActiveScanning(sandboxId, allowedSet)

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
   * 执行后完整验证（第三层防御）
   *
   * 对比执行前后的文件系统快照，检测所有变更：
   * - 新增文件：是否在白名单内？
   * - 修改文件：是否在白名单内？
   * - 删除文件：白名单文件被删除视为合规（Agent 有权删除自己创建的文件）
   *
   * 返回结果包含 newFiles 列表，用于回滚时删除越界新文件
   */
  async postExecutionValidation(sandbox: Sandbox): Promise<ValidationResult> {
    const initialSnapshot = this.initialSnapshots.get(sandbox.id)
    if (!initialSnapshot) {
      console.warn('[ScopeGuard] No initial snapshot found, skipping post-execution validation')
      return { compliant: true, outOfBoundsFiles: [], validFiles: [], shouldRollback: false }
    }

    const currentSnapshot = await this.captureFileSnapshot(sandbox.workingDir)
    const allowedSet = new Set(sandbox.allowedFiles)
    const outOfBoundsFiles: string[] = []
    const validFiles: string[] = []
    const newFiles: string[] = []

    // 检测新增和修改的文件
    for (const [filePath, currentInfo] of currentSnapshot) {
      const initialInfo = initialSnapshot.get(filePath)

      if (!initialInfo) {
        // 新增文件
        if (allowedSet.has(filePath)) {
          validFiles.push(filePath)
        } else {
          outOfBoundsFiles.push(filePath)
          newFiles.push(filePath)
        }
      } else if (initialInfo.mtimeMs !== currentInfo.mtimeMs || initialInfo.size !== currentInfo.size) {
        // 已存在文件被修改
        if (allowedSet.has(filePath)) {
          validFiles.push(filePath)
        } else {
          outOfBoundsFiles.push(filePath)
        }
      }
    }

    // 检测被删除的白名单文件（不算违规，但记录用于日志）
    for (const [filePath] of initialSnapshot) {
      if (!currentSnapshot.has(filePath) && allowedSet.has(filePath)) {
        validFiles.push(filePath)
      }
    }

    const result: ValidationResult = {
      compliant: outOfBoundsFiles.length === 0,
      outOfBoundsFiles,
      validFiles,
      shouldRollback: outOfBoundsFiles.length > 0,
      newFiles,
    }

    if (!result.compliant) {
      console.warn(
        `[ScopeGuard] Post-execution validation failed: ${outOfBoundsFiles.length} out-of-bounds files detected`,
      )
    } else {
      console.log('[ScopeGuard] Post-execution validation passed')
    }

    return result
  }

  /**
   * 验证变更范围（供外部调用，基于已知变更列表）
   */
  validateChanges(actualChanges: string[], allowedFiles: string[], workingDir: string): ValidationResult {
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
   * 强制回滚到备份状态（增强版）
   *
   * 1. 恢复备份文件
   * 2. 删除越界的新创建文件（防止 Agent 残留）
   * 3. 清理空目录
   * 4. 释放沙箱资源
   */
  async rollback(sandbox: Sandbox, validationResult?: ValidationResult): Promise<void> {
    console.log(`[ScopeGuard] Rolling back sandbox ${sandbox.id}...`)

    // 1. 恢复备份文件
    const backupFiles = await this.listFilesRecursive(sandbox.backupDir)
    for (const backupPath of backupFiles) {
      const relativePath = path.relative(sandbox.backupDir, backupPath)
      const targetPath = path.join(sandbox.workingDir, relativePath)

      try {
        const content = await fs.readFile(backupPath, 'utf-8')
        await fs.writeFile(targetPath, content, 'utf-8')
        console.log(`[ScopeGuard] Restored: ${relativePath}`)
      } catch (err) {
        console.warn(`[ScopeGuard] Failed to restore ${relativePath}:`, err)
      }
    }

    // 2. 删除越界的新创建文件
    const filesToDelete = validationResult?.newFiles ?? []
    for (const filePath of filesToDelete) {
      try {
        await fs.unlink(filePath)
        console.log(`[ScopeGuard] Deleted out-of-bounds new file: ${filePath}`)
      } catch (err) {
        console.warn(`[ScopeGuard] Failed to delete ${filePath}:`, err)
      }
    }

    // 3. 清理空目录（保留工作目录本身）
    await this.cleanupEmptyDirs(sandbox.workingDir, sandbox.workingDir)

    // 4. 释放沙箱资源
    await this.cleanupSandbox(sandbox)

    console.log(`[ScopeGuard] Rollback completed for sandbox ${sandbox.id}`)
  }

  /**
   * 提交变更（确认合规后调用）
   * 执行后验证通过后调用
   */
  async commitChanges(sandbox: Sandbox): Promise<ValidationResult> {
    // 执行后验证（第三层防御）
    const validation = await this.postExecutionValidation(sandbox)

    if (!validation.compliant) {
      console.warn('[ScopeGuard] Commit rejected: post-execution validation failed, rolling back...')
      await this.rollback(sandbox, validation)
      throw new ScopeGuardError(
        `Commit rejected: ${validation.outOfBoundsFiles.length} out-of-bounds files detected: ${validation.outOfBoundsFiles.join(', ')}`,
        ErrorCode.SCOPE_OUT_OF_BOUNDS,
      )
    }

    // 验证通过，清理沙箱资源
    await this.cleanupSandbox(sandbox)
    return validation
  }

  /**
   * 清理沙箱资源（停止监控、删除备份、释放快照）
   */
  private async cleanupSandbox(sandbox: Sandbox): Promise<void> {
    // 停止定时扫描
    this.stopActiveScanning(sandbox.id)

    // 释放快照
    this.initialSnapshots.delete(sandbox.id)

    // 停止文件监控
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

  // ============================================
  // 文件系统快照（用于执行后验证）
  // ============================================

  /**
   * 捕获文件系统快照
   * 递归扫描目录，记录每个文件的 mtimeMs 和 size
   * 不保存文件内容，防止内存溢出
   */
  private async captureFileSnapshot(dir: string): Promise<Map<string, FileSnapshotEntry>> {
    const snapshot = new Map<string, FileSnapshotEntry>()
    await this.captureFileSnapshotRecursive(dir, snapshot)
    return snapshot
  }

  private async captureFileSnapshotRecursive(dir: string, snapshot: Map<string, FileSnapshotEntry>): Promise<void> {
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // 跳过无权限目录
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (shouldIgnorePath(fullPath)) continue

      if (entry.isDirectory()) {
        await this.captureFileSnapshotRecursive(fullPath, snapshot)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath)
          snapshot.set(fullPath, { mtimeMs: stat.mtimeMs, size: stat.size })
        } catch {
          // 忽略无法 stat 的文件
        }
      }
    }
  }

  // ============================================
  // 定时主动扫描（第二层防御）
  // ============================================

  /**
   * 启动定时主动扫描
   * 每 500ms 扫描一次白名单目录，补充 chokidar 的异步延迟
   */
  private startActiveScanning(sandboxId: string, allowedSet: Set<string>): void {
    // 收集需要扫描的目录（白名单文件所在的目录）
    const dirsToScan = new Set<string>()
    for (const filePath of allowedSet) {
      dirsToScan.add(path.dirname(filePath))
    }

    const timer = setInterval(async () => {
      const sandbox = this.sandboxes.get(sandboxId)
      if (!sandbox) {
        this.stopActiveScanning(sandboxId)
        return
      }

      try {
        const violations = await this.scanDirectoriesForViolations(dirsToScan, allowedSet)
        if (violations.length > 0) {
          console.warn(`[ScopeGuard] Active scan found violations:`, violations)
          await this.rollback(sandbox)
        }
      } catch (err) {
        console.error(`[ScopeGuard] Active scan error:`, err)
      }
    }, ACTIVE_SCAN_INTERVAL_MS)

    this.scanTimers.set(sandboxId, timer)
  }

  /**
   * 停止定时主动扫描
   */
  private stopActiveScanning(sandboxId: string): void {
    const timer = this.scanTimers.get(sandboxId)
    if (timer) {
      clearInterval(timer)
      this.scanTimers.delete(sandboxId)
    }
  }

  /**
   * 扫描指定目录，检测越界文件
   * 只扫描白名单文件所在的目录，避免递归整个项目
   */
  private async scanDirectoriesForViolations(
    dirs: Set<string>,
    allowedSet: Set<string>,
  ): Promise<string[]> {
    const violations: string[] = []

    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile()) continue
          const fullPath = path.join(dir, entry.name)
          if (shouldIgnorePath(fullPath)) continue
          if (!allowedSet.has(fullPath)) {
            violations.push(fullPath)
          }
        }
      } catch {
        // 忽略无权限目录
      }
    }

    return violations
  }

  // ============================================
  // 工具方法
  // ============================================

  /**
   * 递归列出目录中的所有文件
   */
  private async listFilesRecursive(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await this.listFilesRecursive(fullPath)))
      } else {
        files.push(fullPath)
      }
    }
    return files
  }

  /**
   * 清理空目录（从下往上）
   * @param dir - 要清理的目录
   * @param preserveRoot - 保留的根目录（不会删除此目录本身）
   */
  private async cleanupEmptyDirs(dir: string, preserveRoot?: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(dir, entry.name)
        if (!shouldIgnorePath(subDir)) {
          await this.cleanupEmptyDirs(subDir, preserveRoot)
        }
      }
    }

    // 重新读取，看是否变为空目录
    try {
      const remaining = await fs.readdir(dir)
      if (remaining.length === 0 && dir !== preserveRoot) {
        await fs.rmdir(dir)
      }
    } catch {
      // 忽略删除错误
    }
  }

  /**
   * 构建范围配置
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
