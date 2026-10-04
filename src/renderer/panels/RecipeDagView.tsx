/**
 * Recipe DAG View (D5c-2)
 *
 * 用 @xyflow/react 把 RecipeDefinition 渲染为静态 DAG：
 *   - 节点 = Recipe step（agent / shell）
 *   - 边 = depends_on 显式声明 / outputs.x.y 隐式引用 / 数组顺序兜底
 *   - 颜色按 status（pending / running / completed / failed / cancelled）
 *
 * 设计哲学：
 *   - 自包含：组件内部用 useMemo 调 buildRecipeDag() + dagToFlowNodes/Edges，
 *     调用方只需传 RecipeDefinition 即可。
 *   - 不引入 dagre 等第三方布局 —— Recipe 通常 ≤ 20 步，朴素列网格够用，
 *     也避免外部依赖膨胀。
 *   - 节点可点击查看详情（label + agent_type / shell command + error）。
 *   - 循环依赖、缺失依赖用顶部 warning 条提示，但不阻断渲染。
 */

import { useMemo, useState, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  MarkerType,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  buildRecipeDag,
  dagToFlowNodes,
  dagToFlowEdges,
} from '@shared/recipe-dag'
import type {
  RecipeDefinition,
  RecipeDagNodeStatus,
} from '@shared/types/recipe'

interface Props {
  recipe: RecipeDefinition
  /**
   * 外部传入的实时 step 状态覆盖。key = stepId，value = status。
   * 用于 RecipeRunProgress 面板推动 DAG 节点着色。
   */
  liveStatus?: Record<string, { status: RecipeDagNodeStatus; error?: string }>
}

const STATUS_STYLES: Record<RecipeDagNodeStatus, { bg: string; border: string; label: string; dot: string }> = {
  pending: {
    bg: 'bg-slate-50 dark:bg-slate-900',
    border: 'border-slate-300 dark:border-slate-700',
    label: 'text-slate-700 dark:text-slate-300',
    dot: 'bg-slate-400',
  },
  running: {
    bg: 'bg-amber-50 dark:bg-amber-950',
    border: 'border-amber-500',
    label: 'text-amber-900 dark:text-amber-200',
    dot: 'bg-amber-500 animate-pulse',
  },
  completed: {
    bg: 'bg-emerald-50 dark:bg-emerald-950',
    border: 'border-emerald-500',
    label: 'text-emerald-900 dark:text-emerald-200',
    dot: 'bg-emerald-500',
  },
  failed: {
    bg: 'bg-red-50 dark:bg-red-950',
    border: 'border-red-500',
    label: 'text-red-900 dark:text-red-200',
    dot: 'bg-red-500',
  },
  cancelled: {
    bg: 'bg-orange-50 dark:bg-orange-950',
    border: 'border-orange-400',
    label: 'text-orange-900 dark:text-orange-200',
    dot: 'bg-orange-400',
  },
  skipped: {
    bg: 'bg-zinc-50 dark:bg-zinc-900',
    border: 'border-zinc-300 dark:border-zinc-700',
    label: 'text-zinc-500 dark:text-zinc-400',
    dot: 'bg-zinc-300',
  },
}

