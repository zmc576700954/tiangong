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
import crypto from 'node:crypto'
import os from 'node:os'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { Sandbox, ValidationResult, AgentSessionConfig } from '@shared/types'
import { ScopeGuardError, ErrorCode } from './errors'
import { generateId } from './shared/env'
import { createLogger } from './shared/logger'
import { isErrorWithCode } from './shared/errno'
import { isPathWithin, isRelativeTraversal } from './shared/path-utils'
import { getPlatformProvider } from './platform'

/** 获取临时目录路径（可在测试中 mock） */
// THREAD-SAFETY NOTE: This module-level mutable function reference is not thread-safe.
// If setTempDirGetter is called while sandboxes are active (i.e., this.sandboxes.size > 0),
// concurrent reads of _getTempDir could see a partially replaced function. In practice,
// Electron's main process is single-threaded, so this is safe for production use. However,
// test code that calls setTempDirGetter should ensure no sandboxes are active at the time.
let _getTempDir: () => string = () => {
  // 动态 import electron 避免测试时未安装
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron')
    return app.getPath('temp')
  } catch {
    return os.tmpdir()
  }
}

/** Module-level reference to the ScopeGuard instance, used by setTempDirGetter guard */
let scopeGuardInstance: ScopeGuard | undefined

const logger = createLogger('ScopeGuard')

/** 测试时注入临时目录获取函数 */
export function setTempDirGetter(fn: () => string): void {
  // Guard: warn if sandboxes are active, as swapping the getter mid-operation
  // could cause backup directories to be created in inconsistent locations.
  if (scopeGuardInstance?.hasActiveSandboxes) {
    logger.warn('setTempDirGetter called while sandboxes are active — this is not thread-safe and may cause inconsistent temp directory paths')
  }
  _getTempDir = fn
}

/** 定时扫描初始间隔（毫秒） */
const ACTIVE_SCAN_INTERVAL_MS = 500
/** 定时扫描最大间隔（毫秒），无违规时退避上限 */
const ACTIVE_SCAN_MAX_INTERVAL_MS = 5000
/** 扫描退避系数，每次无违规时乘以此值 */
const ACTIVE_SCAN_BACKOFF_FACTOR = 1.5
/** 连续无违规达到此次数时开始退避 */
const ACTIVE_SCAN_BACKOFF_THRESHOLD = 3
/** 递归扫描最大深度 */
const MAX_SCAN_DEPTH = 5
/** 递归扫描最大运行时间（毫秒），超时后放弃本次扫描 */
const MAX_SCAN_DURATION_MS = 30_000
/** 单个快照最大文件条目数 */
const MAX_SNAPSHOT_ENTRIES = 5_000
/** 所有 sandbox 快照总条目上限，防止多 sandbox 并存时内存爆炸 */
const MAX_TOTAL_SNAPSHOT_ENTRIES = 20_000
/** 文件哈希并发上限：防止快照阶段瞬间打开过多 fd 触发 EMFILE */
const HASH_CONCURRENCY = 32

/**
 * 简单的并发信号量
 * 同时执行 limit 个任务，其余排队等待
 *
 * 实现要点（避免超 limit 的竞态）：
 *   - 旧版在 finally 里先 `active--` 再唤醒 waiter，但下一个 microtask 可能
 *     有新的 run() 调用看到 active<limit 通过门禁并 active++，之后被唤醒的
 *     waiter 再 active++，导致瞬时并发达到 limit+1。
 *   - 新版采用 slot-transfer：释放时若有 waiter，直接把 slot 交给它（active 不减），
 *     waiter 也不再二次自增；只有队列空时才 active--。
 */
class Semaphore {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
      // 唤醒路径：slot 已由 release 端转交，active 计数无需再加
    } else {
      this.active++
    }
    try {
      return await fn()
    } finally {
      const next = this.queue.shift()
      if (next) {
        // 把当前 slot 转交给下一个 waiter，active 维持不变
        next()
      } else {
        this.active--
      }
    }
  }
}

const hashSemaphore = new Semaphore(HASH_CONCURRENCY)

