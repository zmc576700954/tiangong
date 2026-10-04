/**
 * Recipe Run Progress Panel (D5c-3)
 *
 * 显示 Recipe 运行时的实时进度：
 *   - 顶部进度条：X/Y steps completed
 *   - 步骤列表：每个步骤的状态、耗时、错误
 *   - 实时订阅 `recipe:run:progress` IPC 事件 + 初次挂载时拉取最新 RecipeRun 状态
 *   - 关闭按钮（关闭后停止监听）
 *
 * 设计哲学（参考 WritebackPanel）：
 *   - 使用 FloatingPanel shell（绝对定位 top-16 right-4 z-50）
 *   - 错误条：顶部红条 + dismiss
 *   - 折叠 / 展开：可最小化只显示顶部进度条
 *   - 可选 onClose：未处理不强制阻拦（仅在不空闲时给出视觉提示）
 *
 * 与 DAG 的协作：
 *   - 暴露 `liveStatus`（stepId → { status, error }）给父组件 → RecipeDagView 上色。
 *   - 父组件（RecipesPanel）持有这个 map，把 RecipeDagView 嵌在 DAG 折叠面板里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  X,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Ban,
  Circle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  RecipeRunProgressEvent,
  RecipeRunNodeStatus,
  RecipeRun,
  RecipeDefinition,
} from '@shared/types/recipe'

interface Props {
  recipe: RecipeDefinition
  /** 关联的 run id（用于过滤 IPC 事件）。 */
  runId: string
  /** 初始 run record（可选，提供更好的初始状态）。 */
  initialRun?: RecipeRun | null
  /**
   * electronAPI 子集（可注入，便于测试）。未提供时回退到 window.electronAPI。
   * 最小必需：recipes:getRun, onRecipeRunProgress, recipes:cancel。
   */
  electronAPI?: {
    'recipes:getRun': (runId: string) => Promise<RecipeRun | null>
    'recipes:cancel': (runId: string) => Promise<boolean>
    onRecipeRunProgress?: (cb: (data: RecipeRunProgressEvent) => void) => () => void
  }
  /** 实时 step 状态回调：每收到一个 step 进度事件 → 调用一次。 */
  onStepUpdate?: (stepId: string, status: RecipeRunNodeStatus, error?: string) => void
  onClose: () => void
}

function getApi(propsApi?: Props['electronAPI']) {
  return propsApi ?? ((window as unknown as { electronAPI?: Props['electronAPI'] }).electronAPI)
}

interface StepDisplayState {
  stepId: string
  label: string
  kind: 'agent' | 'shell'
  status: RecipeRunNodeStatus
  startedAt?: number
  finishedAt?: number
  error?: string
}

function buildInitialSteps(
  recipe: RecipeDefinition,
  initialRun?: RecipeRun | null,
): StepDisplayState[] {
  const fromRun = new Map<string, RecipeRun['steps'][number]>()
  initialRun?.steps.forEach((s) => fromRun.set(s.step_id, s))
  return recipe.steps.map((s, i) => {
    const stepId = s.id ?? s.name ?? `step_${i}`
    const label = s.name ?? s.id ?? `Step ${i + 1}`
    const fromR = fromRun.get(stepId)
    return {
      stepId,
      label,
      kind: s.kind,
      status: (fromR?.status as RecipeRunNodeStatus | undefined) ?? 'pending',
      startedAt: fromR?.started_at,
      finishedAt: fromR?.finished_at,
      error: fromR?.error,
    }
  })
}

function StatusIcon({ status }: { status: RecipeRunNodeStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-600" aria-hidden="true" />
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
    case 'failed':
      return <AlertTriangle className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
    case 'cancelled':
      return <Ban className="w-3.5 h-3.5 text-orange-500" aria-hidden="true" />
    case 'skipped':
      return <Circle className="w-3.5 h-3.5 text-zinc-400" aria-hidden="true" />
    case 'pending':
    default:
      return <CircleDashed className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
  }
}

