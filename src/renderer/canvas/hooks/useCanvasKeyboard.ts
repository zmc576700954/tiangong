import { useEffect } from 'react'

interface UseCanvasKeyboardOptions {
  selectedNodeId: string | null
  selectedEdgeId: string | null
  onDeleteNode: (id: string) => void
  onDeleteEdge: (id: string) => void
  onDeselect: () => void
}

export function useCanvasKeyboard({
  selectedNodeId,
  selectedEdgeId,
  onDeleteNode,
  onDeleteEdge,
  onDeselect,
}: UseCanvasKeyboardOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodeId) {
          onDeleteNode(selectedNodeId)
          onDeselect()
        } else if (selectedEdgeId) {
          onDeleteEdge(selectedEdgeId)
          onDeselect()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedNodeId, selectedEdgeId, onDeleteNode, onDeleteEdge, onDeselect])
}
