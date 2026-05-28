import { useEffect, useState, useRef } from 'react'
import {
  Terminal,
  Bot,
  Activity,
  Pencil,
  Trash2,
  Plus,
  X,
  Check,
  Settings,
  Play,
  Shield,
  Code2,
  Database,
  Server,
  ArrowRight,
  GitBranch,
} from 'lucide-react'
import { useAgentStore } from '../store/agentStore'
import { useGraphStore } from '../store/graphStore'
import { cn, formatDate } from '../lib/utils'
import {
  AGENT_COMMAND_LABELS,
  NODE_TYPE_LABELS,
  NODE_STATUS_LABELS,
  NODE_TYPE_COLORS,
} from '@shared/constants'
import type {
  AgentCommand,
  AgentSessionConfig,
  GraphNode,
  NodeStatus,
  BusinessRule,
  NodeMetadata,
} from '@shared/types'

export function RightPanel() {
  const {
    adapters,
    sessions,
    currentSessionId,
    loadAdapters,
    selectSession,
  } = useAgentStore()
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

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      loadAdapters()
    }
  }, [loadAdapters])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI?.onAgentOutput) {
      const cleanup = window.electronAPI.onAgentOutput((sessionId, output) => {
        useAgentStore.getState().appendOutput(sessionId, output)
      })
      return cleanup
    }
  }, [])

  const selectedNode = nodes.find((n) => n.id === selectedNodeId)
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId)
  const currentSession = sessions.find((s) => s.id === currentSessionId)

  useEffect(() => {
    if (selectedNode || selectedEdge) {
      setActiveTab('node')
    }
  }, [selectedNode, selectedEdge])

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
      {/* Tab switching */}
      <div className="h-10 border-b flex items-center px-2 gap-1 flex-shrink-0">
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
          <AgentPanel
            adapters={adapters}
            sessions={sessions}
            currentSessionId={currentSessionId}
            selectedNode={selectedNode}
            currentSession={currentSession}
            onStartAgent={handleStartAgent}
            onSendCommand={handleSendCommand}
            onSelectSession={selectSession}
          />
        )}
      </div>
    </div>
  )
}

// ==================== Node Editor ====================

function NodeEditor({
  node,
  onUpdate,
  onDelete,
  onStartAgent,
}: {
  node: GraphNode
  onUpdate: (data: Partial<GraphNode>) => void
  onDelete: () => void
  onStartAgent: () => void
}) {
  const { nodes } = useGraphStore()

  const childNodes = nodes.filter((n) => n.parentId === node.id)
  const typeColor = NODE_TYPE_COLORS[node.type] ?? '#94a3b8'

  return (
    <div className="p-3 space-y-4">
      {/* Node header */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <div
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: typeColor }}
          />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {NODE_TYPE_LABELS[node.type]}
          </span>
        </div>
        <EditableTitle
          title={node.title}
          onSave={(title) => onUpdate({ title })}
        />
      </div>

      {/* Status selector for feature/bug */}
      {(node.type === 'feature' || node.type === 'bug') && (
        <StatusSelector status={node.status} onChange={(s) => onUpdate({ status: s })} />
      )}

      {/* Description */}
      <EditableTextArea
        label="Description"
        value={node.description ?? ''}
        onSave={(v) => onUpdate({ description: v })}
        placeholder="Enter node description..."
        rows={3}
      />

      {/* Module node: child nodes list */}
      {node.type === 'module' && childNodes.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Child processes ({childNodes.length})
          </label>
          <div className="space-y-1">
            {childNodes.map((child) => (
              <div
                key={child.id}
                className="flex items-center gap-1.5 px-2 py-1 text-sm bg-muted/50 rounded"
              >
                <div
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: NODE_TYPE_COLORS[child.type] }}
                />
                <span className="truncate flex-1">{child.title}</span>
                <span className="text-[10px] text-muted-foreground">
                  {NODE_STATUS_LABELS[child.status]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Process node: rules + metadata */}
      {node.type === 'process' && (
        <>
          <RulesEditor rules={node.rules ?? []} onUpdate={(rules) => onUpdate({ rules })} />
          <MetadataEditor metadata={node.metadata} onUpdate={(metadata) => onUpdate({ metadata })} />
        </>
      )}

      {/* Feature/Bug: acceptance criteria */}
      {(node.type === 'feature' || node.type === 'bug') && (
        <CriteriaEditor
          criteria={node.acceptanceCriteria ?? []}
          onUpdate={(criteria) => onUpdate({ acceptanceCriteria: criteria })}
        />
      )}

      {/* Action buttons */}
      <div className="pt-2 space-y-2 border-t">
        {node.type === 'feature' && (
          <button
            onClick={onStartAgent}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            Implement with Agent
          </button>
        )}
        <button
          onClick={onDelete}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm text-destructive border border-destructive/30 rounded-md hover:bg-destructive/10 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete node
        </button>
      </div>
    </div>
  )
}

// ==================== Editable Title ====================

function EditableTitle({ title, onSave }: { title: string; onSave: (v: string) => void }) {
  const [isEditing, setIsEditing] = useState(false)
  const [value, setValue] = useState(title)

  const handleSave = () => {
    if (value.trim()) {
      onSave(value.trim())
    }
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 px-2 py-1 text-sm border rounded bg-background"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave()
            if (e.key === 'Escape') {
              setValue(title)
              setIsEditing(false)
            }
          }}
        />
        <button onClick={handleSave} className="p-1 rounded hover:bg-green-100 text-green-600">
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => { setValue(title); setIsEditing(false) }}
          className="p-1 rounded hover:bg-red-100 text-red-600"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <h3 className="text-base font-semibold flex-1 truncate">{title}</h3>
      <button onClick={() => setIsEditing(true)} className="p-1 rounded hover:bg-muted transition-colors">
        <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
      </button>
    </div>
  )
}

