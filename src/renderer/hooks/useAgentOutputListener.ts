import { useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { useMessageStore } from '../store/messageStore'
import { useSubagentStore } from '../store/subagentStore'
import { eventBus, Events } from '../store/eventBus'
import { generateId } from '../lib/utils'
import type { AgentOutput, ChatMessage, ToolCallBlock, ContextRef } from '@shared/types'

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
  const streamingMsgIdRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    streamingMsgIdRef.current = new Map()
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

      store.appendOutput(tid, output, currentThreadId ?? undefined)

      if (output.type === 'error') {
        const msgId = streamingMsgIdRef.current.get(tid)
        if (msgId) {
          store.markMessageStatus(tid, msgId, 'error', {
            code: output.errorCode ?? 'UNKNOWN',
            message: output.data || 'Agent 异常退出',
          })
          streamingMsgIdRef.current.delete(tid)
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
        const msgId = streamingMsgIdRef.current.get(tid)
        if (msgId) {
          store.markMessageStatus(tid, msgId, 'success')
          streamingMsgIdRef.current.delete(tid)
        }
        store.updateThreadStatus(tid, 'idle')
        useAgentStore.getState().persistThreadMessages(tid)
        return
      }

      if (output.type === 'file_change') {
        const filePath = output.filePath
        if (!filePath) return

        let msgId = streamingMsgIdRef.current.get(tid)
        if (!msgId) {
          msgId = generateId('msg')
          streamingMsgIdRef.current.set(tid, msgId)
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
          changeType: output.changeType,
        }

        // Risk-level-based interception
        const { level, reason } = classifyRiskLevel(output)

        if (level === 'high') {
          // Must confirm — emit CONFIRMATION_REQUIRED event
          eventBus.emit(Events.CONFIRMATION_REQUIRED, {
            threadId: tid,
            messageId: msgId,
            toolCall,
            reason,
          })
          // Store in pendingConfirmations
          useMessageStore.getState().addPendingConfirmation(tid, msgId, toolCall)
        } else {
          // Low/medium risk: auto-accept
          store.appendToolCall(tid, msgId, toolCall)
        }

        store.updateThreadStatus(tid, 'running')
        return
      }

      if (output.type === 'stdout') {
        const text = output.data.trim()
        if (!text) return

        let msgId = streamingMsgIdRef.current.get(tid)
        if (!msgId) {
          msgId = generateId('msg')
          streamingMsgIdRef.current.set(tid, msgId)
          store.appendChatMessage(tid, {
            id: msgId,
            role: 'agent',
            content: text,
            timestamp: output.timestamp,
            adapterName,
            status: 'streaming',
          })
        } else {
          store.appendToStreamingMessage(tid, msgId, '\n' + text)
        }
        store.updateThreadStatus(tid, 'running')
        return
      }

      if (output.type === 'progress') {
        let msgId = streamingMsgIdRef.current.get(tid)
        if (!msgId) {
          msgId = generateId('msg')
          streamingMsgIdRef.current.set(tid, msgId)
          store.appendChatMessage(tid, {
            id: msgId,
            role: 'agent',
            content: '',
            timestamp: output.timestamp,
            adapterName,
            status: 'streaming',
            structuredContent: [],
          })
        }
        store.appendStructuredContent(tid, msgId, {
          type: 'progress',
          data: {
            stage: output.stage,
            label: output.progress?.label ?? output.data,
            current: output.progress?.current,
            total: output.progress?.total,
          },
        })
        store.updateThreadStatus(tid, 'running')
        return
      }

      if (output.type === 'thinking') {
        let msgId = streamingMsgIdRef.current.get(tid)
        if (!msgId) {
          msgId = generateId('msg')
          streamingMsgIdRef.current.set(tid, msgId)
          store.appendChatMessage(tid, {
            id: msgId,
            role: 'agent',
            content: '',
            timestamp: output.timestamp,
            adapterName,
            status: 'streaming',
            structuredContent: [],
          })
        }
        store.appendStructuredContent(tid, msgId, {
          type: 'thinking',
          data: { stage: output.stage, data: output.data },
        })
        store.updateThreadStatus(tid, 'running')
        return
      }

      if (output.type === 'tool_call') {
        const toolCall = output.toolCall
        if (!toolCall) return

        let msgId = streamingMsgIdRef.current.get(tid)
        if (!msgId) {
          msgId = generateId('msg')
          streamingMsgIdRef.current.set(tid, msgId)
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
        store.appendToolCall(tid, msgId, toolCall)
        store.updateThreadStatus(tid, 'running')
        return
      }

      if (output.type === 'context_injection') {
        const refs: ContextRef[] = output.contextRefs ?? []
        let msgId = streamingMsgIdRef.current.get(tid)
        if (!msgId) {
          msgId = generateId('msg')
          streamingMsgIdRef.current.set(tid, msgId)
          store.appendChatMessage(tid, {
            id: msgId,
            role: 'system',
            content: output.data,
            timestamp: output.timestamp,
            adapterName,
            status: 'success',
            contextRefs: refs,
            tokenEstimate: output.tokenEstimate,
            structuredContent: [],
          })
        } else {
          store.setMessageContextRefs(tid, msgId, refs, output.tokenEstimate)
        }
        store.appendStructuredContent(tid, msgId, {
          type: 'context_injection',
          data: { contextRefs: refs, tokenEstimate: output.tokenEstimate },
        })
        return
      }

      if (output.type === 'stderr') {
        const msgId = streamingMsgIdRef.current.get(tid)
        if (msgId) {
          store.appendToStreamingMessage(tid, msgId, '\n[stderr] ' + output.data.trim())
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
  }, [currentThreadId])

  return streamingMsgIdRef
}
