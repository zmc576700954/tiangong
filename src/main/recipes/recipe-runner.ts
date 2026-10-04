/**
 * Recipe Runner
 *
 * 执行 Recipe 步骤（DAG + 并行批处理）：
 *   - 步骤依赖 `depends_on` 形成 DAG；执行时按拓扑分层（wave）。
 *   - 同一 wave 内的步骤：连续 parallel=true 的步聚合为并行批，串行步单独成批。
 *   - 串行/并行混合 wave 中：先跑并行批（含其内部并发），再跑串行批，依此类推。
 *
 * 步骤类型分发：
 *   - agent → SubagentManager.invoke()
 *   - shell → child_process.spawn(cmd[0], cmd.slice(1))
 *
 * 持久化：每次 run() 在 recipe_runs 表插入一行，结束（success/fail/cancel）时更新 status + steps。
 *
 * 边界（与 CLAUDE.md "Boundaries with Agent CLI" 一致）：
 *   - shell 步骤使用 child_process.spawn（数组 argv 形式，无 shell 解释器层）。
 *   - 不在 workingDirectory 之外执行：cwd 必须解析到 workingDirectory 或其子目录。
 *   - 超时强制：默认 30s，max 10min，防止恶意 YAML 把进程钉死。
 *   - 不写 .bizgraph/memory.json（与 scope-guard 一致）；允许 .bizgraph/recipes/** 但只读。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { generateId } from '../shared/env'
import { createLogger } from '../shared/logger'
import { BizGraphError, ErrorCode } from '../errors'
import type { RecipeManager } from './recipe-manager'
import { applyInputTemplate } from './yaml-loader'
import type {
  RecipeDefinition,
  RecipeAgentStep,
  RecipeShellStep,
  RecipeStep,
  RecipeRun,
  RecipeRunRequest,
  RecipeRunStepRecord,
} from '@shared/types/recipe'
import type { SubagentManager } from '../agent/subagent-manager'
import type Database from 'better-sqlite3'

const logger = createLogger('RecipeRunner')

const DEFAULT_SHELL_TIMEOUT_MS = 30_000
const MAX_SHELL_TIMEOUT_MS = 10 * 60 * 1000

export interface RecipeRunnerDeps {
  db: Database.Database
  manager: RecipeManager
  subagentManager?: SubagentManager
  /**
   * Recipe shell 步骤运行的工作目录。null 时 shell 步骤会被拒绝。
   * 支持同步或异步 getter（异步类型覆盖更多场景，如 GraphService.getProjectPaths()）。
   */
  getWorkingDirectory?: () => string | null | Promise<string | null>
}

// ============================================
// 单步执行
// ============================================

async function runAgentStep(
  step: RecipeAgentStep,
  resolvedPrompt: string,
  parentSessionId: string,
  deps: RecipeRunnerDeps,
  signal: AbortSignal,
  context: StepExecutionContext,
): Promise<string> {
  if (!deps.subagentManager) {
    throw new BizGraphError(
      'SubagentManager is not configured; agent steps cannot run',
      ErrorCode.RECIPE_RUN_FAILED,
    )
  }
  // 在 recipe:<id> 前缀路径上，recipeRunner 透传 inputs 到 SubagentManager。
  const invokeArgs: Parameters<typeof deps.subagentManager.invoke>[0] = {
    parentSessionId,
    agentType: step.agent_type,
    description: step.description,
    prompt: resolvedPrompt,
    adapterName: step.adapter_name,
    nodeId: step.node_id,
    allowedFiles: step.allowed_files,
  }
  if (step.agent_type.startsWith('recipe:') && context.recipeInputs) {
    invokeArgs.inputs = context.recipeInputs
  }
  // 透传 allowedDelegates：recipe 子节点应当继承当前 recipe 的 delegate 白名单
  //（除非该步自行覆盖 —— 当前未开放 step 级覆盖，全部用 recipe 级）。
  if (context.allowedDelegates && context.allowedDelegates.length > 0) {
    invokeArgs.allowedDelegates = context.allowedDelegates
  }
  const result = await Promise.race([
    deps.subagentManager.invoke(invokeArgs),
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new BizGraphError('Cancelled', ErrorCode.RECIPE_RUN_FAILED))
        return
      }
      signal.addEventListener('abort', () => {
        reject(new BizGraphError('Cancelled', ErrorCode.RECIPE_RUN_FAILED))
      }, { once: true })
    }),
  ])
  return result.resultText
}

