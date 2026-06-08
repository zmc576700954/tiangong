import { useState, useEffect, useRef, useCallback, type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { AgentOutput, VerificationReport, ChatMessage } from '@shared/types'

interface VerificationFlowReturn {
  showVerification: boolean
  verificationReport: VerificationReport | null
  verifying: boolean
  verifyError: string | null
  retryCount: number
  pendingRetryRef: RefObject<boolean>
  setShowVerification: (v: boolean) => void
  setVerificationReport: (r: VerificationReport | null) => void
  setVerifying: (v: boolean) => void
  setVerifyError: (e: string | null) => void
  setRetryCount: Dispatch<SetStateAction<number>>
  startVerification: (params: {
    nodeId: string
    acceptanceCriteria: string[]
    messages: ChatMessage[]
    fileChanges: AgentOutput[]
    workingDirectory: string
  }) => Promise<void>
  resetVerification: () => void
}

/**
 * 验证/重试状态机 hook
 * 管理验证面板的显示、结果、错误和重试逻辑
 */
export function useVerificationFlow(
  currentThread: { id: string; status: string; messages: ChatMessage[] } | undefined,
  selectedNode: { id: string; acceptanceCriteria?: string[] } | undefined,
  rawOutputs: AgentOutput[],
  projectPath: string | undefined,
): VerificationFlowReturn {
  const [showVerification, setShowVerification] = useState(false)
  const [verificationReport, setVerificationReport] = useState<VerificationReport | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const pendingRetryRef = useRef(false)
  const messagesRef = useRef(currentThread?.messages)
  messagesRef.current = currentThread?.messages

  const startVerification = useCallback(async (params: {
    nodeId: string
    acceptanceCriteria: string[]
    messages: ChatMessage[]
    fileChanges: AgentOutput[]
    workingDirectory: string
  }) => {
    setShowVerification(true)
    setVerifying(true)
    setVerifyError(null)
    try {
      const report = await window.electronAPI['agent:verify']({
        nodeId: params.nodeId,
        acceptanceCriteria: params.acceptanceCriteria,
        messages: params.messages,
        fileChanges: params.fileChanges,
        workingDirectory: params.workingDirectory,
      })
      setVerificationReport(report)
    } catch (err) {
      console.error('[Verification] Failed:', err)
      setVerifyError('Verification failed. Please try again manually.')
    } finally {
      setVerifying(false)
    }
  }, [])

  const resetVerification = useCallback(() => {
    setShowVerification(false)
    setVerificationReport(null)
    setVerifyError(null)
  }, [])

  // Auto-retrigger verification after retry completes (agent idle + pendingRetry)
  useEffect(() => {
    if (!pendingRetryRef.current) return
    if (currentThread?.status !== 'idle') return
    if (!selectedNode?.acceptanceCriteria || selectedNode.acceptanceCriteria.length === 0) return

    pendingRetryRef.current = false

    startVerification({
      nodeId: selectedNode.id,
      acceptanceCriteria: selectedNode.acceptanceCriteria,
      messages: messagesRef.current ?? [],
      fileChanges: rawOutputs.filter((o) => o.type === 'file_change'),
      workingDirectory: projectPath ?? '',
    }).catch((err) => {
      console.error('[Verification] Auto-retrigger failed:', err)
      setVerifyError('Verification failed. Please try again manually.')
    })
  }, [currentThread?.status, selectedNode, rawOutputs, projectPath, startVerification])

  return {
    showVerification,
    verificationReport,
    verifying,
    verifyError,
    retryCount,
    pendingRetryRef,
    setShowVerification,
    setVerificationReport,
    setVerifying,
    setVerifyError,
    setRetryCount,
    startVerification,
    resetVerification,
  }
}