// ==================== Status Selector ====================

function StatusSelector({
  status,
  onChange,
}: {
  status: NodeStatus
  onChange: (s: NodeStatus) => void
}) {
  const options: { value: NodeStatus; label: string; color: string }[] = [
    { value: 'draft', label: 'Draft', color: '#94a3b8' },
    { value: 'confirmed', label: 'Confirmed', color: '#3b82f6' },
    { value: 'developing', label: 'Developing', color: '#f59e0b' },
    { value: 'testing', label: 'Testing', color: '#8b5cf6' },
    { value: 'review', label: 'Review', color: '#06b6d4' },
    { value: 'published', label: 'Published', color: '#22c55e' },
  ]

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">Status</label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'px-2 py-0.5 text-[11px] rounded-full border transition-colors',
              status === opt.value
                ? 'border-transparent text-white'
                : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
            style={status === opt.value ? { backgroundColor: opt.color } : undefined}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ==================== Editable Text Area ====================

function EditableTextArea({
  label,
  value,
  onSave,
  placeholder,
  rows = 3,
}: {
  label: string
  value: string
  onSave: (v: string) => void
  placeholder?: string
  rows?: number
}) {
  const [localValue, setLocalValue] = useState(value)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  // Debounce save: only trigger onSave 500ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => {
      if (localValue !== value) {
        onSave(localValue)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [localValue, onSave, value])

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <textarea
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 text-sm border rounded-md bg-background resize-none"
        rows={rows}
      />
    </div>
  )
}

// ==================== Rules Editor ====================

