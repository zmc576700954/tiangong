/**
 * RecipesPanel — Recipe 工作流面板。
 *
 * UI 结构：
 * - 顶栏：标题 + 关闭按钮
 * - 左列：Recipe 列表（user/project/builtin 三组）
 * - 右列：Recipe 详情 + 参数表单 + Run 按钮 + 历史 runs
 *
 * 状态：纯本地 useState，无 Zustand store。
 */

import { useEffect, useMemo, useState } from 'react'
import { ChefHat, X, Play, Loader2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { useToast } from '../lib/toast'
import type { RecipeWithSource, RecipeRun } from '@shared/types'

const ipc = typeof window !== 'undefined' && window.electronAPI
  ? window.electronAPI
  : null

interface RecipeFormState {
  values: Record<string, string>
}

function ParamInput({
  param,
  value,
  onChange,
}: {
  param: { key: string; inputType: 'string' | 'number' | 'boolean'; required: boolean; description?: string }
  value: string
  onChange: (v: string) => void
}) {
  if (param.inputType === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
        <span>{param.description ?? param.key}{param.required ? ' *' : ''}</span>
      </label>
    )
  }
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{param.description ?? param.key}{param.required ? ' *' : ''}</span>
      <input
        type={param.inputType === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border rounded px-2 py-1 text-sm bg-background"
      />
    </label>
  )
}

function isBuiltin(r: RecipeWithSource): boolean {
  return r.filePath === '<builtin>'
}

