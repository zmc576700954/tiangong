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
      try {
        const absolutePath = path.resolve(this.options.projectPath, filePath)
        const result = await this.indexer.reindexFile(absolutePath)
        this.options.onIndexUpdate?.({
          type: 'add',
          filePath: absolutePath,
          symbolsFound: result.symbolsFound,
        })
      } catch (err) {
        console.warn(`Failed to index added file ${filePath}:`, err)
      }
    })

    this.watcher.on('change', async (filePath) => {
      try {
        const absolutePath = path.resolve(this.options.projectPath, filePath)
        const result = await this.indexer.reindexFile(absolutePath)
        this.options.onIndexUpdate?.({
          type: 'change',
          filePath: absolutePath,
          symbolsFound: result.symbolsFound,
        })
      } catch (err) {
        console.warn(`Failed to reindex changed file ${filePath}:`, err)
      }
    })

    this.watcher.on('unlink', async (filePath) => {
      try {
        const absolutePath = path.resolve(this.options.projectPath, filePath)
        // 从索引中移除
        await (this.indexer as unknown as { symbolIndex: SymbolIndex }).symbolIndex.clearFile(absolutePath)
        this.options.onIndexUpdate?.({ type: 'unlink', filePath: absolutePath, symbolsFound: 0 })
      } catch (err) {
        console.warn(`Failed to remove unlinked file ${filePath} from index:`, err)
      }
    })
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
  }
}