function RulesEditor({
  rules,
  onUpdate,
}: {
  rules: BusinessRule[]
  onUpdate: (rules: BusinessRule[]) => void
}) {
  const [newTitle, setNewTitle] = useState('')
  const [newCondition, setNewCondition] = useState('')
  const [newAction, setNewAction] = useState('')
  const [showForm, setShowForm] = useState(false)

  const handleAdd = () => {
    if (!newTitle.trim()) return
    const rule: BusinessRule = {
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: newTitle.trim(),
      description: '',
      condition: newCondition.trim(),
      action: newAction.trim(),
    }
    onUpdate([...rules, rule])
    setNewTitle('')
    setNewCondition('')
    setNewAction('')
    setShowForm(false)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Business Rules</label>
        <button
          onClick={() => setShowForm(!showForm)}
          className="p-0.5 rounded hover:bg-muted"
        >
          <Plus className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>

      {rules.map((rule) => (
        <div key={rule.id} className="px-2 py-1.5 text-sm bg-amber-50 border border-amber-200 rounded">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Shield className="w-3 h-3 text-amber-600" />
              <span className="font-medium text-xs">{rule.title}</span>
            </div>
            <button
              onClick={() => onUpdate(rules.filter((r) => r.id !== rule.id))}
              className="p-0.5 rounded hover:bg-amber-200 text-amber-700"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          {rule.condition && (
            <div className="text-[10px] text-amber-700 mt-0.5">Condition: {rule.condition}</div>
          )}
          {rule.action && (
            <div className="text-[10px] text-amber-700">Action: {rule.action}</div>
          )}
        </div>
      ))}

      {showForm && (
        <div className="space-y-1.5 p-2 bg-muted/30 rounded">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Rule name"
            className="w-full px-2 py-1 text-xs border rounded bg-background"
          />
          <input
            type="text"
            value={newCondition}
            onChange={(e) => setNewCondition(e.target.value)}
            placeholder="Trigger condition"
            className="w-full px-2 py-1 text-xs border rounded bg-background"
          />
          <input
            type="text"
            value={newAction}
            onChange={(e) => setNewAction(e.target.value)}
            placeholder="Action"
            className="w-full px-2 py-1 text-xs border rounded bg-background"
          />
          <div className="flex gap-1">
            <button
              onClick={handleAdd}
              className="px-2 py-0.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              Add
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== Metadata Editor ====================

function MetadataEditor({
  metadata,
  onUpdate,
}: {
  metadata?: NodeMetadata
  onUpdate: (metadata: NodeMetadata) => void
}) {
  const apis = metadata?.apis ?? []
  const services = metadata?.services ?? []
  const entities = metadata?.entities ?? []

  const addItem = (
    key: 'apis' | 'services' | 'entities',
    item: { name: string; description?: string },
  ) => {
    const next = { ...metadata, [key]: [...(metadata?.[key] ?? []), item] }
    onUpdate(next)
  }

  const removeItem = (key: 'apis' | 'services' | 'entities', index: number) => {
    const next = {
      ...metadata,
      [key]: (metadata?.[key] ?? []).filter((_, i) => i !== index),
    }
    onUpdate(next)
  }

  return (
    <div className="space-y-3">
      {/* APIs */}
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Code2 className="w-3 h-3" />
          APIs
        </div>
        {apis.map((api, i) => (
          <div key={i} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 rounded">
            <span className="flex-1 truncate">{api.name}</span>
            <button
              onClick={() => removeItem('apis', i)}
              className="p-0.5 rounded hover:bg-blue-200 text-blue-700"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        ))}
        <AddItemInput
          placeholder="Add API..."
          onAdd={(name) => addItem('apis', { name })}
        />
      </div>

      {/* Services */}
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Server className="w-3 h-3" />
          Services
        </div>
        {services.map((svc, i) => (
          <div key={i} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-green-50 rounded">
            <span className="flex-1 truncate">{svc.name}</span>
            <button
              onClick={() => removeItem('services', i)}
              className="p-0.5 rounded hover:bg-green-200 text-green-700"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        ))}
        <AddItemInput
          placeholder="Add service..."
          onAdd={(name) => addItem('services', { name })}
        />
      </div>

      {/* Entities */}
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Database className="w-3 h-3" />
          Entities
        </div>
        {entities.map((ent, i) => (
          <div key={i} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-purple-50 rounded">
            <span className="flex-1 truncate">{ent.name}</span>
            <button
              onClick={() => removeItem('entities', i)}
              className="p-0.5 rounded hover:bg-purple-200 text-purple-700"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        ))}
        <AddItemInput
          placeholder="Add entity..."
          onAdd={(name) => addItem('entities', { name })}
        />
      </div>
    </div>
  )
}

function AddItemInput({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => void }) {
  const [value, setValue] = useState('')

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="flex-1 px-2 py-0.5 text-xs border rounded bg-background"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            onAdd(value.trim())
            setValue('')
          }
        }}
      />
      <button
        onClick={() => {
          if (value.trim()) {
            onAdd(value.trim())
            setValue('')
          }
        }}
        className="p-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  )
}

// ==================== Criteria Editor ====================

function CriteriaEditor({
  criteria,
  onUpdate,
}: {
  criteria: string[]
  onUpdate: (criteria: string[]) => void
}) {
  const [newValue, setNewValue] = useState('')

  const handleAdd = () => {
    if (!newValue.trim()) return
    onUpdate([...criteria, newValue.trim()])
    setNewValue('')
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">Acceptance Criteria</label>
      <div className="space-y-1">
        {criteria.map((c, i) => (
          <div key={i} className="flex items-center gap-1.5 px-2 py-1 text-sm bg-muted/50 rounded">
            <Check className="w-3 h-3 text-green-500 flex-shrink-0" />
            <span className="flex-1 truncate">{c}</span>
            <button
              onClick={() => onUpdate(criteria.filter((_, idx) => idx !== i))}
              className="p-0.5 rounded hover:bg-destructive/10 text-destructive"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="Add criterion..."
            className="flex-1 px-2 py-1 text-sm border rounded bg-background"
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <button
            onClick={handleAdd}
            className="p-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ==================== Agent Prompt Templates ====================

function generatePromptTemplate(
  commandType: AgentCommand['type'],
  node: GraphNode | undefined,
): string {
  if (!node) return ''

  const lines: string[] = []

  switch (commandType) {
    case 'implement':
      lines.push(`## 开发任务：${node.title}`)
      lines.push('')
      if (node.description) {
        lines.push(`### 需求描述`)
        lines.push(node.description)
        lines.push('')
      }
      if (node.acceptanceCriteria && node.acceptanceCriteria.length > 0) {
        lines.push(`### 验收标准`)
        node.acceptanceCriteria.forEach((c, i) => {
          lines.push(`${i + 1}. ${c}`)
        })
        lines.push('')
      }
      if (node.rules && node.rules.length > 0) {
        lines.push(`### 业务规则`)
        node.rules.forEach((r) => {
          lines.push(`- ${r.title}${r.condition ? `（条件：${r.condition}）` : ''}${r.action ? ` → ${r.action}` : ''}`)
        })
        lines.push('')
      }
      lines.push('### 请按以上要求完成功能实现')
      break

    case 'fix_bug':
      lines.push(`## 修复 Bug：${node.title}`)
      lines.push('')
      lines.push(`### 问题描述`)
      lines.push(node.description ?? '（请在此补充 Bug 的具体描述）')
      lines.push('')
      if (node.acceptanceCriteria && node.acceptanceCriteria.length > 0) {
        lines.push(`### 修复要求`)
        node.acceptanceCriteria.forEach((c, i) => {
          lines.push(`${i + 1}. ${c}`)
        })
        lines.push('')
      }
      lines.push('### 请定位问题根因并修复，同时确保不引入新问题')
      break

    case 'refactor':
      lines.push(`## 重构任务：${node.title}`)
      lines.push('')
      if (node.description) {
        lines.push(`### 当前问题`)
        lines.push(node.description)
        lines.push('')
      }
      lines.push('### 重构目标')
      lines.push('（请在此补充重构的具体目标和约束）')
      lines.push('')
      lines.push('### 请在保持现有功能不变的前提下完成重构')
      break

    case 'add_test':
      lines.push(`## 添加测试：${node.title}`)
      lines.push('')
      if (node.description) {
        lines.push(`### 功能说明`)
        lines.push(node.description)
        lines.push('')
      }
      if (node.acceptanceCriteria && node.acceptanceCriteria.length > 0) {
        lines.push(`### 测试应覆盖的验收标准`)
        node.acceptanceCriteria.forEach((c, i) => {
          lines.push(`${i + 1}. ${c}`)
        })
        lines.push('')
      }
      lines.push('### 请为该功能编写完整的单元测试和集成测试')
      break
  }

  return lines.join('\n')
}

// ==================== Agent Panel ====================

function AgentPanel({
  adapters,
  sessions,
  currentSessionId,
  selectedNode,
  currentSession,
  onStartAgent: _onStartAgent,
  onSendCommand,
  onSelectSession,
}: {
  adapters: { name: string; version: string; installed: boolean }[]
  sessions: { id: string; adapterName: string; nodeId: string; status: string; outputs: { type: string; data: string }[]; startTime: number; endTime?: number }[]
  currentSessionId: string | null
  selectedNode: GraphNode | undefined
  currentSession: { id: string; adapterName: string; nodeId: string; status: string; outputs: { type: string; data: string }[]; startTime: number; endTime?: number } | undefined
  onStartAgent: (adapterName: string) => void
  onSendCommand: (type: AgentCommand['type']) => void
  onSelectSession: (id: string | null) => void
}) {
  const { nodes } = useGraphStore()
  const [promptText, setPromptText] = useState('')
  const [selectedAdapter, setSelectedAdapter] = useState<string>('')
  const [showTaskBoard, setShowTaskBoard] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  // 当选择节点变化时，重置 prompt
  useEffect(() => {
    setPromptText('')
  }, [selectedNode?.id])

  // 默认选择第一个已安装的适配器
  useEffect(() => {
    const installed = adapters.filter((a) => a.installed)
    if (installed.length > 0 && !selectedAdapter) {
      setSelectedAdapter(installed[0].name)
    }
  }, [adapters, selectedAdapter])

  const installedAdapters = adapters.filter((a) => a.installed)
  const hasRunningSession = currentSession?.status === 'running'

  /** 点击快捷按钮：生成模板并填入输入框 */
  const handleQuickAction = (type: AgentCommand['type']) => {
    const template = generatePromptTemplate(type, selectedNode)
    setPromptText(template)
    // 聚焦输入框，方便用户修改
    setTimeout(() => promptRef.current?.focus(), 50)
  }

  /** 启动 Agent 并发送自定义 prompt */
  const handleStartWithPrompt = async () => {
    if (!selectedAdapter || !selectedNode) return

    // 如果没有自定义 prompt，生成默认的
    const finalPrompt = promptText.trim() || generatePromptTemplate('implement', selectedNode)

    // 启动会话
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

    const sessionId = await useAgentStore
      .getState()
      .startSession(selectedAdapter, config, selectedNode.id)

    // 发送自定义 prompt 作为第一条命令
    const command: AgentCommand = {
      type: 'implement',
      description: finalPrompt,
      targetNodeId: selectedNode.id,
    }
    await useAgentStore.getState().sendCommand(sessionId, command)

    setPromptText('')
    setShowTaskBoard(true)
  }

  /** 给运行中的会话发送带 prompt 的命令 */
  const handleSendWithPrompt = async (type: AgentCommand['type']) => {
    if (!currentSessionId || !selectedNode) return

    const finalPrompt = promptText.trim() || generatePromptTemplate(type, selectedNode)
    const command: AgentCommand = {
      type,
      description: finalPrompt,
      targetNodeId: selectedNode.id,
    }
    await useAgentStore.getState().sendCommand(currentSessionId, command)
    setPromptText('')
  }

  return (
    <div className="flex flex-col h-full">
      {/* 任务看板切换 */}
      {sessions.length > 0 && (
        <div className="border-b flex-shrink-0">
          <button
            onClick={() => setShowTaskBoard(!showTaskBoard)}
            className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">任务看板</span>
              <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
                {sessions.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {sessions.filter((s) => s.status === 'running').length > 0 && (
                <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                  <Activity className="w-2.5 h-2.5 animate-pulse" />
                  {sessions.filter((s) => s.status === 'running').length} 运行中
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {showTaskBoard ? '▲' : '▼'}
              </span>
            </div>
          </button>
        </div>
      )}

      {/* 任务看板 */}
      {showTaskBoard && sessions.length > 0 && (
        <div className="border-b max-h-48 overflow-y-auto flex-shrink-0">
          <div className="p-2 space-y-1">
            {/* 按状态分组：运行中优先 */}
            {[...sessions]
              .sort((a, b) => {
                const order: Record<string, number> = { running: 0, error: 1, completed: 2 }
                return (order[a.status] ?? 3) - (order[b.status] ?? 3)
              })
              .map((session) => {
                const node = nodes.find((n) => n.id === session.nodeId)
                const isSelected = currentSessionId === session.id
                return (
                  <button
                    key={session.id}
                    onClick={() => onSelectSession(session.id)}
                    className={cn(
                      'w-full text-left px-2.5 py-2 rounded-md text-sm transition-colors border',
                      isSelected
                        ? 'bg-primary/5 border-primary/30 text-primary'
                        : 'border-transparent hover:bg-muted/50',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <div className={cn(
                          'w-2 h-2 rounded-full flex-shrink-0',
                          session.status === 'running' ? 'bg-yellow-400 animate-pulse' :
                          session.status === 'completed' ? 'bg-green-400' :
                          'bg-red-400',
                        )} />
                        <span className="font-medium truncate text-xs">
                          {node?.title ?? session.nodeId}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 bg-muted rounded">
                          {session.adapterName}
                        </span>
                        <StatusBadge status={session.status} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-1 ml-4">
                      <span className="text-[10px] text-muted-foreground">
                        {formatDate(new Date(session.startTime))}
                      </span>
                      {session.outputs.length > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          {session.outputs.length} 条输出
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {/* Agent 选择器（紧凑） */}
        <div className="p-3 border-b">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Agent
          </h3>
          {installedAdapters.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {installedAdapters.map((adapter) => (
                <button
                  key={adapter.name}
                  onClick={() => setSelectedAdapter(adapter.name)}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border transition-colors',
                    selectedAdapter === adapter.name
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
                  )}
                >
                  <Bot className="w-3 h-3" />
                  {adapter.name}
                </button>
              ))}
            </div>
          ) : adapters.length > 0 ? (
            <div className="text-xs text-muted-foreground text-center py-2">
              没有已安装的 Agent，请前往设置安装
            </div>
          ) : (
            <div className="text-xs text-muted-foreground text-center py-2">
              检测中...
            </div>
          )}
        </div>

        {/* 快捷操作按钮 */}
        {selectedNode && (
          <div className="p-3 border-b">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              快捷指令
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { type: 'implement' as const, label: '开发功能', icon: Code2, color: 'text-blue-600' },
                  { type: 'fix_bug' as const, label: '修复 Bug', icon: Shield, color: 'text-red-600' },
                  { type: 'refactor' as const, label: '重构优化', icon: GitBranch, color: 'text-purple-600' },
                  { type: 'add_test' as const, label: '添加测试', icon: Check, color: 'text-green-600' },
                ]
              ).map(({ type, label, icon: Icon, color }) => (
                <button
                  key={type}
                  onClick={() => handleQuickAction(type)}
                  disabled={hasRunningSession && !currentSessionId}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-2 text-xs rounded-md border border-border',
                    'hover:bg-muted/50 transition-colors text-left',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  <Icon className={cn('w-3.5 h-3.5', color)} />
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5">
              点击快捷指令生成 Prompt 模板，可在下方修改后再发送
            </p>
          </div>
        )}

        {/* Prompt 输入区 */}
        {selectedNode && (
          <div className="p-3 border-b">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Prompt
              </h3>
              {promptText && (
                <button
                  onClick={() => setPromptText('')}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  清空
                </button>
              )}
            </div>
            <textarea
              ref={promptRef}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder={
                selectedNode
                  ? `输入自定义指令，或点击上方快捷指令生成模板...\n\n当前节点：${selectedNode.title}`
                  : '请先在画布中选择一个节点'
              }
              className="w-full px-2.5 py-2 text-xs border rounded-md bg-background resize-none font-mono leading-relaxed"
              rows={8}
            />

            {/* 发送按钮 */}
            <div className="mt-2">
              {hasRunningSession && currentSessionId ? (
                <button
                  onClick={() => handleSendWithPrompt('implement')}
                  disabled={!promptText.trim()}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-md transition-colors',
                    promptText.trim()
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'bg-muted text-muted-foreground cursor-not-allowed',
                  )}
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                  发送到当前会话
                </button>
              ) : (
                <button
                  onClick={handleStartWithPrompt}
                  disabled={!selectedAdapter || !selectedNode}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-md transition-colors',
                    selectedAdapter && selectedNode
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'bg-muted text-muted-foreground cursor-not-allowed',
                  )}
                >
                  <Play className="w-3.5 h-3.5" />
                  启动 Agent
                </button>
              )}
            </div>
          </div>
        )}

        {/* 运行中会话的快捷命令 */}
        {hasRunningSession && currentSessionId && (
          <div className="p-3 border-b">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              快速发送
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
                  onClick={() => onSendCommand(type)}
                  className="px-2 py-1.5 text-xs bg-secondary rounded-md hover:bg-secondary/80 transition-colors"
                >
                  {AGENT_COMMAND_LABELS[type]}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 无节点选中时的提示 */}
        {!selectedNode && sessions.length === 0 && (
          <div className="text-center text-muted-foreground text-sm py-12 px-4">
            <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>在画布中选择一个功能点节点</p>
            <p className="text-xs mt-1">即可开始创建 Agent 任务</p>
          </div>
        )}

        {/* 无节点选中但有会话时的提示 */}
        {!selectedNode && sessions.length > 0 && (
          <div className="text-center text-muted-foreground text-xs py-6 px-4">
            选择一个节点以创建新的 Agent 任务
          </div>
        )}

        {/* 当前会话输出日志 */}
        {currentSession && currentSession.outputs.length > 0 && (
          <div className="p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                输出日志
              </h3>
              <span className="text-[10px] text-muted-foreground">
                {currentSession.outputs.length} 条
              </span>
            </div>
            <div className="bg-muted/50 rounded-md p-2 font-mono text-xs space-y-1 max-h-64 overflow-y-auto">
              {currentSession.outputs.map((output, i) => (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre-wrap break-all',
                    output.type === 'error' && 'text-destructive',
                    output.type === 'file_change' && 'text-green-600',
                    output.type === 'complete' && 'text-blue-600',
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
    </div>
  )
}

// ==================== Edge Editor ====================

function EdgeEditor({
  edge,
  nodes,
  onUpdate,
  onDelete,
}: {
  edge: import('@shared/types').GraphEdge
  nodes: import('@shared/types').GraphNode[]
  onUpdate: (data: Partial<import('@shared/types').GraphEdge>) => void
  onDelete: () => void
}) {
  const sourceNode = nodes.find((n) => n.id === edge.source)
  const targetNode = nodes.find((n) => n.id === edge.target)

  const edgeTypeOptions = [
    { value: 'default' as const, label: '默认流程', color: '#94a3b8' },
    { value: 'success' as const, label: '成功分支', color: '#22c55e' },
    { value: 'failure' as const, label: '失败分支', color: '#ef4444' },
    { value: 'condition' as const, label: '条件分支', color: '#f59e0b' },
  ]

  return (
    <div className="p-3 space-y-4">
      {/* Edge header */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">连接线</span>
        </div>
        <h3 className="text-base font-semibold">流程连接</h3>
      </div>

      {/* Source → Target */}
      <div className="space-y-2 p-2 bg-muted/30 rounded-md">
        <div className="flex items-center gap-2 text-sm">
          <div className="flex-1 truncate">
            <span className="text-xs text-muted-foreground">From</span>
            <div className="font-medium truncate">{sourceNode?.title || 'Unknown'}</div>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <div className="flex-1 truncate">
            <span className="text-xs text-muted-foreground">To</span>
            <div className="font-medium truncate">{targetNode?.title || 'Unknown'}</div>
          </div>
        </div>
      </div>

      {/* Edge type selector */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">连接类型</label>
        <div className="grid grid-cols-2 gap-1.5">
          {edgeTypeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onUpdate({ edgeType: opt.value })}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border transition-colors',
                edge.edgeType === opt.value
                  ? 'border-transparent text-white'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
              style={
                edge.edgeType === opt.value
                  ? { backgroundColor: opt.color }
                  : undefined
              }
            >
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  backgroundColor: edge.edgeType === opt.value ? 'white' : opt.color,
                }}
              />
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Label */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">条件标签</label>
        <input
          type="text"
          value={edge.label || ''}
          onChange={(e) => onUpdate({ label: e.target.value || undefined })}
          placeholder="例如：金额 > 1000"
          className="w-full px-2 py-1.5 text-sm border rounded-md bg-background"
        />
        <p className="text-[10px] text-muted-foreground">
          用于描述流程分支的触发条件
        </p>
      </div>

      {/* Delete */}
      <div className="pt-2 border-t">
        <button
          onClick={onDelete}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm text-destructive border border-destructive/30 rounded-md hover:bg-destructive/10 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete connection
        </button>
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
        colors[status] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {status === 'running' && (
        <Activity className="w-3 h-3 animate-pulse" />
      )}
      {status === 'running' ? 'Running' : status === 'completed' ? 'Completed' : 'Error'}
    </span>
  )
}
