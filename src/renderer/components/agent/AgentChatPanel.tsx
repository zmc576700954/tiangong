import { useState, useEffect } from 'react'
import { Bot } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { useGraphStore } from '../../store/graphStore'
import { ChatHeader } from './ChatHeader'
import { ContextBar } from './ContextBar'
import { ChatMessageList } from './ChatMessageList'
import { ChatInput } from './ChatInput'
import { TerminalView } from './TerminalView'
import { ThreadListOverlay } from './ThreadListOverlay'
import type { ContextRef } from '@shared/types'
import { generatePromptTemplate } from './promptTemplates'

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
    appendChatMessage,
    renameThread,
    deleteThread,
    selectThread,
  } = useAgentStore()

  const [viewMode, setViewMode] = useState<'chat' | 'terminal'>('chat')
  const [showThreadList, setShowThreadList] = useState(false)
  const [selectedAdapter, setSelectedAdapter] = useState('')
  const [attachedContexts, setAttachedContexts] = useState<ContextRef[]>([])

  const currentThread = threads.find((t) => t.id === currentThreadId)
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId)
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

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
      const cleanup = window.electronAPI.onAgentOutput((_sessionId, output) => {
        useAgentStore.getState().appendOutput(_sessionId, output)

        // System signals: update thread status, don't create chat bubbles
        if (output.type === 'complete' || output.type === 'error') {
          if (currentThreadId) {
            useAgentStore.getState().updateThreadStatus(
              currentThreadId,
              output.type === 'error' ? 'error' : 'idle',
            )
          }
          return
        }

        // Only stdout and file_change produce visible chat messages
        if (output.type === 'stdout' || output.type === 'file_change') {
          const text = output.data.trim()
          if (!text) return
          if (currentThreadId) {
            appendChatMessage(currentThreadId, {
              id: `output-${output.timestamp}`,
              role: 'agent',
              content: text,
              timestamp: output.timestamp,
              adapterName: currentThread?.adapterName,
            })
          }
        }
      })
      return cleanup
    }
  }, [currentThreadId, currentThread?.adapterName, appendChatMessage])

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

    if (content.startsWith('/')) {
      const template = generatePromptTemplate(content.trim(), selectedNode, nodes, edges)
      if (template) {
        await sendMessage(threadId, template, contextRefs)
        return
      }
    }

    await sendMessage(threadId, content, contextRefs)
  }

  const handleMentionAdd = (ref: ContextRef) => {
    setAttachedContexts((prev) => {
      if (prev.some((c) => c.id === ref.id)) return prev
      return [...prev, ref]
    })
  }

  const handleRemoveContext = (id: string) => {
    setAttachedContexts((prev) => prev.filter((c) => c.id !== id))
  }

  const currentSession = sessions.find((s) => s.status === 'running')
  const rawOutputs = currentSession?.outputs ?? []

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

      {currentThread && (
        <ContextBar
          contexts={attachedContexts}
          onRemove={handleRemoveContext}
          onAdd={() => {}}
        />
      )}

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
          isRunning={currentThread?.status === 'running'}
          adapterName={currentThread?.adapterName}
        />
      ) : (
        <TerminalView outputs={rawOutputs} />
      )}

      <ChatInput
        onSend={handleSend}
        onMentionAdd={handleMentionAdd}
        disabled={currentThread?.status === 'running'}
        attachedContexts={attachedContexts}
      />
    </div>
  )
}
