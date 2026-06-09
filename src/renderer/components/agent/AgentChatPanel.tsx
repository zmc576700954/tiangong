import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Bot, GitBranch } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { useGraphStore } from '../../store/graphStore'
import { useAppStore } from '../../store/appStore'
import { useAgentOutputListener } from '../../hooks/useAgentOutputListener'
import { useVerificationFlow } from '../../hooks/useVerificationFlow'
import { useDiffReview } from '../../hooks/useDiffReview'
import { ChatHeader } from './ChatHeader'
import { ContextBar } from './ContextBar'
import { ChatMessageList } from './ChatMessageList'
import { ChatInput } from './ChatInput'
import { TerminalView } from './TerminalView'
import { ThreadListOverlay } from './ThreadListOverlay'
import { ContextPickerPopup } from './ContextPickerPopup'
import { HistorySidebar } from './HistorySidebar'
import { DiffReviewPanel } from './DiffReviewPanel'
import { VerificationPanel } from './VerificationPanel'
import type { ContextRef, AgentSessionConfig } from '@shared/types'

interface AgentChatPanelProps {
  expanded: boolean
  onToggleExpand: () => void
}

export function AgentChatPanel({ expanded, onToggleExpand }: AgentChatPanelProps) {
  const {
    adapters,
    threads,
    currentThreadId,
    threadOutputs,
    lastFallbackHistory,
    loadAdapters,
    createThread,
    sendMessage,
    stopCurrentSession,
    retryMessage,
    renameThread,
    deleteThread,
    selectThread,
  } = useAgentStore()

  const [viewMode, setViewMode] = useState<'chat' | 'terminal'>('chat')
  const [showThreadList, setShowThreadList] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showContextPicker, setShowContextPicker] = useState(false)
  const [selectedAdapter, setSelectedAdapter] = useState('auto')
  const [attachedContexts, setAttachedContexts] = useState<ContextRef[]>([])

  // Derived data — must be declared before useVerificationFlow
  const currentThread = threads.find((t) => t.id === currentThreadId)

  const selectedNodeId = useGraphStore((s) => s.selectedNodeId)
  const nodes = useGraphStore((s) => s.nodes)
  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

  const graphs = useGraphStore((s) => s.graphs)
  const currentGraphId = useGraphStore((s) => s.currentGraphId)
  const currentGraph = graphs.find((g) => g.id === currentGraphId)
  const projectPath = currentGraph?.projectPath

  const rawOutputs = useMemo(
    () => (currentThread ? (threadOutputs[currentThread.id] ?? []) : []),
    [currentThread?.id, threadOutputs],
  )

  // Hooks for separated concerns
  const streamingMsgIdRef = useAgentOutputListener(currentThreadId)
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

  const handleResizeChat = useCallback((e: MouseEvent) => {
    if (!chatContainerRef.current) return
    const rect = chatContainerRef.current.getBoundingClientRect()
    const totalHeight = rect.height
    const bottomY = rect.bottom
    const maxInputHeight = Math.floor(totalHeight * 0.7)
    const newInputHeight = Math.max(60, Math.min(maxInputHeight, bottomY - e.clientY))
    setInputAreaHeight(newInputHeight)
    setHasResized(true)
    localStorage.setItem('agentChatInputHeight', String(newInputHeight))
  }, [])

  useEffect(() => {
    if (!isResizingChat) return
    const onMove = (e: MouseEvent) => handleResizeChat(e)
    const onUp = () => setIsResizingChat(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
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
    const cleanup = useAgentStore.getState().listenForStatusChanges()
    return cleanup
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
    let threadId = currentThreadId
    if (!threadId) {
      threadId = createThread(selectedAdapter, selectedNode?.id)
    }

    const sessionConfig: AgentSessionConfig = {
      workingDirectory: currentGraph?.projectPath ?? '',
      allowedFiles: contextRefs.filter((r) => r.type === 'file').map((r) => r.id),
      forbiddenFiles: [],
      invariantRules: selectedNode?.rules?.map((r) => r.title) ?? [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: selectedNode?.title ?? '',
      nodeId: selectedNode?.id,
      acceptanceCriteria: selectedNode?.acceptanceCriteria ?? [],
    }

    streamingMsgIdRef.current = null
    await sendMessage(threadId, content, contextRefs, sessionConfig)
  }

  const handleStop = async () => {
    if (currentThreadId) {
      streamingMsgIdRef.current = null
      await stopCurrentSession(currentThreadId)
    }
  }

  const handleRetry = async (agentMessageId: string) => {
    if (currentThreadId) {
      streamingMsgIdRef.current = null
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

  const isRunning = currentThread?.status === 'running'

  const currentOperation = useMemo(() => {
    const fileChanges = rawOutputs.filter((o) => o.type === 'file_change')
    const last = fileChanges[fileChanges.length - 1]
    return last?.filePath ? `is editing ${last.filePath}` : undefined
  }, [rawOutputs])

  return (
    <div className="h-full flex flex-col relative" ref={chatContainerRef}>
      <ChatHeader
        adapterName={selectedAdapter}
        adapters={adapters}
        threadTitle={currentThread?.title ?? 'New Thread'}
        viewMode={viewMode}
        expanded={expanded}
        fallbackHistory={lastFallbackHistory}
        onSelectAdapter={setSelectedAdapter}
        onNewThread={handleNewThread}
        onToggleThreads={() => setShowThreadList(!showThreadList)}
        onToggleView={setViewMode}
        onToggleExpand={onToggleExpand}
        onOpenHistory={() => setShowHistory(true)}
      />

      {showThreadList && (
        <ThreadListOverlay
          threads={threads}
          currentThreadId={currentThreadId}
          onSelect={(id) => { selectThread(id); setShowThreadList(false) }}
          onDelete={deleteThread}
          onRename={renameThread}
          onClose={() => setShowThreadList(false)}
        />
      )}

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
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <Bot className="w-10 h-10 mx-auto mb-3 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground mb-1">Welcome to Agent</p>
            <p className="text-xs text-muted-foreground/60">
              Type a message below to start a new conversation
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Message area with flex-1 */}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {/* Resume banner */}
            {currentThread?.sessionId && currentThread?.adapterName === 'claude-code' && currentThread?.status === 'idle' && (
              <div className="px-3 py-2 bg-blue-50 dark:bg-blue-950 text-sm flex items-center justify-between border-b border-blue-200 dark:border-blue-800 shrink-0">
                <span className="text-blue-700 dark:text-blue-300 text-xs">This session can be continued</span>
                <button
                  onClick={() => {
                    const lastUserMsg = currentThread.messages.filter((m) => m.role === 'user').pop()
                    if (lastUserMsg) {
                      sendMessage(currentThread.id, lastUserMsg.content)
                    }
                  }}
                  className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 transition-colors"
                >
                  Resume
                </button>
              </div>
            )}
            {viewMode === 'chat' ? (
              <ChatMessageList
                messages={currentThread?.messages ?? []}
                isRunning={!!isRunning}
                adapterName={currentThread?.adapterName}
                onRetry={handleRetry}
                currentOperation={currentOperation}
              />
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
                  Review Changes
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
                    const msg = err instanceof Error ? err.message : 'Commit failed'
                    console.error('[DiffReview] Commit failed:', err)
                    setCommitError(msg)
                  } finally {
                    setCommitting(false)
                  }
                }}
              />
            </div>
          )}

          {/* Verification Panel */}
          {showVerification && (
            <div className="shrink-0 px-3 py-2">
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
                    useGraphStore.getState().updateNode(selectedNode.id, { status: 'review' })
                  }
                  resetVerification()
                  setRetryCount(0)
                  pendingRetryRef.current = false
                }}
                onBackToEdit={resetVerification}
              />
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
      />

      <HistorySidebar visible={showHistory} onClose={() => setShowHistory(false)} />
    </div>
  )
}