/** 越界检测回调类型 */
export type ScopeGuardViolationHandler = (sandboxId: string, violations: string[]) => void
/**
 * 执行后验证时忽略的文件/目录模式
 *
 * 覆盖范围：
 * 1. 构建产物与依赖目录（node_modules, dist, build 等）
 * 2. 编辑器临时文件（vim .swp/.swo、VSCode .tmp、JetBrains ___jb_*___）
 * 3. OS 元数据文件（.DS_Store、Thumbs.db、desktop.ini）
 * 4. 编辑器配置目录（.idea、.vscode）
 */
/** 快照内容哈希采样大小（前 N 字节） */
const CONTENT_HASH_SAMPLE_SIZE = 1024

const IGNORED_PATTERNS = [
  // 构建产物与依赖 — 使用路径分隔符或边界锚定，避免误匹配（如 /dist/ 匹配 my-dist-folder）
  /[\\/]node_modules[\\/]/,
  /[\\/]\.git[\\/]/,
  /[\\/]\.bizgraph[\\/]/,
  /[\\/]dist[\\/]/,
  /[\\/]dist-electron[\\/]/,
  /[\\/]release[\\/]/,
  /[\\/]\.next[\\/]/,
  /[\\/]build[\\/]/,
  // 编辑器临时文件 — 防止越界检测误报
  /\.swp$/,
  /\.swo$/,
  /___jb_\w+___$/,
  /~$/,
  /\.tmp$/,
  // OS 元数据文件
  /\.DS_Store$/,
  /Thumbs\.db$/,
  /desktop\.ini$/,
  // 编辑器配置目录
  /[\\/]\.idea([\\/]|$)/,
  /[\\/]\.vscode([\\/]|$)/,
]

/**
 * 清洗允许文件列表：移除重复、规范化路径、过滤空值
 * @note 符号链接/junction 的解析由 IPC 层的 validateProjectPath 处理
 */
