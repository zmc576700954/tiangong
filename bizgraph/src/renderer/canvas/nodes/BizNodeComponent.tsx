/**
 * 自定义业务节点组件
 * 支持：类型颜色、状态样式、备注图标、折叠展开按钮、右键菜单
 */

import { memo, useState, useCallback, useRef } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Bug,
  StickyNote,
  ChevronRight,
  ChevronDown,
  Plus,
  MoreHorizontal,
  Trash2,
  Copy,
  Edit3,
  GitBranch,
} from 'lucide-react'
import { useGraphStore } from '../../store/graphStore'
import { getNodeStatusClass, cn } from '../../lib/utils'
import { NODE_TYPE_LABELS, NODE_STATUS_LABELS } from '@shared/constants'
import type { GraphNode, NodeType } from '@shared/types'
import { hasChildren } from '../layout/treeLayout'

const nodeTypeColors: Record<string, string> = {
  module: '#3b82f6',
  process: '#8b5cf6',
  rule: '#f59e0b',
  api: '#06b6d4',
  service: '#22c55e',
  entity: '#ec4899',
}

// 导出给 GraphCanvas 使用
export { nodeTypeColors }

interface NodeContextMenuState {
  visible: boolean
  x: number
  y: number
}

export const BizNodeComponent = memo(function BizNodeComponent({
  id,
  data,
  selected,
}: NodeProps<GraphNode & { bugCount: number; layoutMode: 'free' | 'tree' }>) {
  const {
    updateNode,
    deleteNode,
    createNode,
    createEdge,
    nodes,
    selectNode,
  } = useGraphStore()

  const [menu, setMenu] = useState<NodeContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
  })

  const nodeRef = useRef<HTMLDivElement>(null)

  const typeColor = nodeTypeColors[data.type] ?? '#94a3b8'
  const statusClass = getNodeStatusClass(data.status)
  const hasKids = hasChildren(nodes, id)
  const isCollapsed = data.collapsed ?? false
  const hasNotes = !!data.notes?.trim()

  // 折叠 / 展开
  const toggleCollapse = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      updateNode(id, { collapsed: !isCollapsed })
    },
    [id, isCollapsed, updateNode],
  )

  // 添加子节点
  const handleAddChild = useCallback(async () => {
    const parent = nodes.find((n) => n.id === id)
    if (!parent) return

    // 子节点位置：树形模式下由布局算法决定，自由模式下手动计算
    const childX = parent.position.x + 260
    const siblingCount = nodes.filter((n) => n.parentId === id).length
    const childY = parent.position.y + siblingCount * 110

    const child = await createNode({
      type: 'module',
      status: 'draft',
      title: `子节点 ${siblingCount + 1}`,
      graphId: parent.graphId,
      graphType: parent.graphType,
      parentId: id,
      position: { x: childX, y: childY },
      acceptanceCriteria: [],
    })

    // 自动建立父子边
    await createEdge({
      source: id,
      target: child.id,
      graphId: parent.graphId,
      edgeType: 'smoothstep',
    })

    // 如果父节点是折叠状态，自动展开
    if (isCollapsed) {
      await updateNode(id, { collapsed: false })
    }

    setMenu({ visible: false, x: 0, y: 0 })
  }, [id, nodes, isCollapsed, createNode, createEdge, updateNode])

  // 删除节点（级联删除子节点）
  const handleDelete = useCallback(async () => {
    // 获取所有子孙节点
    const descendantIds: string[] = []
    const collect = (parentId: string) => {
      const children = nodes.filter((n) => n.parentId === parentId)
      for (const child of children) {
        descendantIds.push(child.id)
        collect(child.id)
      }
    }
    collect(id)

    // 先删子孙，再删自己
    for (const childId of descendantIds.reverse()) {
      await deleteNode(childId)
    }
    await deleteNode(id)
    setMenu({ visible: false, x: 0, y: 0 })
  }, [id, nodes, deleteNode])

  // 复制节点（仅复制数据，不含 ID 和父子关系）
  const handleDuplicate = useCallback(async () => {
    const parent = nodes.find((n) => n.id === id)
    if (!parent) return

    await createNode({
      type: parent.type,
      status: parent.status,
      title: `${parent.title} (副本)`,
      description: parent.description,
      graphId: parent.graphId,
      graphType: parent.graphType,
      position: {
        x: parent.position.x + 30,
        y: parent.position.y + 30,
      },
      acceptanceCriteria: parent.acceptanceCriteria,
      notes: parent.notes,
    })
    setMenu({ visible: false, x: 0, y: 0 })
  }, [id, nodes, createNode])

  // 右键菜单
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({ visible: true, x: e.clientX, y: e.clientY })
    },
    [],
  )

  // 点击节点
  const onClick = useCallback(() => {
    selectNode(id)
  }, [id, selectNode])

  return (
    <>
      {/* 左侧连接点（仅树形模式或作为子节点时有用） */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: typeColor, width: 8, height: 8 }}
      />

      {/* 节点主体 */}
      <div
        ref={nodeRef}
        onClick={onClick}
        onContextMenu={onContextMenu}
        className={cn(
          'px-4 py-2.5 rounded-lg border-2 min-w-[150px] max-w-[220px] shadow-sm transition-all cursor-pointer relative group',
          statusClass,
          selected && 'ring-2 ring-primary ring-offset-1',
        )}
        style={data.style}
      >
        {/* 类型指示器 */}
        <div className="flex items-center gap-1.5 mb-1">
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: typeColor }}
          />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {NODE_TYPE_LABELS[data.type]}
          </span>
        </div>

        {/* 标题 */}
        <div className="font-medium text-sm truncate pr-4">{data.title}</div>

        {/* 底部信息栏 */}
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[10px] text-muted-foreground">
            {NODE_STATUS_LABELS[data.status]}
          </span>
          <div className="flex items-center gap-1">
            {hasNotes && (
              <StickyNote className="w-3 h-3 text-amber-500" />
            )}
            {data.bugCount > 0 && (
              <div className="flex items-center gap-0.5 text-[10px] text-destructive">
                <Bug className="w-3 h-3" />
                {data.bugCount}
              </div>
            )}
          </div>
        </div>

        {/* 折叠/展开按钮（仅在树形模式且有子节点时显示） */}
        {data.layoutMode === 'tree' && hasKids && (
          <button
            onClick={toggleCollapse}
            className="absolute -right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full bg-background border shadow-sm hover:bg-muted transition-colors z-10"
            title={isCollapsed ? '展开子树' : '折叠子树'}
          >
            {isCollapsed ? (
              <ChevronRight className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
          </button>
        )}
      </div>

      {/* 右侧连接点 */}
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: typeColor, width: 8, height: 8 }}
      />

      {/* 右键菜单 */}
      {menu.visible && (
        <>
          {/* 遮罩层，点击关闭 */}
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setMenu({ visible: false, x: 0, y: 0 })}
          />
          <div
            className="fixed z-[9999] bg-background border rounded-lg shadow-lg py-1 w-44"
            style={{ left: menu.x, top: menu.y }}
          >
            <div className="px-3 py-1 text-xs text-muted-foreground border-b mb-1 truncate">
              {data.title}
            </div>

            <button
              onClick={() => {
                selectNode(id)
                setMenu({ visible: false, x: 0, y: 0 })
              }}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <Edit3 className="w-3.5 h-3.5 text-muted-foreground" />
              编辑节点
            </button>

            <button
              onClick={handleAddChild}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
              添加子节点
            </button>

            {hasKids && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  toggleCollapse(e)
                  setMenu({ visible: false, x: 0, y: 0 })
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
              >
                {isCollapsed ? (
                  <>
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                    展开子树
                  </>
                ) : (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                    折叠子树
                  </>
                )}
              </button>
            )}

            <div className="border-t my-1" />

            <button
              onClick={handleDuplicate}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <Copy className="w-3.5 h-3.5 text-muted-foreground" />
              复制节点
            </button>

            <button
              onClick={handleDelete}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-2"
            >
              <Trash2 className="w-3.5 h-3.5" />
              删除节点
            </button>
          </div>
        </>
      )}
    </>
  )
})
