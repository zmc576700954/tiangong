/**
 * 代码智能模块统一导出
 */

export { SymbolIndex } from './symbol-index'
export { AstParser } from './ast-parser'
export { ProjectIndexer } from './project-indexer'
export { CodeFileWatcher } from './file-watcher'
export { EntityExtractor } from './entity-extractor'
export { SmartContextResolver } from './smart-context-resolver'
export { PromptAssembler } from './prompt-assembler'
export { ExecutionPlanner } from './execution-planner'

export type { ParseResult } from './ast-parser'
export type { IndexOptions } from './project-indexer'
export type { FileWatcherOptions } from './file-watcher'
export type {
  ExtractedEntity,
  ExtractionResult,
  EntityType,
} from './entity-extractor'
export type {
  SmartContextOptions,
  ResolvedCodeContext,
} from './smart-context-resolver'
export type { PromptAssemblyOptions } from './prompt-assembler'
export type { ExecutionStep, ExecutionPlan } from './execution-planner'
