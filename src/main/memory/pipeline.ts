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
  observations?: any[]
  memories?: Omit<MemoryItem, 'id'>[]
  hallucinationReport?: any
  layeredContext?: any
  waterlineDelta?: any
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

// ---------------------------------------------------------------------------
// PipelineRunner
// ---------------------------------------------------------------------------

export class PipelineRunner {
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
  static async createDefault(): Promise<PipelineRunner> {
    const { OutputNormalizer } = await import('./output-normalizer')
    const { ObserverCompressor } = await import('./observer-compressor')
    const { MemoryExtractor } = await import('./memory-extractor')
    const { HallucinationChecker } = await import('./hallucination-checker')
    const { ContextCompiler } = await import('./context-compiler')
    const { getWaterlineSync } = await import('./waterline-sync')
    const { getMemoryStore } = await import('./memory-store')

    const normalizer = new OutputNormalizer()
    const compressor = new ObserverCompressor()
    const extractor = new MemoryExtractor()
    const checker = new HallucinationChecker()
    const compiler = new ContextCompiler()

    return new PipelineRunner([
      {
        name: 'normalize',
        process: async (ctx) => ({
          ...ctx,
          normalizedOutputs: normalizer.normalizeAll(ctx.outputs),
        }),
      },
      {
        name: 'compress',
        process: async (ctx) => {
          for (const output of ctx.normalizedOutputs ?? ctx.outputs) {
            compressor.feed(output)
          }
          compressor.finalize()
          return { ...ctx, observations: [] as any[] }
        },
      },
      {
        name: 'extract',
        process: async (ctx) => ({
          ...ctx,
          memories: extractor.extract(ctx.sessionId, ctx.normalizedOutputs ?? ctx.outputs, { adapterName: ctx.adapterName ?? 'unknown' }),
        }),
      },
      {
        name: 'verify',
        enabled: () => true,
        hooks: {
          after: (ctx) => {
            if (ctx.hallucinationReport && !ctx.hallucinationReport.passed) {
              logger.warn(`Hallucination check: risk=${ctx.hallucinationReport.riskScore}`)
            }
          },
        },
        process: async (ctx) => ({
          ...ctx,
          hallucinationReport: checker.verifySync(ctx.normalizedOutputs ?? ctx.outputs),
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
          return { ...ctx, waterlineDelta: waterline.getDelta(ctx.projectId ?? '') }
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
            const safeMemories = ctx.hallucinationReport?.riskScore > 70
              ? ctx.memories.filter(m => (m.confidence ?? 0) > 0.7)
              : ctx.memories
            await store.storeMany(safeMemories as Omit<MemoryItem, 'id'>[])
          }
          return ctx
        },
      },
    ])
  }
}
