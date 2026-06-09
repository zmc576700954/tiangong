/**
 * 代码文件变更监听器
 * 使用 chokidar 监听文件变化，自动触发增量索引更新
 */

import * as chokidar from 'chokidar'
import * as path from 'node:path'
import { ProjectIndexer } from './project-indexer'

export interface FileWatcherOptions {
  projectPath: string
  indexer: ProjectIndexer
  includePatterns?: string[]
  excludePatterns?: string[]
  onIndexUpdate?: (event: {
    type: 'add' | 'change' | 'unlink'
    filePath: string
    symbolsFound: number
  }) => void
}

/**
 * 代码文件变更监听器
 * 使用 chokidar 监听文件变化，自动触发增量索引更新
 */
export class CodeFileWatcher {
  private watcher?: chokidar.FSWatcher
  private indexer: ProjectIndexer
  private options: FileWatcherOptions
  /** 防抖定时器：避免短时间内重复触发索引更新 */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly DEBOUNCE_MS = 300

  constructor(options: FileWatcherOptions) {
    this.options = options
    this.indexer = options.indexer
  }

  async start(): Promise<void> {
    const include = this.options.includePatterns ?? ['**/*.{ts,tsx,js,jsx}']
    const ignored = this.options.excludePatterns ?? [
      'node_modules/**',
      'dist/**',
      '.git/**',
      'build/**',
    ]

    this.watcher = chokidar.watch(include.map((p) => path.join(this.options.projectPath, p)), {
      ignored,
      persistent: true,
      ignoreInitial: true, // 初始索引由 ProjectIndexer 完成
      cwd: this.options.projectPath,
    })

    this.watcher.on('add', async (filePath) => {
      this.debouncedHandle(filePath, async () => {
        const absolutePath = path.resolve(this.options.projectPath, filePath)
        const result = await this.indexer.reindexFile(absolutePath)
        this.options.onIndexUpdate?.({
          type: 'add',
          filePath: absolutePath,
          symbolsFound: result.symbolsFound,
        })
      })
    })

    this.watcher.on('change', async (filePath) => {
      this.debouncedHandle(filePath, async () => {
        const absolutePath = path.resolve(this.options.projectPath, filePath)
        const result = await this.indexer.reindexFile(absolutePath)
        this.options.onIndexUpdate?.({
          type: 'change',
          filePath: absolutePath,
          symbolsFound: result.symbolsFound,
        })
      })
    })

    this.watcher.on('unlink', (filePath) => {
      this.debouncedHandle(filePath, async () => {
        const absolutePath = path.resolve(this.options.projectPath, filePath)
        await this.indexer.clearFileIndex(absolutePath)
        this.options.onIndexUpdate?.({ type: 'unlink', filePath: absolutePath, symbolsFound: 0 })
      })
    })
  }

  async stop(): Promise<void> {
    // 清除所有防抖定时器
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    await this.watcher?.close()
  }

  /** 防抖包装：同一文件的短时间内多次事件只执行最后一次 */
  private debouncedHandle(filePath: string, handler: () => Promise<void>): void {
    const existing = this.debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath)
      try {
        await handler()
      } catch (err) {
        console.warn(`File watcher error for ${filePath}:`, err)
      }
    }, this.DEBOUNCE_MS)

    this.debounceTimers.set(filePath, timer)
  }
}
