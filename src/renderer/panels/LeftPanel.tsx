import { useEffect, useCallback, useRef, useState } from 'react'
import {
  FolderOpen,
  Plus,
  Sparkles,
  Loader2,
  Settings,
  X,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { useFileTreeStore } from '../store/fileTreeStore'
import { useGraphStore } from '../store/graphStore'
import { useFileTreeKeyboard } from '../store/fileTreeUtils'
import { TreeNodeItem } from './TreeNodeItem'
import { FileTreeContextMenu } from './FileTreeContextMenu'
import { SettingsPanel } from './SettingsPanel'

const ipc = typeof window !== 'undefined' && window.electronAPI
  ? window.electronAPI
  : null

export function LeftPanel() {
  const projects = useFileTreeStore((s) => s.projects)
  const addProject = useFileTreeStore((s) => s.addProject)
  const removeProject = useFileTreeStore((s) => s.removeProject)
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand)
  const toast = useFileTreeStore((s) => s.toast)
  const clearToast = useFileTreeStore((s) => s.clearToast)

  const { loadGraphs } = useGraphStore()

  const [isDragOver, setIsDragOver] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [scanningId, setScanningId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Keyboard shortcuts (Ctrl+C, Ctrl+V, Delete, Arrow keys, etc.)
  useFileTreeKeyboard(panelRef)

  // Load saved projects on mount
  useEffect(() => {
    const STORAGE_KEY = 'bizgraph:projects'
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const paths = JSON.parse(raw) as string[]
      if (paths.length > 0) {
        ipc?.['fs:registerProjectPaths'](paths).then(() => {
          for (const dirPath of paths) {
            useFileTreeStore.getState().addProject(dirPath)
          }
        })
      }
    } catch {
      // ignore
    }
  }, [])

  // Auto-clear toast
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(clearToast, 3000)
    return () => clearTimeout(timer)
  }, [toast, clearToast])

  const handleOpenDirectory = useCallback(async () => {
    if (!ipc) return
    try {
      const dirPath = await ipc['dialog:openDirectory']()
      if (!dirPath) return
      if (projects.some((p) => p.path === dirPath)) return
      await addProject(dirPath)
    } catch {
      // handled by store
    }
  }, [projects, addProject])

  const handleScanProject = useCallback(async (projectId: string) => {
    if (!ipc) return
    const project = projects.find((p) => p.id === projectId)
    if (!project) return

    setScanningId(projectId)
    try {
      const result = await ipc['graph:initFromProject']({
        projectPath: project.path,
        projectName: project.name,
      })

      const { setCurrentGraph } = useGraphStore.getState()
      setCurrentGraph(result.onlineGraph.id)
      await loadGraphs()
    } catch {
      // handled by store
    } finally {
      setScanningId(null)
    }
  }, [projects, loadGraphs])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      const items = Array.from(e.dataTransfer.items)
      for (const item of items) {
        const entry = item.webkitGetAsEntry?.()
        if (entry?.isDirectory) {
          const path = e.dataTransfer.getData('text/plain') || (entry as { path?: string }).path
          if (path) await addProject(path)
        }
      }
    },
    [addProject],
  )

  // Use store's expandedPaths to check project expansion
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths)

  return (
    <div
      ref={panelRef}
      className={cn(
        'h-full flex flex-col border-r bg-background relative',
        isDragOver && 'ring-2 ring-primary/50',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="h-10 border-b flex items-center justify-between px-3 shrink-0">
        <span className="text-sm font-semibold">Projects</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded hover:bg-muted transition-colors"
            title="Settings"
          >
            <Settings className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={handleOpenDirectory}
            className="p-1.5 rounded hover:bg-muted transition-colors"
            title="Open directory"
          >
            <Plus className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            'px-3 py-1.5 text-xs border-b flex items-center gap-1',
            toast.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-green-50 text-green-700',
          )}
        >
          <X className="w-3 h-3 cursor-pointer" onClick={clearToast} />
          {toast.message}
        </div>
      )}

      {/* Empty state */}
      {projects.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-xs px-4">
          <FolderOpen className="w-6 h-6 mb-2 opacity-50" />
          <p>No projects yet</p>
          <p className="mt-1">Click + to open a directory</p>
        </div>
      )}

      {/* Project list + tree */}
      {projects.length > 0 && (
        <div className="flex-1 overflow-y-auto p-2">
          {projects.map((project) => {
            const isProjectExpanded = expandedPaths.has(project.path)
            return (
              <div key={project.id} className="mb-2">
                {/* Project header */}
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-muted group">
                  <button
                    onClick={() => toggleExpand(project.path)}
                    className="p-0.5 rounded hover:bg-muted-foreground/10"
                  >
                    {isProjectExpanded ? (
                      <svg className="w-3 h-3 text-muted-foreground" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3 text-muted-foreground" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M6 4l4 4-4 4" />
                      </svg>
                    )}
                  </button>
                  <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="text-sm font-medium truncate flex-1">{project.name}</span>
                  <button
                    onClick={() => handleScanProject(project.id)}
                    disabled={scanningId === project.id}
                    className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 focus:opacity-100 p-0.5 rounded hover:bg-primary/10 text-primary transition-opacity"
                    title="Generate mind map"
                  >
                    {scanningId === project.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Sparkles className="w-3 h-3" />
                    )}
                  </button>
                  <button
                    onClick={() => removeProject(project.id)}
                    className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 focus:opacity-100 p-0.5 rounded hover:bg-destructive/10 text-destructive transition-opacity"
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>

                {/* Tree children */}
                {isProjectExpanded && project.root && (
                  <div className="ml-2">
                    {project.root.children?.map((child) => (
                      <TreeNodeItem key={child.path} node={child} depth={1} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Context Menu (rendered at portal level) */}
      <FileTreeContextMenu />

      {/* Settings Overlay */}
      {showSettings && (
        <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur flex flex-col">
          <div className="h-10 border-b flex items-center justify-between px-3 shrink-0">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Settings</span>
            </div>
            <button
              onClick={() => setShowSettings(false)}
              className="p-1 rounded hover:bg-muted transition-colors"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <SettingsPanel />
          </div>
        </div>
      )}
    </div>
  )
}
