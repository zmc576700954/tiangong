import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { Bot, GitBranch, AlertTriangle, Loader2 } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { useAgentOutputStore } from '../../store/agentOutputStore'
import { useGraphStore } from '../../store/graphStore'
import { useAppStore } from '../../store/appStore'
import { useSessionStore } from '../../store/sessionStore'
import { useAdapterStore } from '../../store/adapterStore'
import { getReadonlySupport } from '@shared/readonly-support'
import { toProjectRelative, fromProjectRelative } from '../../lib/project-paths'
import { ScopeEditor } from './ScopeEditor'
import { useSubagentStore } from '../../store/subagentStore'
import { useAgentOutputListener } from '../../hooks/useAgentOutputListener'
import { useVerificationFlow } from '../../hooks/useVerificationFlow'
import { useDiffReview } from '../../hooks/useDiffReview'
import { useWaterline } from '../../hooks/useWaterline'
import { ChatHeader } from './ChatHeader'
import { ConfirmationDialog } from './ConfirmationDialog'
import { ContextBar } from './ContextBar'
import { ChatMessageList } from './ChatMessageList'
import { ChatInput } from './ChatInput'
import { TerminalView } from './TerminalView'
import { ThreadListSidebar } from './ThreadListSidebar'
import { ContextPickerPopup } from './ContextPickerPopup'
import { HistorySidebar } from './HistorySidebar'
import { AdapterSetupGuide } from './AdapterSetupGuide'
import { SubagentInvocationsPanel } from './SubagentInvocationsPanel'
import { eventBus, Events } from '../../store/eventBus'
import { threadTitle as localizeThreadTitle } from '@shared/i18n'
import { useI18n } from '../../i18n/useI18n'
import { toastError } from '../../lib/toast'
import { errorText } from '../../lib/error-text'
import type { ContextRef, AgentSessionConfig } from '@shared/types'

const DiffReviewPanel = lazy(() => import('./DiffReviewPanel').then(m => ({ default: m.DiffReviewPanel })))
const VerificationPanel = lazy(() => import('./VerificationPanel').then(m => ({ default: m.VerificationPanel })))

const LazyFallback = () => (
  <div className="flex items-center justify-center p-4">
    <div className="h-6 w-48 animate-pulse rounded bg-muted" />
  </div>
)

interface AgentChatPanelProps {
  expanded: boolean
  onToggleExpand: () => void
}