interface ShellRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function runShellStep(
  step: RecipeShellStep,
  workingDirectory: string,
  signal: AbortSignal,
): Promise<ShellRunResult> {
  const timeoutMs = Math.min(
    Math.max(step.timeout_ms ?? DEFAULT_SHELL_TIMEOUT_MS, 1000),
    MAX_SHELL_TIMEOUT_MS,
  )
  const cwd = step.cwd
    ? path.resolve(workingDirectory, step.cwd)
    : workingDirectory
  // 强制 cwd 在 workingDirectory 之下
  const relative = path.relative(workingDirectory, cwd)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BizGraphError(
      `Shell step cwd escapes workingDirectory: ${step.cwd}`,
      ErrorCode.RECIPE_RUN_FAILED,
    )
  }

  return new Promise<ShellRunResult>((resolve, reject) => {
    const child = spawn(step.command[0]!, step.command.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 不继承 shell，避免解释器层注入；argv 数组形式直接 execve
      shell: false,
      // 限制环境变量传播（避免把 safeStorage key / 数据库路径等传进去）
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TMPDIR: process.env.TMPDIR,
        TEMP: process.env.TEMP,
      },
    })

    let stdout = ''
    let stderr = ''
    let killedByTimeout = false
    const timer = setTimeout(() => {
      killedByTimeout = true
      child.kill('SIGTERM')
      // 5 秒后还没退，强制 KILL
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 5000)
    }, timeoutMs)

    const onAbort = () => {
      child.kill('SIGTERM')
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      // 防止日志爆炸：每步 stdout/stderr 上限 1MB
      if (stdout.length > 1_000_000) {
        killedByTimeout = true
        child.kill('SIGTERM')
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 1_000_000) {
        killedByTimeout = true
        child.kill('SIGTERM')
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(
        new BizGraphError(
          `Shell step failed to spawn: ${err.message}`,
          ErrorCode.RECIPE_RUN_FAILED,
        ),
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (killedByTimeout) {
        reject(
          new BizGraphError(
            `Shell step exceeded ${timeoutMs}ms or output limit`,
            ErrorCode.RECIPE_RUN_FAILED,
          ),
        )
        return
      }
      if (signal.aborted) {
        reject(new BizGraphError('Shell step cancelled', ErrorCode.RECIPE_RUN_FAILED))
        return
      }
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}

// ============================================
// DAG + 并行批
// ============================================

/**
 * 一个并行批：要么 1 个串行步，要么 ≥1 个 parallel=true 步并发执行。
 * 批内的所有步属于同一个 wave（依赖前序 wave 全部完成）。
 */
interface StepBatch {
  /** 批内步索引（指向 def.steps）。 */
  stepIndices: number[]
  /** true = 批内并发；false = 批内只有 1 个串行步。 */
  parallel: boolean
}

/**
 * 步骤执行时携带的上下文：
 *   - recipeInputs：recipe 级 inputs（用于透传到 recipe:<id> 子步骤）
 *   - allowedDelegates：当前 recipe 暴露的 delegate 白名单（透传到子 session）
 */
interface StepExecutionContext {
  recipeInputs: Record<string, string | number | boolean>
  allowedDelegates?: string[]
}

/**
 * 给定 Recipe.steps 计算 DAG 拓扑分层（waves）：
 *   - wave 0：所有无 depends_on 的步
 *   - wave n+1：所有 dep 都在前序 wave 中的步
 *   - 环检测：若某步的依赖无法被任何 wave 满足 → BizGraphError(RECIPE_INVALID_STEP)
 *
 * 不在数组顺序中、仅依赖满足即可进入 wave；同一 wave 内按数组顺序排列
 * 以保证 deterministic 输出与可读性。
 */
export function computeWaves(steps: RecipeStep[]): number[][] {
  // step → 它的 id/name（用于依赖解析）
  const labelOf = (s: RecipeStep): string | undefined => s.id ?? s.name
  const labelToIndex = new Map<string, number>()
  for (let i = 0; i < steps.length; i++) {
    const lbl = labelOf(steps[i]!)
    if (lbl) labelToIndex.set(lbl, i)
  }

  const inWave: number[] = new Array<number>(steps.length).fill(-1)
  const remaining = new Set<number>(steps.map((_, i) => i))
  const waves: number[][] = []
  let currentWave = 0

  while (remaining.size > 0) {
    const ready: number[] = []
    for (const idx of remaining) {
      const s = steps[idx]!
      const deps = s.depends_on ?? []
      const allResolved = deps.every((dep) => {
        const depIdx = labelToIndex.get(dep)
        return depIdx !== undefined && inWave[depIdx] !== -1
      })
      if (allResolved) ready.push(idx)
    }
    if (ready.length === 0) {
      // 仍有未解析的步 → 环或悬空依赖。yaml-loader 已经做过悬空校验，
      // 这里仅可能是环（depends_on 形成环）。
      throw new BizGraphError(
        `Recipe step DAG has a cycle or unresolved dependency among steps: ${[...remaining]
          .map((i) => steps[i]!.id ?? steps[i]!.name ?? `#${i}`)
          .join(', ')}`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
    // 同一 wave 内按数组顺序排列
    ready.sort((a, b) => a - b)
    for (const idx of ready) {
      inWave[idx] = currentWave
      remaining.delete(idx)
    }
    waves.push(ready)
    currentWave++
  }

  return waves
}

/**
 * 把单个 wave 切分成串行/并行子批：
 *   - 连续 parallel=true 的步合并为一个并行批
 *   - 每个 parallel=undefined/false 的步单独成串行批
 *
 * 这样串行步和并行批在 wave 内交替出现，整体仍按数组顺序推进。
 */
export function batchWave(indices: number[], steps: RecipeStep[]): StepBatch[] {
  const batches: StepBatch[] = []
  let current: number[] = []
  let currentParallel = false
  for (const idx of indices) {
    const isParallel = steps[idx]!.kind === 'agent' && (steps[idx] as RecipeAgentStep).parallel === true
    if (isParallel) {
      if (currentParallel && current.length > 0) {
        current.push(idx)
      } else {
        if (current.length > 0) batches.push({ stepIndices: current, parallel: currentParallel })
        current = [idx]
        currentParallel = true
      }
    } else {
      if (current.length > 0) batches.push({ stepIndices: current, parallel: currentParallel })
      batches.push({ stepIndices: [idx], parallel: false })
      current = []
      currentParallel = false
    }
  }
  if (current.length > 0) batches.push({ stepIndices: current, parallel: currentParallel })
  return batches
}

export class RecipeRunner {
  private activeRuns = new Map<string, AbortController>()

  constructor(private deps: RecipeRunnerDeps) {}

  /** 取消正在进行的 run。best-effort：找不到时 no-op。 */
  cancel(runId: string): boolean {
    const ctrl = this.activeRuns.get(runId)
    if (!ctrl) return false
    ctrl.abort()
    return true
  }

  /** 主入口：执行一个 recipe。 */
  async run(request: RecipeRunRequest): Promise<RecipeRun> {
    const runId = generateId('recipe')
    const ctrl = new AbortController()
    this.activeRuns.set(runId, ctrl)

    let def: RecipeDefinition
    try {
      def = this.deps.manager.getOrThrow(request.recipeId)
    } catch (err) {
      // Recipe 不存在时仍然要持久化一条 failed run，便于用户看到错误
      const failed: RecipeRun = {
        id: runId,
        recipe_id: request.recipeId,
        recipe_version: 'unknown',
        session_id: request.parentSessionId ?? null,
        graph_id: null,
        node_id: request.nodeId ?? null,
        status: 'failed',
        inputs: request.inputs ?? {},
        steps: [],
        outputs: {},
        error: err instanceof Error ? err.message : String(err),
        started_at: Date.now(),
        finished_at: Date.now(),
      }
      this.activeRuns.delete(runId)
      this.insertRunRow(failed)
      return failed
    }

    const runRecord: RecipeRun = {
      id: runId,
      recipe_id: def.id,
      recipe_version: def.version,
      session_id: request.parentSessionId ?? null,
      graph_id: null,
      node_id: request.nodeId ?? null,
      status: 'running',
      inputs: request.inputs ?? {},
      steps: [],
      outputs: {},
      error: null,
      started_at: Date.now(),
      finished_at: null,
    }

    this.insertRunRow(runRecord)

    try {
      await this.executeSteps(def, request, runRecord, ctrl.signal)
      runRecord.status = 'succeeded'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      runRecord.error = msg
      runRecord.status = ctrl.signal.aborted ? 'cancelled' : 'failed'
      logger.warn(`Recipe run ${runId} ended with status=${runRecord.status}: ${msg}`)
    } finally {
      runRecord.finished_at = Date.now()
      this.activeRuns.delete(runId)
      this.updateRunRow(runRecord)
    }

    return runRecord
  }

  private async executeSteps(
    def: RecipeDefinition,
    request: RecipeRunRequest,
    run: RecipeRun,
    signal: AbortSignal,
  ): Promise<void> {
    const inputs = request.inputs ?? {}
    const execCtx: StepExecutionContext = {
      recipeInputs: inputs,
      allowedDelegates: def.allowed_delegates && def.allowed_delegates.length > 0
        ? def.allowed_delegates
        : undefined,
    }

    // DAG 拓扑分层；wave 内再切批
    const waves = computeWaves(def.steps)
    for (const waveIndices of waves) {
      if (signal.aborted) throw new BizGraphError('Cancelled', ErrorCode.RECIPE_RUN_FAILED)
      const batches = batchWave(waveIndices, def.steps)
      for (const batch of batches) {
        if (signal.aborted) throw new BizGraphError('Cancelled', ErrorCode.RECIPE_RUN_FAILED)
        await this.executeBatch(def, request, run, batch, execCtx, signal)
      }
    }
  }

  /**
   * 执行一个批：
   *   - serial 批：1 个步，await
   *   - parallel 批：≥1 个步，并发执行
   *
   * 错误处理：使用 Promise.allSettled 而非 Promise.all，确保所有并发步都有机会
   * 完成（成功或失败）并写入步骤记录，再判断批是否失败。
   * 「同批中一个失败 → 整个批失败」语义：收集所有失败原因，抛首个给上层。
   */
  private async executeBatch(
    def: RecipeDefinition,
    request: RecipeRunRequest,
    run: RecipeRun,
    batch: StepBatch,
    execCtx: StepExecutionContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (batch.parallel) {
      const results = await Promise.allSettled(
        batch.stepIndices.map((idx) => this.executeOneStep(def, request, run, idx, execCtx, signal)),
      )
      const firstRejection = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (firstRejection) {
        // 重新抛出首个失败原因（D5c 再加 on_failure 策略：retry / skip）
        throw firstRejection.reason instanceof Error
          ? firstRejection.reason
          : new BizGraphError(String(firstRejection.reason), ErrorCode.RECIPE_RUN_FAILED)
      }
      return
    }
    // serial 批：长度为 1
    await this.executeOneStep(def, request, run, batch.stepIndices[0]!, execCtx, signal)
  }

  /**
   * 执行单个步（agent 或 shell）。失败时立即 throw，由上层 executeSteps 捕获。
   */
  private async executeOneStep(
    def: RecipeDefinition,
    request: RecipeRunRequest,
    run: RecipeRun,
    stepIdx: number,
    execCtx: StepExecutionContext,
    signal: AbortSignal,
  ): Promise<void> {
    const step = def.steps[stepIdx]!
    if (signal.aborted) throw new BizGraphError('Cancelled', ErrorCode.RECIPE_RUN_FAILED)
    const inputs = request.inputs ?? {}
    const record: RecipeRunStepRecord = {
      step_id: step.id ?? step.name ?? `step_${stepIdx}`,
      step_name: step.name ?? step.id ?? `Step ${stepIdx + 1}`,
      kind: step.kind,
      status: 'running',
      started_at: Date.now(),
    }
    run.steps.push(record)
    try {
      if (step.kind === 'agent') {
        const resolvedPrompt = applyInputTemplate(step.prompt, inputs, def.inputs)
        const result = await runAgentStep(
          step,
          resolvedPrompt,
          request.parentSessionId ?? `recipe-${run.id}`,
          this.deps,
          signal,
          execCtx,
        )
        record.output = result
        run.outputs[record.step_id] = result
      } else {
        const wd = (await this.deps.getWorkingDirectory?.()) ?? null
        if (!wd) {
          throw new BizGraphError(
            'Shell steps require a working directory; none configured',
            ErrorCode.RECIPE_RUN_FAILED,
          )
        }
        const shellResult = await runShellStep(step, wd, signal)
        record.output = shellResult.stdout + (shellResult.stderr ? `\n[stderr]\n${shellResult.stderr}` : '')
        if (shellResult.exitCode !== 0) {
          throw new BizGraphError(
            `Shell step "${record.step_name}" exited with code ${shellResult.exitCode}`,
            ErrorCode.RECIPE_RUN_FAILED,
          )
        }
      }
      record.status = 'succeeded'
      record.finished_at = Date.now()
    } catch (err) {
      record.status = 'failed'
      record.finished_at = Date.now()
      record.error = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  // ============================================
  // 持久化
  // ============================================

  private insertRunRow(run: RecipeRun): void {
    this.deps.db.prepare(`
        INSERT INTO recipe_runs (id, recipe_id, recipe_version, session_id, graph_id, node_id, status, inputs_json, steps_json, outputs_json, error, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.recipe_id,
        run.recipe_version,
        run.session_id,
        run.graph_id,
        run.node_id,
        run.status,
        JSON.stringify(run.inputs),
        JSON.stringify(run.steps),
        JSON.stringify(run.outputs),
        run.error,
        run.started_at,
        run.finished_at,
      )
  }

  private updateRunRow(run: RecipeRun): void {
    this.deps.db.prepare(`
        UPDATE recipe_runs
        SET status = ?, steps_json = ?, outputs_json = ?, error = ?, finished_at = ?
        WHERE id = ?
      `).run(
        run.status,
        JSON.stringify(run.steps),
        JSON.stringify(run.outputs),
        run.error,
        run.finished_at,
        run.id,
      )
  }

  /** 读取单条 run 记录（用于 IPC handler）。 */
  getRun(runId: string): RecipeRun | undefined {
    const row = this.deps.db
      .prepare('SELECT * FROM recipe_runs WHERE id = ?')
      .get(runId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return this.rowToRun(row)
  }

  /** 列出某 recipe 的所有 runs。 */
  listRuns(recipeId: string, limit = 50): RecipeRun[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM recipe_runs WHERE recipe_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(recipeId, limit) as Record<string, unknown>[]
    return rows.map((r) => this.rowToRun(r))
  }

  private rowToRun(row: Record<string, unknown>): RecipeRun {
    return {
      id: row.id as string,
      recipe_id: row.recipe_id as string,
      recipe_version: row.recipe_version as string,
      session_id: (row.session_id as string | null) ?? null,
      graph_id: (row.graph_id as string | null) ?? null,
      node_id: (row.node_id as string | null) ?? null,
      status: row.status as RecipeRun['status'],
      inputs: JSON.parse((row.inputs_json as string) || '{}'),
      steps: JSON.parse((row.steps_json as string) || '[]'),
      outputs: JSON.parse((row.outputs_json as string) || '{}'),
      error: (row.error as string | null) ?? null,
      started_at: row.started_at as number,
      finished_at: (row.finished_at as number | null) ?? null,
    }
  }
}

// ============================================
// SubagentManager 钩子：recipe:<id> 前缀
// ============================================

/**
 * 包装 SubagentManager.invoke() —— 如果 agentType 以 "recipe:" 开头，
 * 委托给 RecipeRunner.run()，否则原样调用。
 *
 * 用法（在 ipc-handlers.ts 里替换直接调用 subagentManager.invoke()）：
 *   const dispatchInvoke = wrapSubagentInvokeWithRecipes(subagentManager, recipeRunner)
 *   await dispatchInvoke({ ...args })
 */
export function isRecipeAgentType(agentType: string): boolean {
  return agentType.startsWith('recipe:')
}

export function parseRecipeId(agentType: string): string | null {
  if (!agentType.startsWith('recipe:')) return null
  const id = agentType.slice('recipe:'.length).trim()
  return id.length > 0 ? id : null
}