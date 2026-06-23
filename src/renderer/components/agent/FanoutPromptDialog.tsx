import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { useGraphStore } from '../../store/graphStore'
import { useAppStore } from '../../store/appStore'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const TEMPLATE = `请你为以下节点各派发一个 implement 子代理并行执行:
{NODE_LIST}

要求:对每个节点用 dispatch_subagent 工具发起任务,各任务允许并行,等所有完成后给我汇总。`

export function FanoutPromptDialog({ open, onOpenChange }: Props) {
  const selectedNodeIds = useGraphStore((s) => Array.from(s.selectedNodeIds))
  const singleSelectedNodeId = useGraphStore((s) => s.selectedNodeId)
  const nodes = useGraphStore((s) => s.nodes)
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    if (!open) return
    // Collecting from graphStore.selectedNodeIds supports multi-select.
    // Fall back to selectedNodeId for single-click selection.
    const idSet = new Set<string>(selectedNodeIds)
    if (idSet.size === 0 && singleSelectedNodeId) {
      idSet.add(singleSelectedNodeId)
    }
    const selectedNodes = Array.from(idSet)
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => Boolean(n))

    if (selectedNodes.length === 0) {
      setPrompt(TEMPLATE.replace('{NODE_LIST}', '- (no nodes selected — use Ctrl+click to select multiple)'))
      return
    }
    const lines = selectedNodes.map((n) => {
      const relatedFiles = n.content?.relatedFiles
        ?? n.metadata?.fileAssociations?.map((a) => a.path)
        ?? []
      const filesPart = relatedFiles.length > 0
        ? `, files: ${relatedFiles.slice(0, 5).join(', ')}${relatedFiles.length > 5 ? '…' : ''}`
        : ''
      return `- ${n.title} (${n.id}${filesPart})`
    })
    setPrompt(TEMPLATE.replace('{NODE_LIST}', lines.join('\n')))
  }, [open, selectedNodeIds, singleSelectedNodeId, nodes])

  const handleSubmit = () => {
    useAppStore.getState().setPendingPrompt(prompt)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Fan-out 子代理</DialogTitle>
        </DialogHeader>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="w-full h-48 p-2 border rounded text-sm font-mono resize-y bg-background"
          placeholder="Edit the prompt as needed…"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSubmit}>发送到当前会话</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
