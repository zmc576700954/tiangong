import { useState } from 'react'
import { FolderTree, FileCode, ChevronRight, ChevronDown } from 'lucide-react'

interface FileEntry {
  name: string
  isDirectory: boolean
  children?: FileEntry[]
  expanded?: boolean
}

export function LeftPanel() {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [currentPath, setCurrentPath] = useState('')

  const toggleExpand = (index: number) => {
    setEntries((prev) =>
      prev.map((e, i) =>
        i === index ? { ...e, expanded: !e.expanded } : e,
      ),
    )
  }

  return (
    <div className="h-full flex flex-col border-r bg-background">
      {/* 标题栏 */}
      <div className="h-10 border-b flex items-center px-3 gap-2 flex-shrink-0">
        <FolderTree className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">项目目录</span>
      </div>

      {/* 文件树 */}
      <div className="flex-1 overflow-y-auto p-2">
        {entries.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm py-8">
            <FileCode className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>选择一个项目目录</p>
            <p className="text-xs mt-1">以浏览文件结构</p>
          </div>
        ) : (
          <FileTree entries={entries} onToggle={toggleExpand} />
        )}
      </div>
    </div>
  )
}

function FileTree({
  entries,
  onToggle,
  depth = 0,
}: {
  entries: FileEntry[]
  onToggle: (index: number) => void
  depth?: number
}) {
  return (
    <div className="space-y-0.5">
      {entries.map((entry, index) => (
        <div key={entry.name}>
          <div
            className="flex items-center gap-1 px-2 py-1 rounded text-sm hover:bg-muted cursor-pointer transition-colors"
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            onClick={() => entry.isDirectory && onToggle(index)}
          >
            {entry.isDirectory ? (
              entry.expanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              )
            ) : (
              <span className="w-3.5 flex-shrink-0" />
            )}
            {entry.isDirectory ? (
              <FolderTree className="w-3.5 h-3.5 text-primary flex-shrink-0" />
            ) : (
              <FileCode className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            )}
            <span className="truncate">{entry.name}</span>
          </div>
          {entry.isDirectory && entry.expanded && entry.children && (
            <FileTree
              entries={entry.children}
              onToggle={onToggle}
              depth={depth + 1}
            />
          )}
        </div>
      ))}
    </div>
  )
}
