import { useState } from 'react'
import { Plus, List, Maximize2, Minimize2, ChevronDown, Terminal, MessageSquare, Clock, Zap, AlertCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useI18n } from '../../i18n/useI18n'
import type { AdapterFallbackAttempt, ContextState } from '@shared/types'
import type { ResidualRisk, SessionGrantInfo } from '@shared/types/agent-runtime'
import { ContextWaterlineBar } from './ContextWaterlineBar'

interface ChatHeaderProps {
  adapterName: string
  adapters: { name: string; installed: boolean }[]
  threadTitle: string
  viewMode: 'chat' | 'terminal'
  expanded: boolean
  fallbackHistory?: AdapterFallbackAttempt[]
  noAdaptersInstalled?: boolean
  onSelectAdapter: (name: string) => void
  onNewThread: () => void
  onToggleThreads: () => void
  onToggleView: (mode: 'chat' | 'terminal') => void
  onToggleExpand: () => void
  onOpenCli?: () => void
  onOpenHistory?: () => void
  onOpenSettings?: () => void
  waterlineState?: ContextState | null
  onCompact?: () => void
  activeSubagentCount?: number
  onOpenSubagents?: () => void
  /** 会话级残留状态（none 不展示；possible/unconfirmed 展示徽标） */
  residualRisk?: ResidualRisk
  recoveryNote?: string | null
  /** A2：当前会话的写操作授权（存在即展示徽标，可手动撤销） */
  sessionGrant?: SessionGrantInfo | null
  onRevokeSessionGrant?: () => void
  /** M1：打开用量视图（会话级 + 图级按日） */
  onOpenUsage?: () => void
}