export function AgentChatPanel({ expanded, onToggleExpand }: AgentChatPanelProps) {
  const { locale, t } = useI18n()
  const adapters = useAgentStore((s) => s.adapters)
  const threads = useAgentStore((s) => s.threads)
  const currentThreadId = useAgentStore((s) => s.currentThreadId)
  const threadOutputs = useAgentOutputStore((s) => s.threadOutputs)
  const lastFallbackHistory = useAgentStore((s) => s.lastFallbackHistory)
  const marketplaceItems = useAgentStore((s) => s.marketplaceItems)
  const loadAdapters = useAgentStore((s) => s.loadAdapters)
  const loadMarketplaceItems = useAgentStore((s) => s.loadMarketplaceItems)
  const setOpenSettingsPanel = useAgentStore((s) => s.setOpenSettingsPanel)
  const createThread = useAgentStore((s) => s.createThread)
  const sendMessage = useAgentStore((s) => s.sendMessage)
  const stopCurrentSession = useAgentStore((s) => s.stopCurrentSession)
  const retryMessage = useAgentStore((s) => s.retryMessage)
  const renameThread = useAgentStore((s) => s.renameThread)
  const deleteThread = useAgentStore((s) => s.deleteThread)
  const selectThread = useAgentStore((s) => s.selectThread)

  const [viewMode, setViewMode] = useState<'chat' | 'terminal'>('chat')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showContextPicker, setShowContextPicker] = useState(false)
  const [selectedAdapter, setSelectedAdapter] = useState('auto')
  const [attachedContexts, setAttachedContexts] = useState<ContextRef[]>([])
  const [showResumePrompt, setShowResumePrompt] = useState(false)
  const [recoveredFlash, setRecoveredFlash] = useState(false)
  const [showSubagentPanel, setShowSubagentPanel] = useState(false)
  const subagentInvocations = useSubagentStore((s) => s.invocations)
  const activeSubagentCount = useMemo(
    () => subagentInvocations.filter((i) => i.status === 'queued' || i.status === 'running').length,
    [subagentInvocations],
  )
  // Derived data — must be declared before useVerificationFlow
  const currentThread = useMemo(() => threads.find((t) => t.id === currentThreadId), [threads, currentThreadId])
  const noAdaptersInstalled = adapters.length > 0 && adapters.every((a) => !a.installed)

  const selectedNodeId = useGraphStore((s) => s.selectedNodeId)
  const nodes = useGraphStore((s) => s.nodes)
  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

  const graphs = useGraphStore((s) => s.graphs)
  const currentGraphId = useGraphStore((s) => s.currentGraphId)
  const currentGraph = graphs.find((g) => g.id === currentGraphId)
  const projectPath = currentGraph?.projectPath

  const requestStatuses = useSessionStore((s) => s.requestStatuses)
  const queuedCount = useMemo(() => Array.from(requestStatuses.values()).filter((r) => r.status === 'queued').length, [requestStatuses])
  const executingCount = useMemo(() => Array.from(requestStatuses.values()).filter((r) => r.status === 'executing').length, [requestStatuses])

  // —— 文件范围（只读默认）——
  const projectDefaults = useSessionStore((s) => s.projectDefaults)
  const loadProjectDefaults = useSessionStore((s) => s.loadProjectDefaults)
  const saveProjectDefaults = useSessionStore((s) => s.saveProjectDefaults)
  const [sessionScope, setSessionScope] = useState<string[]>([])

  // 切项目 / 切图 → 重载项目级默认
  useEffect(() => {
    void loadProjectDefaults(projectPath ?? '')
  }, [projectPath, loadProjectDefaults])

  // 生效范围 = 项目级默认 ∪ 本次会话显式加的
  const scopeEffectiveFiles = useMemo(() => {
    const fromProject = (projectDefaults?.allowedFiles ?? []).map((rel) =>
      fromProjectRelative(projectPath ?? '', rel),
    )
    return [...new Set([...fromProject, ...sessionScope])]
  }, [projectDefaults, sessionScope, projectPath])

  // 范围为空 ⇒ 只读（与主进程 resolveReadonly 同一套语义）
  const scopeReadonly = scopeEffectiveFiles.length === 0
  // 'auto' 实际指向默认适配器 —— 别硬编码 claude-code（用户可以在设置里改默认）
  const adapterPreferences = useAdapterStore((s) => s.adapterPreferences)
  const scopeAdapterSupportsReadonly = getReadonlySupport(
    selectedAdapter === 'auto'
      ? adapterPreferences.defaultAdapter
      : selectedAdapter,
  ) === 'enforced'

  const handleScopeAddFile = (relPath: string) => {
    setSessionScope((prev) => [...new Set([...prev, relPath])])
    // 同时写进项目级默认 → 下次自动带上（用户不必每次重选）
    void saveProjectDefaults({
      ...projectDefaults,
      allowedFiles: [...new Set([...(projectDefaults?.allowedFiles ?? []), relPath])],
    })
  }

  const handleScopeRemoveFile = (file: string) => {
    setSessionScope((prev) => prev.filter((f) => f !== file))
    const rel = toProjectRelative(projectPath ?? '', file)
    void saveProjectDefaults({
      ...projectDefaults,
      allowedFiles: (projectDefaults?.allowedFiles ?? []).filter((f) => f !== rel),
    })
  }

  const handleScopeClearAll = () => {
    setSessionScope([])
    // 清掉项目级默认 → 下一次会话回到只读（否则用户会以为「我明明关了它又开了」）
    void saveProjectDefaults({ ...projectDefaults, allowedFiles: [] })
  }

  const rawOutputs = useMemo(
    () => (currentThread ? (threadOutputs[currentThread.id] ?? []) : []),
    [currentThread, threadOutputs],
  )

  // Hooks for separated concerns
  const streamingMsgIdRef = useAgentOutputListener(currentThreadId)
  const waterlineState = useWaterline(currentThreadId)
  const {
    showVerification,
    verificationReport,
    verifying,
    verifyError,
    retryCount,
    pendingRetryRef,
    setRetryCount,
    startVerification,
    resetVerification,
  } = useVerificationFlow(
    currentThread,
    selectedNode,
    rawOutputs,
    projectPath,
  )
  const {
    showDiffReview,
    committing,
    commitError,
    setShowDiffReview,
    setCommitting,
    setCommitError,
    handleAcceptFile,
    handleRejectFile,
    handleAcceptAll,
    handleRejectAll,
  } = useDiffReview()

  // Resize state for message area / input area split
  const [inputAreaHeight, setInputAreaHeight] = useState(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('agentChatInputHeight') : null
    return saved ? parseInt(saved, 10) : 120
  })
  const [isResizingChat, setIsResizingChat] = useState(false)
  const [hasResized, setHasResized] = useState(false)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const lastResizeHeightRef = useRef(0)

  const handleResizeChat = useCallback((e: MouseEvent) => {
    if (!chatContainerRef.current) return
    const rect = chatContainerRef.current.getBoundingClientRect()
    const totalHeight = rect.height
    const bottomY = rect.bottom
    const maxInputHeight = Math.floor(totalHeight * 0.7)
    const newInputHeight = Math.max(60, Math.min(maxInputHeight, bottomY - e.clientY))
    setInputAreaHeight(newInputHeight)
    setHasResized(true)
    lastResizeHeightRef.current = newInputHeight
  }, [])

  useEffect(() => {
    if (!isResizingChat) return
    const onMove = (e: MouseEvent) => handleResizeChat(e)
    const onUp = () => {
      setIsResizingChat(false)
      if (lastResizeHeightRef.current > 0) {
        localStorage.setItem('agentChatInputHeight', String(lastResizeHeightRef.current))
      }
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('mouseup', onUp, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isResizingChat, handleResizeChat])

  const pendingContextRef = useAppStore((s) => s.pendingContextRef)
  const setPendingContextRef = useAppStore((s) => s.setPendingContextRef)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      loadAdapters()
    }
  }, [loadAdapters])

  useEffect(() => {
    const installed = adapters.filter((a) => a.installed)
    if (installed.length > 0 && !selectedAdapter) {
      setSelectedAdapter('auto')
    }
  }, [adapters, selectedAdapter])

  // Listen for agent status changes to sync node status
  useEffect(() => {
    const cleanup1 = useAgentStore.getState().listenForStatusChanges()
    const cleanup2 = useSessionStore.getState().listenForNodeStatusChanges()
    return () => {
      cleanup1?.()
      cleanup2?.()
    }
  }, [])

  // Auto-recovery flash when adapter recovers from degradation
  useEffect(() => {
    const unsub = eventBus.on(Events.ADAPTER_RECOVERED, () => {
      setRecoveredFlash(true)
      setTimeout(() => setRecoveredFlash(false), 2000)
    })
    return unsub
  }, [])

  // Consume pendingContextRef from file tree right-click
  useEffect(() => {
    if (!pendingContextRef) return

    setAttachedContexts((prev) => {
      if (prev.some((c) => c.id === pendingContextRef.id)) return prev
      return [...prev, pendingContextRef]
    })

    if (!currentThreadId && selectedAdapter) {
      createThread(selectedAdapter, selectedNode?.id)
    }

    setPendingContextRef(null)
  }, [pendingContextRef, setPendingContextRef, currentThreadId, selectedAdapter, createThread, selectedNode])

  // Check for interrupted session when switching threads
  useEffect(() => {
    if (currentThreadId) {
      const hasInterrupted = useSessionStore.getState().hasInterruptedSession(currentThreadId)
      setShowResumePrompt(hasInterrupted)
    } else {
      setShowResumePrompt(false)
    }
  }, [currentThreadId])

  // Consume pendingPrompt from mindmap dev prompt generation
  const pendingPrompt = useAppStore((s) => s.pendingPrompt)
  const setPendingPrompt = useAppStore((s) => s.setPendingPrompt)
  const pendingPromptRef = useRef<string | null>(null)

  useEffect(() => {
    if (!pendingPrompt) return
    pendingPromptRef.current = pendingPrompt
    setPendingPrompt(null)
    if (!currentThreadId && selectedAdapter) {
      createThread(selectedAdapter, selectedNode?.id)
    }
  }, [pendingPrompt, setPendingPrompt, currentThreadId, selectedAdapter, createThread, selectedNode])

  const handleNewThread = () => {
    if (!selectedAdapter) return
    createThread(selectedAdapter, selectedNode?.id)
    if (selectedNode) {
      setAttachedContexts([
        { type: 'node', id: selectedNode.id, label: selectedNode.title },
      ])
    }
  }

  const handleSend = async (content: string, contextRefs: ContextRef[]) => {
    // 用户**主动**选了一个不保证只读的适配器 + 范围为空 → 发送前二次确认。
    // 注意与回退链那处的语义区别：回退链那处是**直接拒绝**（不能把写权限
    // 在用户不知情的情况下交出去）；这里是用户自己选的，给一次确认机会。
    if (scopeReadonly && !scopeAdapterSupportsReadonly) {
      const ok = window.confirm(t('agent.scope.confirmWritable'))
      if (!ok) return
    }

    let threadId = currentThreadId
    if (!threadId) {
      threadId = createThread(selectedAdapter, selectedNode?.id)
    }

    const projectPath = currentGraph?.projectPath ?? ''
    // 范围 = 项目级默认 ∪ 本次会话显式引用的文件
    // （项目级默认存的是**相对项目根**的相对路径；引用给的是绝对路径 → 统一成绝对）
    const projectFiles = (projectDefaults?.allowedFiles ?? []).map((rel) =>
      fromProjectRelative(projectPath, rel),
    )
    const refFiles = contextRefs.filter((r) => r.type === 'file').map((r) => r.id)
    const allowedFiles = [...new Set([...projectFiles, ...refFiles])]

    const sessionConfig: AgentSessionConfig = {
      workingDirectory: projectPath,
      allowedFiles,
      forbiddenFiles: [],
      invariantRules: selectedNode?.rules?.map((r) => r.title) ?? [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: selectedNode?.title ?? '',
      nodeId: selectedNode?.id,
      acceptanceCriteria: selectedNode?.acceptanceCriteria ?? [],
    }

    if (currentThreadId) streamingMsgIdRef.current.delete(currentThreadId)
    await sendMessage(threadId, content, contextRefs, sessionConfig)
  }

  const handleStop = async () => {
    if (currentThreadId) {
      streamingMsgIdRef.current.delete(currentThreadId)
      await stopCurrentSession(currentThreadId)
    }
  }

  const handleResumeFromInterrupt = async () => {
    if (!currentThreadId) return
    const snapshot = useSessionStore.getState().loadSnapshot(currentThreadId)
    if (!snapshot) {
      setShowResumePrompt(false)
      return
    }

    // Build context message from snapshot
    const lastMessages = snapshot.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n')
    const filesSummary = snapshot.filesChanged.length > 0
      ? `Files changed: ${snapshot.filesChanged.join(', ')}`
      : 'No files were changed'
    const resumeContent = `Continuing from previous session. Last activity:\n${filesSummary}\n\nRecent messages:\n${lastMessages}`

    // Clear the snapshot and hide prompt
    useSessionStore.getState().clearSnapshot(currentThreadId)
    setShowResumePrompt(false)

    // Send resume message
    await handleSend(resumeContent, attachedContexts)
  }

  const handleRetry = async (agentMessageId: string) => {
    if (currentThreadId) {
      streamingMsgIdRef.current.delete(currentThreadId)
      await retryMessage(currentThreadId, agentMessageId)
    }
  }

  const handleMentionAdd = (ref: ContextRef) => {
    setAttachedContexts((prev) => {
      if (prev.some((c) => c.id === ref.id)) return prev
      return [...prev, ref]
    })
    if (!currentThreadId && selectedAdapter) {
      createThread(selectedAdapter, selectedNode?.id)
    }
  }

  const handleRemoveContext = (id: string) => {
    setAttachedContexts((prev) => prev.filter((c) => c.id !== id))
  }

  const handleContextPickerSelect = (ref: ContextRef) => {
    setAttachedContexts((prev) => {
      if (prev.some((c) => c.id === ref.id)) return prev
      return [...prev, ref]
    })
    setShowContextPicker(false)
  }

  const handleCompact = useCallback(async () => {
    if (!currentThread?.sessionId) return
    try {
      const result = await window.electronAPI['context:compactNow'](currentThread.sessionId)
      console.log('[Compact] success', result)
    } catch (err) {
      console.error('[Compact] failed', err)
    }
  }, [currentThread?.sessionId])

  const isRunning = currentThread?.status === 'running'
  const isDegraded = currentThread?.fallbackInfo != null
  const originalAdapter = currentThread?.fallbackInfo?.originalAdapter ?? ''
  const currentAdapter = currentThread?.adapterName ?? ''

  const currentOperation = useMemo(() => {
    const fileChanges = rawOutputs.filter((o) => o.type === 'file_change')
    const last = fileChanges[fileChanges.length - 1]
    return last?.filePath ? `${t('agent.running.editingVerb')} ${last.filePath}` : undefined
  }, [rawOutputs, t])

  return (
    <div className="h-full flex flex-col relative" ref={chatContainerRef}>
      <ChatHeader
        adapterName={selectedAdapter}
        adapters={adapters}
        threadTitle={currentThread ? localizeThreadTitle(currentThread.title, locale) : t('thread.defaultTitle')}
        viewMode={viewMode}
        expanded={expanded}
        fallbackHistory={lastFallbackHistory}
        noAdaptersInstalled={noAdaptersInstalled}
        onSelectAdapter={setSelectedAdapter}
        onNewThread={handleNewThread}
        onToggleThreads={() => setSidebarCollapsed((c) => !c)}
        onToggleView={setViewMode}
        onToggleExpand={onToggleExpand}
        onOpenHistory={() => setShowHistory(true)}
        onOpenSettings={() => setOpenSettingsPanel(true)}
        waterlineState={waterlineState}
        onCompact={handleCompact}
        activeSubagentCount={activeSubagentCount}
        onOpenSubagents={() => setShowSubagentPanel(true)}
      />

      <div className="flex-1 min-h-0 flex">
        <ThreadListSidebar
          threads={threads}
          currentThreadId={currentThreadId}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
          onSelect={selectThread}
          onNewThread={handleNewThread}
          onDelete={deleteThread}
          onRename={renameThread}
        />

        <div className="flex-1 min-h-0 flex flex-col">
          <div className="relative">
            <ContextBar
              contexts={attachedContexts}
              onRemove={handleRemoveContext}
              onAdd={() => setShowContextPicker((v) => !v)}
            />
        {showContextPicker && (
          <ContextPickerPopup
            onSelect={handleContextPickerSelect}
            onClose={() => setShowContextPicker(false)}
            excludeIds={attachedContexts.filter((c) => c.type === 'node').map((c) => c.id)}
          />
        )}
      </div>

      {!currentThread && threads.length === 0 ? (
        noAdaptersInstalled ? (
          <AdapterSetupGuide
            items={marketplaceItems}
            onOpenSettings={() => setOpenSettingsPanel(true)}
            onRefresh={async () => {
              await loadAdapters()
              await loadMarketplaceItems()
            }}
            onInstallCli={async (name: string) => {
              if (!window.electronAPI) return { success: false, message: t('agent.install.unavailable') }
              const result = await window.electronAPI['settings:installCli'](name)
              if (result.success) {
                await loadAdapters()
                await loadMarketplaceItems()
              }
              return result
            }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-center px-6">
            <div>
              <Bot className="w-10 h-10 mx-auto mb-3 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground mb-1">{t('agent.welcome.title')}</p>
              <p className="text-xs text-muted-foreground/60">
                {t('agent.welcome.hint')}
              </p>
            </div>
          </div>
        )
      ) : (
        <>
          {/* Message area with flex-1 */}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {/* Resume banner */}
            {currentThread?.sessionId && currentThread?.adapterName === 'claude-code' && currentThread?.status === 'idle' && (
              <div className="px-3 py-2 bg-blue-50 dark:bg-blue-950 text-sm flex items-center justify-between border-b border-blue-200 dark:border-blue-800 shrink-0">
                <span className="text-blue-700 dark:text-blue-300 text-xs">{t('agent.resume.canContinue')}</span>
                <button
                  onClick={() => {
                    const lastUserMsg = currentThread.messages.filter((m) => m.role === 'user').pop()
                    if (lastUserMsg) {
                      sendMessage(currentThread.id, lastUserMsg.content)
                    }
                  }}
                  className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 transition-colors"
                >
                  {t('agent.resume.action')}
                </button>
              </div>
            )}
            {/* Interrupt recovery prompt */}
            {showResumePrompt && (
              <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 dark:bg-blue-950 border-b border-blue-200 dark:border-blue-800 text-sm shrink-0">
                <span className="text-blue-700 dark:text-blue-300 text-xs">{t('agent.resume.interrupted')}</span>
                <button
                  onClick={handleResumeFromInterrupt}
                  className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 transition-colors"
                >
                  {t('agent.resume.action')}
                </button>
                <button
                  onClick={() => setShowResumePrompt(false)}
                  className="px-3 py-1 bg-gray-200 dark:bg-gray-700 rounded text-xs hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                >
                  {t('agent.resume.dismiss')}
                </button>
              </div>
            )}
            {/* Degradation banner */}
            {isDegraded && (
              <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200 mx-3 mt-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{t('agent.degraded.notice', { from: originalAdapter, to: currentAdapter })}</span>
                <button
                  onClick={() => {
                    eventBus.emit(Events.OPEN_ADAPTER_SELECTOR)
                  }}
                  className="text-[10px] px-2 py-0.5 rounded border border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900 ml-2"
                >
                  {t('agent.degraded.switchAdapter')}
                </button>
              </div>
            )}
            {/* Auto-recovery flash banner */}
            {recoveredFlash && (
              <div className="bg-green-100 dark:bg-green-900 border border-green-300 dark:border-green-700 rounded px-3 py-1 text-xs text-green-700 dark:text-green-300 animate-fade-out-3s mx-3 mt-2">
                {t('agent.adapter.recovered')}
              </div>
            )}
            <ConfirmationDialog />
            {viewMode === 'chat' ? (
              <>
                {isRunning && currentThread?.messages?.length === 0 && (
                  <div className="flex items-center gap-2 px-4 py-3">
                    <div className="h-4 w-48 animate-pulse rounded bg-muted" />
                    <span className="text-sm text-muted-foreground">{t('agent.thinkingBanner')}</span>
                  </div>
                )}
                <ChatMessageList
                messages={currentThread?.messages ?? []}
                isRunning={!!isRunning}
                adapterName={currentThread?.adapterName}
                onRetry={handleRetry}
                currentOperation={currentOperation}
              />
              </>
            ) : (
              <TerminalView outputs={rawOutputs} />
            )}
          </div>

          {/* Review Changes button */}
          {currentThread?.status === 'idle' &&
            rawOutputs.some((o) => o.type === 'file_change') &&
            !showDiffReview && (
              <div className="px-3 py-2 shrink-0">
                <button
                  onClick={() => setShowDiffReview(true)}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600/10 border border-blue-600/30
                    rounded-lg text-sm text-blue-400 hover:bg-blue-600/20 transition-colors"
                >
                  <GitBranch className="w-4 h-4" />
                  {t('agent.review.changes')}
                </button>
              </div>
          )}

          {/* Diff Review Panel */}
          {showDiffReview && currentThread && (
            <div className="shrink-0 px-3 py-2">
              {commitError && (
                <div className="mb-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
                  {commitError}
                </div>
              )}
              <Suspense fallback={<LazyFallback />}>
              <DiffReviewPanel
                toolCalls={
                  currentThread.messages
                    .filter((m) => m.role === 'agent')
                    .flatMap((m) => m.toolCalls ?? [])
                }
                sessionId={currentThread.sessionId}
                committing={committing}
                onAcceptFile={(index) => handleAcceptFile(currentThread.id, 0, index)}
                onRejectFile={(index, filePath) => handleRejectFile(currentThread.id, 0, index, filePath, currentThread.sessionId)}
                onAcceptAll={() => handleAcceptAll(currentThread.id)}
                onRejectAll={() => handleRejectAll(currentThread.id, currentThread.sessionId)}
                onCommit={async () => {
                  setCommitting(true)
                  setCommitError(null)
                  try {
                    if (currentThread.sessionId) {
                      await window.electronAPI['scopeGuard:commitSession'](currentThread.sessionId)
                    }
                    useAgentStore.getState().updateThreadStatus(currentThread.id, 'reviewed')
                    setShowDiffReview(false)

                    if (selectedNode?.acceptanceCriteria && selectedNode.acceptanceCriteria.length > 0) {
                      await startVerification({
                        nodeId: selectedNode.id,
                        acceptanceCriteria: selectedNode.acceptanceCriteria,
                        messages: currentThread.messages,
                        fileChanges: rawOutputs.filter((o) => o.type === 'file_change'),
                        workingDirectory: projectPath ?? '',
                      })
                    }
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : t('agent.commit.failed')
                    console.error('[DiffReview] Commit failed:', err)
                    setCommitError(msg)
                  } finally {
                    setCommitting(false)
                  }
                }}
              />
              </Suspense>
            </div>
          )}

          {/* Verification Panel */}
          {showVerification && (
            <div className="shrink-0 px-3 py-2">
              <Suspense fallback={<LazyFallback />}>
              <VerificationPanel
                report={verificationReport}
                loading={verifying}
                currentRetry={retryCount}
                error={verifyError}
                onRetryFailed={() => {
                  if (!verificationReport) return
                  const failedResults = verificationReport.results.filter((r) => !r.passed)
                  setRetryCount((c) => c + 1)
                  const retryPrompt = `Fix the following unmet criteria:\n${failedResults.map((r, i) => `${i + 1}. ${r.criterion}\n   Issue: ${r.justification}`).join('\n')}`
                  pendingRetryRef.current = true
                  resetVerification()
                  handleSend(retryPrompt, attachedContexts)
                }}
                onMarkComplete={() => {
                  if (selectedNode) {
                    // 状态推进失败要说出来 —— 否则界面回到「编辑中」，用户以为没生效
                    void useGraphStore.getState()
                      .updateNode(selectedNode.id, { status: 'review' })
                      .catch((err: unknown) => {
                        toastError(t('node.toast.updateFailed'), errorText(err))
                      })
                  }
                  resetVerification()
                  setRetryCount(0)
                  pendingRetryRef.current = false
                }}
                onBackToEdit={resetVerification}
              />
              </Suspense>
            </div>
          )}

          {/* Resize handle */}
          <div
            className="h-1.5 cursor-row-resize hover:bg-primary/30 transition-colors shrink-0 flex items-center justify-center"
            onMouseDown={(e) => {
              e.preventDefault()
              setIsResizingChat(true)
            }}
          >
            <div className="w-8 h-0.5 rounded-full bg-border" />
          </div>
        </>
      )}

      {(queuedCount > 0 || executingCount > 0) && (
        <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-muted-foreground border-b border-border">
          {queuedCount > 0 && <span>{t('agent.queue.queued', { count: queuedCount })}</span>}
          {executingCount > 0 && <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" />{t('agent.queue.executing', { count: executingCount })}</span>}
        </div>
      )}

      <ScopeEditor
        effectiveFiles={scopeEffectiveFiles}
        readonly={scopeReadonly}
        adapterSupportsReadonly={scopeAdapterSupportsReadonly}
        onAddFile={handleScopeAddFile}
        onRemoveFile={handleScopeRemoveFile}
        onClearAll={handleScopeClearAll}
      />

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onMentionAdd={handleMentionAdd}
        disabled={!!isRunning}
        isRunning={!!isRunning}
        attachedContexts={attachedContexts}
        projectPath={projectPath}
        selectedNode={selectedNode}
        containerHeight={hasResized ? inputAreaHeight : undefined}
        initialPrompt={pendingPromptRef.current}
        onPromptConsumed={() => { pendingPromptRef.current = null }}
        threadId={currentThreadId ?? undefined}
      />

      </div>
    </div>

    <HistorySidebar visible={showHistory} onClose={() => setShowHistory(false)} />

      <SubagentInvocationsPanel
        open={showSubagentPanel}
        onOpenChange={setShowSubagentPanel}
        parentSessionId={currentThread?.sessionId ?? null}
      />
    </div>
  )
}