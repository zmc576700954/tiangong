import { memo, useCallback } from 'react'
import {
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Folder,
  FileCode,
  File,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { useFileTreeStore } from '../store/fileTreeStore'
import type { TreeNode } from '../store/fileTreeStore'

function getFileIcon(name: string) {
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return FileCode
  if (name.endsWith('.js') || name.endsWith('.jsx')) return FileCode
  if (name.endsWith('.json')) return FileCode
  if (name.endsWith('.md')) return File
  return File
}

export const TreeNodeItem = memo(function TreeNodeItem({
  node,
  depth,
}: {
  node: TreeNode
  depth: number
}) {
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths)
  const selectedPaths = useFileTreeStore((s) => s.selectedPaths)
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand)
  const selectPath = useFileTreeStore((s) => s.selectPath)
  const setContextMenu = useFileTreeStore((s) => s.setContextMenu)

  const isExpanded = expandedPaths.has(node.path)
  const isSelected = selectedPaths.has(node.path)

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (node.isDirectory) {
        toggleExpand(node.path)
      }
      selectPath(node.path, e.ctrlKey || e.metaKey, e.shiftKey)
    },
    [node.isDirectory, node.path, toggleExpand, selectPath],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!selectedPaths.has(node.path)) {
        selectPath(node.path)
      }
      setContextMenu(node.path, { x: e.clientX, y: e.clientY })
    },
    [node.path, selectedPaths, selectPath, setContextMenu],
  )

  const Icon = node.isDirectory
    ? isExpanded
      ? FolderOpen
      : Folder
    : getFileIcon(node.name)

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded text-sm cursor-pointer transition-colors',
          'hover:bg-muted',
          isSelected && 'bg-primary/10 text-primary',
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {node.isDirectory ? (
          isExpanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Icon
          className={cn(
            'w-3.5 h-3.5 shrink-0',
            node.isDirectory ? 'text-primary' : 'text-muted-foreground',
          )}
        />
        <span className="truncate">{node.name}</span>
      </div>

      {node.isDirectory && isExpanded && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeNodeItem key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
})