export function ChatHeader({
  adapterName,
  adapters,
  threadTitle,
  viewMode,
  expanded,
  fallbackHistory,
  noAdaptersInstalled,
  onSelectAdapter,
  onNewThread,
  onToggleThreads,
  onToggleView,
  onToggleExpand,
  onOpenCli,
  onOpenHistory,
  onOpenSettings,
  waterlineState,
  onCompact,
  activeSubagentCount,
  onOpenSubagents,
  residualRisk,
  recoveryNote,
  sessionGrant,
  onRevokeSessionGrant,
  onOpenUsage,
}: ChatHeaderProps) {
  const { t } = useI18n()
  const [showAdapterMenu, setShowAdapterMenu] = useState(false)

  // 回退指示器：显示从哪个适配器回退到了哪个
  const fallbackInfo = fallbackHistory && fallbackHistory.length > 1
    ? fallbackHistory.filter((f) => !f.success).map((f) => f.adapter).join(' → ') +
      ' → ' +
      fallbackHistory.find((f) => f.success)?.adapter
    : null

  return (
    <div className="shrink-0 border-b border-border bg-muted/30">
      <div className="flex items-center justify-between px-2.5 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative">
          <button
            onClick={() => setShowAdapterMenu(!showAdapterMenu)}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md hover:bg-muted transition-colors"
          >
            {adapterName === 'auto' ? (
              noAdaptersInstalled ? (
                <AlertCircle className="w-3 h-3 text-red-400" />
              ) : (
                <Zap className="w-3 h-3 text-amber-400" />
              )
            ) : (
              <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            )}
            <span className="truncate max-w-[80px]">{adapterName === 'auto' ? t('agent.adapter.auto') : adapterName || t('agent.adapter.select')}</span>
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          </button>
          {showAdapterMenu && (
            <div className="absolute top-full left-0 mt-1 bg-background border border-border rounded-lg shadow-lg z-50 overflow-hidden min-w-[140px]">
              {/* Auto 选项 */}
              <button
                onClick={() => { onSelectAdapter('auto'); setShowAdapterMenu(false) }}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-2 text-xs hover:bg-muted transition-colors text-left',
                  adapterName === 'auto' && 'bg-muted',
                )}
              >
                <Zap className="w-3 h-3 text-amber-400" />
                {t('agent.adapter.auto')}
                <span className="text-[10px] text-muted-foreground ml-auto">{t('agent.adapter.default')}</span>
              </button>
              {adapters.map((a) => (
                <button
                  key={a.name}
                  onClick={() => {
                    if (a.installed) {
                      onSelectAdapter(a.name)
                    } else {
                      onOpenSettings?.()
                    }
                    setShowAdapterMenu(false)
                  }}
                  className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-2 text-xs hover:bg-muted transition-colors text-left',
                    adapterName === a.name && 'bg-muted',
                    !a.installed && 'opacity-50',
                  )}
                >
                  <div className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    a.installed ? 'bg-green-400' : 'bg-muted-foreground/30',
                  )} />
                  {a.name}
                  {!a.installed && (
                    <span className="text-[10px] text-muted-foreground ml-auto">{t('agent.adapter.notInstalled')}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* 回退指示器 */}
        {fallbackInfo && (
          <span className="text-[10px] text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded" title={fallbackInfo}>
            {fallbackInfo}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground truncate max-w-[120px]">
          {threadTitle}
        </span>
        {residualRisk && residualRisk !== 'none' && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 border border-amber-500/30 whitespace-nowrap"
            title={recoveryNote ?? undefined}
            data-testid="session-residual-risk"
          >
            {t(residualRisk === 'possible' ? 'agent.residualRisk.possible' : 'agent.residualRisk.unconfirmed')}
          </span>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        <button
          onClick={onNewThread}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground"
          title={t('thread.newThread')}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onToggleThreads}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground"
          title={t('agent.header.threads')}
        >
          <List className="w-3.5 h-3.5" />
        </button>
        {onOpenSubagents && (
          <button
            className="relative w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground text-xs"
            onClick={onOpenSubagents}
            title={t('agent.header.subagents')}
            data-testid="chat-header-subagents-btn"
          >
            <span aria-hidden>🤖</span>
            {activeSubagentCount !== undefined && activeSubagentCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground rounded-full text-[9px] min-w-[16px] h-4 px-1 flex items-center justify-center">
                {activeSubagentCount}
              </span>
            )}
          </button>
        )}
        {onOpenUsage && (
          <button
            className="h-6 px-1.5 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground text-[10px]"
            onClick={onOpenUsage}
            title={t('agent.usage.open')}
            data-testid="chat-header-usage-btn"
          >
            {t('agent.usage.open')}
          </button>
        )}
        {onOpenHistory && (
          <button
            onClick={onOpenHistory}
            className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground"
            title={t('agent.header.history')}
          >
            <Clock className="w-3.5 h-3.5" />
          </button>
        )}
        {onOpenCli && (
          <button
            onClick={onOpenCli}
            className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground"
            title={t('agent.header.openInCli')}
          >
            <Terminal className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="flex bg-muted rounded overflow-hidden ml-1">
          <button
            onClick={() => onToggleView('chat')}
            className={cn(
              'px-1.5 py-0.5 text-[10px] transition-colors',
              viewMode === 'chat' ? 'bg-background text-foreground' : 'text-muted-foreground',
            )}
          >
            <MessageSquare className="w-3 h-3" />
          </button>
          <button
            onClick={() => onToggleView('terminal')}
            className={cn(
              'px-1.5 py-0.5 text-[10px] transition-colors',
              viewMode === 'terminal' ? 'bg-background text-foreground' : 'text-muted-foreground',
            )}
          >
            <Terminal className="w-3 h-3" />
          </button>
        </div>
        <button
          onClick={onToggleExpand}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground ml-1"
          title={expanded ? t('agent.header.collapse') : t('agent.header.expand')}
        >
          {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>
      </div>

      {/* A2：会话级授权必须始终可见（窄面板下也不能被挤出屏幕），并提供撤销入口 */}
      {sessionGrant && (
        <div
          className="flex items-center justify-between gap-2 px-2.5 py-1 border-t border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-600"
          title={`grant: ${sessionGrant.approvalId}`}
          data-testid="session-grant-badge"
        >
          <span className="truncate">{t('agent.sessionGrant.badge')}</span>
          {onRevokeSessionGrant && (
            <button
              type="button"
              onClick={onRevokeSessionGrant}
              className="underline hover:text-emerald-800 dark:hover:text-emerald-300 shrink-0"
              data-testid="session-grant-revoke"
            >
              {t('agent.sessionGrant.revoke')}
            </button>
          )}
        </div>
      )}

      <ContextWaterlineBar state={waterlineState ?? null} onCompact={onCompact} />
    </div>
  )
}
