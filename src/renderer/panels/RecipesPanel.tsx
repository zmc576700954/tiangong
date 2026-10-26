/**
 * Recipes Panel
 *
 * 列出所有已加载的 Recipe（user 级 + project 级），允许 Run 一个 Recipe 并查看历史 runs。
 *
 * 设计：
 *   - 顶部按钮：Refresh（强制重扫）+ Run by ID（手填 recipe id + inputs）
 *   - 左侧 Recipe 列表（id + source 徽标 + description）
 *   - 右侧详情：步骤预览（步骤类型 + prompt 摘要）+ Inputs 表单 + Run 按钮 + Run History
 *   - 折叠面板：DAG 视图（D5c-2）
 *   - 运行时进度面板（D5c-3）
 *   - 不实现 YAML 编辑器（CLAUDE.md 不在渲染进程编辑 YAML；用户在文件系统写 .yaml 后点 Refresh）
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { ChevronDown, ChevronRight, Network } from 'lucide-react'
import { useI18n } from '../i18n/useI18n'
import type { TranslationKey } from '@shared/i18n'
import type {
  RecipeDefinition,
  RecipeRun,
  RecipeRunStatus,
  RecipeRunProgressEvent,
  RecipeDagNodeStatus,
} from '@shared/types/recipe'
import { RecipeDagView } from './RecipeDagView'
import { RecipeRunProgress } from './RecipeRunProgress'

interface Props {
  /** 注入 electronAPI；测试可传 mock。 */
  electronAPI?: {
    'recipes:list': () => Promise<RecipeDefinition[]>
    'recipes:get': (id: string) => Promise<RecipeDefinition | null>
    'recipes:dag': (id: string) => Promise<unknown>
    'recipes:run': (req: { recipeId: string; inputs?: Record<string, string | number | boolean> }) => Promise<RecipeRun>
    'recipes:cancel': (runId: string) => Promise<boolean>
    'recipes:refresh': () => Promise<number>
    'recipes:listRuns': (recipeId: string, limit?: number) => Promise<RecipeRun[]>
    'recipes:getRun': (runId: string) => Promise<RecipeRun | null>
    onRecipeRunProgress?: (cb: (data: RecipeRunProgressEvent) => void) => () => void
  }
}

/** 来源徽标文案——user / project / builtin 是存储值，展示时按语言替换 */
const SOURCE_LABEL_KEYS: Record<'user' | 'project' | 'builtin', TranslationKey> = {
  user: 'recipes.source.user',
  project: 'recipes.source.project',
  builtin: 'recipes.source.builtin',
}

/** 运行状态徽标文案 */
const RUN_STATUS_LABEL_KEYS: Record<RecipeRunStatus, TranslationKey> = {
  pending: 'recipes.status.pending',
  running: 'recipes.status.running',
  succeeded: 'recipes.status.succeeded',
  failed: 'recipes.status.failed',
  cancelled: 'recipes.status.cancelled',
}

/**
 * 布尔输入的固定选项。
 * true / false 是 YAML 字面量，值与显示都保持英文——用户写进 YAML 的就是这两个词。
 */
const BOOLEAN_OPTIONS = [
  { value: 'true', label: 'true' },
  { value: 'false', label: 'false' },
] as const

/** 用户级 recipe 目录（相对 userData） */
const USER_RECIPES_DIR = 'userData/recipes/'

/** 项目级 recipe 目录（相对工作目录） */
const PROJECT_RECIPES_DIR = '.bizgraph/recipes/'

function getApi(propsApi?: Props['electronAPI']) {
  return propsApi ?? (window.electronAPI as unknown as Props['electronAPI'])
}

