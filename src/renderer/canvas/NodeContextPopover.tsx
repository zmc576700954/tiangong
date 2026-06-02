import { useState, useEffect, useRef } from 'react'
import { X, FileText, Type, Search, Plus } from 'lucide-react'
import type { ContextRef } from '@shared/types'

interface NodeContextPopoverProps {
  x: number
  y: number
  existingContexts: ContextRef[]
  projectPath?: string
  onSave: (contexts: ContextRef[]) => void
  onClose: () => void
}

export function NodeContextPopover({ x, y, existingContexts, projectPath, onSave, onClose }: NodeContextPopoverProps) {
  const [contexts, setContexts] = useState<ContextRef[]>(existingContexts)
  const [mode, setMode] = useState<'file' | 'text'>('file')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ name: string; path: string }[]>([])
  const [textValue, setTextValue] = useState('')
  const [textLabel, setTextLabel] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Click outside to close
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as HTMLElement)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [onClose])

  // File search with debounce
  useEffect(() => {
    if (mode !== 'file' || !searchQuery.trim() || !projectPath) {
      setSearchResults([])
      return
    }
    const timer = setTimeout(async () => {
      setIsSearching(true)
      try {
        const results = await window.electronAPI['fs:searchFiles'](projectPath, searchQuery)
        setSearchResults(results.slice(0, 10))
      } catch {
        setSearchResults([])
      }
      setIsSearching(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, mode, projectPath])

  const addFileContext = (file: { name: string; path: string }) => {
    const id = `ctx-file-${Date.now()}`
    const ref: ContextRef = { type: 'file', id, label: file.name, source: 'user-attach' }
    if (!contexts.some((c) => c.type === 'file' && c.label === file.name)) {
      setContexts([...contexts, ref])
    }
    setSearchQuery('')
    setSearchResults([])
  }

  const addTextContext = () => {
    if (!textValue.trim()) return
    const id = `ctx-text-${Date.now()}`
    const ref: ContextRef = {
      type: 'text',
      id,
      label: textLabel.trim() || textValue.trim().slice(0, 30),
      content: textValue.trim(),
      source: 'user-attach',
    }
    setContexts([...contexts, ref])
    setTextValue('')
    setTextLabel('')
  }

  const removeContext = (id: string) => {
    setContexts(contexts.filter((c) => c.id !== id))
  }

  return (
    <div
      ref={popoverRef}
      className="absolute z-50 bg-background border rounded-lg shadow-xl w-72"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-xs font-medium">添加上下文</span>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-muted">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Mode tabs */}
      <div className="flex border-b">
        <button
          onClick={() => setMode('file')}
          className={`flex-1 px-3 py-1.5 text-[11px] flex items-center justify-center gap-1 transition-colors ${
            mode === 'file' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          <FileText className="w-3 h-3" />
          文件
        </button>
        <button
          onClick={() => setMode('text')}
          className={`flex-1 px-3 py-1.5 text-[11px] flex items-center justify-center gap-1 transition-colors ${
            mode === 'text' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          <Type className="w-3 h-3" />
          文本
        </button>
      </div>

      <div className="p-2 space-y-2">
        {mode === 'file' ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 px-2 py-1 border rounded bg-background">
              <Search className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索项目文件..."
                className="flex-1 text-xs bg-transparent outline-none"
              />
            </div>
            {isSearching && <div className="text-[10px] text-muted-foreground px-2">搜索中...</div>}
            {searchResults.map((file) => (
              <button
                key={file.path}
                onClick={() => addFileContext(file)}
                className="w-full text-left px-2 py-1 text-xs rounded hover:bg-muted flex items-center gap-1.5 transition-colors"
              >
                <FileText className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <span className="truncate">{file.name}</span>
                <span className="text-[9px] text-muted-foreground truncate ml-auto">{file.path}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-1.5">
            <input
              type="text"
              value={textLabel}
              onChange={(e) => setTextLabel(e.target.value)}
              placeholder="标题（可选）"
              className="w-full px-2 py-1 text-xs border rounded bg-background"
            />
            <textarea
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder="输入业务约束、技术要求等..."
              rows={3}
              className="w-full px-2 py-1 text-xs border rounded bg-background resize-none"
            />
            <button
              onClick={addTextContext}
              disabled={!textValue.trim()}
              className="w-full px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
            >
              <Plus className="w-3 h-3" />
              添加文本
            </button>
          </div>
        )}

        {/* Existing contexts list */}
        {contexts.length > 0 && (
          <div className="border-t pt-2 space-y-1">
            <div className="text-[10px] text-muted-foreground px-1">已添加 ({contexts.length})</div>
            {contexts.map((ctx) => (
              <div key={ctx.id} className="flex items-center gap-1.5 px-2 py-1 text-xs bg-muted/50 rounded group">
                {ctx.type === 'file' ? (
                  <FileText className="w-3 h-3 text-blue-500 flex-shrink-0" />
                ) : ctx.type === 'text' ? (
                  <Type className="w-3 h-3 text-amber-500 flex-shrink-0" />
                ) : (
                  <FileText className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                )}
                <span className="truncate flex-1">{ctx.label}</span>
                <button
                  onClick={() => removeContext(ctx.id)}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-destructive transition-opacity"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save button */}
      <div className="border-t px-2 py-1.5 flex justify-end gap-1.5">
        <button
          onClick={onClose}
          className="px-2.5 py-1 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          取消
        </button>
        <button
          onClick={() => { onSave(contexts); onClose() }}
          className="px-2.5 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          保存
        </button>
      </div>
    </div>
  )
}
