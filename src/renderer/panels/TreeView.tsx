import { useState, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFileTreeStore } from '../store/fileTreeStore'
import { useGraphStore } from '../store/graphStore'
import { TreeNodeItem } from './TreeNodeItem'
import { useI18n } from '../i18n/useI18n'
import { nodeStatusLabel, nodeTypeLabel } from '@shared/i18n'
import type { GraphNode } from '@shared/types'

function renderNodeRow(node: GraphNode) {
  return (
    <div
      key={node.id}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded text-sm cursor-pointer hover:bg-muted"
      style={{
        paddingLeft: `${(node.communityLevel ?? 0) * 12 + 8}px`,
      }}
      onClick={() => useGraphStore.getState().selectNode(node.id)}
    >
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${
          node.status === 'placeholder' ? 'bg-gray-400 border border-dashed border-gray-500' :
          node.status === 'developing' ? 'bg-orange-400' :
          node.status === 'confirmed' ? 'bg-blue-400' :
          node.status === 'draft' ? 'bg-gray-300' :
          node.status === 'testing' ? 'bg-purple-400' :
          node.status === 'review' ? 'bg-cyan-400' :
          node.status === 'published' ? 'bg-green-400' :
          'bg-gray-300'
        }`}
      />
      <span className="text-[10px] text-muted-foreground uppercase shrink-0 w-4">
        {node.type === 'module' ? 'M' : node.type === 'process' ? 'P' : node.type === 'feature' ? 'F' : node.type === 'bug' ? 'B' : 'P'}
      </span>
      <span className="truncate">{node.title}</span>
    </div>
  )
}

export function TreeView() {
  const projects = useFileTreeStore((s) => s.projects)
  const nodes = useGraphStore((s) => s.nodes)
  const { t, locale } = useI18n()

  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<'name' | 'type' | 'status' | 'modified'>('name')

  const filteredNodes = useMemo(() => {
    let result = nodes

    if (statusFilter !== 'all') {
      result = result.filter((n: GraphNode) => n.status === statusFilter)
    }
    if (typeFilter !== 'all') {
      result = result.filter((n: GraphNode) => n.type === typeFilter)
    }

    result = [...result].sort((a: GraphNode, b: GraphNode) => {
      switch (sortBy) {
        case 'name':
          return a.title.localeCompare(b.title)
        case 'type':
          return a.type.localeCompare(b.type) || a.title.localeCompare(b.title)
        case 'status':
          return a.status.localeCompare(b.status) || a.title.localeCompare(b.title)
        case 'modified':
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        default:
          return 0
      }
    })

    return result
  }, [nodes, statusFilter, typeFilter, sortBy])

  const hasGraphNodes = nodes.length > 0

  const parentRef = useRef<HTMLDivElement>(null)
  const shouldVirtualize = filteredNodes.length > 100
  const virtualizer = useVirtualizer({
    count: filteredNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    enabled: shouldVirtualize,
  })

  return (
    <div className="flex-1 overflow-y-auto flex flex-col">
      {/* 筛选 / 排序工具栏 */}
      {hasGraphNodes && (
        <div className="flex gap-1 px-2 py-1 border-b border-border text-[10px] shrink-0">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-transparent border border-border rounded px-1 py-0.5 text-muted-foreground"
          >
            <option value="all">{t('projects.tree.filterAllStatus')}</option>
            <option value="placeholder">{nodeStatusLabel('placeholder', locale)}</option>
            <option value="developing">{nodeStatusLabel('developing', locale)}</option>
            <option value="confirmed">{nodeStatusLabel('confirmed', locale)}</option>
            <option value="draft">{nodeStatusLabel('draft', locale)}</option>
            <option value="testing">{nodeStatusLabel('testing', locale)}</option>
            <option value="review">{nodeStatusLabel('review', locale)}</option>
            <option value="published">{nodeStatusLabel('published', locale)}</option>
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="bg-transparent border border-border rounded px-1 py-0.5 text-muted-foreground"
          >
            <option value="all">{t('projects.tree.filterAllTypes')}</option>
            <option value="module">{nodeTypeLabel('module', locale)}</option>
            <option value="process">{nodeTypeLabel('process', locale)}</option>
            <option value="feature">{nodeTypeLabel('feature', locale)}</option>
            <option value="bug">{nodeTypeLabel('bug', locale)}</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'name' | 'type' | 'status' | 'modified')}
            className="bg-transparent border border-border rounded px-1 py-0.5 text-muted-foreground"
          >
            <option value="name">{t('projects.tree.sortName')}</option>
            <option value="type">{t('projects.tree.sortType')}</option>
            <option value="status">{t('projects.tree.sortStatus')}</option>
            <option value="modified">{t('projects.tree.sortModified')}</option>
          </select>
        </div>
      )}

      {/* 图节点视图（有图数据时） */}
      {hasGraphNodes && (
        <div ref={parentRef} className="flex-1 overflow-y-auto">
          {filteredNodes.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t('projects.tree.noMatchingNodes')}
            </div>
          )}
          {shouldVirtualize ? (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: 'relative',
                width: '100%',
              }}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const node = filteredNodes[vItem.index]
                return (
                  <div
                    key={node.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${vItem.size}px`,
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    {renderNodeRow(node)}
                  </div>
                )
              })}
            </div>
          ) : (
            filteredNodes.map((node: GraphNode) => renderNodeRow(node))
          )}
        </div>
      )}

      {/* 文件树视图（没有图数据时的回落） */}
      {!hasGraphNodes && (
        <div className="flex-1 overflow-y-auto">
          {projects.map((project) => (
            <div key={project.id} className="mb-1">
              {project.loading && (
                <div className="px-3 py-1 text-xs text-muted-foreground animate-pulse">
                  {t('projects.tree.loadingProject', { name: project.name })}
                </div>
              )}
              {project.root && (
                <TreeNodeItem node={project.root} depth={0} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
