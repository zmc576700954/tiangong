import { useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { useMessageStore } from '../store/messageStore'
import { useSubagentStore } from '../store/subagentStore'
import { eventBus, Events } from '../store/eventBus'
import { generateId } from '../lib/utils'
import type { AgentOutput, ChatMessage, ToolCallBlock } from '@shared/types'

// ==================== Risk level classification ====================

/** Risk level for agent file-change operations */
export type RiskLevel = 'high' | 'medium' | 'low'

/** Config file patterns that are considered medium-risk when modified */
const CONFIG_PATTERNS = /\.(json[c]?|yaml|yml|toml|ini|conf|config)$|\/\.?(tsconfig|vite\.config|webpack\.config|rollup\.config|babel\.config|jest\.config|eslint|prettier)\.?/i

/**
 * Classifies a file_change output into a risk level with reason.
 *  - high:   file deletion → must confirm
 *  - medium: config file modification → auto-accept but hint-able
 *  - low:    everything else → auto-accept
 */
export function classifyRiskLevel(output: AgentOutput): { level: RiskLevel; reason: string } {
  // Only file_change outputs are classified
  if (output.type !== 'file_change') {
    return { level: 'low', reason: '' }
  }

  // File deletion is always high-risk
  if (output.changeType === 'delete') {
    return { level: 'high', reason: `File deletion: ${output.filePath ?? 'unknown file'}` }
  }

  // Config file modification is medium-risk
  const filePath = output.filePath ?? ''
  const isEnvFile = /\/\.env(?:\.\w+)?$|^\.env(?:\.\w+)?$/.test(filePath)
  if (filePath && (CONFIG_PATTERNS.test(filePath) || isEnvFile)) {
    return { level: 'medium', reason: `Config file modification: ${filePath}` }
  }

  // Everything else is low-risk
  return { level: 'low', reason: '' }
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
      // Phase 5: subagent outputs carry invocationId — route to subagentStore, bypass main stream
      if (output.invocationId) {
        useSubagentStore.getState().appendOutput(output.invocationId, output)
        return
      }

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
          const msgId = generateId('msg')
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

        // Risk-level-based interception
        const { level, reason } = classifyRiskLevel(output)

        if (level === 'high') {
          // Must confirm — emit CONFIRMATION_REQUIRED event
          eventBus.emit(Events.CONFIRMATION_REQUIRED, {
            threadId: tid,
            messageId: streamingMsgIdRef.current,
            toolCall,
            reason,
          })
          // Store in pendingConfirmations
          useMessageStore.getState().addPendingConfirmation(tid, streamingMsgIdRef.current, toolCall)
        } else if (level === 'medium') {
          // Auto-accept but could show hint (for now just accept)
          store.appendToolCall(tid, streamingMsgIdRef.current!, toolCall)
        } else {
          // Low risk: auto-accept
          store.appendToolCall(tid, streamingMsgIdRef.current!, toolCall)
        }

        store.updateThreadStatus(tid, 'running')
        return
      }

      if (output.type === 'stdout') {
        const text = output.data.trim()
        if (!text) return

        if (!streamingMsgIdRef.current) {
          const msgId = generateId('msg')
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
        return
      }

      if (output.type === 'system') {
        const systemMsg: ChatMessage = {
          id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'system',
          content: output.data,
          timestamp: output.timestamp,
          status: 'success',
        }
        store.appendChatMessage(tid, systemMsg)
        return
      }
    })

    let progressCleanup: (() => void) | undefined
    if (window.electronAPI?.onSubagentProgress) {
      progressCleanup = window.electronAPI.onSubagentProgress((data) => {
        useSubagentStore.getState().applyProgress(data)
      })
    }

    return () => {
      cleanup()
      progressCleanup?.()
    }
  }, [])

  return streamingMsgIdRef
}
