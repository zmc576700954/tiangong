import { useEffect, useState } from 'react'
import {
  Pencil,
  Settings,
  Terminal,
  PanelRightClose,
} from 'lucide-react'
import { useGraphStore } from '../store/graphStore'
import { useAppStore } from '../store/appStore'
import { eventBus, Events } from '../store/eventBus'
import { cn } from '../lib/utils'
import { AgentChatPanel } from '../components/agent/AgentChatPanel'
import { NodeEditor } from './NodeEditor'
import { EdgeEditor } from './EdgeEditor'
import { useI18n } from '../i18n/useI18n'

export function RightPanel({
  expandedAgent,
  onToggleExpand,
  onClose,
}: {
  expandedAgent?: boolean
  onToggleExpand?: () => void
  onClose?: () => void
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
  const { t } = useI18n()

  const activeRightPanel = useAppStore((s) => s.activeRightPanel)
  const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)

  // 同步 appStore 的外部 tab 切换（例如文件树右键菜单触发）
  useEffect(() => {
    if (activeRightPanel === 'agent' && activeTab !== 'agent') {
      setActiveTab('agent')
      // 清掉 store 信号，免得它一直覆盖用户手动切的 tab
      setActiveRightPanel('node')
    }
  }, [activeRightPanel, activeTab, setActiveRightPanel])

  const selectedNode = nodes.find((n) => n.id === selectedNodeId)
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId)

  const handleNodeNavigate = (targetId: string) => {
    eventBus.emit(Events.NAVIGATE_TO_NODE, targetId)
  }

  // 注意：不再自动切换 tab。用户选择节点后，需要手动点击 'node' tab 查看详情。
  // 这避免覆盖用户的显式 tab 选择。

  return (
    <div className="h-full flex flex-col border-l bg-background">
      {/* Tab 切换 */}
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
          {t('right.tab.node')}
        </button>
        <button
          onClick={() => setActiveTab('agent')}
          data-testid="right-panel-agent-tab"
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors',
            activeTab === 'agent'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted',
          )}
        >
          <Terminal className="w-3.5 h-3.5" />
          {t('right.tab.agent')}
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 rounded bg-primary/5 border border-primary/15 hover:bg-primary/10 transition-colors ml-auto"
            title={t('right.hidePanel')}
          >
            <PanelRightClose className="w-3.5 h-3.5 text-primary/70" />
          </button>
        )}
      </div>

      {/* 内容区 */}
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
                onNavigate={handleNodeNavigate}
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
                <p>{t('right.emptyTitle')}</p>
                <p className="text-xs mt-1">{t('right.emptyHint')}</p>
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
