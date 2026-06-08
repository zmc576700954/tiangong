import { useState } from 'react'
import { useAgentStore } from '../store/agentStore'

interface DiffReviewReturn {
  showDiffReview: boolean
  committing: boolean
  commitError: string | null
  setShowDiffReview: (v: boolean) => void
  setCommitting: (v: boolean) => void
  setCommitError: (e: string | null) => void
  handleAcceptFile: (threadId: string, messageIndex: number, fileIndex: number) => void
  handleRejectFile: (threadId: string, messageIndex: number, fileIndex: number, filePath: string, sessionId?: string) => Promise<void>
  handleAcceptAll: (threadId: string) => void
  handleRejectAll: (threadId: string, sessionId?: string) => Promise<void>
}

/**
 * 提交/回滚/接受状态 hook
 * 管理 DiffReview 面板的显示和文件操作
 */
export function useDiffReview(): DiffReviewReturn {
  const [showDiffReview, setShowDiffReview] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const updateToolCallAccepted = useAgentStore((s) => s.updateToolCallAccepted)
  const updateAllToolCallsAccepted = useAgentStore((s) => s.updateAllToolCallsAccepted)

  const handleAcceptFile = (threadId: string, messageIndex: number, fileIndex: number) => {
    updateToolCallAccepted(threadId, messageIndex, fileIndex, true)
  }

  const handleRejectFile = async (threadId: string, messageIndex: number, fileIndex: number, filePath: string, sessionId?: string) => {
    updateToolCallAccepted(threadId, messageIndex, fileIndex, false)
    if (sessionId) {
      try {
        await window.electronAPI['scopeGuard:rollbackFile'](sessionId, filePath)
      } catch (err) {
        console.error('[DiffReview] Failed to rollback file:', err)
      }
    }
  }

  const handleAcceptAll = (threadId: string) => {
    updateAllToolCallsAccepted(threadId, true)
  }

  const handleRejectAll = async (threadId: string, sessionId?: string) => {
    updateAllToolCallsAccepted(threadId, false)
    if (sessionId) {
      try {
        await window.electronAPI['scopeGuard:rollbackSession'](sessionId)
      } catch (err) {
        console.error('[DiffReview] Failed to rollback session:', err)
      }
    }
  }

  return {
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
  }
}