import { useEffect, useState } from 'react'
import {
  Pencil,
  Settings,
  Terminal,
} from 'lucide-react'
import { useGraphStore } from '../store/graphStore'
import { useAppStore } from '../store/appStore'
import { cn } from '../lib/utils'
import { AgentChatPanel } from '../components/agent/AgentChatPanel'
import { NodeEditor } from './NodeEditor'
import { EdgeEditor } from './EdgeEditor'

export function RightPanel({
  expandedAgent,
  onToggleExpand,
}: {
  expandedAgent?: boolean
  onToggleExpand?: () => void
}) {
  const {
    selectedNodeId,
    selectedEdgeId,
    nodes,
    edges,
    updateNode,
    updateEdge,
    deleteNode,
    deleteEdge,
    selectNode,
    selectEdge,
  } = useGraphStore()

  const [activeTab, setActiveTab] = useState<'node' | 'agent'>('node')

  const activeRightPanel = useAppStore((s) => s.activeRightPanel)
  const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)

  // Sync external tab switching from appStore (e.g., from file tree context menu)
  useEffect(() => {
    if (activeRightPanel === 'agent' && activeTab !== 'agent') {
      setActiveTab('agent')
      // Reset store signal so it doesn't keep overriding manual tab clicks
      setActiveRightPanel('node')
    }
  }, [activeRightPanel, activeTab, setActiveRightPanel])

  const selectedNode = nodes.find((n) => n.id === selectedNodeId)
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId)

  // 注意：不再自动切换 tab。用户选择节点后，需要手动点击 'node' tab 查看详情。
  // 这避免覆盖用户的显式 tab 选择。

  return (
    <div className="h-full flex flex-col border-l bg-background">
      {/* Tab switching */}
      <div className="h-10 border-b flex items-center px-2 gap-1 shrink-0">
        <button
          onClick={() => setActiveTab('node')}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors',
            activeTab === 'node'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted',
          )}
        >
          <Pencil className="w-3.5 h-3.5" />
          Node
        </button>
        <button
          onClick={() => setActiveTab('agent')}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors',
            activeTab === 'agent'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted',
          )}
        >
          <Terminal className="w-3.5 h-3.5" />
          Agent
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'node' && (
          <>
            {selectedNode ? (
              <NodeEditor
                node={selectedNode}
                onUpdate={(data) => updateNode(selectedNode.id, data)}
                onDelete={() => {
                  deleteNode(selectedNode.id)
                  selectNode(null)
                }}
                onStartAgent={() => setActiveTab('agent')}
              />
            ) : selectedEdge ? (
              <EdgeEditor
                edge={selectedEdge}
                nodes={nodes}
                onUpdate={(data) => updateEdge(selectedEdge.id, data)}
                onDelete={() => {
                  deleteEdge(selectedEdge.id)
                  selectEdge(null)
                }}
              />
            ) : (
              <div className="text-center text-muted-foreground text-sm py-12 px-4">
                <Settings className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>Select a node or edge on the canvas</p>
                <p className="text-xs mt-1">to edit properties</p>
              </div>
            )}
          </>
        )}

        {activeTab === 'agent' && (
          <AgentChatPanel
            expanded={expandedAgent ?? false}
            onToggleExpand={onToggleExpand ?? (() => {})}
          />
        )}
      </div>
    </div>
  )
}
