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
 *   - 使用 FloatingPanel shell，并 portal 到 document.body 贴视口右下角
 *     （Recipes 弹层在画布右上角，进度面板贴右下角，两者不互相遮挡）
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
import { useI18n } from '../i18n/useI18n'
import { FloatingPanel } from '../components/ui/FloatingPanel'
import type { TranslationKey } from '@shared/i18n'
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
  return (recipe.steps ?? []).map((s, i) => {
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

/** 运行状态徽标文案（与 RecipesPanel 共用同一组 key）。 */
const RUN_STATUS_LABEL_KEYS: Record<RecipeRunNodeStatus, TranslationKey> = {
  pending: 'recipes.status.pending',
  running: 'recipes.status.running',
  completed: 'recipes.status.succeeded',
  failed: 'recipes.status.failed',
  cancelled: 'recipes.status.cancelled',
  skipped: 'recipes.status.skipped',
}

/**
 * 合并 DB 快照与本地实时状态。
 * 实时事件比 DB 记录新：running 一律以本地为准；DB 还是 pending 而本地已有
 * 终态时也以本地为准（DB 行在 run 结束时才落终态）。
 */
function mergeSteps(fromRun: StepDisplayState[], local: StepDisplayState[]): StepDisplayState[] {
  return fromRun.map((s, i) => {
    const l = local[i]
    if (!l || l.stepId !== s.stepId) return s
    if (l.status === 'running') return l
    if (s.status === 'pending' && l.status !== 'pending') return l
    return s
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
  const { t } = useI18n()
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

  // 换 recipe / 换 run 时重置步骤表，并回填 DB 里已有的 run 状态 ——
  // 面板可能在 run 结束之后才挂载（历史 run 回看），此时只看实时事件会全是 pending。
  useEffect(() => {
    setSteps(buildInitialSteps(recipe, initialRun ?? null))
    setLastError(null)
    const getRun = api?.['recipes:getRun']
    if (!getRun) return
    let cancelled = false
    void Promise.resolve(getRun(runId))
      .then((run) => {
        if (cancelled || !run) return
        setSteps((prev) => mergeSteps(buildInitialSteps(recipe, run), prev))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe.id, runId])

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
    <FloatingPanel
      isOpen
      onClose={onClose}
      variant="corner"
      width="md"
      // portal + fixed：画布祖先的 backdrop-filter 会成为 fixed 后代的包含块，
      // 不 portal 的话「贴右下角」会被算成「贴祖先右下角」，还会被 Recipes 弹层裁掉。
      portal
      className="top-auto bottom-4"
      dataAttributes={{
        'data-testid': 'recipe-run-progress',
        'data-run-id': runId,
        'data-percent': percent,
      }}
      icon={
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('recipes.progress.expand') : t('recipes.progress.collapse')}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground transition-colors"
          data-testid="recipe-progress-collapse-toggle"
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      }
      title={t('recipes.progress.title')}
      subtitle={
        <span className="whitespace-nowrap" data-testid="recipe-progress-counter">
          {doneCount}/{totalSteps}
        </span>
      }
      showCloseButton={false}
      headerActions={
        <button
          type="button"
          onClick={onClose}
          title={t('recipes.progress.close')}
          aria-label={t('recipes.progress.close')}
          data-testid="recipe-progress-close"
          className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      }
    >
      {/* 顶部进度条 + 状态徽标 */}
      {!collapsed && (
        <>
          <div className="shrink-0 px-3 py-2 border-b bg-muted/30">
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
                {overallDone
                  ? t(RUN_STATUS_LABEL_KEYS[failedSteps > 0 ? 'failed' : 'completed'])
                  : t(RUN_STATUS_LABEL_KEYS[isRunning ? 'running' : 'pending'])}
              </span>
              {isRunning && api?.['recipes:cancel'] && (
                <button
                  type="button"
                  onClick={() => void handleCancel()}
                  className="ml-auto text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
                  data-testid="recipe-progress-cancel"
                >
                  {t('recipes.cancel')}
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
                {t('recipes.progress.summary', {
                  completed: completedSteps,
                  failed: failedSteps,
                  pending: totalSteps - doneCount,
                })}
              </span>
              <span>{percent}%</span>
            </div>
          </div>

          {/* 错误条 */}
          {lastError && (
            <div
              role="alert"
              className="shrink-0 flex items-start gap-2 px-3 py-2 bg-red-50 border-b border-red-200 text-red-700 text-xs"
              data-testid="recipe-progress-error-banner"
            >
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <p className="flex-1 break-words">{lastError}</p>
              <button
                type="button"
                onClick={() => setLastError(null)}
                aria-label={t('recipes.progress.dismissError')}
                className="p-0.5 rounded hover:bg-red-100 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* 步骤列表 */}
          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
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
    </FloatingPanel>
  )
}
