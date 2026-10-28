import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { getNodeStatusClass, cn } from '../lib/utils'
import { NODE_TYPE_COLORS } from '@shared/constants'
import { nodeStatusLabel, nodeTypeLabel, wikiPageTitle } from '@shared/i18n'
import { useI18n } from '../i18n/useI18n'
import type { GraphNode, AgentOutput } from '@shared/types'
import { Bug, Loader2, AlertTriangle, Check, BookOpen, ChevronDown, ChevronRight } from 'lucide-react'
import { useAgentOutputStore } from '../store/agentOutputStore'
import { useGraphStore } from '../store/graphStore'
import { ChangeSummaryBadge } from './ChangeSummaryBadge'
import { REPARENT_REASON_I18N_KEY } from './hooks/useReparentDrag'
import type { ReparentReason } from './hooks/useReparentDrag'

const EMPTY_OUTPUTS: AgentOutput[] = []

/**
 * 折叠指示器 + 徽标。
 *
 * 后代数由 `useCollapse` 算好后经 `flowNode.data` 传进来 —— BizNode 是 React Flow
 * 逐节点渲染的，每个实例自己数一遍就是 O(n²)。
 * 「有没有子节点」也用这个数判断：后代数 > 0 ⟺ 至少有一个直接子节点。
 *
 * 折叠态自己（`data.collapsed`）决定指示器朝向与徽标是否出现。
 */
function FoldControl({
  nodeId,
  collapsed,
  descendantCount,
  onToggle,
}: {
  nodeId: string
  collapsed: boolean
  descendantCount: number
  onToggle?: (nodeId: string) => void
}) {
  const { t } = useI18n()
  // 没有后代 = 没有子节点 = 没有可折叠的东西
  if (descendantCount <= 0) return null
  const hiddenCountLabel = t('canvas.collapse.hiddenCount', { count: descendantCount })
  const toggleLabel = t('canvas.collapse.toggle')
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {collapsed && (
        <span className="rounded bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
          {/* 可见的「⊕ N」对读屏软件没有意义 —— 数字的含义由下面的隐藏文案给出。
              挂在普通 span 上的 aria-label 会被读屏软件忽略（没有 role 就不会
              参与可访问名计算），所以这里用 sr-only 文本节点。

              `title` 挂在**字形**这个 span 上，不挂外层：外层 span 的 title 会
              变成「可访问描述」，跟可访问名（sr-only 文本，同一句话）重复 →
              读屏把数字念两遍。`aria-hidden` 只影响无障碍树的暴露，
              不影响渲染 —— 鼠标悬停照样出原生 tooltip。 */}
          <span aria-hidden="true" title={hiddenCountLabel}>
            ⊕ {descendantCount}
          </span>
          <span className="sr-only">{hiddenCountLabel}</span>
        </span>
      )}
      <button
        type="button"
        // `nodrag` 是 react flow 的约定 class：在按钮上按下时不拖动节点
        className="nodrag rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={toggleLabel}
        onClick={(e) => {
          // 不冒泡：否则折叠的同时会顺带触发节点选中/拖拽
          e.stopPropagation()
          onToggle?.(nodeId)
        }}
      >
        {/* `title` 挂在**图标**这个 span 上，不挂按钮本身：按钮上的 title 会变成
            「可访问描述」，跟可访问名（aria-label，同一句话）重复 → 读屏念两遍。
            `aria-hidden` 只影响无障碍树的暴露，不影响渲染 —— 鼠标悬停照样出原生 tooltip。 */}
        <span aria-hidden="true" title={toggleLabel}>
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      </button>
    </span>
  )
}

interface BizNodeProps {
  id: string
  data: GraphNode & {
    bugCount: number
    isZoomedOut?: boolean
    hideTextLabels?: boolean
    isConnectingSource?: boolean
    isFlashed?: boolean
    hasThread?: boolean
    agentThreadId?: string
    agentStatus?: string
    agentSessionId?: string
    /** D10b: 远端用户选中本节点的颜色列表（按 colorIndex 排序去重） */
    remoteSelectionColors?: string[]
    /** 拖拽重挂：本节点是当前落点候选 */
    isReparentTarget?: boolean
    /** 拖拽重挂：落点是否合法（false = 红框） */
    isReparentTargetValid?: boolean
    /** 拖拽重挂：落点非法的原因 */
    reparentReason?: ReparentReason
    /** 子树折叠：折叠该节点时会被隐藏的后代数（0 = 没有子节点，不显示折叠控件） */
    hiddenDescendantCount?: number
    /** 子树折叠：折叠/展开（引用稳定，来自 useCollapse.toggle） */
    onToggleCollapse?: (nodeId: string) => void
  }
  selected?: boolean
  multiSelected?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}

