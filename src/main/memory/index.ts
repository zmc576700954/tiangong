/**
 * 会话记忆模块 - 入口
 *
 * 借鉴 claude-mem 的记忆压缩 + 渐进式披露设计
 * 为 BizGraph 注入跨会话记忆能力
 */

export { MemoryStore, getMemoryStore, setMemoryStoreForTesting } from './memory-store'
export { MemoryExtractor } from './memory-extractor'
export { ContextCompiler } from './context-compiler'
export { ObserverCompressor } from './observer-compressor'
export type { CompressedObservation, CompressorState, ObserverCompressorConfig } from './observer-compressor'
export { HallucinationChecker } from './hallucination-checker'
export type { SuspiciousClaim, HallucinationReport, HallucinationCheckerConfig } from './hallucination-checker'
export { WaterlineSync, getWaterlineSync, setWaterlineSyncForTesting } from './waterline-sync'
export type { WaterlineSnapshot, WaterlineDelta, WaterlineSyncConfig } from './waterline-sync'
export { HybridSearchEngine, getHybridSearchEngine, setHybridSearchEngineForTesting } from './hybrid-search'
export type { RankedSearchResult, HybridSearchOptions, HybridSearchConfig } from './hybrid-search'
export { GraphMemory, formatEdgeLabel, getEdgeStyle } from './graph-memory'
export type { MemoryNode, MemoryEdge, MemoryRelationType, GraphTraversalResult, GraphMemoryConfig } from './graph-memory'
export { OutputNormalizer } from './output-normalizer'
export { PipelineRunner } from './pipeline'
export type { PipelineContext, PipelineError, PipelineStage, PipelineResult } from './pipeline'
