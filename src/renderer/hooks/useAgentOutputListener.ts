import { useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { useMessageStore } from '../store/messageStore'
import { eventBus, Events } from '../store/eventBus'
import { generateId } from '../lib/utils'
import type { AgentOutput, ToolCallBlock } from '@shared/types'

// ==================== High-risk operation detection ====================

/** Config file patterns that are considered high-risk when modified */
const CONFIG_PATTERNS = [
  /\.env(\.|$)/i,
  /\.config\.(js|ts|mjs|cjs|json|yaml|yml)$/i,
  /\/\.?(prettierrc|eslintrc|tsconfig|babelrc|jest\.config|vite\.config|webpack\.config)/i,
  /\/\.?(npmrc|nvmrc|node-version|editorconfig|gitignore)/i,
  /\/(package\.json|docker-compose|Dockerfile|Makefile|Cargo\.toml|go\.mod)/i,
  /\/(settings\.json|launch\.json|extensions\.json)/i,
]

/**
 * Returns true if a file_change output is considered high-risk.
 * High-risk conditions:
 *  1. File deletion (changeType === 'delete')
 *  2. Config file modification (matches known config patterns)
 *  3. Future: >5 file changes in one session (tracked externally)
 */
export function isHighRiskOperation(output: AgentOutput): boolean {
  if (output.type !== 'file_change') return false

  // File deletion is always high-risk
  if (output.changeType === 'delete') return true

  // Config file modification is high-risk
  const filePath = output.filePath ?? ''
  if (CONFIG_PATTERNS.some((pat) => pat.test(filePath))) return true

  return false
}

/**
 * Returns a human-readable reason string explaining why the operation is high-risk.
 */
export function classifyRisk(output: AgentOutput): string {
  if (output.type !== 'file_change') return ''

  if (output.changeType === 'delete') {
    return `File deletion: ${output.filePath ?? 'unknown file'}`
  }

  const filePath = output.filePath ?? ''
  if (CONFIG_PATTERNS.some((pat) => pat.test(filePath))) {
    return `Config file modification: ${filePath}`
  }

  return 'Unknown high-risk operation'
}

// ==================== Hook ====================

/**
 * IPC 输出 → store 的副作用 hook
 * 监听 agent:output IPC 事件，将输出路由到正确的 thread 和 message
 */
export function useAgentOutputListener(currentThreadId: string | null) {
  const streamingMsgIdRef = useRef<string | null>(null)

  // Reset streaming ref when thread changes
  useEffect(() => {
    streamingMsgIdRef.current = null
  }, [currentThreadId])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onAgentOutput) return

    const cleanup = window.electronAPI.onAgentOutput((_sessionId: string, output: AgentOutput) => {
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

        const toolCall: ToolCallBlock = {
          type: output.changeType === 'add' ? 'file_create' : 'file_edit',
          filePath,
          content: output.data,
          status: 'done',
        }

        // High-risk operation interception
        const isHighRisk = isHighRiskOperation(output)
        if (isHighRisk) {
          // Emit CONFIRMATION_REQUIRED event instead of auto-accepting
          eventBus.emit(Events.CONFIRMATION_REQUIRED, {
            threadId: tid,
            messageId: streamingMsgIdRef.current,
            toolCall,
            reason: classifyRisk(output),
          })
          // Store in pendingConfirmations
          useMessageStore.getState().addPendingConfirmation(tid, streamingMsgIdRef.current, toolCall)
        } else {
          // Auto-accept low-risk operations as before
          store.appendToolCall(tid, streamingMsgIdRef.current!, toolCall)
        }

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
          store.appendToStreamingMessage(tid, streamingMsgIdRef.current, '\n' + text)
        }
        store.updateThreadStatus(tid, 'running')
        return
      }

      if (output.type === 'stderr') {
        if (streamingMsgIdRef.current) {
          store.appendToStreamingMessage(tid, streamingMsgIdRef.current, '\n[stderr] ' + output.data.trim())
        }
      }
    })

    return cleanup
  }, [currentThreadId])

  return streamingMsgIdRef
}
