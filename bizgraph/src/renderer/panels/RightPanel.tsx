import { useState, useEffect } from 'react'
import { Terminal, Bot, Activity, Settings, FileText } from 'lucide-react'
import { useAgentStore } from '../store/agentStore'
import { useGraphStore } from '../store/graphStore'
import { NodePropertyPanel } from './NodePropertyPanel'
import { cn, formatDate } from '../lib/utils'
import { SUPPORTED_AGENTS, AGENT_COMMAND_LABELS } from '@shared/constants'
import type { AgentCommand, AgentSessionConfig } from '@shared/types'

type PanelTab = 'properties' | 'agent'

export function RightPanel() {
  const {
    adapters,
    sessions,
    currentSessionId,
    loadAdapters,
    selectSession,
  } = useAgentStore()
  const { selectedNodeId, nodes } = useGraphStore()

  const [activeTab, setActiveTab] = useState<PanelTab>('properties')

  useEffect(() => {
    loadAdapters()
  }, [loadAdapters])

  // 监听 Agent 输出
  useEffect(() => {
    const cleanup = window.electronAPI.onAgentOutput((sessionId, output) => {
      useAgentStore.getState().appendOutput(sessionId, output)
    })
    return cleanup
  }, [])

  const selectedNode = nodes.find((n) => n.id === selectedNodeId)
  const currentSession = sessions.find((s) => s.id === currentSessionId)

  const handleStartAgent = async (adapterName: string) => {
    if (!selectedNode) return

    const config: AgentSessionConfig = {
      workingDirectory: '',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: selectedNode.title,
      acceptanceCriteria: selectedNode.acceptanceCriteria ?? [],
    }

    await useAgentStore
      .getState()
      .startSession(adapterName, config, selectedNode.id)
  }

  const handleSendCommand = async (type: AgentCommand['type']) => {
    if (!currentSessionId || !selectedNode) return

    const command: AgentCommand = {
      type,
      description: `请${AGENT_COMMAND_LABELS[type]}：${selectedNode.title}`,
      targetNodeId: selectedNode.id,
    }

    await useAgentStore.getState().sendCommand(currentSessionId, command)
  }

  return (
    <div className="h-full flex flex-col border-l bg-background">
      {/* Tab 切换栏 */}
      <div className="h-10 border-b flex items-center bg-muted/30">
        <button
          onClick={() => setActiveTab('properties')}
          className={cn(
            'flex-1 h-full flex items-center justify-center gap-1.5 text-xs font-medium transition-colors border-b-2',
            activeTab === 'properties'
              ? 'border-primary text-primary bg-background'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
        >
          <FileText className="w-3.5 h-3.5" />
          节点属性
        </button>
        <button
          onClick={() => setActiveTab('agent')}
          className={cn(
            'flex-1 h-full flex items-center justify-center gap-1.5 text-xs font-medium transition-colors border-b-2',
            activeTab === 'agent'
              ? 'border-primary text-primary bg-background'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
        >
          <Terminal className="w-3.5 h-3.5" />
          Agent 面板
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'properties' && (
          <>
            {selectedNode ? (
              <NodePropertyPanel node={selectedNode} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground px-6">
                <Settings className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm font-medium mb-1">未选择节点</p>
                <p className="text-xs text-center">
                  点击画布上的节点以查看和编辑其属性
                </p>
              </div>
            )}
          </>
        )}

        {activeTab === 'agent' && (
          <div className="h-full overflow-y-auto">
            {/* 已安装的 Agent */}
            <div className="p-3 border-b">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Agent 适配器
              </h3>
              <div className="space-y-1.5">
                {adapters.map((adapter) => (
                  <div
                    key={adapter.name}
                    className="flex items-center justify-between px-2 py-1.5 rounded-md text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Bot className="w-3.5 h-3.5" />
                      <span>{adapter.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'text-xs px-1.5 py-0.5 rounded-full',
                          adapter.installed
                            ? 'bg-green-100 text-green-700'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {adapter.installed ? '已安装' : '未安装'}
                      </span>
                      {adapter.installed && selectedNode && (
                        <button
                          onClick={() => handleStartAgent(adapter.name)}
                          className="text-xs px-2 py-0.5 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
                        >
                          启动
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {adapters.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-2">
                  正在检测 Agent...
                </div>
              )}
            </div>

            {/* 会话列表 */}
            {sessions.length > 0 && (
              <div className="p-3 border-b">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  执行会话
                </h3>
                <div className="space-y-1">
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      onClick={() => selectSession(session.id)}
                      className={cn(
                        'w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors',
                        currentSessionId === session.id
                          ? 'bg-primary/10 text-primary'
                          : 'hover:bg-muted'
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate">{session.adapterName}</span>
                        <StatusBadge status={session.status} />
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {formatDate(session.startTime)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 指令面板 */}
            {currentSession && currentSession.status === 'running' && (
              <div className="p-3 border-b">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  发送指令
                </h3>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      'implement',
                      'fix_bug',
                      'refactor',
                      'add_test',
                    ] as AgentCommand['type'][]
                  ).map((type) => (
                    <button
                      key={type}
                      onClick={() => handleSendCommand(type)}
                      className="px-2 py-1.5 text-xs bg-secondary rounded-md hover:bg-secondary/80 transition-colors"
                    >
                      {AGENT_COMMAND_LABELS[type]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 输出日志 */}
            {currentSession && currentSession.outputs.length > 0 && (
              <div className="p-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  输出日志
                </h3>
                <div className="bg-muted/50 rounded-md p-2 font-mono text-xs space-y-1 max-h-64 overflow-y-auto">
                  {currentSession.outputs.map((output, i) => (
                    <div
                      key={i}
                      className={cn(
                        'whitespace-pre-wrap break-all',
                        output.type === 'error' && 'text-destructive',
                        output.type === 'file_change' && 'text-green-600'
                      )}
                    >
                      <span className="text-muted-foreground opacity-50 mr-1">
                        [{output.type}]
                      </span>
                      {output.data}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-yellow-100 text-yellow-700',
    completed: 'bg-green-100 text-green-700',
    error: 'bg-red-100 text-red-700',
  }

  return (
    <span
      className={cn(
        'text-xs px-1.5 py-0.5 rounded-full flex items-center gap-1',
        colors[status] ?? 'bg-muted text-muted-foreground'
      )}
    >
      {status === 'running' && (
        <Activity className="w-3 h-3 animate-pulse" />
      )}
      {status === 'running'
        ? '运行中'
        : status === 'completed'
          ? '已完成'
          : '错误'}
    </span>
  )
}
