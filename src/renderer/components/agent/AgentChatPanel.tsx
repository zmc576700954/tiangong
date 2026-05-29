import { useState, useEffect, useRef } from 'react'
import { Bot } from 'lucide-react'
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
import type { ContextRef, AgentSessionConfig, AgentOutput } from '@shared/types'
import { generatePromptTemplate } from './promptTemplates'
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
    sessions,
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
  const [showContextPicker, setShowContextPicker] = useState(false)
  const [selectedAdapter, setSelectedAdapter] = useState('')
  const [attachedContexts, setAttachedContexts] = useState<ContextRef[]>([])

  // Track the current streaming agent message ID within this render cycle
  const streamingMsgIdRef = useRef<string | null>(null)

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
        useAgentStore.getState().appendOutput(_sessionId, output)
        const tid = useAgentStore.getState().currentThreadId
        if (!tid) return

        const store = useAgentStore.getState()
        const thread = store.threads.find((t) => t.id === tid)
        const adapterName = thread?.adapterName

        if (output.type === 'error') {
          // If there's a current streaming message, mark it as error
          if (streamingMsgIdRef.current) {
            store.markMessageStatus(tid, streamingMsgIdRef.current, 'error', {
              code: output.errorCode ?? 'UNKNOWN',
              message: output.data || 'Agent 异常退出',
            })
            streamingMsgIdRef.current = null
          } else {
            // No streaming message — create a new error message
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
          return
        }

        if (output.type === 'stdout' || output.type === 'file_change') {
          const text = output.data.trim()
          if (!text) return

          if (!streamingMsgIdRef.current) {
            // Create a new streaming agent message
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
            // Append content to existing streaming message
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
          // Append stderr to current streaming message as warning text
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
      acceptanceCriteria: selectedNode?.acceptanceCriteria ?? [],
    }

    if (content.startsWith('/')) {
      const template = generatePromptTemplate(content.trim(), selectedNode)
      if (template) {
        await sendMessage(threadId, template, contextRefs, sessionConfig)
        return
      }
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

  const currentSession = sessions.find((s) => s.status === 'running')
  const rawOutputs = currentSession?.outputs ?? []
  const isRunning = currentThread?.status === 'running'

  return (
    <div className="h-full flex flex-col relative">
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
      ) : viewMode === 'chat' ? (
        <ChatMessageList
          messages={currentThread?.messages ?? []}
          isRunning={!!isRunning}
          adapterName={currentThread?.adapterName}
          onRetry={handleRetry}
        />
      ) : (
        <TerminalView outputs={rawOutputs} />
      )}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onMentionAdd={handleMentionAdd}
        disabled={!!isRunning}
        isRunning={!!isRunning}
        attachedContexts={attachedContexts}
        projectPath={projectPath}
      />
    </div>
  )
}
