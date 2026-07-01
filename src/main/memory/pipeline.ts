/**
 * ContextPipeline 统一管线
 *
 * 将 OutputNormalizer → HallucinationChecker → MemoryExtractor →
 * WaterlineSync → ContextCompiler 串联为可插拔的处理管线。
 * 每个阶段独立运行，失败不阻塞后续阶段。
 */

import type { AgentOutput, MemoryItem } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('PipelineRunner')


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineError {
  stage: string
  error: Error
}

export interface PipelineContext {
  outputs: AgentOutput[]
  sessionId: string
  adapterName?: string
  projectId?: string
  nodeId?: string
  normalizedOutputs?: AgentOutput[]
  observations?: Array<{ summary: string; text?: string; outputTokens: number }>
  memories?: Omit<MemoryItem, 'id'>[]
  hallucinationReport?: { passed: boolean; riskScore: number; details?: string[] }
  layeredContext?: { layers: Array<{ level: number; label: string; content: string; estimatedTokens: number }> }
  waterlineDelta?: { newFindings: string[]; pendingIssues: string[]; resolvedSinceLast: string[]; sessionsSinceLast: number }
  errors?: PipelineError[]
}

export interface PipelineStage {
  name: string
  /** 返回 false 跳过此阶段 */
  enabled?: () => boolean
  process: (ctx: PipelineContext) => Promise<PipelineContext>
  hooks?: {
    before?: (ctx: PipelineContext) => void
    after?: (ctx: PipelineContext) => void
  }
}

export interface PipelineResult {
  context: PipelineContext
  errors: PipelineError[]
  durationMs: number
}

/** Overrides for pipeline stage configuration */
export interface StageOverride {
  /** Stage names to skip entirely */
  skip?: string[]
  /** Stage name → replacement stage implementation */
  replace?: Record<string, PipelineStage>
}

// ---------------------------------------------------------------------------
// PipelineRunner
// ---------------------------------------------------------------------------

export class PipelineRunner {
  /**
   * 跨 runner 实例存活的 pipeline 执行计数。
   * createDefault 每次会话结束都会新建 runner 实例，若用实例字段会每次归零，
   * 导致周期性 adapt() 永不触发。静态字段解决此问题，同时可在测试中重置：
   *   PipelineRunner._executionCount = 0
   */
  static _executionCount = 0

  constructor(private readonly stages: PipelineStage[]) {}

