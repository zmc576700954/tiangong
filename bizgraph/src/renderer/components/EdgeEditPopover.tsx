/**
 * 边属性编辑浮层
 * 支持编辑：条件文本、连线类型、颜色、粗细、虚实、箭头类型
 */

import { useState, useEffect, useCallback } from 'react'
import { X, ArrowRight, Minus, GitCommit } from 'lucide-react'
import { useGraphStore } from '../store/graphStore'
import { cn } from '../lib/utils'
import {
  EDGE_TYPE_LABELS,
  MARKER_END_LABELS,
} from '@shared/constants'
import type { GraphEdge, EdgeType } from '@shared/types'

interface EdgeEditPopoverProps {
  edge: GraphEdge
  onClose: () => void
}

export function EdgeEditPopover({ edge, onClose }: EdgeEditPopoverProps) {
  const { updateEdge, deleteEdge } = useGraphStore()

  const [form, setForm] = useState({
    condition: edge.condition || '',
    label: edge.label || '',
    edgeType: edge.edgeType || 'default',
    stroke: edge.style?.stroke || '#94a3b8',
    strokeWidth: edge.style?.strokeWidth || 2,
    strokeDasharray: edge.style?.strokeDasharray || '',
    markerEnd: edge.markerEnd || 'arrow',
  })

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSave = useCallback(() => {
    updateEdge(edge.id, {
      condition: form.condition || undefined,
      label: form.label || undefined,
      edgeType: (form.edgeType as EdgeType) || undefined,
      style: {
        stroke: form.stroke,
        strokeWidth: form.strokeWidth,
        strokeDasharray: form.strokeDasharray || undefined,
      },
      markerEnd: form.markerEnd as GraphEdge['markerEnd'],
    })
    onClose()
  }, [edge.id, form, updateEdge, onClose])

  const handleDelete = useCallback(() => {
    deleteEdge(edge.id)
    onClose()
  }, [edge.id, deleteEdge, onClose])

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 z-[9998] bg-black/20"
        onClick={onClose}
      />
      {/* 编辑面板 */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] bg-background border rounded-xl shadow-xl w-80 max-h-[90vh] overflow-y-auto">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <GitCommit className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">编辑连线</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* 条件文本 */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              流程条件
            </label>
            <input
              type="text"
              value={form.condition}
              onChange={(e) =>
                setForm((p) => ({ ...p, condition: e.target.value }))
              }
              placeholder="例如：审批通过 / 库存 > 0"
              className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* 标签 */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              标签
            </label>
            <input
              type="text"
              value={form.label}
              onChange={(e) =>
                setForm((p) => ({ ...p, label: e.target.value }))
              }
              placeholder="连线描述"
              className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* 连线类型 */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              连线类型
            </label>
            <select
              value={form.edgeType}
              onChange={(e) =>
                setForm((p) => ({ ...p, edgeType: e.target.value }))
              }
              className="w-full px-2 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {Object.entries(EDGE_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* 颜色与粗细 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                颜色
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.stroke}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, stroke: e.target.value }))
                  }
                  className="w-8 h-8 rounded cursor-pointer border flex-shrink-0"
                />
                <input
                  type="text"
                  value={form.stroke}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, stroke: e.target.value }))
                  }
                  className="flex-1 px-2 py-1 text-sm border rounded-md bg-background"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                粗细
              </label>
              <input
                type="number"
                min={1}
                max={8}
                value={form.strokeWidth}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    strokeWidth: Number(e.target.value),
                  }))
                }
                className="w-full px-2 py-1.5 text-sm border rounded-md bg-background"
              />
            </div>
          </div>

          {/* 线型与箭头 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                线型
              </label>
              <select
                value={form.strokeDasharray}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    strokeDasharray: e.target.value,
                  }))
                }
                className="w-full px-2 py-1.5 text-sm border rounded-md bg-background"
              >
                <option value="">实线</option>
                <option value="5,5">虚线</option>
                <option value="10,5">长虚线</option>
                <option value="2,2">点线</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                箭头
              </label>
              <select
                value={form.markerEnd}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    markerEnd: e.target.value,
                  }))
                }
                className="w-full px-2 py-1.5 text-sm border rounded-md bg-background"
              >
                {Object.entries(MARKER_END_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/30">
          <button
            onClick={handleDelete}
            className="text-xs text-destructive hover:text-destructive/80 transition-colors px-2 py-1 rounded hover:bg-destructive/10"
          >
            删除连线
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
