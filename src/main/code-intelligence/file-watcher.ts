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
  /** 文件变更时触发节点关联回调，用于 LLM 自动触发 */
  onNodeFileChange?: (filePath: string, changeType: 'add' | 'change' | 'unlink') => void
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
        this.options.onNodeFileChange?.(absolutePath, 'add')
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
        this.options.onNodeFileChange?.(absolutePath, 'change')
      })
    })

    this.watcher.on('unlink', (filePath) => {
      this.debouncedHandle(filePath, async () => {
        const absolutePath = path.resolve(this.options.projectPath, filePath)
        await this.indexer.clearFileIndex(absolutePath)
        this.options.onIndexUpdate?.({ type: 'unlink', filePath: absolutePath, symbolsFound: 0 })
        this.options.onNodeFileChange?.(absolutePath, 'unlink')
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

  /**
   * 根据文件扩展名分类变更等级
   * - minor: 格式/文档变更，不触发 LLM
   * - medium: 代码逻辑变更，触发节点状态更新
   * - major: 配置变更，触发结构建议
   */
  classifyChange(filePath: string): 'minor' | 'medium' | 'major' {
    const ext = path.extname(filePath).toLowerCase()
    const basename = path.basename(filePath).toLowerCase()

    // 配置文件 → major
    if (basename === 'package.json' || basename === 'tsconfig.json' || basename === '.env') {
      return 'major'
    }

    // 样式/文档 → minor
    if (ext === '.css' || ext === '.scss' || ext === '.less' || ext === '.md') {
      return 'minor'
    }

    // 其他代码文件 → medium
    return 'medium'
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