export function RecipesPanel({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [recipes, setRecipes] = useState<RecipeWithSource[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [formState, setFormState] = useState<RecipeFormState>({ values: {} })
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState<RecipeRun[]>([])

  useEffect(() => {
    if (!ipc) return
    void ipc['recipes:list']()
      .then((res) => {
        const list = res as RecipeWithSource[]
        setRecipes(list)
        if (list.length > 0 && !selectedId) setSelectedId(getKey(list[0]))
      })
      .catch((err) => toast.error(`加载 Recipe 失败: ${(err as Error).message}`))
  }, [])

  useEffect(() => {
    if (!ipc) return
    void ipc['recipes:listRuns']()
      .then((res) => setHistory(res as RecipeRun[]))
      .catch(() => { /* history optional */ })
  }, [running])

  const selected = useMemo(
    () => recipes.find((r) => getKey(r) === selectedId) ?? null,
    [recipes, selectedId],
  )

  // 切换 Recipe 时重置表单
  useEffect(() => {
    if (!selected) return
    const initial: Record<string, string> = {}
    for (const p of selected.parameters ?? []) {
      if (p.default !== undefined) initial[p.key] = String(p.default)
      else initial[p.key] = ''
    }
    setFormState({ values: initial })
  }, [selectedId])

  const runRecipe = async () => {
    if (!selected || !ipc) return
    const inputs: Record<string, unknown> = {}
    for (const p of selected.parameters ?? []) {
      const raw = formState.values[p.key] ?? ''
      if (p.inputType === 'number') inputs[p.key] = Number(raw)
      else if (p.inputType === 'boolean') inputs[p.key] = raw === 'true'
      else inputs[p.key] = raw
    }
    setRunning(true)
    try {
      // 尝试从 useAgentStore 拿 active session
      const agentStore = (window as unknown as { __bizgraphAgentStore?: { getState?: () => { activeSessionId?: string | null } } }).__bizgraphAgentStore
      const parentSessionId = agentStore?.getState?.()?.activeSessionId ?? ''
      if (!parentSessionId) {
        toast.error('请先在右侧 Agent 面板启动一个会话，再用 Recipe 派发')
        setRunning(false)
        return
      }
      const result = (await ipc['recipes:run'](selected, inputs, parentSessionId)) as RecipeRun
      if (result.status === 'completed') {
        toast.success(`Recipe 完成: ${selected.title}`)
      } else if (result.status === 'failed') {
        toast.error(`Recipe 失败: ${result.error ?? '未知错误'}`)
      }
      // 刷新历史
      const runs = (await ipc['recipes:listRuns']()) as RecipeRun[]
      setHistory(runs)
    } catch (err) {
      toast.error(`运行 Recipe 失败: ${(err as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  const grouped = useMemo(() => {
    const builtin: RecipeWithSource[] = []
    const project: RecipeWithSource[] = []
    const user: RecipeWithSource[] = []
    for (const r of recipes) {
      if (isBuiltin(r)) builtin.push(r)
      else if (r.source === 'project') project.push(r)
      else user.push(r)
    }
    return { builtin, project, user }
  }, [recipes])

  return (
    <div className="flex flex-col h-full">
      <div className="h-10 border-b flex items-center justify-between px-3 shrink-0">
        <div className="flex items-center gap-2">
          <ChefHat className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">Recipes（工作流）</span>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
      <div className="flex-1 overflow-hidden grid grid-cols-[240px_1fr]">
        {/* 左列：列表 */}
        <div className="border-r overflow-y-auto py-2">
          {(['builtin', 'project', 'user'] as const).map((bucket) => {
            const list = grouped[bucket]
            if (list.length === 0) return null
            const label = bucket === 'builtin' ? '内置' : bucket === 'project' ? '项目' : '用户'
            return (
              <div key={bucket} className="mb-2">
                <div className="px-3 py-1 text-xs uppercase text-muted-foreground tracking-wide">
                  {label}
                </div>
                {list.map((r) => {
                  const key = getKey(r)
                  return (
                    <button
                      key={key}
                      onClick={() => setSelectedId(key)}
                      className={cn(
                        'w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors',
                        selectedId === key && 'bg-muted',
                      )}
                    >
                      <div className="font-medium truncate">{r.title}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {r.version}
                        {r.defaultAdapter ? ` · ${r.defaultAdapter}` : ''}
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          })}
          {recipes.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              暂无 Recipe。在项目下创建 <code className="bg-muted px-1 rounded">.bizgraph/recipes/*.yaml</code> 或在用户级 <code className="bg-muted px-1 rounded">~/.bizgraph/recipes/*.yaml</code>。
            </div>
          )}
        </div>

        {/* 右列：详情 */}
        <div className="overflow-y-auto p-4 flex flex-col gap-4">
          {!selected && (
            <div className="text-sm text-muted-foreground">选中一个 Recipe 查看详情。</div>
          )}
          {selected && (
            <>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold">{selected.title}</h2>
                  {isBuiltin(selected) && (
                    <span className="text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">内置</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-1">{selected.description}</p>
                <div className="text-xs text-muted-foreground mt-2 flex flex-wrap gap-2">
                  <span>v{selected.version}</span>
                  {selected.defaultAdapter && <span>· {selected.defaultAdapter}</span>}
                  {selected.scopeStrategy && <span>· scope: {selected.scopeStrategy}</span>}
                  {selected.allowedTools && <span>· tools: {selected.allowedTools.join(', ')}</span>}
                </div>
              </div>

              {selected.parameters && selected.parameters.length > 0 && (
                <div className="flex flex-col gap-2 border-t pt-4">
                  <div className="text-sm font-medium">参数</div>
                  {selected.parameters.map((p) => (
                    <ParamInput
                      key={p.key}
                      param={p}
                      value={formState.values[p.key] ?? ''}
                      onChange={(v) =>
                        setFormState((s) => ({ values: { ...s.values, [p.key]: v } }))
                      }
                    />
                  ))}
                </div>
              )}

              <div className="flex gap-2 border-t pt-4">
                <button
                  onClick={runRecipe}
                  disabled={running}
                  className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-50"
                >
                  {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  Run
                </button>
              </div>

              {history.length > 0 && (
                <div className="border-t pt-4">
                  <div className="text-sm font-medium mb-2">历史</div>
                  <div className="flex flex-col gap-1">
                    {history.slice(0, 20).map((h) => (
                      <div key={h.id} className="text-xs flex items-center gap-2">
                        <span
                          className={cn(
                            'px-1 rounded',
                            h.status === 'completed' && 'bg-green-100 text-green-800',
                            h.status === 'failed' && 'bg-red-100 text-red-800',
                            h.status === 'running' && 'bg-blue-100 text-blue-800',
                          )}
                        >
                          {h.status}
                        </span>
                        <span>{h.recipeId}</span>
                        <span className="text-muted-foreground">
                          {new Date(h.startedAt).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function getKey(r: RecipeWithSource): string {
  return `${r.source}:${r.title}:${r.version}`
}