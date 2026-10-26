import { useEffect, useState, useRef, useCallback } from 'react'
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
  NODE_TYPE_COLORS,
} from '@shared/constants'
import { nodeStatusLabel, nodeTypeLabel } from '@shared/i18n'
import { useI18n } from '../i18n/useI18n'
import type {
  GraphNode,
  NodeStatus,
  BusinessRule,
  NodeMetadata,
} from '@shared/types'
import { WikiPageEditor } from '../components/wiki/WikiPageEditor'

// ==================== 可编辑标题 ====================

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

// ==================== 状态选择器 ====================

function StatusSelector({
  status,
  onChange,
}: {
  status: NodeStatus
  onChange: (s: NodeStatus) => void
}) {
  const { t, locale } = useI18n()

  const options: { value: NodeStatus; label: string; color: string }[] = [
    { value: 'draft', label: nodeStatusLabel('draft', locale), color: '#94a3b8' },
    { value: 'confirmed', label: nodeStatusLabel('confirmed', locale), color: '#3b82f6' },
    { value: 'developing', label: nodeStatusLabel('developing', locale), color: '#f59e0b' },
    { value: 'testing', label: nodeStatusLabel('testing', locale), color: '#8b5cf6' },
    { value: 'review', label: nodeStatusLabel('review', locale), color: '#06b6d4' },
    { value: 'published', label: nodeStatusLabel('published', locale), color: '#22c55e' },
  ]

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{t('node.editor.status')}</label>
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

// ==================== 可编辑文本域 ====================

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
  const localValueRef = useRef(localValue)
  const valueRef = useRef(value)
  const pendingSaveRef = useRef(false)

  useEffect(() => { localValueRef.current = localValue }, [localValue])
  useEffect(() => { valueRef.current = value }, [value])

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  // 防抖保存：用户停止输入 500ms 后才触发 onSave
  useEffect(() => {
    pendingSaveRef.current = true
    const timer = setTimeout(() => {
      if (localValueRef.current !== valueRef.current) {
        onSave(localValueRef.current)
      }
      pendingSaveRef.current = false
    }, 500)
    return () => clearTimeout(timer)
  }, [localValue, onSave, value])

  // 卸载前把待保存内容刷出去，避免编辑丢失
  useEffect(() => {
    return () => {
      if (pendingSaveRef.current && localValueRef.current !== valueRef.current) {
        onSave(localValueRef.current)
      }
    }
    // 期望 onSave 引用稳定（父组件里用 useCallback）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

// ==================== 业务规则编辑器 ====================

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
  const { t } = useI18n()

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
        <label className="text-xs font-medium text-muted-foreground">{t('node.editor.businessRules')}</label>
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
            <div className="text-[10px] text-amber-700 mt-0.5">
              {t('node.editor.ruleCondition', { condition: rule.condition })}
            </div>
          )}
          {rule.action && (
            <div className="text-[10px] text-amber-700">
              {t('node.editor.ruleAction', { action: rule.action })}
            </div>
          )}
        </div>
      ))}

      {showForm && (
        <div className="space-y-1.5 p-2 bg-muted/30 rounded">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder={t('node.editor.ruleNamePlaceholder')}
            className="w-full px-2 py-1 text-xs border rounded bg-background"
          />
          <input
            type="text"
            value={newCondition}
            onChange={(e) => setNewCondition(e.target.value)}
            placeholder={t('node.editor.ruleConditionPlaceholder')}
            className="w-full px-2 py-1 text-xs border rounded bg-background"
          />
          <input
            type="text"
            value={newAction}
            onChange={(e) => setNewAction(e.target.value)}
            placeholder={t('node.editor.ruleActionPlaceholder')}
            className="w-full px-2 py-1 text-xs border rounded bg-background"
          />
          <div className="flex gap-1">
            <button
              onClick={handleAdd}
              className="px-2 py-0.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              {t('node.editor.add')}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== 元数据编辑器 ====================

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
  const { t } = useI18n()

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
      {/* API 接口 */}
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Code2 className="w-3 h-3" />
          {t('node.editor.apis')}
        </div>
        {apis.map((api, i) => (
          <div key={api.name || i} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 rounded">
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
          placeholder={t('node.editor.addApiPlaceholder')}
          onAdd={(name) => addItem('apis', { name })}
        />
      </div>

      {/* 服务 */}
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Server className="w-3 h-3" />
          {t('node.editor.services')}
        </div>
        {services.map((svc, i) => (
          <div key={svc.name || i} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-green-50 rounded">
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
          placeholder={t('node.editor.addServicePlaceholder')}
          onAdd={(name) => addItem('services', { name })}
        />
      </div>

      {/* 实体 */}
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Database className="w-3 h-3" />
          {t('node.editor.entities')}
        </div>
        {entities.map((ent, i) => (
          <div key={ent.name || i} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-purple-50 rounded">
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
          placeholder={t('node.editor.addEntityPlaceholder')}
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

// ==================== 验收标准编辑器 ====================

function CriteriaEditor({
  criteria,
  onUpdate,
}: {
  criteria: string[]
  onUpdate: (criteria: string[]) => void
}) {
  const [newValue, setNewValue] = useState('')
  const { t } = useI18n()

  const handleAdd = () => {
    if (!newValue.trim()) return
    onUpdate([...criteria, newValue.trim()])
    setNewValue('')
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{t('node.editor.acceptanceCriteria')}</label>
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
            placeholder={t('node.editor.addCriterionPlaceholder')}
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

// ==================== 节点编辑器 ====================

export function NodeEditor({
  node,
  onUpdate,
  onDelete,
  onStartAgent,
  onNavigate,
}: {
  node: GraphNode
  onUpdate: (data: Partial<GraphNode>) => void
  onDelete: () => void
  onStartAgent: () => void
  onNavigate?: (nodeId: string) => void
}) {
  const { nodes } = useGraphStore()
  const { locale, t } = useI18n()

  const childNodes = nodes.filter((n) => n.parentId === node.id)
  const typeColor = NODE_TYPE_COLORS[node.type] ?? '#94a3b8'

  const handleTitleSave = useCallback((title: string) => onUpdate({ title }), [onUpdate])
  const handleDescriptionSave = useCallback((v: string) => onUpdate({ description: v }), [onUpdate])
  const handleWikiUpdate = useCallback((data: { wikiContent?: string; wikiMeta?: Record<string, unknown> }) => {
    onUpdate(data)
  }, [onUpdate])

  return (
    <div className="p-3 space-y-4">
      {/* 节点头部 */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <div
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: typeColor }}
          />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {nodeTypeLabel(node.type, locale)}
          </span>
        </div>
        <EditableTitle
          title={node.title}
          onSave={handleTitleSave}
        />
      </div>

      {/* 功能点 / BUG 的状态选择器 */}
      {(node.type === 'feature' || node.type === 'bug') && (
        <StatusSelector status={node.status} onChange={(s) => onUpdate({ status: s })} />
      )}

      {/* Wiki 页面编辑器 */}
      {node.type === 'wiki-page' && (
        <WikiPageEditor
          nodeId={node.id}
          graphId={node.graphId}
          wikiContent={node.wikiContent}
          wikiMeta={node.wikiMeta}
          onUpdate={handleWikiUpdate}
          onNavigate={onNavigate}
        />
      )}

      {/* 描述 */}
      <EditableTextArea
        label={t('node.editor.description')}
        value={node.description ?? ''}
        onSave={handleDescriptionSave}
        placeholder={t('node.editor.descriptionPlaceholder')}
        rows={3}
      />

      {/* 关联上下文展示 */}
      {node.contextRefs && node.contextRefs.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('node.editor.relatedContext')}</label>
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

      {/* 模块节点：子节点列表 */}
      {node.type === 'module' && childNodes.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t('node.editor.childProcesses', { count: childNodes.length })}
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
                  {nodeStatusLabel(child.status, locale)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 流程节点：规则 + 元数据 */}
      {node.type === 'process' && (
        <>
          <RulesEditor rules={node.rules ?? []} onUpdate={(rules) => onUpdate({ rules })} />
          <MetadataEditor metadata={node.metadata} onUpdate={(metadata) => onUpdate({ metadata })} />
        </>
      )}

      {/* 功能点 / BUG：验收标准 */}
      {(node.type === 'feature' || node.type === 'bug') && (
        <CriteriaEditor
          criteria={node.acceptanceCriteria ?? []}
          onUpdate={(criteria) => onUpdate({ acceptanceCriteria: criteria })}
        />
      )}

      {/* 操作按钮 */}
      <div className="pt-2 space-y-2 border-t">
        {(node.type === 'feature' || node.type === 'wiki-page') && (
          <button
            onClick={onStartAgent}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            {node.type === 'wiki-page'
              ? t('node.editor.completeWiki')
              : t('node.editor.implementWithAgent')}
          </button>
        )}
        {node.type !== 'project' && !node.wikiMeta?.specialPage && (
          <button
            onClick={onDelete}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm text-destructive border border-destructive/30 rounded-md hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('node.editor.deleteNode')}
          </button>
        )}
      </div>
    </div>
  )
}
