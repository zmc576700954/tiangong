import { useEffect } from 'react'

interface UseCanvasKeyboardOptions {
  selectedNodeId: string | null
  selectedEdgeId: string | null
  onDeleteNode: (id: string) => void
  onDeleteEdge: (id: string) => void
  onDeselect: () => void
  /** 连线模式下按 Esc 取消 */
  isConnecting?: boolean
  onCancelConnect?: () => void
  /** 请求删除确认（若提供，则不再直接删除） */
  onRequestDeleteConfirm?: (target: 'node' | 'edge') => void
}

export function useCanvasKeyboard({
  selectedNodeId,
  selectedEdgeId,
  onDeleteNode,
  onDeleteEdge,
  onDeselect,
  isConnecting,
  onCancelConnect,
  onRequestDeleteConfirm,
}: UseCanvasKeyboardOptions): { clearConfirmPending: () => void } {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Esc 取消连线模式或取消选中
      if (e.key === 'Escape') {
        if (isConnecting && onCancelConnect) {
          onCancelConnect()
        } else {
          onDeselect()
        }
        return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 文本输入中不响应删除键
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
        // 连线模式下不响应删除键
        if (isConnecting) return
        if (selectedNodeId) {
          if (onRequestDeleteConfirm) {
            onRequestDeleteConfirm('node')
          } else {
            onDeleteNode(selectedNodeId)
            onDeselect()
          }
        } else if (selectedEdgeId) {
          if (onRequestDeleteConfirm) {
            onRequestDeleteConfirm('edge')
          } else {
            onDeleteEdge(selectedEdgeId)
            onDeselect()
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedNodeId, selectedEdgeId, onDeleteNode, onDeleteEdge, onDeselect, isConnecting, onCancelConnect, onRequestDeleteConfirm])

  return { clearConfirmPending: () => {} }
}