export const BizNodeComponent = memo(function BizNodeComponent({
  id: _id,
  data,
  selected,
  multiSelected,
  onContextMenu,
}: BizNodeProps) {
  const { locale, t } = useI18n()
  const typeColor = NODE_TYPE_COLORS[data.type] ?? 'hsl(var(--muted-foreground))'
  const isProject = data.type === 'project'
  const isWikiPage = data.type === 'wiki-page'
  const isPreview = data.metadata?.preview === true

  const { isConnectingSource, isFlashed, agentThreadId, agentStatus, agentSessionId, remoteSelectionColors } = data
  const isPotentialTarget = !!isConnectingSource
  const isFlashing = !!isFlashed

  const isAgentRunning = agentStatus === 'running'
  const isAgentError = agentStatus === 'error'
  const isAgentCompleted = agentStatus === 'idle' && !!agentSessionId

  // Select only this thread's outputs — stable empty array when no outputs
  const agentOutputs = useAgentOutputStore((s) => {
    if (!agentThreadId) return EMPTY_OUTPUTS as AgentOutput[]
    return s.threadOutputs[agentThreadId] ?? EMPTY_OUTPUTS as AgentOutput[]
  })

  /**
   * 拖拽重挂落点高亮。
   *
   * 用 outline 而不是 border-* / ring-*：border-orange-400（agent running）/
   * border-red-400（agent error）/ border-green-400（agent completed）已经占了
   * border 颜色，ring-blue-400（选中）/ ring-purple-400（多选）已经占了 ring，
   * 再加同类工具类最终谁赢由 Tailwind 产物里的 CSS 顺序决定，不由类名书写顺序决定。
   * outline 是独立的 CSS 属性，跟 border-color 和 box-shadow 都不冲突。
   */
  const isReparentTarget = data.isReparentTarget === true
  const reparentOutlineClass = isReparentTarget
    ? data.isReparentTargetValid
      ? 'outline-2 outline-offset-2 outline-green-500'
      : 'outline-2 outline-offset-2 outline-red-500'
    : undefined
  const reparentReasonText = data.reparentReason
    ? t(REPARENT_REASON_I18N_KEY[data.reparentReason])
    : undefined

  if (isProject) {
    return (
      <div
        className={cn(
          'group relative px-6 py-4 rounded-xl border-2 min-w-[180px] shadow-md cursor-default',
          reparentOutlineClass,
        )}
        style={{
          borderColor: multiSelected ? '#8b5cf6' : selected ? '#3b82f6' : typeColor,
          background: `linear-gradient(135deg, ${typeColor}08, ${typeColor}15)`,
          boxShadow: [
            multiSelected
              ? '0 0 0 2px rgba(139, 92, 246, 0.3)'
              : selected
                ? '0 0 0 2px rgba(59, 130, 246, 0.3)'
                : 'none',
            // D10b: 远端选中时叠加多色 ring
            ...(remoteSelectionColors ?? []).map((color, idx) =>
              `0 0 0 ${4 + idx * 3}px ${color}40`,
            ),
          ].filter((s) => s !== 'none').join(', ') || undefined,
        }}
        onContextMenu={onContextMenu}
      >
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-top-[5px] transition-all"
        />
        <Handle
          type="target"
          position={Position.Left}
          id="left"
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-left-[5px] transition-all"
        />
        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-bottom-[5px] transition-all"
        />
        <Handle
          type="source"
          position={Position.Right}
          id="right"
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-right-[5px] transition-all"
        />
        <div className="flex items-center gap-1.5 mb-1">
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: typeColor }} />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {nodeTypeLabel(data.type, locale)}
          </span>
          <FoldControl
            nodeId={data.id}
            collapsed={data.collapsed === true}
            descendantCount={data.hiddenDescendantCount ?? 0}
            onToggle={data.onToggleCollapse}
          />
        </div>
        <div className="font-bold text-lg truncate">{wikiPageTitle(data.title, locale)}</div>
        {reparentReasonText && (
          <div className="absolute left-0 top-full mt-1 z-10 whitespace-nowrap rounded bg-red-500 px-1.5 py-0.5 text-[10px] leading-tight text-white shadow-sm pointer-events-none">
            {reparentReasonText}
          </div>
        )}
      </div>
    )
  }

  const statusClass = getNodeStatusClass(data.status)

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'group relative px-4 py-2.5 rounded-lg border-2 min-w-[140px] max-w-[200px] shadow-xs hover:shadow-md cursor-pointer',
        statusClass,
        selected && 'ring-2 ring-blue-400 ring-offset-1',
        multiSelected && 'ring-2 ring-purple-400 ring-offset-1',
        isAgentRunning && 'border-orange-400 animate-pulse',
        isAgentError && 'border-red-400',
        isAgentCompleted && 'border-green-400',
        isPreview && 'opacity-50 border-dashed border-2 border-gray-400 dark:border-gray-500',
        isPotentialTarget && 'animate-breathe',
        isFlashing && 'animate-flash-once',
        reparentOutlineClass,
      )}
      style={{
        borderColor: multiSelected ? '#8b5cf6' : selected ? typeColor : undefined,
        transition: 'border-color var(--duration-normal), box-shadow var(--duration-normal), transform var(--duration-normal)',
        transform: selected || multiSelected ? 'scale(1.02)' : 'scale(1)',
        boxShadow: [
          multiSelected
            ? '0 0 0 2px rgba(139, 92, 246, 0.3)'
            : selected
              ? `0 0 0 2px ${typeColor}40`
              : 'none',
          // D10b: 远端选中时叠加多色 ring
          ...(remoteSelectionColors ?? []).map((color, idx) =>
            `0 0 0 ${4 + idx * 3}px ${color}40`,
          ),
        ].filter((s) => s !== 'none').join(', ') || undefined,
      }}
      onContextMenu={onContextMenu}
    >
      {/* Target handles: top + left (连线入端) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-top-[5px] transition-all"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-left-[5px] transition-all"
      />
      {/* Source handles: bottom + right (连线出端) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-bottom-[5px] transition-all"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-right-[5px] transition-all"
      />

      <div className="flex items-center gap-1.5 mb-1">
        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: typeColor }} />
        <span className={cn("text-[10px] text-muted-foreground uppercase tracking-wider", (data.isZoomedOut || data.hideTextLabels) && "hidden")}>
          {nodeTypeLabel(data.type, locale)}
        </span>
        <FoldControl
          nodeId={data.id}
          collapsed={data.collapsed === true}
          descendantCount={data.hiddenDescendantCount ?? 0}
          onToggle={data.onToggleCollapse}
        />
      </div>
      <div className={cn("font-medium text-sm truncate", data.isZoomedOut && "text-[8px]", data.hideTextLabels && "text-[8px]")}>{wikiPageTitle(data.title, locale)}</div>
      {isWikiPage && data.wikiContent && (
        <div className="mt-1 text-[9px] text-muted-foreground truncate max-w-[180px]">
          {data.wikiContent.split('\n')[0]?.replace(/^#+\s*/, '')}
        </div>
      )}
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-muted-foreground">{nodeStatusLabel(data.status, locale)}</span>
        {isWikiPage && (
          <BookOpen className="w-3 h-3 text-amber-500" />
        )}
        {data.bugCount > 0 && (
          <div className="flex items-center gap-0.5 text-[10px] text-destructive">
            <Bug className="w-3 h-3" />
            {data.bugCount}
          </div>
        )}
      </div>

      {/* Agent activity badge */}
      {(isAgentRunning || isAgentError || isAgentCompleted) && (
        <div className={cn(
          'absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center shadow-xs',
          isAgentRunning && 'bg-orange-400',
          isAgentError && 'bg-red-400',
          isAgentCompleted && 'bg-green-400 animate-fade-out-3s',
        )}>
          {isAgentRunning && <Loader2 className="w-3 h-3 text-white animate-spin" />}
          {isAgentError && <AlertTriangle className="w-3 h-3 text-white" />}
          {isAgentCompleted && <Check className="w-3 h-3 text-white" />}
        </div>
      )}

      {isPreview && (
        <div className="flex gap-1 mt-1">
          <button
            onClick={(e) => { e.stopPropagation(); useGraphStore.getState().confirmPreviewNode(data.id) }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900 dark:text-green-300"
          >
            {t('canvas.node.previewConfirm')}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); useGraphStore.getState().clearPreviewNodes() }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-300"
          >
            {t('canvas.node.previewClear')}
          </button>
        </div>
      )}

      {agentOutputs.length > 0 && (
        <ChangeSummaryBadge outputs={agentOutputs} />
      )}

      {/* 落点非法的原因说明 —— 紧挨着红框，拖拽过程中就能看到为什么不能挂 */}
      {reparentReasonText && (
        <div className="absolute left-0 top-full mt-1 z-10 whitespace-nowrap rounded bg-red-500 px-1.5 py-0.5 text-[10px] leading-tight text-white shadow-sm pointer-events-none">
          {reparentReasonText}
        </div>
      )}
    </div>
  )
})
