import { useEffect, useState } from 'react'
import {
  Pencil,
  Trash2,
  Plus,
  X,
  Check,
  Shield,
  Code2,
  Database,
  Server,
  FileText,
  Type,
  Play,
} from 'lucide-react'
import { useGraphStore } from '../store/graphStore'
import { cn } from '../lib/utils'
import {
  NODE_TYPE_LABELS,
  NODE_STATUS_LABELS,
  NODE_TYPE_COLORS,
} from '@shared/constants'
import type {
  GraphNode,
  NodeStatus,
  BusinessRule,
  NodeMetadata,
} from '@shared/types'

// ==================== Editable Title ====================

export function EditableTitle({ title, onSave }: { title: string; onSave: (v: string) => void }) {
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
            <Check className="w-3 h-3 text-green-500 shrink-0" />
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

// ==================== Node Editor ====================

export function NodeEditor({
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
            className="w-2.5 h-2.5 rounded-full shrink-0"
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

      {/* Context refs display */}
      {node.contextRefs && node.contextRefs.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">关联上下文</label>
          <div className="flex flex-wrap gap-1">
            {node.contextRefs.map((ctx) => (
              <span
                key={ctx.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-muted rounded-full"
              >
                {ctx.type === 'file' ? (
                  <FileText className="w-2.5 h-2.5 text-blue-500" />
                ) : ctx.type === 'text' ? (
                  <Type className="w-2.5 h-2.5 text-amber-500" />
                ) : null}
                <span className="max-w-[120px] truncate">{ctx.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}

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
                  className="w-1.5 h-1.5 rounded-full shrink-0"
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
        {node.type !== 'project' && (
          <button
            onClick={onDelete}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm text-destructive border border-destructive/30 rounded-md hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete node
          </button>
        )}
      </div>
    </div>
  )
}