function sanitizeAllowedFiles(allowedFiles: string[], workingDir: string): string[] {
  return allowedFiles.map((file) => {
    const resolved = path.resolve(workingDir, file)
    const relative = path.relative(workingDir, resolved)
    const isTraversal = isRelativeTraversal(relative) || path.isAbsolute(relative)
    if (isTraversal) {
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

/**
 * 计算文件内容哈希（快速采样）
 * 读取文件前 CONTENT_HASH_SAMPLE_SIZE 字节，使用 xxhash-like 快速哈希
 * 对于小文件读取全部内容，大文件只采样前 N 字节 + 文件大小作为混合输入
 *
 * fallback 哈希策略：
 *   绝对不能包含 Date.now()/Math.random() 之类的时变量，
 *   否则同一文件两次快照永远不一致 → 全部被误判为修改 → 错误触发回滚。
 *   失败时返回一个稳定的 "unhashable:size" 标识：两次快照若都失败仍能匹配；
 *   一边成功一边失败会判为不一致，这正是希望的行为（fd 压力下宁可重做扫描也不要静默通过）。
 */
async function computeContentHash(filePath: string, fileSize: number): Promise<string> {
  return hashSemaphore.run(async () => {
    try {
      const sampleSize = Math.min(fileSize, CONTENT_HASH_SAMPLE_SIZE)
      if (sampleSize === 0) return '0'

      const fd = await fs.open(filePath, 'r')
      try {
        const buffer = Buffer.alloc(sampleSize)
        await fd.read(buffer, 0, sampleSize, 0)
        // 使用 SHA-1 替代 SHA-256：Node.js 内部为 C 实现，速度更快，
        // 且无需 native 模块编译，适配低配机和普通用户环境。
        const hash = crypto.createHash('sha1')
        hash.update(buffer)
        hash.update(Buffer.from(fileSize.toString()))
        // 截断至 64 bit（16 十六进制字符），降低内存与比对开销。
        return hash.digest('hex').substring(0, 16)
      } finally {
        await fd.close()
      }
    } catch {
      // 无法读取时返回稳定的占位哈希——不含时间戳，避免每次都被判为变化
      return `unhashable:${fileSize}`
    }
  })
}

/** 文件系统快照项 */
interface FileSnapshotEntry {
  mtimeMs: number
  size: number
  /** 内容哈希（前 1KB 采样），用于检测文件内容是否真正变更 */
  contentHash: string
}

export class ScopeGuard {
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level singleton tracking
    scopeGuardInstance = this
  }

  /** Whether any sandboxes are currently active (used by setTempDirGetter guard) */
  get hasActiveSandboxes(): boolean {
    return this.sandboxes.size > 0
  }

  private sandboxes = new Map<string, Sandbox>()
  private watchers = new Map<string, FSWatcher>()
  /** 定时主动扫描器：补充 chokidar 的异步延迟 */
  private scanTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 初始文件系统快照：用于执行后对比验证 */
  private initialSnapshots = new Map<string, Map<string, FileSnapshotEntry>>()
  /** 每个 sandbox 监控的目录集合（用于执行后验证时复用相同扫描范围） */
  private sandboxWatchDirs = new Map<string, Set<string>>()
  /** 扫描并发锁：防止 setTimeout 回调重叠执行 */
  private scanLocks = new Set<string>()
  /** 每个 sandbox 的当前扫描间隔（自适应退避） */
  private scanIntervals = new Map<string, number>()
  /** 每个 sandbox 连续无违规扫描次数 */
  private scanCleanCounts = new Map<string, number>()
  /** 越界事件处理器（通知上层终止 Agent session） */
  private violationHandlers: ScopeGuardViolationHandler[] = []

  /** 所有 sandbox 快照总条目数（实时跟踪，用于全局内存保护） */
  private totalSnapshotEntries = 0

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
    const backupDir = path.join(_getTempDir(), 'bizgraph-backups', sandboxId)

    await fs.mkdir(backupDir, { recursive: true })

    // TG-007: 消毒 allowedFiles，防止路径遍历
    const sanitizedFiles = sanitizeAllowedFiles(allowedFiles, workingDir)

    // 备份允许修改的文件
    for (const srcPath of sanitizedFiles) {
      const relativePath = path.relative(workingDir, srcPath)
      const backupPath = path.join(backupDir, relativePath)
      await fs.mkdir(path.dirname(backupPath), { recursive: true })
      try {
        // 使用 copyFile 避免把文件完整读入用户态内存，降低低配机内存压力
        await fs.copyFile(srcPath, backupPath)
      } catch (e) {
        // ENOENT is expected (file may not exist yet); other errors need attention
        if (!isErrorWithCode(e) || e.code !== 'ENOENT') {
          logger.warn('ScopeGuard: failed to backup file', { srcPath, error: String(e) })
        }
      }
    }

    // 创建初始文件系统快照（白名单文件所在目录 + 工作目录本身，消除监控盲区）
    const watchDirs = new Set<string>()
    for (const filePath of sanitizedFiles) {
      watchDirs.add(path.dirname(filePath))
    }
    // 始终纳入工作目录，确保项目范围内所有文件变更可被检测
    watchDirs.add(workingDir)
    const initialSnapshot = await this.captureFileSnapshot(watchDirs)
    this.initialSnapshots.set(sandboxId, initialSnapshot)
    this.totalSnapshotEntries += initialSnapshot.size
    this.evictSnapshotsIfNeeded()
    this.sandboxWatchDirs.set(sandboxId, watchDirs)

    // 启动文件监控 — 白名单文件父目录 + 工作目录（消除监控盲区）
    const watchPaths: string[] = []
    const watchedDirs = new Set<string>()

    // 始终监控工作目录本身，覆盖白名单目录之外的项目文件
    if (!watchedDirs.has(workingDir)) {
      watchedDirs.add(workingDir)
      watchPaths.push(workingDir)
    }

    for (const filePath of sanitizedFiles) {
      const dir = path.dirname(filePath)
      if (!watchedDirs.has(dir)) {
        watchedDirs.add(dir)
        watchPaths.push(dir)
      }
    }

    const watcherPaths = watchPaths

    // P2-7A: WSL/网络 FS 检测，自动启用 usePolling
    const provider = getPlatformProvider()
    const isWsl = provider.isWsl
    const isNetworkFs = workingDir.startsWith('\\') || workingDir.startsWith('//')

    const providerWatcherOpts = provider.getWatcherOptions()
    const watcher = chokidar.watch(watcherPaths, {
      ignored: IGNORED_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      usePolling: isWsl || isNetworkFs,
      interval: isWsl || isNetworkFs ? 500 : undefined,
      ...providerWatcherOpts,
    })

    // 允许进程退出时不被 watcher 阻塞
    const watcherWithUnref = watcher as unknown as { unref?: () => void }
    if (typeof watcherWithUnref.unref === 'function') {
      watcherWithUnref.unref()
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
    this.startActiveScanning(sandboxId, allowedSet, workingDir)

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
      logger.error('Initial snapshot evicted — cannot validate, forcing rollback')
      return { compliant: false, outOfBoundsFiles: [], validFiles: [], shouldRollback: true }
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
      } else if (
        initialInfo.mtimeMs !== currentInfo.mtimeMs ||
        initialInfo.size !== currentInfo.size ||
        initialInfo.contentHash !== currentInfo.contentHash
      ) {
        // 已存在文件被修改（mtime/size 任一变化，或内容哈希不一致时触发深度检查）
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
      // 验证失败时保留快照，rollback 可能需要初始快照信息
    } else {
      logger.info('Post-execution validation passed')
      // 验证成功后释放初始快照内存
      if (initialSnapshot) {
        this.totalSnapshotEntries -= initialSnapshot.size
        this.initialSnapshots.delete(sandbox.id)
      }
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
        const content = await fs.readFile(backupPath)
        await fs.writeFile(targetPath, content)
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
    // 安全校验：确保 filePath 在沙箱工作目录内，防止路径遍历攻击
    // Relative paths are resolved against the sandbox working directory, not process.cwd().
    const resolvedPath = path.resolve(sandbox.workingDir, filePath)
    if (!(await isPathWithin(sandbox.workingDir, resolvedPath))) {
      logger.warn(`rollbackFile rejected: ${filePath} is outside sandbox working directory ${sandbox.workingDir}`)
      return false
    }

    const relativePath = path.relative(sandbox.workingDir, resolvedPath)
    const backupPath = path.join(sandbox.backupDir, relativePath)

    try {
      const content = await fs.readFile(backupPath)
      await fs.writeFile(resolvedPath, content)
      logger.info(`Rolled back file: ${relativePath}`)
      return true
    } catch {
      // File may not have existed before (new file) — delete it
      try {
        await fs.unlink(resolvedPath)
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
    const snapshot = this.initialSnapshots.get(sandbox.id)
    if (snapshot) {
      this.totalSnapshotEntries -= snapshot.size
    }
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

  /**
   * 销毁所有沙箱资源（应用退出时调用，防止定时器和 watcher 泄漏）
   *
   * 依次清理：
   * 1. 所有定时扫描器（scanTimers）
   * 2. 所有文件监控器（watchers）
   * 3. 所有内部状态 Map
   */
  destroy(): void {
    // Clear module-level singleton reference
    if (scopeGuardInstance === this) scopeGuardInstance = undefined

    // 1. 清理所有定时扫描器
    for (const [, timer] of this.scanTimers) {
      clearTimeout(timer)
    }
    this.scanTimers.clear()

    // 2. 清理所有文件监控器
    for (const [, watcher] of this.watchers) {
      watcher.close().catch((err) => {
        logger.warn('Failed to close watcher during destroy:', err)
      })
    }
    this.watchers.clear()

    // 3. 清理所有内部状态 Map
    this.scanLocks.clear()
    this.scanIntervals.clear()
    this.scanCleanCounts.clear()
    this.initialSnapshots.clear()
    this.totalSnapshotEntries = 0
    this.sandboxWatchDirs.clear()
    this.sandboxes.clear()
    this.violationHandlers.length = 0
  }

  // ============================================
  // 快照内存管理（全局 LRU 淘汰）
  // ============================================

  /**
   * 当全局快照总条目超限时，淘汰最早创建的非活跃 sandbox 快照
   * 使用 Map 的插入顺序作为 LRU 近似
   * 不淘汰仍在 active 状态的 sandbox，防止合规会话被错误回滚
   */
  private evictSnapshotsIfNeeded(): void {
    if (this.totalSnapshotEntries <= MAX_TOTAL_SNAPSHOT_ENTRIES) return

    const iterator = this.initialSnapshots.keys()
    while (this.totalSnapshotEntries > MAX_TOTAL_SNAPSHOT_ENTRIES) {
      const { value: oldestId, done } = iterator.next()
      if (done) break
      // Skip sandboxes that are still active (watcher exists)
      if (this.watchers.has(oldestId)) continue
      const snapshot = this.initialSnapshots.get(oldestId)
      if (snapshot) {
        this.totalSnapshotEntries -= snapshot.size
        this.initialSnapshots.delete(oldestId)
        logger.warn(`Evicted snapshot for sandbox ${oldestId} (${snapshot.size} entries) due to memory pressure`)
      }
    }
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
    if (snapshot.size >= MAX_SNAPSHOT_ENTRIES) {
      logger.warn(`Snapshot entry limit (${MAX_SNAPSHOT_ENTRIES}) reached, truncating scan at ${dir}`)
      return
    }

    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      logger.debug(`Skipping directory (no permission or deleted): ${dir}`, err)
      return // 跳过无权限目录
    }

    // 并行处理子目录和文件，减少大型目录的扫描时间
    const subDirs: string[] = []
    const files: string[] = []

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (shouldIgnorePath(fullPath)) continue

      if (entry.isDirectory()) {
        subDirs.push(fullPath)
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }

    // 并行收集所有文件 stat
    const fileStats = await Promise.all(
      files.map(async (filePath) => {
        try {
          const stat = await fs.stat(filePath)
          return { filePath, stat }
        } catch (err) {
          logger.debug(`stat failed for ${filePath}`, err)
          return null
        }
      }),
    )

    for (const result of fileStats) {
      if (result && snapshot.size < MAX_SNAPSHOT_ENTRIES) {
        const contentHash = await computeContentHash(result.filePath, result.stat.size)
        snapshot.set(result.filePath, {
          mtimeMs: result.stat.mtimeMs,
          size: result.stat.size,
          contentHash,
        })
      }
    }

    // 并行递归扫描子目录
    // 分批并发处理子目录，避免 EMFILE
    const BATCH_SIZE = 4
    for (let i = 0; i < subDirs.length; i += BATCH_SIZE) {
      const batch = subDirs.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map((subDir) => this.captureFileSnapshotRecursive(subDir, snapshot, depth + 1)))
    }
  }

  // ============================================
  // 定时主动扫描（第二层防御）
  // ============================================

  /**
   * 启动定时主动扫描
   * 使用 setTimeout 替代 setInterval，支持自适应间隔（无违规时逐步退避）
   */
  private startActiveScanning(sandboxId: string, allowedSet: Set<string>, workingDir: string): void {
    // 收集需要扫描的目录（白名单文件所在目录 + 工作目录本身，消除监控盲区）
    const dirsToScan = new Set<string>()
    for (const filePath of allowedSet) {
      dirsToScan.add(path.dirname(filePath))
    }
    // 始终扫描工作目录，确保项目范围内的越界文件可被检测
    dirsToScan.add(workingDir)

    this.scanIntervals.set(sandboxId, ACTIVE_SCAN_INTERVAL_MS)
    this.scanCleanCounts.set(sandboxId, 0)
    this.scheduleNextScan(sandboxId, dirsToScan, allowedSet, ACTIVE_SCAN_INTERVAL_MS)
  }

  /**
   * 调度下一次扫描（自适应间隔）
   */
  private scheduleNextScan(
    sandboxId: string,
    dirsToScan: Set<string>,
    allowedSet: Set<string>,
    delayMs: number,
  ): void {
    const timer = setTimeout(async () => {
      // 防止并发扫描（上一次扫描未完成时跳过本次）
      if (this.scanLocks.has(sandboxId)) {
        // 重新调度下一次
        this.scheduleNextScan(sandboxId, dirsToScan, allowedSet, delayMs)
        return
      }
      this.scanLocks.add(sandboxId)

      // 修复：若 timer 已被 stopActiveScanning 清除，则放弃本次扫描
      if (!this.scanTimers.has(sandboxId)) {
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
        const violations = await this.scanDirectoriesForViolations(dirsToScan, allowedSet, sandboxId)
        if (violations.length > 0) {
          logger.warn('Active scan found violations:', violations)
          this.notifyViolation(sandboxId, violations)
          // 发现违规：重置间隔
          this.scanCleanCounts.set(sandboxId, 0)
          this.scanIntervals.set(sandboxId, ACTIVE_SCAN_INTERVAL_MS)
        } else {
          // 无违规：逐步退避间隔
          const cleanCount = (this.scanCleanCounts.get(sandboxId) ?? 0) + 1
          this.scanCleanCounts.set(sandboxId, cleanCount)
          if (cleanCount >= ACTIVE_SCAN_BACKOFF_THRESHOLD) {
            const currentInterval = this.scanIntervals.get(sandboxId) ?? ACTIVE_SCAN_INTERVAL_MS
            const nextInterval = Math.min(
              Math.round(currentInterval * ACTIVE_SCAN_BACKOFF_FACTOR),
              ACTIVE_SCAN_MAX_INTERVAL_MS,
            )
            this.scanIntervals.set(sandboxId, nextInterval)
          }
        }
      } catch (err) {
        logger.error('Active scan error:', err)
      } finally {
        this.scanLocks.delete(sandboxId)
      }

      // 调度下一次扫描（使用当前间隔）
      const nextDelay = this.scanIntervals.get(sandboxId) ?? ACTIVE_SCAN_INTERVAL_MS
      if (this.scanTimers.has(sandboxId)) {
        this.scheduleNextScan(sandboxId, dirsToScan, allowedSet, nextDelay)
      }
    }, delayMs)

    this.scanTimers.set(sandboxId, timer)
  }

  /**
   * 停止定时主动扫描
   */
  private stopActiveScanning(sandboxId: string): void {
    const timer = this.scanTimers.get(sandboxId)
    if (timer) {
      clearTimeout(timer)
      this.scanTimers.delete(sandboxId)
    }
    this.scanLocks.delete(sandboxId)
    this.scanIntervals.delete(sandboxId)
    this.scanCleanCounts.delete(sandboxId)
  }

  /**
   * 扫描指定目录，检测越界文件（递归版，带深度限制）
   */
  private async scanDirectoriesForViolations(
    dirs: Set<string>,
    allowedSet: Set<string>,
    sandboxId?: string,
  ): Promise<string[]> {
    // 获取初始快照，用于区分“新增文件”和“已有文件”，避免误报
    const initialSnapshot = sandboxId ? this.initialSnapshots.get(sandboxId) : undefined
    const violations: string[] = []
    const scanStartTime = Date.now()
    for (const dir of dirs) {
      await this.scanDirRecursive(dir, allowedSet, violations, 0, initialSnapshot, scanStartTime)
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
    initialSnapshot?: Map<string, FileSnapshotEntry>,
    scanStartTime?: number,
  ): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return
    // Bail out if scan has exceeded maximum duration to prevent unbounded recursion
    if (scanStartTime !== undefined && Date.now() - scanStartTime > MAX_SCAN_DURATION_MS) {
      logger.warn(`Active scan exceeded ${MAX_SCAN_DURATION_MS}ms, aborting scan at ${dir}`)
      return
    }
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isDirectory()) continue
        const fullPath = path.join(dir, entry.name)
        if (shouldIgnorePath(fullPath)) continue
        if (entry.isFile()) {
          if (!allowedSet.has(fullPath)) {
            if (!initialSnapshot || !initialSnapshot.has(fullPath)) {
              // 新增的越界文件
              violations.push(fullPath)
            } else {
              // 已有越界文件被修改（mtime 变化）
              try {
                const stat = await fs.stat(fullPath)
                const snap = initialSnapshot.get(fullPath)!
                if (stat.mtimeMs !== snap.mtimeMs) {
                  violations.push(fullPath)
                }
              } catch (err) {
                logger.debug(`stat failed during violation scan: ${fullPath}`, err)
              }
            }
          }
        } else if (entry.isDirectory()) {
          await this.scanDirRecursive(fullPath, allowedSet, violations, depth + 1, initialSnapshot, scanStartTime)
        }
      }
    } catch (err) {
      logger.debug(`scanDirRecursive failed for ${dir}`, err)
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
   *
   * NOTE: This method recursively walks sandbox.workingDir and deletes empty directories
   * regardless of whether they were created during the sandbox session. This is intentional
   * behavior — after rollback, any empty directories left behind are likely artifacts of the
   * agent's operation. However, if a directory was pre-existing and became empty due to
   * unrelated causes, it could be incorrectly deleted. Deletions are logged at warn level
   * so users can review and identify any unintended removals.
   */
  private async cleanupEmptyDirs(dir: string, preserveRoot?: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      logger.warn(`cleanupEmptyDirs: failed to read directory ${dir}`, err)
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
        logger.warn(`Deleted empty directory (may not have been created by agent): ${dir}`)
      }
    } catch (err) {
      logger.warn(`cleanupEmptyDirs: failed to remove directory ${dir}`, err)
    }
  }

  /**
   * 构建范围配置
   * Static: this method does not access instance state and is a pure data transform.
   */
  static buildScopeConfig(params: {
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
