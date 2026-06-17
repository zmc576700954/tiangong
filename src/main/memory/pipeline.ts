/**
 * ContextPipeline 统一管线
 *
 * 将 OutputNormalizer → HallucinationChecker → MemoryExtractor →
 * WaterlineSync → ContextCompiler 串联为可插拔的处理管线。
 * 每个阶段独立运行，失败不阻塞后续阶段。
 */

import type { AgentOutput, MemoryItem } from '@shared/types'

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
   * 创建默认的空管线（Task 12 将填充阶段）
   */
  static createDefault(): PipelineRunner {
    return new PipelineRunner([])
  }
}