export function RecipesPanel({ electronAPI: apiProp }: Props) {
  const api = getApi(apiProp)
  const { t } = useI18n()
  const [recipes, setRecipes] = useState<RecipeDefinition[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const [runs, setRuns] = useState<RecipeRun[]>([])
  const [dagExpanded, setDagExpanded] = useState(true)
  const [activeRun, setActiveRun] = useState<{ runId: string; recipe: RecipeDefinition } | null>(null)
  const [liveStepStatus, setLiveStepStatus] = useState<Record<string, { status: RecipeDagNodeStatus; error?: string }>>({})

  const refresh = async (): Promise<void> => {
    if (!api) return
    try {
      const list = await api['recipes:list']()
      setRecipes(list)
      if (list.length > 0 && !selectedId) setSelectedId(list[0]!.id)
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = useMemo(() => recipes.find((r) => r.id === selectedId), [recipes, selectedId])

  useEffect(() => {
    if (!selected || !api) {
      setRuns([])
      return
    }
    setInputValues({})
    setLiveStepStatus({})
    void api['recipes:listRuns'](selected.id, 20).then(setRuns).catch(() => setRuns([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const handleStepUpdate = useCallback((stepId: string, status: RecipeDagNodeStatus, error?: string) => {
    setLiveStepStatus((prev) => ({
      ...prev,
      [stepId]: { status, error },
    }))
  }, [])

  const handleRun = async (): Promise<void> => {
    if (!selected || !api) return
    setRunning(true)
    setLastError(null)
    setLiveStepStatus({})
    try {
      const inputs: Record<string, string | number | boolean> = {}
      for (const spec of selected.inputs ?? []) {
        const v = inputValues[spec.name] ?? ''
        if (spec.type === 'number') {
          const parsed = Number(v)
          if (spec.required && Number.isNaN(parsed)) {
            throw new Error(`Input "${spec.name}" must be numeric`)
          }
        }
        if (spec.type === 'boolean') {
          inputs[spec.name] = v === 'true'
        } else if (spec.type === 'number') {
          inputs[spec.name] = Number(v)
        } else {
          inputs[spec.name] = v
        }
      }
      const run = await api['recipes:run']({ recipeId: selected.id, inputs })
      setActiveRun({ runId: run.id, recipe: selected })
      const history = await api['recipes:listRuns'](selected.id, 20)
      setRuns(history)
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleCancel = async (runId: string): Promise<void> => {
    if (!api) return
    try {
      await api['recipes:cancel'](runId)
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!api) {
    return <div className="p-4 text-xs text-muted-foreground">{t('recipes.apiUnavailable')}</div>
  }

  return (
    <div className="relative flex h-full text-sm">
      {/* Left: list */}
      <div className="w-64 border-r flex flex-col">
        <div className="flex items-center justify-between p-2 border-b">
          <h3 className="font-medium">{t('recipes.title')}</h3>
          <Button
            size="sm"
            variant="ghost"
            title={t('recipes.refresh')}
            aria-label={t('recipes.refresh')}
            onClick={() => void refresh()}
          >
            ↻
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {recipes.length === 0 && (
            <div className="p-4 text-xs text-muted-foreground">
              {t('recipes.emptyPrefix')}{' '}
              <code className="font-mono">{USER_RECIPES_DIR}</code>{' '}
              {t('recipes.emptyConnector')}{' '}
              <code className="font-mono">{PROJECT_RECIPES_DIR}</code>
              {t('recipes.emptySuffix')}
            </div>
          )}
          {recipes.map((r) => (
            <div
              key={r.id}
              className={`p-2 border-b cursor-pointer hover:bg-accent ${selectedId === r.id ? 'bg-accent' : ''}`}
              onClick={() => setSelectedId(r.id)}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{r.id}</span>
                <Badge variant={r.source === 'project' ? 'default' : 'outline'} className="text-[10px]">
                  {t(SOURCE_LABEL_KEYS[r.source ?? 'user'])}
                </Badge>
              </div>
              {r.description && (
                <div className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{r.description}</div>
              )}
              <div className="text-[10px] text-muted-foreground mt-1">
                {t('recipes.stepCount', { count: (r.steps ?? []).length })}
                {r.sub_recipes && r.sub_recipes.length > 0 && <> &rarr; {t('recipes.subRecipeCount', { count: r.sub_recipes.length })}</>}
                {r.tags && r.tags.length > 0 && <> &rarr; {r.tags.join(', ')}</>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selected ? (
          <>
            <div className="p-3 border-b">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">{selected.name}</h2>
                <Badge variant={selected.source === 'project' ? 'default' : 'outline'}>
                  {t(SOURCE_LABEL_KEYS[selected.source ?? 'user'])}
                </Badge>
              </div>
              {selected.description && (
                <div className="text-xs text-muted-foreground mt-1">{selected.description}</div>
              )}
              {selected.sourcePath && (
                <div className="text-[10px] text-muted-foreground font-mono mt-1 truncate">{selected.sourcePath}</div>
              )}
            </div>

            {/* DAG 视图（折叠面板） */}
            <div className="border-b">
              <button
                type="button"
                onClick={() => setDagExpanded((v) => !v)}
                aria-expanded={dagExpanded}
                data-testid="recipes-dag-toggle"
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-accent transition-colors"
              >
                {dagExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                <Network className="w-3.5 h-3.5 text-muted-foreground" />
                {t('recipes.dag.viewTitle')}
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {t('recipes.dag.nodeEdgeSummary', {
                    nodes: (selected.steps ?? []).length,
                    edges: Math.max((selected.steps ?? []).length - 1, 0),
                  })}
                </span>
              </button>
              {dagExpanded && (
                <div className="px-3 pb-3">
                  <RecipeDagView recipe={selected} liveStatus={liveStepStatus} />
                </div>
              )}
            </div>

            {/* Inputs form */}
            {selected.inputs && selected.inputs.length > 0 && (
              <div className="p-3 border-b space-y-2">
                <h4 className="text-xs font-medium">{t('recipes.inputs')}</h4>
                {selected.inputs.map((spec) => (
                  <div key={spec.name}>
                    <label className="text-[10px] text-muted-foreground">
                      {spec.label ?? spec.name}
                      {spec.required && <span className="text-destructive"> *</span>}
                      {spec.type === 'enum' && spec.options && (
                        <span className="ml-2 text-[10px] font-mono">enum {spec.options.join('|')}</span>
                      )}
                    </label>
                    {spec.type === 'boolean' ? (
                      <select
                        className="w-full border rounded px-2 py-1 text-xs"
                        value={inputValues[spec.name] ?? ''}
                        onChange={(e) => setInputValues({ ...inputValues, [spec.name]: e.target.value })}
                      >
                        <option value="">-</option>
                        {BOOLEAN_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    ) : spec.type === 'enum' && spec.options ? (
                      <select
                        className="w-full border rounded px-2 py-1 text-xs"
                        value={inputValues[spec.name] ?? ''}
                        onChange={(e) => setInputValues({ ...inputValues, [spec.name]: e.target.value })}
                      >
                        <option value="">-</option>
                        {spec.options.map((o) => (
                          <option key={String(o)} value={String(o)}>{String(o)}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={spec.type === 'number' ? 'number' : 'text'}
                        className="w-full border rounded px-2 py-1 text-xs"
                        value={inputValues[spec.name] ?? ''}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInputValues({ ...inputValues, [spec.name]: e.target.value })}
                        placeholder={spec.default !== undefined ? String(spec.default) : ''}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Run button */}
            <div className="p-3 border-b flex items-center gap-2">
              <Button onClick={() => void handleRun()} disabled={running}>
                {running ? t('recipes.running') : t('recipes.run')}
              </Button>
              {lastError && (
                <span className="text-xs text-destructive">{lastError}</span>
              )}
            </div>

            {/* Steps preview */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              <h4 className="text-xs font-medium">{t('recipes.steps', { count: (selected.steps ?? []).length })}</h4>
              {(selected.steps ?? []).map((s, i) => (
                <div key={i} className="border rounded p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Badge variant={s.kind === 'shell' ? 'secondary' : 'outline'} className="text-[10px]">
                      {s.kind}
                    </Badge>
                    <span className="font-mono">{s.id ?? s.name ?? `step_${i + 1}`}</span>
                  </div>
                  {s.kind === 'agent' ? (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      agent_type=<code>{s.agent_type}</code>
                      <pre className="mt-1 whitespace-pre-wrap font-mono">{s.prompt}</pre>
                    </div>
                  ) : (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      command=<code>{s.command.join(' ')}</code>
                      {s.cwd && <div>cwd=<code>{s.cwd}</code></div>}
                    </div>
                  )}
                </div>
              ))}

              {/* Sub-recipes preview (D5a) */}
              {selected.sub_recipes && selected.sub_recipes.length > 0 && (
                <div className="mt-3">
                  <h4 className="text-xs font-medium">{t('recipes.subRecipesTitle', { count: selected.sub_recipes.length })}</h4>
                  {selected.sub_recipes.map((sr, i) => (
                    <div key={i} className="border rounded p-2 text-xs mt-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">sub_recipe</Badge>
                        <span className="font-mono">{sr.name}</span>
                        <span className="text-muted-foreground">→ {sr.recipe}</span>
                      </div>
                      {sr.inputs && Object.keys(sr.inputs).length > 0 && (
                        <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                          inputs: {JSON.stringify(sr.inputs)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Response preview (D5a) */}
              {selected.response && (selected.response.success_condition || selected.response.failure_condition) && (
                <div className="mt-3">
                  <h4 className="text-xs font-medium">{t('recipes.responseTitle')}</h4>
                  {selected.response.success_condition && (
                    <div className="text-[10px] text-muted-foreground">
                      {t('recipes.response.success')}: {selected.response.success_condition}
                    </div>
                  )}
                  {selected.response.failure_condition && (
                    <div className="text-[10px] text-muted-foreground">
                      {t('recipes.response.failure')}: {selected.response.failure_condition}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Run history */}
            <div className="border-t max-h-40 overflow-y-auto p-3 space-y-1">
              <h4 className="text-xs font-medium">{t('recipes.runHistory', { count: runs.length })}</h4>
              {runs.length === 0 && (
                <div className="text-[10px] text-muted-foreground">{t('recipes.noRuns')}</div>
              )}
              {runs.map((run) => (
                <div key={run.id} className="text-[10px] flex items-center gap-2">
                  <Badge
                    variant={run.status === 'succeeded' ? 'default' : 'destructive'}
                    className="text-[10px]"
                  >
                    {t(RUN_STATUS_LABEL_KEYS[run.status])}
                  </Badge>
                  <span className="font-mono">{run.id}</span>
                  <span className="text-muted-foreground">
                    {new Date(run.started_at).toLocaleString()}
                  </span>
                  {run.status === 'running' && (
                    <Button size="sm" variant="ghost" className="h-4 text-[10px] ml-auto"
                      onClick={() => void handleCancel(run.id)}>{t('recipes.cancel')}</Button>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
            {t('recipes.selectHint')}
          </div>
        )}
      </div>

      {/* 执行进度面板（D5c-3） */}
      {activeRun && (
        <RecipeRunProgress
          recipe={activeRun.recipe}
          runId={activeRun.runId}
          electronAPI={api}
          onStepUpdate={handleStepUpdate}
          onClose={() => setActiveRun(null)}
        />
      )}
    </div>
  )
}