function StatusDot({ status }: { status: RecipeDagNodeStatus }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${STATUS_STYLES[status].dot}`}
      aria-label={`status=${status}`}
    />
  )
}

function StepNode({ data }: { data: { label: string; nodeType: 'agent' | 'shell'; agentType?: string; shellCommand?: string; status: RecipeDagNodeStatus; index: number; error?: string } }) {
  const { label, nodeType, agentType, shellCommand, status, index, error } = data
  const style = STATUS_STYLES[status]
  return (
    <div
      className={`px-3 py-2 rounded-md border-2 shadow-sm min-w-[160px] ${style.bg} ${style.border}`}
      data-testid={`dag-node-${index}`}
      data-status={status}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <span className="text-[10px] font-mono text-muted-foreground">#{index}</span>
        <span className={`text-xs font-medium ${style.label} flex-1 truncate`} title={label}>
          {label}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1 text-[10px]">
        <span className="px-1 py-0.5 rounded bg-muted text-muted-foreground font-mono">{nodeType}</span>
        {agentType && (
          <span className="px-1 py-0.5 rounded bg-blue-50 text-blue-700 font-mono truncate" title={agentType}>
            {agentType}
          </span>
        )}
        {shellCommand && (
          <span className="px-1 py-0.5 rounded bg-purple-50 text-purple-700 font-mono truncate" title={shellCommand}>
            {shellCommand}
          </span>
        )}
      </div>
      {error && (
        <div className="mt-1 text-[10px] text-red-700 dark:text-red-300 line-clamp-2" title={error}>
          {error}
        </div>
      )}
    </div>
  )
}

const nodeTypes = { stepNode: StepNode }

export function RecipeDagView({ recipe, liveStatus }: Props) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)

  const dag = useMemo(() => buildRecipeDag(recipe), [recipe])

  // 把 liveStatus 合并进节点
  const nodes: Node[] = useMemo(() => {
    const baseNodes = dagToFlowNodes(dag) as unknown as Node[]
    return baseNodes.map((n) => {
      const live = liveStatus?.[n.id]
      if (!live) return n
      return {
        ...n,
        data: {
          ...n.data,
          status: live.status,
          error: live.error ?? (n.data as { error?: string }).error,
        },
      }
    }).map((n) => ({
      ...n,
      type: 'stepNode',
    })) as Node[]
  }, [dag, liveStatus])

  const edges: Edge[] = useMemo(() => {
    const baseEdges = dagToFlowEdges(dag) as unknown as Edge[]
    return baseEdges.map((e) => {
      const kind = (e.data as { kind?: string })?.kind ?? 'index'
      const isOutputRef = kind === 'output-ref'
      const isDependsOn = kind === 'depends_on'
      return {
        ...e,
        type: 'default',
        animated: isOutputRef,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: {
          strokeWidth: 1.5,
          stroke: isDependsOn ? '#475569' : isOutputRef ? '#2563eb' : '#94a3b8',
          strokeDasharray: isOutputRef ? '4 4' : undefined,
        },
      } as Edge
    })
  }, [dag])

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setSelectedStepId((cur) => (cur === node.id ? null : node.id))
  }, [])

  const selectedStep = useMemo(() => {
    if (!selectedStepId) return null
    return recipe.steps.find((s, i) => {
      const id = s.id ?? s.name ?? `step_${i}`
      return id === selectedStepId
    }) ?? null
  }, [selectedStepId, recipe])

  const totalSteps = recipe.steps.length
  const hasCycle = dag.cycles.length > 0
  const missingCount = dag.missingDeps.length

  return (
    <div className="border rounded-md overflow-hidden bg-background" data-testid="recipe-dag-view">
      {/* 顶部统计条 */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b bg-muted/30 text-xs">
        <span className="text-muted-foreground">
          节点 <strong>{dag.nodes.length}</strong>
        </span>
        <span className="text-muted-foreground">
          层级 <strong>{dag.levels.length}</strong>
        </span>
        <span className="text-muted-foreground">
          边 <strong>{dag.edges.length}</strong>
        </span>
        <span className="text-muted-foreground">
          步骤 <strong>{totalSteps}</strong>
        </span>
        {hasCycle && (
          <span className="text-destructive" data-testid="dag-cycle-warning">
            ⚠ 检测到循环依赖（{dag.cycles.flat().length} 节点）
          </span>
        )}
        {missingCount > 0 && (
          <span className="text-amber-600 dark:text-amber-400" data-testid="dag-missing-warn">
            ⚠ 缺失依赖 {missingCount} 处
          </span>
        )}
      </div>

      {/* DAG 画布 */}
      <div className="h-72 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
          zoomOnScroll={true}
          panOnDrag={true}
          minZoom={0.2}
          maxZoom={1.5}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} className="[&>button]:bg-background [&>button]:border-border [&>button]:text-foreground" />
        </ReactFlow>
      </div>

      {/* 选中节点详情 */}
      {selectedStep && (
        <div className="border-t p-3 bg-muted/20 text-xs" data-testid="dag-node-detail">
          <div className="flex items-center gap-2 mb-1">
            <StatusDot status={nodes.find((n) => n.id === selectedStepId)?.data?.status as RecipeDagNodeStatus ?? 'pending'} />
            <strong>{selectedStep.name ?? selectedStep.id ?? 'Step'}</strong>
            <span className="font-mono text-[10px] text-muted-foreground">{selectedStep.kind}</span>
          </div>
          {selectedStep.kind === 'agent' && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground">agent_type: <code>{selectedStep.agent_type}</code></div>
              <pre className="text-[10px] whitespace-pre-wrap font-mono bg-muted/40 rounded p-1.5 max-h-24 overflow-y-auto">{selectedStep.prompt}</pre>
            </div>
          )}
          {selectedStep.kind === 'shell' && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground">command:</div>
              <pre className="text-[10px] whitespace-pre-wrap font-mono bg-muted/40 rounded p-1.5">{selectedStep.command.join(' ')}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
