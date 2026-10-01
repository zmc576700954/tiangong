/**
 * Recipe Runner
 *
 * 顺序执行 Recipe 的所有步骤（拓扑排序简化版：按数组顺序；depends_on 仅做运行前校验）。
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
import { applyTemplate, topoSortSubRecipes } from './yaml-loader'
import type {
  RecipeDefinition,
  RecipeAgentStep,
  RecipeShellStep,
  RecipeRun,
  RecipeRunRequest,
  RecipeRunStepRecord,
  SubRecipe,
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
): Promise<string> {
  if (!deps.subagentManager) {
    throw new BizGraphError(
      'SubagentManager is not configured; agent steps cannot run',
      ErrorCode.RECIPE_RUN_FAILED,
    )
  }
  const result = await Promise.race([
    deps.subagentManager.invoke({
      parentSessionId,
      agentType: step.agent_type,
      description: step.description,
      prompt: resolvedPrompt,
      adapterName: step.adapter_name,
      nodeId: step.node_id,
      allowedFiles: step.allowed_files,
    }),
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
// RecipeRunner
// ============================================

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

  /** 主入口：执行一个 recipe。
   *
   * 行为决策：
   *   - 顶层 Recipe 含 sub_recipes → 走 runDAG() 路径（序列执行子流程，outputs 跨步骤可见）。
   *   - 否则走原单 Recipe 的 run() 路径（保持向后兼容）。
   */
  async run(request: RecipeRunRequest): Promise<RecipeRun> {
    // 先轻量探一下 def，决定走哪条路径
    let def: RecipeDefinition | undefined
    try {
      def = this.deps.manager.getOrThrow(request.recipeId)
    } catch (err) {
      // Recipe 不存在时仍然要持久化一条 failed run，便于用户看到错误
      return this.recordFailedLookup(request, err)
    }
    if (def.sub_recipes && def.sub_recipes.length > 0) {
      return this.runDAG(request, def)
    }
    return this.runSingle(request, def)
  }

  /**
   * 直接以 DAG 模式运行 Recipe（即使顶层 Recipe 没有 sub_recipes，也会进入 DAG 入口并
   * 顺序执行 def.steps）。调用方主要在内部使用；测试代码可显式调用以验证 sub_recipes 路径。
   */
  async runDAG(request: RecipeRunRequest, topDef: RecipeDefinition): Promise<RecipeRun> {
    const runId = generateId('recipe')
    const ctrl = new AbortController()
    this.activeRuns.set(runId, ctrl)

    const run: RecipeRun = {
      id: runId,
      recipe_id: topDef.id,
      recipe_version: topDef.version,
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
      subRuns: [],
    }
    this.insertRunRow(run)

    // dagOutputs 跨步骤累积，由 sub_recipe[*].name 做命名空间
    const dagOutputs: Record<string, unknown> = {}
    // 顶层 inputs 在 sub_recipe 渲染时也可见（${input.x}）
    const topInputs = request.inputs ?? {}

    try {
      // 1. 先跑顶层 steps（如果有），它们的 outputs 不进 dagOutputs（顶层 steps 的输出走 run.outputs[step_id]）
      if (topDef.steps && topDef.steps.length > 0) {
        await this.executeSteps(topDef, request, run, ctrl.signal, dagOutputs)
      }
      // 2. 再跑 sub_recipes（串行）
      if (topDef.sub_recipes && topDef.sub_recipes.length > 0) {
        const ordered = topoSortSubRecipes(topDef.sub_recipes)
        for (const sr of ordered) {
          if (ctrl.signal.aborted) {
            throw new BizGraphError('Cancelled', ErrorCode.RECIPE_RUN_FAILED)
          }
          await this.executeSubRecipe(sr, topInputs, dagOutputs, request, run, ctrl.signal)
        }
      }
      run.status = 'succeeded'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      run.error = msg
      run.status = ctrl.signal.aborted ? 'cancelled' : 'failed'
      logger.warn(`Recipe DAG run ${runId} ended with status=${run.status}: ${msg}`)
    } finally {
      run.finished_at = Date.now()
      this.activeRuns.delete(runId)
      this.updateRunRow(run)
    }
    return run
  }

  /** 单 Recipe 路径（基座 v1 兼容：不识别 sub_recipes）。
   *
   * parentSignal 可选：DAG 调用时传入顶层 ctrl.signal，使得子 run 也能随父级一起取消。
   */
  private async runSingle(request: RecipeRunRequest, def: RecipeDefinition, parentSignal?: AbortSignal): Promise<RecipeRun> {
    const runId = generateId('recipe')
    const ctrl = new AbortController()
    this.activeRuns.set(runId, ctrl)
    if (parentSignal) {
      if (parentSignal.aborted) ctrl.abort()
      else parentSignal.addEventListener('abort', () => ctrl.abort(), { once: true })
    }

    const run: RecipeRun = {
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
    this.insertRunRow(run)

    try {
      await this.executeSteps(def, request, run, ctrl.signal, {})
      run.status = 'succeeded'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      run.error = msg
      run.status = ctrl.signal.aborted ? 'cancelled' : 'failed'
      logger.warn(`Recipe run ${runId} ended with status=${run.status}: ${msg}`)
    } finally {
      run.finished_at = Date.now()
      this.activeRuns.delete(runId)
      this.updateRunRow(run)
    }
    return run
  }

  /** 当 Recipe id 找不到时，仍然要持久化一条 failed run，便于用户看到错误。 */
  private recordFailedLookup(request: RecipeRunRequest, err: unknown): RecipeRun {
    const failed: RecipeRun = {
      id: generateId('recipe'),
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
    this.insertRunRow(failed)
    return failed
  }

  /**
   * 执行一个 sub_recipe：
   *   - 解析 inputs：${input.x} 来自顶层 inputs；${outputs.<prev>.field} 来自 dagOutputs
   *   - 把 sub_recipe 自己声明的 inputs 字典覆盖到 inputs（sub_recipe 优先）
   *   - 串行跑被引用 Recipe 的 steps（不支持嵌套 sub_recipes 展开 —— D5b/D5c 再做）
   *   - 把该 sub_recipe 的最终 outputs 整体塞进 dagOutputs[name]
   *   - 把 sub_recipe 对应的 RecipeRun 推入 run.subRuns
   */
  private async executeSubRecipe(
    sr: SubRecipe,
    topInputs: Record<string, string | number | boolean>,
    dagOutputs: Record<string, unknown>,
    request: RecipeRunRequest,
    parentRun: RecipeRun,
    signal: AbortSignal,
  ): Promise<void> {
    const subDef = this.deps.manager.getOrThrow(sr.recipe)
    // inputs 优先级：sub_recipe 显式 inputs > 顶层 inputs
    const mergedInputs: Record<string, string | number | boolean> = {
      ...topInputs,
      ...(sr.inputs ?? {}),
    }
    // 渲染 sub_recipe.inputs 字典里的 ${input.x} / ${outputs.x.y} 占位符
    const resolvedInputs: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(mergedInputs)) {
      if (typeof v === 'string') {
        resolvedInputs[k] = applyTemplate(v, mergedInputs, dagOutputs, subDef.inputs)
      } else {
        resolvedInputs[k] = v
      }
    }
    // 构造子 RecipeRun
    const subRequest: RecipeRunRequest = {
      recipeId: subDef.id,
      inputs: resolvedInputs,
      parentSessionId: request.parentSessionId ?? `recipe-${parentRun.id}`,
      nodeId: request.nodeId,
      allowedFiles: request.allowedFiles,
      adapterName: request.adapterName,
      description: `${sr.name} (sub of ${parentRun.recipe_id})`,
    }
    // 子 RecipeRun 直接走 runSingle（暂不嵌套 DAG；D5c 可扩展），并把父 signal 透传以便 cancel 联动。
    const subRun = await this.runSingle(subRequest, subDef, signal)
    parentRun.subRuns!.push(subRun)
    // 把子 run 的 outputs 累积到 dagOutputs[sr.name]
    if (subRun.status === 'succeeded') {
      dagOutputs[sr.name] = { ...subRun.outputs }
      parentRun.outputs[sr.name] = JSON.stringify(subRun.outputs)
    }
    // 任何非 succeeded 状态（D5a 不做 on_failure）→ 让整个 DAG 失败
    if (subRun.status !== 'succeeded') {
      throw new BizGraphError(
        `Sub-recipe "${sr.name}" (${sr.recipe}) ended with status=${subRun.error ?? subRun.status}`,
        ErrorCode.RECIPE_RUN_FAILED,
      )
    }
  }

  private async executeSteps(
    def: RecipeDefinition,
    request: RecipeRunRequest,
    run: RecipeRun,
    signal: AbortSignal,
    outputs: Record<string, unknown>,
  ): Promise<void> {
    const inputs = request.inputs ?? {}
    const steps = def.steps ?? []
    for (const step of steps) {
      if (signal.aborted) throw new BizGraphError('Cancelled', ErrorCode.RECIPE_RUN_FAILED)
      const record: RecipeRunStepRecord = {
        step_id: step.id ?? step.name ?? `step_${run.steps.length}`,
        step_name: step.name ?? step.id ?? `Step ${run.steps.length + 1}`,
        kind: step.kind,
        status: 'running',
        started_at: Date.now(),
      }
      run.steps.push(record)
      try {
        if (step.kind === 'agent') {
          const resolvedPrompt = applyTemplate(step.prompt, inputs, outputs, def.inputs)
          const result = await runAgentStep(
            step,
            resolvedPrompt,
            request.parentSessionId ?? `recipe-${run.id}`,
            this.deps,
            signal,
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