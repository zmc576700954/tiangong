/**
 * File Tree Store — 文件树状态管理（Zustand + localStorage 持久化）
 *
 * 功能：
 * - 展开/折叠状态持久化
 * - 搜索过滤
 * - 剪贴板（剪切/复制/粘贴）
 * - 多选
 * - 重命名
 * - 拖拽
 */

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { enableMapSet } from 'immer'

enableMapSet()
import {
  type TreeNode,
  path,
  loadTreeRecursive,
  loadChildrenForNode,
  collectAllDirPaths,
  findNodeByPath,
  findAndUpdateNode,
  flattenVisible,
} from './fileTreeUtils'

export type { TreeNode } from './fileTreeUtils'

const ipc = typeof window !== 'undefined' && window.electronAPI
  ? window.electronAPI
  : null

// Module-level toast timer for cleanup
let toastTimer: ReturnType<typeof setTimeout> | undefined

// ---- 持久化 key ----
const EXPANDED_PATHS_KEY = 'bizgraph:expandedPaths'

function loadExpandedPaths(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_PATHS_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(arr)
  } catch {
    return new Set()
  }
}

function saveExpandedPaths(paths: Set<string>) {
  localStorage.setItem(EXPANDED_PATHS_KEY, JSON.stringify([...paths]))
}

// ---- 剪贴板 ----
interface Clipboard {
  type: 'copy' | 'cut'
  sourcePaths: string[]
}

// ---- Store ----
interface FileTreeState {
  // 项目列表
  projects: { id: string; name: string; path: string; root: TreeNode | null; loading: boolean }[]

  // 展开的目录路径集合（持久化）
  expandedPaths: Set<string>

  // 当前选中的路径
  selectedPaths: Set<string>
  lastSelectedPath: string | null

  // 搜索
  searchQuery: string
  searchActive: boolean

  // 剪贴板
  clipboard: Clipboard | null

  // 重命名
  renamingPath: string | null

  // 拖拽状态
  dragOverPath: string | null
  draggedPaths: string[]

  // 上下文菜单
  contextMenuPath: string | null
  contextMenuPos: { x: number; y: number } | null

  // 反馈消息
  toast: { message: string; type: 'success' | 'error' } | null

  // ---- Actions ----
  addProject: (dirPath: string) => Promise<void>
  removeProject: (id: string) => void
  loadProjectTree: (projectPath: string) => Promise<void>
  refreshProject: (projectPath: string) => Promise<void>

  toggleExpand: (path: string) => void
  expandAll: (rootPath: string) => void
  collapseAll: () => void

  selectPath: (path: string, multi?: boolean, range?: boolean) => void
  clearSelection: () => void

  setSearchQuery: (q: string) => void
  setSearchActive: (active: boolean) => void

  setClipboard: (type: 'copy' | 'cut', paths: string[]) => void
  paste: (destDir: string) => Promise<void>

  startRename: (path: string) => void
  commitRename: (oldPath: string, newName: string) => Promise<void>
  cancelRename: () => void

  createFile: (parentDir: string, name: string) => Promise<void>
  createDir: (parentDir: string, name: string) => Promise<void>
  deletePaths: (paths: string[]) => Promise<void>

  setDragOver: (path: string | null) => void
  setDraggedPaths: (paths: string[]) => void
  handleDrop: (destDir: string) => Promise<void>

  setContextMenu: (path: string | null, pos?: { x: number; y: number }) => void
  clearToast: () => void
}