function formatDuration(startedAt?: number, finishedAt?: number): string {
  if (!startedAt) return ''
  const end = finishedAt ?? Date.now()
  const ms = end - startedAt
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

export function RecipeRunProgress({
  recipe,
  runId,
  initialRun,
  electronAPI: apiProp,
  onStepUpdate,
  onClose,
}: Props) {
  const api = getApi(apiProp)
  const [steps, setSteps] = useState<StepDisplayState[]>(() => buildInitialSteps(recipe, initialRun))
  const [collapsed, setCollapsed] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  // ref to keep latest runId inside subscription closure without re-subscribing
  const runIdRef = useRef(runId)
  runIdRef.current = runId

  // 订阅 IPC 进度事件
  useEffect(() => {
    if (!api?.onRecipeRunProgress) return
    const off = api.onRecipeRunProgress((event) => {
      if (event.runId !== runIdRef.current) return
      setSteps((prev) => {
        const idx = prev.findIndex((s) => s.stepId === event.stepId)
        if (idx < 0) return prev
        const updated = [...prev]
        const cur = updated[idx]!
        updated[idx] = {
          ...cur,
          status: event.status,
          startedAt: event.startedAt ?? cur.startedAt,
          finishedAt: event.finishedAt ?? cur.finishedAt,
          error: event.error ?? (event.status !== 'failed' ? undefined : cur.error),
        }
        return updated
      })
      onStepUpdate?.(event.stepId, event.status, event.error)
      if (event.status === 'failed' && event.error) {
        setLastError(event.error)
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalSteps = steps.length
  const completedSteps = steps.filter((s) => s.status === 'completed').length
  const failedSteps = steps.filter((s) => s.status === 'failed').length
  const cancelledSteps = steps.filter((s) => s.status === 'cancelled').length
  const doneCount = completedSteps + failedSteps + cancelledSteps
  const isRunning = steps.some((s) => s.status === 'running')
  const overallDone = doneCount === totalSteps && !isRunning

  const percent = useMemo(() => {
    if (totalSteps === 0) return 0
    return Math.round((doneCount / totalSteps) * 100)
  }, [doneCount, totalSteps])

  const handleCancel = useCallback(async () => {
    if (!api?.['recipes:cancel']) return
    try {
      await api['recipes:cancel'](runId)
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
    }
  }, [api, runId])

  return (
    <div
      className="absolute top-16 right-4 z-50 w-80 max-h-[70vh] flex flex-col bg-background/95 backdrop-blur border rounded-lg shadow-lg"
      data-testid="recipe-run-progress"
      data-run-id={runId}
      data-percent={percent}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开进度面板' : '折叠进度面板'}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground transition-colors"
            data-testid="recipe-progress-collapse-toggle"
          >
            {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <span className="text-sm font-medium truncate">执行进度</span>
          <span className="text-[10px] text-muted-foreground whitespace-nowrap" data-testid="recipe-progress-counter">
            {doneCount}/{totalSteps}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭进度面板"
          data-testid="recipe-progress-close"
          className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 顶部进度条 + 状态徽标 */}
      {!collapsed && (
        <>
          <div className="px-3 py-2 border-b bg-muted/30">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded-full border font-mono',
                  overallDone
                    ? failedSteps > 0
                      ? 'bg-red-50 text-red-700 border-red-200'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : isRunning
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-slate-50 text-slate-600 border-slate-200',
                )}
                data-testid="recipe-progress-state"
              >
                {overallDone ? (failedSteps > 0 ? 'failed' : 'succeeded') : isRunning ? 'running' : 'pending'}
              </span>
              {isRunning && api?.['recipes:cancel'] && (
                <button
                  type="button"
                  onClick={() => void handleCancel()}
                  className="ml-auto text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
                  data-testid="recipe-progress-cancel"
                >
                  取消
                </button>
              )}
            </div>
            <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
              <div
                className={cn(
                  'h-full transition-all',
                  failedSteps > 0 ? 'bg-red-500' : 'bg-emerald-500',
                )}
                style={{ width: `${percent}%` }}
                data-testid="recipe-progress-bar"
              />
            </div>
            <div className="flex items-center justify-between mt-1 text-[10px] text-muted-foreground">
              <span>
                {completedSteps} 完成 · {failedSteps} 失败 · {totalSteps - doneCount} 待执行
              </span>
              <span>{percent}%</span>
            </div>
          </div>

          {/* 错误条 */}
          {lastError && (
            <div
              role="alert"
              className="flex items-start gap-2 px-3 py-2 bg-red-50 border-b border-red-200 text-red-700 text-xs"
              data-testid="recipe-progress-error-banner"
            >
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <p className="flex-1 break-words">{lastError}</p>
              <button
                type="button"
                onClick={() => setLastError(null)}
                aria-label="关闭错误提示"
                className="p-0.5 rounded hover:bg-red-100 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* 步骤列表 */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {steps.map((s, i) => (
              <div key={s.stepId}>
                <div
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded border text-xs',
                    s.status === 'running' && 'border-amber-300 bg-amber-50/50 dark:bg-amber-950/30',
                    s.status === 'completed' && 'border-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/30',
                    s.status === 'failed' && 'border-red-300 bg-red-50/50 dark:bg-red-950/30',
                    s.status === 'cancelled' && 'border-orange-300 bg-orange-50/50',
                    s.status === 'pending' && 'border-slate-200 dark:border-slate-700',
                  )}
                  data-testid={`recipe-progress-step-${i}`}
                  data-status={s.status}
                >
                  <StatusIcon status={s.status} />
                  <span className="font-mono text-[10px] text-muted-foreground w-6 shrink-0 text-right">
                    #{i + 1}
                  </span>
                  <span className="flex-1 truncate font-medium" title={s.label}>
                    {s.label}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                    {formatDuration(s.startedAt, s.finishedAt)}
                  </span>
                </div>
                {s.error && (
                  <div className="text-[10px] text-red-700 dark:text-red-300 px-2 pb-1 line-clamp-2 ml-7" title={s.error}>
                    {s.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
