/**
 * 审核队列面板（WritebackPanel）
 *
 * 设计哲学：
 * - 完整预览：content 用 Markdown 渲染（react-markdown），details 用原生 <details> 折叠，
 *   narrative 单独展示纯文本摘要，避免旧版「line-clamp-3 截断整段 <details>」的反 UX。
 * - 双 Tab：Pending（待审核 / accept / discard） + History（已采纳 + 已撤回，撤回 / 灰显）。
 * - 批量操作：Pending Tab 顶部 checkbox + 「批量采纳 / 批量丢弃」按当前选中集合操作。
 * - In-flight 守卫：`pendingIds` 集合内的项禁用按钮，防重复点击 + 视觉反馈。
 * - 错误展示：顶部 banner 显示 lastError，单独 dismiss。
 * - 关闭前未处理项检查：避免误关导致用户丢失上下文（仅在不空闲时给出一次 toast，不强制阻拦）。
 * - 撤回（rollback）：仅 accepted 可撤回；rolled_back 项灰显 + hover 显示已执行的撤销步骤。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckSquare, MapPin, Square, Undo2, X, ChevronDown, ChevronRight, AlertTriangle, History } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import type { WritebackItem, WritebackKind } from '@shared/types/wiki'

interface WritebackPanelProps {
  items: WritebackItem[]
  historyItems?: WritebackItem[]
  pendingIds: ReadonlySet<string>
  lastError?: string | null
  onAccept: (itemId: string) => Promise<void> | void
  onDiscard: (itemId: string) => Promise<void> | void
  onRollback?: (itemId: string) => Promise<void> | void
  onBatchAccept: (itemIds: string[]) => Promise<void> | void
  onBatchDiscard: (itemIds: string[]) => Promise<void> | void
  onNavigate: (nodeId: string) => void
  onClose: () => void
  onDismissError?: () => void
}

type ActiveTab = 'pending' | 'history'

const KIND_LABELS: Record<WritebackKind, string> = {
  'append-log': '追加日志',
  'new-page': '新页面',
}

function KindBadge({ kind }: { kind: WritebackKind }) {
  return (
    <span
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded-full border shrink-0',
        kind === 'append-log'
          ? 'bg-blue-50 text-blue-700 border-blue-200'
          : 'bg-green-50 text-green-700 border-green-200',
      )}
    >
      {KIND_LABELS[kind]}
    </span>
  )
}

function StatusBadge({ status }: { status: WritebackItem['status'] }) {
  if (status === 'rolled_back') {
    return (
      <span
        data-testid="status-rolled-back"
        className="text-[10px] px-1.5 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200 shrink-0"
      >
        已撤回
      </span>
    )
  }
  if (status === 'accepted') {
    return (
      <span
        data-testid="status-accepted"
        className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 shrink-0"
      >
        已采纳
      </span>
    )
  }
  return null
}

function formatConfidence(c: number | undefined): string {
  if (c == null || Number.isNaN(c)) return '0%'
  return `${Math.round(c * 100)}%`
}

export function WritebackPanel({
  items,
  historyItems = [],
  pendingIds,
  lastError,
  onAccept,
  onDiscard,
  onRollback,
  onBatchAccept,
  onBatchDiscard,
  onNavigate,
  onClose,
  onDismissError,
}: WritebackPanelProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('pending')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // items 变化时清掉过期的选择（被采纳/丢弃/消失）
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set<string>()
      for (const id of prev) if (items.some((it) => it.id === id)) live.add(id)
      return live
    })
  }, [items])

  const selectableIds = useMemo(() => items.map((i) => i.id), [items])
  const allSelected = selectableIds.length > 0 && selected.size === selectableIds.length

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === selectableIds.length ? new Set() : new Set(selectableIds),
    )
  }, [selectableIds])

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const batchAccept = useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setSelected(new Set())
    await onBatchAccept(ids)
  }, [selected, onBatchAccept])

  const batchDiscard = useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setSelected(new Set())
    await onBatchDiscard(ids)
  }, [selected, onBatchDiscard])

  const historyCount = historyItems.length
  const pendingCount = items.length

  return (
    <div className="absolute top-16 right-4 z-50 w-96 max-h-[70vh] flex flex-col bg-background/95 backdrop-blur border rounded-lg shadow-lg">
      {/* 标题栏 + Tab 切换 */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">审核队列</span>
          <span className="text-[10px] text-muted-foreground">
            待审核 {items.length}
            {selected.size > 0 && ` · 已选 ${selected.size}`}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭审核队列"
          className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tab 栏 */}
      <div role="tablist" className="flex items-center gap-1 px-3 py-1.5 border-b bg-muted/20">
        <button
          role="tab"
          type="button"
          aria-selected={activeTab === 'pending'}
          data-testid="tab-pending"
          onClick={() => setActiveTab('pending')}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
            activeTab === 'pending'
              ? 'bg-background text-foreground shadow-xs font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          待审核
          <span className="text-[10px] text-muted-foreground">{pendingCount}</span>
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={activeTab === 'history'}
          data-testid="tab-history"
          onClick={() => setActiveTab('history')}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
            activeTab === 'history'
              ? 'bg-background text-foreground shadow-xs font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <History className="w-3 h-3" aria-hidden="true" />
          历史
          <span className="text-[10px] text-muted-foreground">{historyCount}</span>
        </button>
      </div>

      {/* 错误条 */}
      {lastError && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 bg-red-50 border-b border-red-200 text-red-700 text-xs"
          data-testid="writeback-error-banner"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <p className="flex-1 break-words">{lastError}</p>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              aria-label="关闭错误提示"
              className="p-0.5 rounded hover:bg-red-100 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* 批量操作栏 — 仅 Pending Tab */}
      {activeTab === 'pending' && items.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b bg-muted/30 text-xs">
          <button
            type="button"
            onClick={toggleAll}
            aria-label={allSelected ? '全不选' : '全选'}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-muted transition-colors"
          >
            {allSelected ? (
              <CheckSquare className="w-3 h-3" aria-hidden="true" />
            ) : (
              <Square className="w-3 h-3" aria-hidden="true" />
            )}
            {allSelected ? '全不选' : '全选'}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={batchDiscard}
            data-testid="batch-discard"
            className="px-2 py-1 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            批量丢弃
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={batchAccept}
            data-testid="batch-accept"
            className="px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            批量采纳
          </button>
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {activeTab === 'pending' ? (
          items.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">暂无待审核的写回项</p>
          ) : (
            items.map((item) => (
              <WritebackItemCard
                key={item.id}
                item={item}
                pending={pendingIds.has(item.id)}
                selected={selected.has(item.id)}
                onToggleSelect={() => toggleOne(item.id)}
                onAccept={() => onAccept(item.id)}
                onDiscard={() => onDiscard(item.id)}
                onNavigate={onNavigate}
              />
            ))
          )
        ) : historyItems.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">暂无历史写回项</p>
        ) : (
          historyItems.map((item) => (
            <HistoryItemCard
              item={item}
              pending={pendingIds.has(item.id)}
              onRollback={onRollback ? () => onRollback(item.id) : undefined}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface WritebackItemCardProps {
  item: WritebackItem
  pending: boolean
  selected: boolean
  onToggleSelect: () => void
  onAccept: () => void
  onDiscard: () => void
  onNavigate: (nodeId: string) => void
}

function WritebackItemCard({
  item,
  pending,
  selected,
  onToggleSelect,
  onAccept,
  onDiscard,
  onNavigate,
}: WritebackItemCardProps) {
  const [expanded, setExpanded] = useState(false)

  const hasDetails = !!item.details && item.details.trim().length > 0
  const hasNarrative = !!item.narrative && item.narrative.trim().length > 0
  const hasSourceNodes = !!item.sourceNodeIds && item.sourceNodeIds.length > 0
  const hasTargetNodeTitle = !!item.targetNodeTitle
  const hasExpandable = hasDetails || hasSourceNodes || hasTargetNodeTitle

  return (
    <div
      className={cn(
        'p-2 rounded border bg-background text-xs space-y-1.5 transition-opacity',
        pending && 'opacity-60',
      )}
      data-testid={`writeback-item-${item.id}`}
    >
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          aria-label={`选择 ${item.title}`}
          checked={selected}
          onChange={onToggleSelect}
          disabled={pending}
          className="shrink-0 cursor-pointer"
        />
        <KindBadge kind={item.kind} />
        <span className="flex-1 truncate font-medium" title={item.title}>
          {item.title}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {formatConfidence(item.confidence)}
        </span>
      </div>

      {/* 始终可见的 content（Markdown 渲染） */}
      {item.content && (
        <div className="prose prose-xs max-w-none dark:prose-invert text-[11px] leading-relaxed line-clamp-4 [&_p]:my-0.5 [&_ul]:my-0.5 [&_li]:my-0 [&_h1]:text-xs [&_h2]:text-[11px] [&_h3]:text-[11px] [&_h2]:mt-1 [&_h2]:mb-0.5 [&_h3]:mt-0.5 [&_h3]:mb-0">
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
            {item.content}
          </ReactMarkdown>
        </div>
      )}

      {/* 展开区按钮：任何可展开字段都在时显示 */}
      {hasExpandable && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid="expand-toggle"
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3" aria-hidden="true" />
          )}
          {expanded ? '收起详情' : '展开详情'}
        </button>
      )}
      {expanded && (
        <div className="space-y-1.5 pl-1 border-l-2 border-muted">
          {hasDetails && (
            <div className="prose prose-xs max-w-none dark:prose-invert text-[11px] leading-relaxed [&_p]:my-0.5 [&_ul]:my-0.5 [&_li]:my-0 [&_h3]:text-[11px] [&_h3]:mt-0.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                {item.details!}
              </ReactMarkdown>
            </div>
          )}
          {hasNarrative && (
            <div className="text-[10px] text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {item.narrative}
            </div>
          )}
          {hasSourceNodes && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted-foreground">来源节点：</span>
              {item.sourceNodeIds!.map((nid) => (
                <button
                  key={nid}
                  type="button"
                  onClick={() => onNavigate(nid)}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition-colors"
                  title={`定位到 ${nid}`}
                >
                  <MapPin className="w-2.5 h-2.5" aria-hidden="true" />
                  <span className="font-mono text-[10px]">{nid.slice(0, 12)}</span>
                </button>
              ))}
            </div>
          )}
          {hasTargetNodeTitle && (
            <div className="text-[10px] text-muted-foreground">
              来源节点标题：<span className="text-foreground">{item.targetNodeTitle}</span>
            </div>
          )}
        </div>
      )}

      {/* 隐藏 details 时仍展示 narrative 一行 TL;DR（仅 append-log） */}
      {!expanded && hasNarrative && (
        <p className="text-[10px] text-muted-foreground line-clamp-2 leading-snug">
          {item.narrative}
        </p>
      )}

      <div className="flex items-center gap-1.5 pt-0.5">
        {item.kind === 'append-log' && item.targetNodeId && (
          <button
            type="button"
            onClick={() => onNavigate(item.targetNodeId)}
            title="定位到目标节点"
            className="flex items-center gap-1 px-2 py-1 rounded text-muted-foreground hover:bg-muted transition-colors"
          >
            <MapPin className="w-3 h-3" />
            定位
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDiscard}
          disabled={pending}
          data-testid={`discard-${item.id}`}
          className="px-2 py-1 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? '处理中…' : '丢弃'}
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={pending}
          data-testid={`accept-${item.id}`}
          className="px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? '处理中…' : '采纳'}
        </button>
      </div>
    </div>
  )
}

interface HistoryItemCardProps {
  item: WritebackItem
  pending: boolean
  onRollback?: (() => void) | undefined
  onNavigate: (nodeId: string) => void
}

/**
 * 历史 Tab 中的写回项卡片：
 * - accepted：原样显示但按钮区只暴露「撤回」
 * - rolled_back：灰显 + 标题旁加「已撤回」徽标 + hover 显示已执行的 rollback 步骤
 */
function HistoryItemCard({ item, pending, onRollback, onNavigate }: HistoryItemCardProps) {
  const isRolledBack = item.status === 'rolled_back'
  const rollbackSteps = item.rollbackActions ?? []

  const rollbackTitle = isRolledBack
    ? rollbackSteps.length > 0
      ? `已执行：${rollbackSteps.map((s) => s.description).join('；')}`
      : '已撤回'
    : undefined

  return (
    <div
      className={cn(
        'p-2 rounded border text-xs space-y-1.5 transition-opacity',
        isRolledBack
          ? 'bg-muted/40 border-muted opacity-60'
          : 'bg-background border-border',
        pending && 'opacity-60',
      )}
      data-testid={`history-item-${item.id}`}
      data-status={item.status}
      title={rollbackTitle}
    >
      <div className="flex items-center gap-1.5">
        <KindBadge kind={item.kind} />
        <span
          className={cn(
            'flex-1 truncate font-medium',
            isRolledBack && 'line-through text-muted-foreground',
          )}
          title={item.title}
        >
          {item.title}
        </span>
        <StatusBadge status={item.status} />
        <span className="text-[10px] text-muted-foreground shrink-0">
          {formatConfidence(item.confidence)}
        </span>
      </div>

      {/* accepted/rolled_back 都允许回看 content（Markdown 渲染） */}
      {item.content && (
        <div className="prose prose-xs max-w-none dark:prose-invert text-[11px] leading-relaxed line-clamp-4 [&_p]:my-0.5 [&_ul]:my-0.5 [&_li]:my-0 [&_h1]:text-xs [&_h2]:text-[11px] [&_h3]:text-[11px] [&_h2]:mt-1 [&_h2]:mb-0.5 [&_h3]:mt-0.5 [&_h3]:mb-0">
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
            {item.content}
          </ReactMarkdown>
        </div>
      )}

      {/* rolled_back：显示已执行的动作摘要 */}
      {isRolledBack && rollbackSteps.length > 0 && (
        <div
          className="text-[10px] text-muted-foreground border-l-2 border-muted pl-2"
          data-testid="rollback-steps"
        >
          <div className="font-medium mb-0.5">撤回步骤：</div>
          <ul className="list-disc list-inside space-y-0.5">
            {rollbackSteps.map((s, idx) => (
              <li key={idx}>{s.description}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-0.5">
        {item.kind === 'append-log' && item.targetNodeId && (
          <button
            type="button"
            onClick={() => onNavigate(item.targetNodeId)}
            title="定位到目标节点"
            className="flex items-center gap-1 px-2 py-1 rounded text-muted-foreground hover:bg-muted transition-colors"
          >
            <MapPin className="w-3 h-3" />
            定位
          </button>
        )}
        <div className="flex-1" />
        {item.kind === 'append-log' && item.targetNodeId && isRolledBack && (
          <span className="text-[10px] text-muted-foreground">段落已移除</span>
        )}
        {!isRolledBack && onRollback && (
          <button
            type="button"
            onClick={onRollback}
            disabled={pending}
            data-testid={`rollback-${item.id}`}
            className="flex items-center gap-1 px-2 py-1 rounded text-muted-foreground hover:bg-amber-50 hover:text-amber-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="撤回（移除已采纳的内容）"
          >
            <Undo2 className="w-3 h-3" />
            {pending ? '撤回中…' : '撤回'}
          </button>
        )}
      </div>
    </div>
  )
}