export const useFileTreeStore = create<FileTreeState>()(
  immer((set, get) => ({
    projects: [],
    expandedPaths: loadExpandedPaths(),
    selectedPaths: new Set(),
    lastSelectedPath: null,
    searchQuery: '',
    searchActive: false,
    clipboard: null,
    renamingPath: null,
    dragOverPath: null,
    draggedPaths: [],
    contextMenuPath: null,
    contextMenuPos: null,
    toast: null,

    // ---- 项目管理 ----
    addProject: async (dirPath: string) => {
      const { projects } = get()
      if (projects.some((p) => p.path === dirPath)) return

      const name = dirPath.split(/[\\/]/).pop() || dirPath
      const id = `proj-${Date.now()}`

      set((s) => {
        s.projects.push({ id, name, path: dirPath, root: null, loading: true })
      })

      // 保存到 localStorage
      const allPaths = get().projects.map((p) => p.path)
      localStorage.setItem('bizgraph:projects', JSON.stringify(allPaths))

      // 注册到主进程
      await ipc?.['fs:registerProjectPaths']([dirPath])

      // 加载目录树
      await get().loadProjectTree(dirPath)
    },

    removeProject: (id: string) => {
      set((s) => {
        const proj = s.projects.find((p) => p.id === id)
        if (proj) {
          // 清除该项目的展开状态
          const newExpanded = new Set(s.expandedPaths)
          for (const p of newExpanded) {
            if (p.startsWith(proj.path)) newExpanded.delete(p)
          }
          s.expandedPaths = newExpanded
          saveExpandedPaths(newExpanded)
        }
        s.projects = s.projects.filter((p) => p.id !== id)
      })

      const allPaths = get().projects.map((p) => p.path)
      localStorage.setItem('bizgraph:projects', JSON.stringify(allPaths))
    },

    loadProjectTree: async (projectPath: string) => {
      set((s) => {
        const proj = s.projects.find((p) => p.path === projectPath)
        if (proj) proj.loading = true
      })

      try {
        const root = await loadTreeRecursive(projectPath, 0, get().expandedPaths)
        set((s) => {
          const proj = s.projects.find((p) => p.path === projectPath)
          if (proj) {
            proj.root = root
            proj.loading = false
          }
        })
      } catch {
        set((s) => {
          const proj = s.projects.find((p) => p.path === projectPath)
          if (proj) proj.loading = false
        })
      }
    },

    refreshProject: async (projectPath: string) => {
      await get().loadProjectTree(projectPath)
    },

    // ---- 展开/折叠 ----
    toggleExpand: (path: string) => {
      set((s) => {
        const newExpanded = new Set(s.expandedPaths)
        if (newExpanded.has(path)) {
          newExpanded.delete(path)
        } else {
          newExpanded.add(path)
        }
        s.expandedPaths = newExpanded
        saveExpandedPaths(newExpanded)
      })

      // 如果是展开且子节点未加载，则加载
      const { expandedPaths, projects } = get()
      if (expandedPaths.has(path)) {
        const proj = projects.find((p) => {
          const node = findNodeByPath(p.root, path)
          return node !== null
        })
        if (proj) {
          const node = findNodeByPath(proj.root, path)
          if (node && node.isDirectory && node.children && node.children.length === 0) {
            loadChildrenForNode(node.path, true, get().expandedPaths).then((children) => {
              set((s) => {
                const p = s.projects.find((pp) => pp.id === proj.id)
                if (p) {
                  findAndUpdateNode(p.root, node.path, (n) => { n.children = children })
                }
              })
            })
          }
        }
      }
    },

    expandAll: (rootPath: string) => {
      const { projects } = get()
      const proj = projects.find((p) => p.path === rootPath || rootPath.startsWith(p.path))
      if (!proj?.root) return

      const allDirs = collectAllDirPaths(proj.root)
      set((s) => {
        const newExpanded = new Set(s.expandedPaths)
        for (const d of allDirs) newExpanded.add(d)
        s.expandedPaths = newExpanded
        saveExpandedPaths(newExpanded)
      })
    },

    collapseAll: () => {
      set((s) => {
        s.expandedPaths = new Set()
        saveExpandedPaths(new Set())
      })
    },

    // ---- 选择 ----
    selectPath: (path: string, multi = false, range = false) => {
      set((s) => {
        if (range && s.lastSelectedPath) {
          // 范围选择（Shift+Click）- 在同一项目内
          const proj = s.projects.find((p) =>
            path.startsWith(p.path) || s.lastSelectedPath!.startsWith(p.path)
          )
          if (proj?.root) {
            const flat = flattenVisible(proj.root, s.expandedPaths, '')
            const startIdx = flat.findIndex((n) => n.path === s.lastSelectedPath)
            const endIdx = flat.findIndex((n) => n.path === path)
            if (startIdx >= 0 && endIdx >= 0) {
              const from = Math.min(startIdx, endIdx)
              const to = Math.max(startIdx, endIdx)
              s.selectedPaths = new Set(flat.slice(from, to + 1).map((n) => n.path))
              return
            }
          }
        }

        if (multi) {
          const newSelected = new Set(s.selectedPaths)
          if (newSelected.has(path)) {
            newSelected.delete(path)
          } else {
            newSelected.add(path)
          }
          s.selectedPaths = newSelected
        } else {
          s.selectedPaths = new Set([path])
        }
        s.lastSelectedPath = path
      })
    },

    clearSelection: () => {
      set((s) => {
        s.selectedPaths = new Set()
        s.lastSelectedPath = null
      })
    },

    // ---- 搜索 ----
    setSearchQuery: (q: string) => {
      set((s) => { s.searchQuery = q })
    },
    setSearchActive: (active: boolean) => {
      set((s) => {
        s.searchActive = active
        if (!active) s.searchQuery = ''
      })
    },

    // ---- 剪贴板 ----
    setClipboard: (type: 'copy' | 'cut', paths: string[]) => {
      set((s) => { s.clipboard = { type, sourcePaths: paths } })
    },

    paste: async (destDir: string) => {
      const { clipboard } = get()
      if (!clipboard) return

      set((s) => { s.toast = null })

      try {
        for (const sourcePath of clipboard.sourcePaths) {
          if (clipboard.type === 'copy') {
            await ipc?.['fs:copy'](sourcePath, destDir)
          } else {
            await ipc?.['fs:move'](sourcePath, destDir)
          }
        }

        if (clipboard.type === 'cut') {
          set((s) => { s.clipboard = null })
        }

        // 刷新相关项目
        const { projects } = get()
        for (const proj of projects) {
          if (destDir.startsWith(proj.path)) {
            await get().refreshProject(proj.path)
          }
        }

        set((s) => { s.toast = { message: 'Pasted successfully', type: 'success' } })
      } catch (err) {
        set((s) => { s.toast = { message: `Paste failed: ${err}`, type: 'error' } })
      }

      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => get().clearToast(), 3000)
    },

    // ---- 重命名 ----
    startRename: (path: string) => {
      set((s) => { s.renamingPath = path })
    },

    commitRename: async (oldPath: string, newName: string) => {
      const { renamingPath } = get()
      if (!renamingPath || renamingPath !== oldPath) return

      try {
        await ipc?.['fs:rename'](oldPath, newName)
        set((s) => { s.renamingPath = null })

        // 刷新项目
        const { projects } = get()
        for (const proj of projects) {
          if (oldPath.startsWith(proj.path)) {
            await get().refreshProject(proj.path)
          }
        }

        set((s) => { s.toast = { message: 'Renamed successfully', type: 'success' } })
      } catch (err) {
        set((s) => { s.toast = { message: `Rename failed: ${err}`, type: 'error' } })
      }

      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => get().clearToast(), 3000)
    },

    cancelRename: () => {
      set((s) => { s.renamingPath = null })
    },

    // ---- 创建 ----
    createFile: async (parentDir: string, name: string) => {
      try {
        const filePath = `${parentDir}/${name}`
        await ipc?.['fs:createFile'](filePath)

        const { projects } = get()
        for (const proj of projects) {
          if (parentDir.startsWith(proj.path)) {
            // 确保父目录展开
            set((s) => {
              const newExpanded = new Set(s.expandedPaths)
              newExpanded.add(parentDir)
              s.expandedPaths = newExpanded
              saveExpandedPaths(newExpanded)
            })
            await get().refreshProject(proj.path)
          }
        }

        set((s) => { s.toast = { message: `Created file: ${name}`, type: 'success' } })
      } catch (err) {
        set((s) => { s.toast = { message: `Create file failed: ${err}`, type: 'error' } })
      }

      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => get().clearToast(), 3000)
    },

    createDir: async (parentDir: string, name: string) => {
      try {
        const dirPath = `${parentDir}/${name}`
        await ipc?.['fs:createDir'](dirPath)

        const { projects } = get()
        for (const proj of projects) {
          if (parentDir.startsWith(proj.path)) {
            set((s) => {
              const newExpanded = new Set(s.expandedPaths)
              newExpanded.add(parentDir)
              s.expandedPaths = newExpanded
              saveExpandedPaths(newExpanded)
            })
            await get().refreshProject(proj.path)
          }
        }

        set((s) => { s.toast = { message: `Created folder: ${name}`, type: 'success' } })
      } catch (err) {
        set((s) => { s.toast = { message: `Create folder failed: ${err}`, type: 'error' } })
      }

      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => get().clearToast(), 3000)
    },

    // ---- 删除 ----
    deletePaths: async (paths: string[]) => {
      try {
        for (const p of paths) {
          await ipc?.['fs:delete'](p, true)
        }

        // 清除选中
        set((s) => {
          s.selectedPaths = new Set()
          s.lastSelectedPath = null
        })

        // 刷新项目
        const { projects } = get()
        const affectedProjectPaths = new Set<string>()
        for (const p of paths) {
          for (const proj of projects) {
            if (p.startsWith(proj.path)) affectedProjectPaths.add(proj.path)
          }
        }
        for (const projPath of affectedProjectPaths) {
          await get().refreshProject(projPath)
        }

        set((s) => { s.toast = { message: `Deleted ${paths.length} item(s)`, type: 'success' } })
      } catch (err) {
        set((s) => { s.toast = { message: `Delete failed: ${err}`, type: 'error' } })
      }

      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => get().clearToast(), 3000)
    },

    // ---- 拖拽 ----
    setDragOver: (path: string | null) => {
      set((s) => { s.dragOverPath = path })
    },
    setDraggedPaths: (paths: string[]) => {
      set((s) => { s.draggedPaths = paths })
    },
    handleDrop: async (destDir: string) => {
      const { draggedPaths } = get()
      if (draggedPaths.length === 0) return

      try {
        for (const sourcePath of draggedPaths) {
          // 不能拖到自己内部
          if (destDir.startsWith(sourcePath)) continue
          if (destDir === path.dirname(sourcePath)) continue // 同目录不处理
          await ipc?.['fs:move'](sourcePath, destDir)
        }

        set((s) => {
          s.draggedPaths = []
          s.dragOverPath = null
        })

        // 刷新项目
        const { projects } = get()
        const affectedProjectPaths = new Set<string>()
        for (const p of [...draggedPaths, destDir]) {
          for (const proj of projects) {
            if (p.startsWith(proj.path)) affectedProjectPaths.add(proj.path)
          }
        }
        for (const projPath of affectedProjectPaths) {
          await get().refreshProject(projPath)
        }

        set((s) => { s.toast = { message: 'Moved successfully', type: 'success' } })
      } catch (err) {
        set((s) => { s.toast = { message: `Move failed: ${err}`, type: 'error' } })
      }

      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => get().clearToast(), 3000)
    },

    // ---- 上下文菜单 ----
    setContextMenu: (path: string | null, pos?: { x: number; y: number }) => {
      set((s) => {
        s.contextMenuPath = path
        s.contextMenuPos = pos || null
      })
    },

    clearToast: () => {
      set((s) => { s.toast = null })
    },
  })),
)

