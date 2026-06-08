import { useEffect, useRef } from 'react'
import { useAgentStore } from '../store/agentStore'
import { generateId } from '../lib/utils'
import type { AgentOutput } from '@shared/types'

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
