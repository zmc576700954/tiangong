/**
 * 代码智能 IPC 处理器
 * 暴露符号索引、项目扫描、执行计划生成等能力给渲染进程
 */

import type { IpcMain } from 'electron'
import { SymbolIndex } from '../code-intelligence/symbol-index'
import { ProjectIndexer } from '../code-intelligence/project-indexer'
import { ExecutionPlanner } from '../code-intelligence/execution-planner'
import { createTypedHandle } from './utils'
import { createLogger } from '../shared/logger'

const logger = createLogger('CodeIntelIPC')

let symbolIndex: SymbolIndex | null = null
let projectIndexer: ProjectIndexer | null = null
const executionPlanner = new ExecutionPlanner()

/**
 * 初始化代码智能依赖（在数据库就绪后调用）
 */
export async function initCodeIntelligence(injectedSymbolIndex?: SymbolIndex): Promise<void> {
  symbolIndex = injectedSymbolIndex ?? new SymbolIndex()
  await symbolIndex.initTables()
  logger.info('Code intelligence initialized')
}

export function getSymbolIndex(): SymbolIndex | null {
  return symbolIndex
}

export function registerCodeIntelHandlers(ipcMain: IpcMain): void {
  const typedHandle = createTypedHandle(ipcMain)

  // 索引项目代码
  typedHandle('codeIntel:indexProject', async (_event, projectPath: string) => {
    if (!symbolIndex) {
      throw new Error('Code intelligence not initialized')
    }
    if (!projectIndexer) {
      projectIndexer = new ProjectIndexer(symbolIndex)
    }
    logger.info(`Indexing project: ${projectPath}`)
    const result = await projectIndexer.indexProject({ projectPath })
    logger.info(`Indexed ${result.filesIndexed} files, ${result.symbolsFound} symbols, ${result.importsFound} imports`)
    return result
  })

  // 查询符号
  typedHandle('codeIntel:querySymbols', async (_event, name: string, options) => {
    if (!symbolIndex) {
      throw new Error('Code intelligence not initialized')
    }
    return symbolIndex.querySymbols(name, options)
  })

  // 获取相关文件
  typedHandle('codeIntel:getRelatedFiles', async (_event, filePath: string, depth) => {
    if (!symbolIndex) {
      throw new Error('Code intelligence not initialized')
    }
    const related = await symbolIndex.getRelatedFiles(filePath, depth ?? 2)
    return Array.from(related.entries()).map(([filePath, distance]) => ({
      filePath,
      distance,
    }))
  })

  // 生成执行计划
  typedHandle('codeIntel:generatePlan', async (_event, userQuery: string) => {
    const plan = executionPlanner.generatePlan(userQuery)
    return {
      intent: plan.intent,
      steps: plan.steps,
      estimatedComplexity: plan.estimatedComplexity,
      requiresNewFiles: plan.requiresNewFiles,
      affectedSymbols: plan.affectedSymbols,
    }
  })
}
