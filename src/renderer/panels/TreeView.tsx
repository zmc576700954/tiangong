import { useState, useMemo } from 'react'
import { useFileTreeStore } from '../store/fileTreeStore'
import { useGraphStore } from '../store/graphStore'
import { TreeNodeItem } from './TreeNodeItem'
import type { GraphNode } from '@shared/types'

export function TreeView() {
  const projects = useFileTreeStore((s) => s.projects)
  const nodes = useGraphStore((s) => s.nodes)

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

  return (
    <div className="flex-1 overflow-y-auto flex flex-col">
      {/* Filter/sort toolbar */}
      {hasGraphNodes && (
        <div className="flex gap-1 px-2 py-1 border-b border-border text-[10px] shrink-0">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-transparent border border-border rounded px-1 py-0.5 text-muted-foreground"
          >
            <option value="all">All Status</option>
            <option value="placeholder">Placeholder</option>
            <option value="developing">Developing</option>
            <option value="confirmed">Confirmed</option>
            <option value="draft">Draft</option>
            <option value="testing">Testing</option>
            <option value="review">Review</option>
            <option value="published">Published</option>
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="bg-transparent border border-border rounded px-1 py-0.5 text-muted-foreground"
          >
            <option value="all">All Types</option>
            <option value="module">Module</option>
            <option value="process">Process</option>
            <option value="feature">Feature</option>
            <option value="bug">Bug</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'name' | 'type' | 'status' | 'modified')}
            className="bg-transparent border border-border rounded px-1 py-0.5 text-muted-foreground"
          >
            <option value="name">Name</option>
            <option value="type">Type</option>
            <option value="status">Status</option>
            <option value="modified">Modified</option>
          </select>
        </div>
      )}

      {/* Graph nodes view (when graph data is available) */}
      {hasGraphNodes && (
        <div className="flex-1 overflow-y-auto">
          {filteredNodes.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No nodes match the current filters
            </div>
          )}
          {filteredNodes.map((node: GraphNode) => (
            <div
              key={node.id}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-sm cursor-pointer hover:bg-muted"
              style={{ paddingLeft: `${(node.communityLevel ?? 0) * 12 + 8}px` }}
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
          ))}
        </div>
      )}

      {/* File tree view (fallback when no graph data) */}
      {!hasGraphNodes && (
        <div className="flex-1 overflow-y-auto">
          {projects.map((project) => (
            <div key={project.id} className="mb-1">
              {project.loading && (
                <div className="px-3 py-1 text-xs text-muted-foreground animate-pulse">
                  Loading {project.name}...
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
