/**
 * 节点属性面板
 * 编辑节点的标题、类型、状态、描述、备注、验收标准、自定义样式
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Type,
  AlignLeft,
  StickyNote,
  CheckSquare,
  Palette,
  Save,
  X,
  Plus,
  Trash2,
} from 'lucide-react'
import { useGraphStore } from '../store/graphStore'
import { cn } from '../lib/utils'
import {
  NODE_TYPE_LABELS,
  NODE_STATUS_LABELS,
} from '@shared/constants'
import type { GraphNode, NodeType, NodeStatus } from '@shared/types'

interface NodePropertyPanelProps {
  node: GraphNode
}

export function NodePropertyPanel({ node }: NodePropertyPanelProps) {
  const { updateNode } = useGraphStore()
  const [form, setForm] = useState({
    title: node.title,
    type: node.type,
    status: node.status,
    description: node.description || '',
    notes: node.notes || '',
    acceptanceCriteria: node.acceptanceCriteria || [],
    backgroundColor: node.style?.backgroundColor || '',
    borderColor: node.style?.borderColor || '',
  })

  // 节点切换时重置表单
  useEffect(() => {
    setForm({
      title: node.title,
      type: node.type,
      status: node.status,
      description: node.description || '',
      notes: node.notes || '',
      acceptanceCriteria: node.acceptanceCriteria || [],
      backgroundColor: node.style?.backgroundColor || '',
      borderColor: node.style?.borderColor || '',
    })
  }, [node.id])

  const handleSave = useCallback(() => {
    updateNode(node.id, {
      title: form.title,
      type: form.type,
      status: form.status,
      description: form.description || undefined,
      notes: form.notes || undefined,
      acceptanceCriteria:
        form.acceptanceCriteria.length > 0 ? form.acceptanceCriteria : undefined,
      style:
        form.backgroundColor || form.borderColor
          ? {
              backgroundColor: form.backgroundColor || undefined,
              borderColor: form.borderColor || undefined,
            }
          : undefined,
    })
  }, [node.id, form, updateNode])

  // 防抖保存
  useEffect(() => {
    const timer = setTimeout(() => {
      handleSave()
    }, 500)
    return () => clearTimeout(timer)
  }, [form, handleSave])

  const addCriterion = () => {
    setForm((prev) => ({
      ...prev,
      acceptanceCriteria: [...prev.acceptanceCriteria, ''],
    }))
  }

  const updateCriterion = (index: number, value: string) => {
    setForm((prev) => ({
      ...prev,
      acceptanceCriteria: prev.acceptanceCriteria.map((c, i) =>
        i === index ? value : c
      ),
    }))
  }

  const removeCriterion = (index: number) => {
    setForm((prev) => ({
      ...prev,
      acceptanceCriteria: prev.acceptanceCriteria.filter((_, i) => i !== index),
    }))
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* 标题 */}
      <div className="p-3 border-b">
        <div className="flex items-center gap-2 mb-2">
          <Type className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            标题
          </span>
        </div>
        <input
          type="text"
          value={form.title}
          onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
          className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* 类型与状态 */}
      <div className="p-3 border-b">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              类型
            </label>
            <select
              value={form.type}
              onChange={(e) =>
                setForm((p) => ({ ...p, type: e.target.value as NodeType }))
              }
              className="w-full px-2 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {Object.entries(NODE_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              状态
            </label>
            <select
              value={form.status}
              onChange={(e) =>
                setForm((p) => ({ ...p, status: e.target.value as NodeStatus }))
              }
              className="w-full px-2 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {Object.entries(NODE_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 描述 */}
      <div className="p-3 border-b">
        <div className="flex items-center gap-2 mb-2">
          <AlignLeft className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            描述
          </span>
        </div>
        <textarea
          value={form.description}
          onChange={(e) =>
            setForm((p) => ({ ...p, description: e.target.value }))
          }
          placeholder="节点功能描述..."
          rows={3}
          className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* 备注 */}
      <div className="p-3 border-b">
        <div className="flex items-center gap-2 mb-2">
          <StickyNote className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            备注
          </span>
        </div>
        <textarea
          value={form.notes}
          onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
          placeholder="支持 Markdown 格式的备注..."
          rows={5}
          className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary font-mono"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          支持 Markdown：*斜体* **粗体** `代码` - 列表
        </p>
      </div>

      {/* 验收标准 */}
      <div className="p-3 border-b">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <CheckSquare className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              验收标准
            </span>
          </div>
          <button
            onClick={addCriterion}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
          >
            <Plus className="w-3 h-3" />
            添加
          </button>
        </div>
        <div className="space-y-1.5">
          {form.acceptanceCriteria.map((criterion, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <input
                type="text"
                value={criterion}
                onChange={(e) => updateCriterion(index, e.target.value)}
                placeholder={`标准 ${index + 1}`}
                className="flex-1 px-2 py-1 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={() => removeCriterion(index)}
                className="p-1 text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {form.acceptanceCriteria.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-2">
              暂无验收标准
            </p>
          )}
        </div>
      </div>

      {/* 自定义样式 */}
      <div className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <Palette className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            自定义样式
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              背景色
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.backgroundColor || '#ffffff'}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    backgroundColor: e.target.value,
                  }))
                }
                className="w-8 h-8 rounded cursor-pointer border"
              />
              <input
                type="text"
                value={form.backgroundColor}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    backgroundColor: e.target.value,
                  }))
                }
                placeholder="#ffffff"
                className="flex-1 px-2 py-1 text-sm border rounded-md bg-background"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              边框色
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.borderColor || '#000000'}
                onChange={(e) =>
                  setForm((p) => ({ ...p, borderColor: e.target.value }))
                }
                className="w-8 h-8 rounded cursor-pointer border"
              />
              <input
                type="text"
                value={form.borderColor}
                onChange={(e) =>
                  setForm((p) => ({ ...p, borderColor: e.target.value }))
                }
                placeholder="#000000"
                className="flex-1 px-2 py-1 text-sm border rounded-md bg-background"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
