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
import type { Dirent } from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { Sandbox, ValidationResult, AgentSessionConfig } from '@shared/types'
import { ScopeGuardError, ErrorCode } from './errors'
import { generateId } from './shared/env'
import { createLogger } from './shared/logger'

const logger = createLogger('ScopeGuard')

/** 定时扫描间隔（毫秒） */
const ACTIVE_SCAN_INTERVAL_MS = 500
/** 递归扫描最大深度 */
const MAX_SCAN_DEPTH = 3

/** 越界检测回调类型 */
export type ScopeGuardViolationHandler = (sandboxId: string, violations: string[]) => void
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
  /** 每个 sandbox 监控的目录集合（用于执行后验证时复用相同扫描范围） */
  private sandboxWatchDirs = new Map<string, Set<string>>()
  /** 扫描并发锁：防止 setInterval 回调重叠执行 */
  private scanLocks = new Set<string>()
  /** 越界事件处理器（通知上层终止 Agent session） */
  private violationHandlers: ScopeGuardViolationHandler[] = []

  /** 注册越界事件处理器 */
  onViolation(handler: ScopeGuardViolationHandler): void {
    this.violationHandlers.push(handler)
  }

  /** 通知所有越界事件处理器 */
  private notifyViolation(sandboxId: string, violations: string[]): void {
    for (const handler of this.violationHandlers) {
      try { handler(sandboxId, violations) } catch (err) {
        logger.error('violation handler error:', err)
      }
    }
  }

  /**
   * 准备沙箱环境
   * 1. 备份所有 allowedFiles
   * 2. 创建初始文件系统快照（仅扫描白名单相关目录）
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

    // 创建初始文件系统快照（仅扫描白名单文件所在目录，避免全目录递归）
    const watchDirs = new Set<string>()
    for (const filePath of sanitizedFiles) {
      watchDirs.add(path.dirname(filePath))
    }
    // 若白名单为空则退化为监控工作目录本身
    if (watchDirs.size === 0) {
      watchDirs.add(workingDir)
    }
    const initialSnapshot = await this.captureFileSnapshot(watchDirs)
    this.initialSnapshots.set(sandboxId, initialSnapshot)
    this.sandboxWatchDirs.set(sandboxId, watchDirs)

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

    // 允许进程退出时不被 watcher 阻塞
    if (typeof watcher.unref === 'function') {
      watcher.unref()
    }

    const allowedSet = new Set(sanitizedFiles)

    // chokidar 事件处理器（第一层：快速响应）
    const onFileEvent = async (eventPath: string) => {
      const sandbox = this.sandboxes.get(sandboxId)
      const resolved = sandbox ? path.resolve(sandbox.workingDir, eventPath) : path.resolve(eventPath)

      if (shouldIgnorePath(resolved)) return

      if (!allowedSet.has(resolved)) {
        logger.warn(`Out-of-bounds write detected by watcher: ${eventPath}`)
        this.notifyViolation(sandboxId, [resolved])
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
      logger.warn('No initial snapshot found, skipping post-execution validation')
      return { compliant: true, outOfBoundsFiles: [], validFiles: [], shouldRollback: false }
    }

    const watchDirs = this.sandboxWatchDirs.get(sandbox.id)
    const currentSnapshot = watchDirs
      ? await this.captureFileSnapshot(watchDirs)
      : await this.captureFileSnapshot(new Set([sandbox.workingDir]))
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
      logger.warn(
        `Post-execution validation failed: ${outOfBoundsFiles.length} out-of-bounds files detected`,
      )
    } else {
      logger.info('Post-execution validation passed')
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
    logger.info(`Rolling back sandbox ${sandbox.id}...`)

    // 1. 恢复备份文件
    const backupFiles = await this.listFilesRecursive(sandbox.backupDir)
    for (const backupPath of backupFiles) {
      const relativePath = path.relative(sandbox.backupDir, backupPath)
      const targetPath = path.join(sandbox.workingDir, relativePath)

      try {
        const content = await fs.readFile(backupPath, 'utf-8')
        await fs.writeFile(targetPath, content, 'utf-8')
        logger.info(`Restored: ${relativePath}`)
      } catch (err) {
        logger.warn(`Failed to restore ${relativePath}:`, err)
      }
    }

    // 2. 删除越界的新创建文件
    const filesToDelete = validationResult?.newFiles ?? []
    for (const filePath of filesToDelete) {
      try {
        await fs.unlink(filePath)
        logger.info(`Deleted out-of-bounds new file: ${filePath}`)
      } catch (err) {
        logger.warn(`Failed to delete ${filePath}:`, err)
      }
    }

    // 3. 清理空目录（保留工作目录本身）
    await this.cleanupEmptyDirs(sandbox.workingDir, sandbox.workingDir)

    // 4. 释放沙箱资源
    await this.cleanupSandbox(sandbox)

    logger.info(`Rollback completed for sandbox ${sandbox.id}`)
  }

  /**
   * 回滚单个文件到备份状态
   */
  async rollbackFile(sandbox: Sandbox, filePath: string): Promise<boolean> {
    const relativePath = path.relative(sandbox.workingDir, filePath)
    const backupPath = path.join(sandbox.backupDir, relativePath)

    try {
      const content = await fs.readFile(backupPath, 'utf-8')
      await fs.writeFile(filePath, content, 'utf-8')
      logger.info(`Rolled back file: ${relativePath}`)
      return true
    } catch {
      // File may not have existed before (new file) — delete it
      try {
        await fs.unlink(filePath)
        logger.info(`Deleted new file: ${relativePath}`)
        return true
      } catch {
        logger.warn(`Failed to rollback ${relativePath}`)
        return false
      }
    }
  }

  /**
   * 提交变更（确认合规后调用）
   * 执行后验证通过后调用
   */
  async commitChanges(sandbox: Sandbox): Promise<ValidationResult> {
    // 执行后验证（第三层防御）
    const validation = await this.postExecutionValidation(sandbox)

    if (!validation.compliant) {
      logger.warn('Commit rejected: post-execution validation failed, rolling back...')
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

    // 释放快照和监控目录记录
    this.initialSnapshots.delete(sandbox.id)
    this.sandboxWatchDirs.delete(sandbox.id)

    // 停止文件监控
    const watcher = this.watchers.get(sandbox.id)
    if (watcher) {
      await watcher.close()
      this.watchers.delete(sandbox.id)
    }

    // 删除备份目录
    try {
      await fs.rm(sandbox.backupDir, { recursive: true, force: true })
    } catch (err) {
      logger.warn(`Failed to delete backup directory ${sandbox.backupDir}:`, err)
    }

    this.sandboxes.delete(sandbox.id)
  }

  // ============================================
  // 文件系统快照（用于执行后验证）
  // ============================================

  /**
   * 捕获文件系统快照
   * 扫描指定目录集合，记录每个文件的 mtimeMs 和 size
   * 不保存文件内容，防止内存溢出
   */
  private async captureFileSnapshot(dirs: Set<string>): Promise<Map<string, FileSnapshotEntry>> {
    const snapshot = new Map<string, FileSnapshotEntry>()
    for (const dir of dirs) {
      await this.captureFileSnapshotRecursive(dir, snapshot, 0)
    }
    return snapshot
  }

  private async captureFileSnapshotRecursive(dir: string, snapshot: Map<string, FileSnapshotEntry>, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // 跳过无权限目录
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (shouldIgnorePath(fullPath)) continue

      if (entry.isDirectory()) {
        await this.captureFileSnapshotRecursive(fullPath, snapshot, depth + 1)
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
      // 防止并发扫描（上一次扫描未完成时跳过本次）
      if (this.scanLocks.has(sandboxId)) return
      this.scanLocks.add(sandboxId)

      // 修复：若 timer 已被 stopActiveScanning 清除，则放弃本次扫描
      if (this.scanTimers.get(sandboxId) !== timer) {
        this.scanLocks.delete(sandboxId)
        return
      }

      const sandbox = this.sandboxes.get(sandboxId)
      if (!sandbox) {
        this.scanLocks.delete(sandboxId)
        this.stopActiveScanning(sandboxId)
        return
      }

      try {
        const violations = await this.scanDirectoriesForViolations(dirsToScan, allowedSet)
        if (violations.length > 0) {
          logger.warn('Active scan found violations:', violations)
          this.notifyViolation(sandboxId, violations)
        }
      } catch (err) {
        logger.error('Active scan error:', err)
      } finally {
        this.scanLocks.delete(sandboxId)
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
    this.scanLocks.delete(sandboxId)
  }

  /**
   * 扫描指定目录，检测越界文件（递归版，带深度限制）
   */
  private async scanDirectoriesForViolations(
    dirs: Set<string>,
    allowedSet: Set<string>,
  ): Promise<string[]> {
    const violations: string[] = []
    for (const dir of dirs) {
      await this.scanDirRecursive(dir, allowedSet, violations, 0)
    }
    return violations
  }

  /**
   * 递归扫描目录，检测不在白名单中的文件
   */
  private async scanDirRecursive(
    dir: string,
    allowedSet: Set<string>,
    violations: string[],
    depth: number,
  ): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isDirectory()) continue
        const fullPath = path.join(dir, entry.name)
        if (shouldIgnorePath(fullPath)) continue
        if (entry.isFile()) {
          if (!allowedSet.has(fullPath)) {
            violations.push(fullPath)
          }
        } else if (entry.isDirectory()) {
          await this.scanDirRecursive(fullPath, allowedSet, violations, depth + 1)
        }
      }
    } catch {
      // 忽略无权限目录
    }
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
    let entries: Dirent[]
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
