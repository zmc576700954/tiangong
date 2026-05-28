import { useState, useEffect, useCallback } from 'react'
import {
  FolderTree,
  FileCode,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  X,
  Plus,
  Sparkles,
  Loader2,
  Settings,
} from 'lucide-react'
import { cn, formatDate } from '../lib/utils'
import { useGraphStore } from '../store/graphStore'
import { SettingsPanel } from './SettingsPanel'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  expanded?: boolean
  children?: FileEntry[]
}

interface ProjectDir {
  id: string
  name: string
  path: string
  entries: FileEntry[]
  expanded: boolean
  scannedAt?: number
}

const ipc = typeof window !== 'undefined' && window.electronAPI
  ? window.electronAPI
  : null

const STORAGE_KEY = 'bizgraph:projects'

function loadSavedProjects(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveProjects(paths: string[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(paths))
}

export function LeftPanel() {
  const [projects, setProjects] = useState<ProjectDir[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [scanningId, setScanningId] = useState<string | null>(null)
  const { loadGraphs } = useGraphStore()

  const loadDirectory = useCallback(async (dirPath: string): Promise<FileEntry[]> => {
    if (!ipc) return []
    const rawEntries = await ipc['fs:readDir'](dirPath)
    const sorted = rawEntries
      .filter((e: { name: string }) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort((a: { isDirectory: boolean }, b: { isDirectory: boolean }) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return 0
      })
    return sorted.map((e: { name: string; isDirectory: boolean }) => ({
      name: e.name,
      path: `${dirPath}/${e.name}`,
      isDirectory: e.isDirectory,
      expanded: false,
      children: e.isDirectory ? [] : undefined,
    }))
  }, [])

  const addProject = useCallback(async (dirPath: string) => {
    const name = dirPath.split(/[\\/]/).pop() || dirPath
    // 注册路径到主进程后再读取目录
    await ipc?.['fs:registerProjectPaths']([dirPath])
    const entries = await loadDirectory(dirPath)
    const newProject: ProjectDir = {
      id: `proj-${Date.now()}`,
      name,
      path: dirPath,
      entries,
      expanded: true,
    }
    setProjects((prev) => {
      const next = [...prev, newProject]
      saveProjects(next.map((p) => p.path))
      return next
    })
  }, [loadDirectory])

  const handleOpenDirectory = useCallback(async () => {
    if (!ipc) return
    try {
      const dirPath = await ipc['dialog:openDirectory']()
      if (!dirPath) return
      const exists = projects.some((p) => p.path === dirPath)
      if (exists) {
        setError('Project already added')
        setTimeout(() => setError(null), 2000)
        return
      }
      await addProject(dirPath)
    } catch (err) {
      setError(String(err))
      setTimeout(() => setError(null), 3000)
    }
  }, [projects, addProject])

  const removeProject = useCallback((id: string) => {
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id)
      saveProjects(next.map((p) => p.path))
      return next
    })
  }, [])

  const toggleProject = useCallback((id: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, expanded: !p.expanded } : p))
    )
  }, [])

  useEffect(() => {
    const savedPaths = loadSavedProjects()
    if (savedPaths.length > 0) {
      // 先将 localStorage 保存的项目路径注册到主进程，避免路径校验拒绝
      ipc?.['fs:registerProjectPaths'](savedPaths).then(() =>
        Promise.all(
          savedPaths.map(async (dirPath: string) => {
            const name = dirPath.split(/[\\/]/).pop() || dirPath
            const entries = await loadDirectory(dirPath)
            return { id: `proj-${dirPath}`, name, path: dirPath, entries, expanded: false }
          })
        ).then((loaded) => setProjects(loaded))
      )
    }
  }, [loadDirectory])

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

      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId ? { ...p, scannedAt: Date.now() } : p
        )
      )
    } catch (err) {
      setError(`Scan failed: ${err}`)
      setTimeout(() => setError(null), 3000)
    } finally {
      setScanningId(null)
    }
  }, [projects, loadGraphs])

  const toggleExpand = useCallback(
    async (projectId: string, entryPath: string) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p
          return {
            ...p,
            entries: toggleEntryExpand(p.entries, entryPath),
          }
        })
      )
    },
    [loadDirectory]
  )

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
          const path = e.dataTransfer.getData('text/plain') || (entry as any).path
          if (path) await addProject(path)
        }
      }
    },
    [addProject]
  )

  return (
    <div
      className={cn(
        'h-full flex flex-col border-r bg-background relative',
        isDragOver && 'ring-2 ring-primary/50',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="h-10 border-b flex items-center justify-between px-3 flex-shrink-0">
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

      {/* Error */}
      {error && (
        <div className="px-3 py-1.5 text-xs bg-destructive/10 text-destructive border-b flex items-center gap-1">
          <X className="w-3 h-3" />
          {error}
        </div>
      )}

      {/* Project list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {projects.length === 0 && (
          <div className="text-center text-muted-foreground text-xs py-8 px-4">
            <FolderOpen className="w-6 h-6 mx-auto mb-2 opacity-50" />
            <p>No projects yet</p>
            <p className="mt-1">Click + to open a directory</p>
          </div>
        )}

        {projects.map((project) => (
          <div key={project.id} className="space-y-0.5">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-muted group">
              <button
                onClick={() => toggleProject(project.id)}
                className="p-0.5 rounded hover:bg-muted-foreground/10"
              >
                {project.expanded ? (
                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                )}
              </button>
              <FolderTree className="w-3.5 h-3.5 text-primary flex-shrink-0" />
              <span className="text-sm font-medium truncate flex-1">{project.name}</span>
              <button
                onClick={() => handleScanProject(project.id)}
                disabled={scanningId === project.id}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-primary/10 text-primary transition-opacity"
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
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 text-destructive transition-opacity"
                title="Remove"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {project.expanded && (
              <div className="pl-5">
                <FileTree
                  entries={project.entries}
                  projectId={project.id}
                  onToggle={toggleExpand}
                />
                {project.scannedAt && (
                  <div className="text-[10px] text-muted-foreground px-2 py-0.5">
                    Scanned {formatDate(new Date(project.scannedAt))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Settings Overlay */}
      {showSettings && (
        <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur flex flex-col">
          <div className="h-10 border-b flex items-center justify-between px-3 flex-shrink-0">
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

function FileTree({
  entries,
  projectId,
  onToggle,
}: {
  entries: FileEntry[]
  projectId: string
  onToggle: (projectId: string, entryPath: string) => void
}) {
  return (
    <div className="space-y-0.5">
      {entries.map((entry) => (
        <div key={entry.path}>
          <div
            className="flex items-center gap-1 px-2 py-0.5 rounded text-sm hover:bg-muted cursor-pointer transition-colors"
            onClick={() => entry.isDirectory && onToggle(projectId, entry.path)}
          >
            {entry.isDirectory ? (
              entry.expanded ? (
                <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              )
            ) : (
              <span className="w-3 flex-shrink-0" />
            )}
            {entry.isDirectory ? (
              <FolderTree className="w-3 h-3 text-primary flex-shrink-0" />
            ) : (
              <FileCode className="w-3 h-3 text-muted-foreground flex-shrink-0" />
            )}
            <span className="truncate">{entry.name}</span>
          </div>
          {entry.isDirectory && entry.expanded && entry.children && entry.children.length > 0 && (
            <div className="pl-4">
              <FileTree entries={entry.children} projectId={projectId} onToggle={onToggle} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function toggleEntryExpand(
  entries: FileEntry[],
  targetPath: string,
): FileEntry[] {
  return entries.map((entry) => {
    if (entry.path === targetPath) {
      return { ...entry, expanded: !entry.expanded }
    }
    if (entry.children) {
      return {
        ...entry,
        children: toggleEntryExpand(entry.children, targetPath),
      }
    }
    return entry
  })
}