  /**
   * 顺序执行所有阶段。
   * - 某阶段失败时记录错误，不阻塞后续阶段
   * - enabled() 返回 false 时跳过
   * - 调用 before/after hooks
   */
  async run(initial: Partial<PipelineContext>): Promise<PipelineResult> {
    const start = performance.now()
    const errors: PipelineError[] = []

    // 构建完整上下文，补全必填字段
    let ctx: PipelineContext = {
      outputs: initial.outputs ?? [],
      sessionId: initial.sessionId ?? '',
      adapterName: initial.adapterName,
      projectId: initial.projectId,
      nodeId: initial.nodeId,
      normalizedOutputs: initial.normalizedOutputs,
      observations: initial.observations,
      memories: initial.memories,
      hallucinationReport: initial.hallucinationReport,
      layeredContext: initial.layeredContext,
      waterlineDelta: initial.waterlineDelta,
      errors: initial.errors,
    }

    for (const stage of this.stages) {
      // 检查是否启用
      if (stage.enabled && !stage.enabled()) {
        continue
      }

      // before hook
      try {
        stage.hooks?.before?.(ctx)
      } catch {
        // hook 错误不阻塞管线
      }

      // 执行阶段
      try {
        ctx = await stage.process(ctx)
      } catch (err) {
        errors.push({
          stage: stage.name,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }

      // after hook
      try {
        stage.hooks?.after?.(ctx)
      } catch {
        // hook 错误不阻塞管线
      }
    }

    const durationMs = performance.now() - start

    return { context: ctx, errors, durationMs }
  }

  /**
   * 创建默认的完整管线（8 阶段）
   *
   * 阶段顺序: normalize → compress → extract → verify → compile → waterline → node-bind → persist
   * 每个阶段独立运行，失败不阻塞后续阶段。
   * 使用动态 import 避免循环依赖和启动时的全量加载。
   */
  static async createDefault(overrides?: StageOverride): Promise<PipelineRunner> {
    const { OutputNormalizer } = await import('./output-normalizer')
    const { ObserverCompressor } = await import('./observer-compressor')
    const { MemoryExtractor } = await import('./memory-extractor')
    const { HallucinationChecker } = await import('./hallucination-checker')
    const { ContextCompiler } = await import('./context-compiler')
    const { getWaterlineSync } = await import('./waterline-sync')
    const { getMemoryStore } = await import('./memory-store')
    const { getAdaptiveConfig } = await import('../adaptive-config')

    const normalizer = new OutputNormalizer()
    const compressor = new ObserverCompressor()
    const extractor = new MemoryExtractor()
    const checker = new HallucinationChecker()
    const compiler = new ContextCompiler()

    // Build the default stages array
    const defaultStages: PipelineStage[] = [
      {
        name: 'normalize',
        process: async (ctx) => ({
          ...ctx,
          normalizedOutputs: normalizer.normalizeAll(ctx.outputs, ctx.adapterName),
        }),
      },
      {
        name: 'compress',
        process: async (ctx) => {
          // Read compress threshold from AdaptiveConfig instead of hardcoded value
          const adaptiveConfig = getAdaptiveConfig()
          const threshold = adaptiveConfig.get('compressThresholdTokens')

          for (const output of ctx.normalizedOutputs ?? ctx.outputs) {
            compressor.feed(output)
          }
          const observations = compressor.finalize()

          // Record output token estimate from observations for adaptive tuning
          const outputTokens = observations.reduce(
            (sum, obs) => sum + obs.outputTokens, 0,
          )
          adaptiveConfig.recordMetric('compressThresholdTokens', outputTokens)

          // Log the threshold being used for observability
          logger.info(`Compress stage: threshold=${threshold}, outputTokens≈${outputTokens}`)

          return { ...ctx, observations }
        },
      },
      {
        name: 'extract',
        process: async (ctx) => {
          // 当 compress 产出 observations 时，用其摘要作为主文本来源；
          // 但必须始终并入原始的 file_change 事件——MemoryExtractor 主要依赖它推断
          // files_modified（进而决定 kind=fix、graph-memory 的 depends_on/supersedes、
          // waterline 的 modifiedFiles）。仅传 observation 摘要会丢失全部文件变更信息。
          const baseOutputs = ctx.normalizedOutputs ?? ctx.outputs
          let sourceOutputs: AgentOutput[]
          if (ctx.observations && ctx.observations.length > 0) {
            const fileChangeEvents = baseOutputs.filter((o) => o.type === 'file_change')
            const observationOutputs: AgentOutput[] = ctx.observations.map((obs) => ({
              type: 'stdout' as const,
              data: obs.summary ?? obs.text ?? '',
              timestamp: Date.now(),
            }))
            sourceOutputs = [...observationOutputs, ...fileChangeEvents]
          } else {
            sourceOutputs = baseOutputs
          }
          return {
            ...ctx,
            memories: extractor.extract(ctx.sessionId, sourceOutputs, { adapterName: ctx.adapterName ?? 'unknown' }),
          }
        },
      },
      {
        name: 'verify',
        hooks: {
          after: (ctx) => {
            if (ctx.hallucinationReport && !ctx.hallucinationReport.passed) {
              logger.warn(`Hallucination check: risk=${ctx.hallucinationReport.riskScore}`)
            }
          },
        },
        process: async (ctx) => ({
          ...ctx,
          // 使用异步 verify() 并传入工作目录（projectId 即 workingDirectory），
          // 以启用文件路径幻觉检查（_checkFileClaims）——这是最能识别幻觉的检查，
          // verifySync 会跳过它，导致 persist 阶段据以过滤的 riskScore 被显著削弱。
          hallucinationReport: ctx.projectId
            ? await checker.verify(ctx.normalizedOutputs ?? ctx.outputs, ctx.projectId)
            : checker.verifySync(ctx.normalizedOutputs ?? ctx.outputs),
        }),
      },
      {
        name: 'compile',
        process: async (ctx) => ({
          ...ctx,
          layeredContext: await compiler.compile(ctx.normalizedOutputs ?? ctx.outputs, {
            sessionId: ctx.sessionId,
            adapterName: ctx.adapterName,
            projectId: ctx.projectId,
            nodeId: ctx.nodeId,
          }),
        }),
      },
      {
        name: 'waterline',
        process: async (ctx) => {
          const waterline = getWaterlineSync()
          if (ctx.memories && ctx.memories.length > 0) {
            waterline.advance(ctx.projectId ?? '', ctx.memories as MemoryItem[])
          }
          // Data flow: compile→waterline — if layeredContext has L1/L2 summaries,
          // extract concept keywords and register them as completed investigations
          // so that future sessions avoid re-investigating the same topics.
          if (ctx.layeredContext?.layers) {
            const conceptLayers = ctx.layeredContext.layers.filter(
              (layer: { level: number; content: string }) => layer.level === 1 || layer.level === 2,
            )
            if (conceptLayers.length > 0) {
              const concepts = conceptLayers
                .map((layer: { level: number; content: string }) => layer.content)
                .filter(Boolean)
              waterline.addCompletedInvestigations(ctx.projectId ?? '', concepts)
            }
          }
          const delta = waterline.getDelta(ctx.projectId ?? '')
          // 持久化水位线快照，使其在进程重启后可恢复（restore()）。
          // 此前无任何生产调用方调用 persist，导致已完成调查/已修复问题/已验证节点
          // 全部仅存于内存，进程退出即丢失，"避免重复工作"的核心功能失效。
          if (ctx.projectId) {
            try {
              waterline.persist(ctx.projectId)
            } catch (err) {
              logger.warn('Waterline persist failed:', err)
            }
          }
          return { ...ctx, waterlineDelta: delta }
        },
      },
      {
        name: 'node-bind',
        process: async (ctx) => {
          if (ctx.nodeId && ctx.projectId && ctx.memories && ctx.memories.length > 0) {
            try {
              const waterline = getWaterlineSync()
              waterline.markNodeVerified(ctx.projectId, ctx.nodeId)
            } catch {
              // node-bind is a side-effect; errors should not block the pipeline
            }
          }
          return ctx
        },
      },
      {
        name: 'persist',
        process: async (ctx) => {
          if (ctx.memories && ctx.memories.length > 0) {
            const store = getMemoryStore()
            const riskScore = ctx.hallucinationReport?.riskScore ?? 0

            // Tiered filtering based on hallucination risk:
            // risk > 90: only keep high-confidence, verified memories
            // risk > 70: keep medium+ confidence; mark low-confidence (0.3-0.5) as unverified
            // risk <= 70: keep all memories (they're verified)
            let safeMemories: Omit<MemoryItem, 'id'>[]
            if (riskScore > 90) {
              safeMemories = ctx.memories.filter(m => (m.confidence ?? 0) > 0.8)
            } else if (riskScore > 70) {
              // Keep memories with confidence > 0.5 as-is
              // Mark memories with confidence 0.3-0.5 as unverified instead of discarding
              safeMemories = ctx.memories
                .filter(m => (m.confidence ?? 0) > 0.3)
                .map(m => {
                  const confidence = m.confidence ?? 0
                  if (confidence > 0.5) {
                    return m
                  }
                  // confidence 0.3-0.5: mark as unverified via narrative annotation
                  return {
                    ...m,
                    narrative: m.narrative + ' (verified: false)',
                  }
                })
            } else {
              safeMemories = ctx.memories
            }

            // 走带概念级版本化/去重的写入路径，避免反复跑相同任务时记忆无限重复增长。
            const ids = await store.storeManyVersioned(safeMemories as Omit<MemoryItem, 'id'>[])

            // Generate embeddings for stored memories (non-blocking, graceful degradation)
            const { getEmbeddingService } = await import('./embedding-service')
            const embeddingService = getEmbeddingService()
            if (embeddingService.isReady()) {
              const texts = safeMemories.map(m =>
                `${m.title} ${m.narrative} ${(m.facts ?? []).join(' ')}`
              )
              try {
                const { getClient } = await import('../database')
                const embeddings = await embeddingService.generateEmbeddings(texts)
                const db = getClient()
                const batchUpdates: Array<{ sql: string; args: [string, number] }> = []
                for (let i = 0; i < ids.length; i++) {
                  if (embeddings[i]) {
                    batchUpdates.push({
                      sql: 'UPDATE memory_items SET embedding = ? WHERE id = ?',
                      args: [JSON.stringify(embeddings[i]), ids[i]],
                    })
                  }
                }
                if (batchUpdates.length > 0) {
                  try {
                    // 预编译一次，在事务内重复调用 run()，避免每条记录分配新 Statement 对象
                    const updateStmt = db.prepare('UPDATE memory_items SET embedding = ? WHERE id = ?')
                    db.transaction(() => {
                      for (const u of batchUpdates) updateStmt.run(...u.args)
                    })()
                  } catch {
                    // Batch write failure should not block the pipeline
                  }
                }
              } catch {
                // Batch embedding generation failure should not block the pipeline
              }
            } else {
              logger.info('EmbeddingService not ready, skipping embedding generation for persisted memories')
            }
          }

          // Periodic adaptive config tuning (every 20 pipeline executions)
          PipelineRunner._executionCount++
          if (PipelineRunner._executionCount % 20 === 0) {
            try {
              getAdaptiveConfig().adapt()
            } catch {
              // adapt() failure should not block the pipeline
            }
          }

          return ctx
        },
      },
    ]

    // Apply stage overrides
    let stages = defaultStages
    if (overrides?.skip) {
      stages = stages.filter(s => !overrides.skip!.includes(s.name))
    }
    if (overrides?.replace) {
      stages = stages.map(s => overrides.replace![s.name] ?? s)
    }

    return new PipelineRunner(stages)
  }
}
