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
import { applyInputTemplate } from './yaml-loader'
import type {
  RecipeDefinition,
  RecipeAgentStep,
  RecipeShellStep,
  RecipeRun,
  RecipeRunProgressEvent,
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

/**
 * 步骤级进度事件回调签名。
 *
 * 为什么放在 RecipeRunnerDeps 之外：
 *   - deps 在 RecipeRunner 构造时一次性注入；监听器可能在稍后由 IPC 层挂载。
 *   - 监听器与 RecipeRunner 解耦，方便测试与单元验证。
 *   - 与 SubagentManager.onProgress 模式保持一致。
 */
export type RecipeProgressListener = (event: RecipeRunProgressEvent) => void

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
  private progressListener: RecipeProgressListener | null = null

  constructor(private deps: RecipeRunnerDeps) {}

  /**
   * 注册步骤级进度事件监听器（D5c-3）。
   * 同一时刻仅保留最后一个监听器（项目无并发场景需要广播）。
   * 返回 unsubscribe 函数。
   */
  setProgressListener(listener: RecipeProgressListener | null): () => void {
    this.progressListener = listener
    return () => {
      if (this.progressListener === listener) {
        this.progressListener = null
      }
    }
  }

  /** 取消正在进行的 run。best-effort：找不到时 no-op。 */
  cancel(runId: string): boolean {
    const ctrl = this.activeRuns.get(runId)
    if (!ctrl) return false
    ctrl.abort()
    return true
  }

  private emitProgress(event: RecipeRunProgressEvent): void {
    try {
      this.progressListener?.(event)
    } catch (err) {
      // 监听器抛错不影响 run 主流程 —— 仅日志。
      logger.warn(`Recipe progress listener threw: ${err instanceof Error ? err.message : String(err)}`)
    }
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
    const totalSteps = def.steps.length
    let completedSteps = 0
    let failedSteps = 0
    for (let stepIndex = 0; stepIndex < def.steps.length; stepIndex++) {
      if (signal.aborted) throw new BizGraphError('Cancelled', ErrorCode.RECIPE_RUN_FAILED)
      const step = def.steps[stepIndex]!
      const stepId = step.id ?? step.name ?? `step_${stepIndex}`
      const record: RecipeRunStepRecord = {
        step_id: stepId,
        step_name: step.name ?? step.id ?? `Step ${stepIndex + 1}`,
        kind: step.kind,
        status: 'running',
        started_at: Date.now(),
      }
      run.steps.push(record)
      this.emitProgress({
        runId: run.id,
        recipeId: def.id,
        stepId,
        status: 'running',
        stepIndex,
        totalSteps,
        completedSteps,
        failedSteps,
        startedAt: record.started_at,
      })
      try {
        if (step.kind === 'agent') {
          const resolvedPrompt = applyInputTemplate(step.prompt, inputs, def.inputs)
          const result = await runAgentStep(
            step,
            resolvedPrompt,
            request.parentSessionId ?? `recipe-${run.id}`,
            this.deps,
            signal,
          )
          record.output = result
          run.outputs[stepId] = result
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
        completedSteps++
        this.emitProgress({
          runId: run.id,
          recipeId: def.id,
          stepId,
          status: 'completed',
          stepIndex,
          totalSteps,
          completedSteps,
          failedSteps,
          startedAt: record.started_at,
          finishedAt: record.finished_at,
        })
      } catch (err) {
        record.status = signal.aborted ? 'cancelled' : 'failed'
        record.finished_at = Date.now()
        record.error = err instanceof Error ? err.message : String(err)
        if (record.status === 'failed') failedSteps++
        this.emitProgress({
          runId: run.id,
          recipeId: def.id,
          stepId,
          status: record.status,
          stepIndex,
          totalSteps,
          completedSteps,
          failedSteps,
          startedAt: record.started_at,
          finishedAt: record.finished_at,
          error: record.error,
        })
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