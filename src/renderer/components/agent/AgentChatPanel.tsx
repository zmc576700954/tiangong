import { useState, useEffect, useRef, useCallback } from 'react'
import { Bot, GitBranch } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { useGraphStore } from '../../store/graphStore'
import { useAppStore } from '../../store/appStore'
import { ChatHeader } from './ChatHeader'
import { ContextBar } from './ContextBar'
import { ChatMessageList } from './ChatMessageList'
import { ChatInput } from './ChatInput'
import { TerminalView } from './TerminalView'
import { ThreadListOverlay } from './ThreadListOverlay'
import { ContextPickerPopup } from './ContextPickerPopup'
import { HistorySidebar } from './HistorySidebar'
import { DiffReviewPanel } from './DiffReviewPanel'
import type { ContextRef, AgentSessionConfig, AgentOutput } from '@shared/types'
import { generateId } from '../../lib/utils'

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
  const [selectedAdapter, setSelectedAdapter] = useState('')
  const [attachedContexts, setAttachedContexts] = useState<ContextRef[]>([])
  const [showDiffReview, setShowDiffReview] = useState(false)
  const [committing, setCommitting] = useState(false)

  // Track the current streaming agent message ID within this render cycle
  const streamingMsgIdRef = useRef<string | null>(null)

  // Resize state for message area / input area split
  const [inputAreaHeight, setInputAreaHeight] = useState(120)
  const [isResizingChat, setIsResizingChat] = useState(false)
  const [hasResized, setHasResized] = useState(false)
  const chatContainerRef = useRef<HTMLDivElement>(null)

  const handleResizeChat = useCallback((e: MouseEvent) => {
    if (!chatContainerRef.current) return
    const rect = chatContainerRef.current.getBoundingClientRect()
    const totalHeight = rect.height
    const bottomY = rect.bottom
    // Input area can occupy up to 70% of total chat height
    const maxInputHeight = Math.floor(totalHeight * 0.7)
    const newInputHeight = Math.max(60, Math.min(maxInputHeight, bottomY - e.clientY))
    setInputAreaHeight(newInputHeight)
    setHasResized(true)
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

  const currentThread = threads.find((t) => t.id === currentThreadId)
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId)
  const nodes = useGraphStore((s) => s.nodes)
  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

  const pendingContextRef = useAppStore((s) => s.pendingContextRef)
  const setPendingContextRef = useAppStore((s) => s.setPendingContextRef)

  const graphs = useGraphStore((s) => s.graphs)
  const currentGraphId = useGraphStore((s) => s.currentGraphId)
  const currentGraph = graphs.find((g) => g.id === currentGraphId)
  const projectPath = currentGraph?.projectPath

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      loadAdapters()
    }
  }, [loadAdapters])

  useEffect(() => {
    const installed = adapters.filter((a) => a.installed)
    if (installed.length > 0 && !selectedAdapter) {
      setSelectedAdapter(installed[0].name)
    }
  }, [adapters, selectedAdapter])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI?.onAgentOutput) {
      const cleanup = window.electronAPI.onAgentOutput((_sessionId: string, output: AgentOutput) => {
        // 通过 sessionId 找到对应的 thread，记录输出
        const store = useAgentStore.getState()
        const ownerThread = store.findThreadBySessionId(_sessionId)
        if (!ownerThread) return
        const tid = ownerThread.id
        const adapterName = ownerThread.adapterName

        store.appendOutput(tid, output)

        if (output.type === 'error') {
          if (streamingMsgIdRef.current) {
            store.markMessageStatus(tid, streamingMsgIdRef.current, 'error', {
              code: output.errorCode ?? 'UNKNOWN',
              message: output.data || 'Agent 异常退出',
            })
            streamingMsgIdRef.current = null
          } else {
            store.appendChatMessage(tid, {
              id: generateId('msg'),
              role: 'agent',
              content: '',
              timestamp: output.timestamp,
              adapterName,
              status: 'error',
              error: {
                code: output.errorCode ?? 'UNKNOWN',
                message: output.data || 'Agent 异常退出',
              },
            })
          }
          store.updateThreadStatus(tid, 'error')
          return
        }

        if (output.type === 'complete') {
          if (streamingMsgIdRef.current) {
            store.markMessageStatus(tid, streamingMsgIdRef.current, 'success')
            streamingMsgIdRef.current = null
          }
          store.updateThreadStatus(tid, 'idle')
          useAgentStore.getState().persistThreadMessages(tid)
          return
        }

        if (output.type === 'file_change') {
          const filePath = output.filePath
          if (!filePath) return

          // Ensure streaming message exists
          if (!streamingMsgIdRef.current) {
            const msgId = `output-${output.timestamp}`
            streamingMsgIdRef.current = msgId
            store.appendChatMessage(tid, {
              id: msgId,
              role: 'agent',
              content: '',
              timestamp: output.timestamp,
              adapterName,
              status: 'streaming',
              toolCalls: [],
            })
          }

          // Construct ToolCallBlock from file_change output
          const toolCall: import('@shared/types').ToolCallBlock = {
            type: output.changeType === 'add' ? 'file_create' : 'file_edit',
            filePath,
            content: output.data,
            status: 'done',
          }

          store.appendToolCall(tid, streamingMsgIdRef.current!, toolCall)
          store.updateThreadStatus(tid, 'running')
          return
        }

        if (output.type === 'stdout') {
          const text = output.data.trim()
          if (!text) return

          if (!streamingMsgIdRef.current) {
            const msgId = `output-${output.timestamp}`
            streamingMsgIdRef.current = msgId
            store.appendChatMessage(tid, {
              id: msgId,
              role: 'agent',
              content: text,
              timestamp: output.timestamp,
              adapterName,
              status: 'streaming',
            })
          } else {
            const thread = useAgentStore.getState().threads.find((t) => t.id === tid)
            const existingMsg = thread?.messages.find((m) => m.id === streamingMsgIdRef.current)
            if (existingMsg) {
              useAgentStore.setState({
                threads: useAgentStore.getState().threads.map((t) =>
                  t.id === tid
                    ? {
                        ...t,
                        messages: t.messages.map((m) =>
                          m.id === streamingMsgIdRef.current
                            ? { ...m, content: m.content + '\n' + text }
                            : m,
                        ),
                      }
                    : t,
                ),
              })
            }
          }
          store.updateThreadStatus(tid, 'running')
          return
        }

        if (output.type === 'stderr') {
          if (streamingMsgIdRef.current) {
            const thread = useAgentStore.getState().threads.find((t) => t.id === tid)
            const existingMsg = thread?.messages.find((m) => m.id === streamingMsgIdRef.current)
            if (existingMsg) {
              useAgentStore.setState({
                threads: useAgentStore.getState().threads.map((t) =>
                  t.id === tid
                    ? {
                        ...t,
                        messages: t.messages.map((m) =>
                          m.id === streamingMsgIdRef.current
                            ? { ...m, content: m.content + '\n[stderr] ' + output.data.trim() }
                            : m,
                        ),
                      }
                    : t,
                ),
              })
            }
          }
        }
      })
      return cleanup
    }
  }, [currentThreadId])

  // Reset streaming ref when thread changes
  useEffect(() => {
    streamingMsgIdRef.current = null
  }, [currentThreadId])

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

    // Auto-create a thread if none exists — ContextBar only renders when currentThread is set
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

    // 从当前选中节点构建完整的会话配置
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
    // Auto-create thread if none exists, so ContextBar is visible and send works
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

  const rawOutputs = currentThread ? (threadOutputs.get(currentThread.id) ?? []) : []
  const isRunning = currentThread?.status === 'running'

  return (
    <div className="h-full flex flex-col relative" ref={chatContainerRef}>
      <ChatHeader
        adapterName={selectedAdapter}
        adapters={adapters}
        threadTitle={currentThread?.title ?? 'New Thread'}
        viewMode={viewMode}
        expanded={expanded}
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
              <div className="px-3 py-2 bg-blue-50 dark:bg-blue-950 text-sm flex items-center justify-between border-b border-blue-200 dark:border-blue-800 flex-shrink-0">
                <span className="text-blue-700 dark:text-blue-300 text-xs">This session can be continued</span>
                <button
                  onClick={() => {
                    // 恢复会话：重新发送最后一条用户消息以触发 Agent 续接
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
              />
            ) : (
              <TerminalView outputs={rawOutputs} />
            )}
          </div>

          {/* Review Changes button */}
          {currentThread?.status === 'idle' &&
            rawOutputs.some((o) => o.type === 'file_change') &&
            !showDiffReview && (
              <div className="px-3 py-2 flex-shrink-0">
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
            <div className="flex-shrink-0 px-3 py-2">
              <DiffReviewPanel
                toolCalls={
                  currentThread.messages
                    .filter((m) => m.role === 'agent')
                    .flatMap((m) => m.toolCalls ?? [])
                }
                sessionId={currentThread.sessionId}
                committing={committing}
                onAcceptFile={(index) => {
                  const allToolCalls = currentThread.messages
                    .filter((m) => m.role === 'agent')
                    .flatMap((m) => m.toolCalls ?? [])
                  const tc = allToolCalls[index]
                  if (tc) tc.accepted = true
                  useAgentStore.setState({ threads: [...useAgentStore.getState().threads] })
                }}
                onRejectFile={async (index, filePath) => {
                  const allToolCalls = currentThread.messages
                    .filter((m) => m.role === 'agent')
                    .flatMap((m) => m.toolCalls ?? [])
                  const tc = allToolCalls[index]
                  if (tc) tc.accepted = false
                  if (currentThread.sessionId) {
                    try {
                      await window.electronAPI['scopeGuard:rollbackFile'](currentThread.sessionId, filePath)
                    } catch (err) {
                      console.error('[DiffReview] Failed to rollback file:', err)
                    }
                  }
                  useAgentStore.setState({ threads: [...useAgentStore.getState().threads] })
                }}
                onAcceptAll={() => {
                  currentThread.messages
                    .filter((m) => m.role === 'agent')
                    .forEach((m) => m.toolCalls?.forEach((tc) => { tc.accepted = true }))
                  useAgentStore.setState({ threads: [...useAgentStore.getState().threads] })
                }}
                onRejectAll={async () => {
                  currentThread.messages
                    .filter((m) => m.role === 'agent')
                    .forEach((m) => m.toolCalls?.forEach((tc) => { tc.accepted = false }))
                  if (currentThread.sessionId) {
                    try {
                      await window.electronAPI['scopeGuard:commitSession'](currentThread.sessionId)
                    } catch (err) {
                      console.error('[DiffReview] Failed to reject all:', err)
                    }
                  }
                  useAgentStore.setState({ threads: [...useAgentStore.getState().threads] })
                }}
                onCommit={async () => {
                  setCommitting(true)
                  try {
                    if (currentThread.sessionId) {
                      await window.electronAPI['scopeGuard:commitSession'](currentThread.sessionId)
                    }
                    useAgentStore.getState().updateThreadStatus(currentThread.id, 'reviewed')
                    setShowDiffReview(false)
                  } catch (err) {
                    console.error('[DiffReview] Commit failed:', err)
                  } finally {
                    setCommitting(false)
                  }
                }}
              />
            </div>
          )}

          {/* Resize handle */}
          <div
            className="h-1.5 cursor-row-resize hover:bg-primary/30 transition-colors flex-shrink-0 flex items-center justify-center"
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
