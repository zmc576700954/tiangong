/**
 * File Tree Utilities — 文件树辅助函数和键盘 Hook
 *
 * 从 fileTreeStore.ts 提取，包含：
 * - 路径处理工具（兼容 Windows/POSIX，不依赖 Node.js）
 * - 树加载/查找/扁平化
 * - 键盘导航 Hook
 */

import { useEffect, type RefObject } from 'react'
import { useFileTreeStore } from './fileTreeStore'

// ---- 树节点 ----
export interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: TreeNode[]
  size?: number
  mtimeMs?: number
}

const ipc = typeof window !== 'undefined' && window.electronAPI
  ? window.electronAPI
  : null

// ---- 路径处理（不依赖 Node.js path 模块，兼容 Windows 和 POSIX） ----

export const path = {
  dirname(p: string): string {
    const normalized = p.replace(/\\/g, '/')
    const lastSlash = normalized.lastIndexOf('/')
    if (lastSlash <= 0) return p.slice(0, 1) || '/'
    return p.slice(0, lastSlash)
  },
  basename(p: string): string {
    const normalized = p.replace(/\\/g, '/')
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash < 0 ? p : p.slice(lastSlash + 1)
  },
}

export function pathDirname(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash <= 0) return p.slice(0, 1) || '/'
  return p.slice(0, lastSlash)
}

// ---- 树加载 ----

/** 递归加载目录树 */
export async function loadTreeRecursive(
  dirPath: string,
  depth: number,
  expandedPaths: Set<string>,
  maxDepth = 10,
): Promise<TreeNode> {
  const name = dirPath.split(/[\\/]/).pop() || dirPath

  if (depth >= maxDepth) {
    return { name, path: dirPath, isDirectory: true, children: [] }
  }

  let children: TreeNode[] = []
  if (ipc) {
    try {
      const entries = await ipc['fs:readDirDetail'](dirPath)
      const filtered = entries
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__')
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })

      children = await Promise.all(
        filtered.map(async (entry) => {
          if (entry.isDirectory && expandedPaths.has(entry.path)) {
            return loadTreeRecursive(entry.path, depth + 1, expandedPaths, maxDepth)
          }
          return {
            name: entry.name,
            path: entry.path,
            isDirectory: entry.isDirectory,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            children: entry.isDirectory ? [] : undefined,
          }
        }),
      )
    } catch {
      // 忽略权限错误
    }
  }

  return { name, path: dirPath, isDirectory: true, children }
}

/** 为已展开但子节点为空的目录加载子节点，返回子节点数组（不直接修改 node） */
export async function loadChildrenForNode(
  nodePath: string,
  nodeIsDirectory: boolean,
  expandedPaths: Set<string>,
): Promise<TreeNode[]> {
  if (!nodeIsDirectory || !ipc) return []

  try {
    const entries = await ipc['fs:readDirDetail'](nodePath)
    const filtered = entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__')
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })

    return await Promise.all(
      filtered.map(async (entry) => {
        if (entry.isDirectory && expandedPaths.has(entry.path)) {
          const childNode: TreeNode = {
            name: entry.name,
            path: entry.path,
            isDirectory: true,
            children: [],
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          }
          childNode.children = await loadChildrenForNode(entry.path, true, expandedPaths)
          return childNode
        }
        return {
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          children: entry.isDirectory ? [] : undefined,
        }
      }),
    )
  } catch {
    return []
  }
}

// ---- 树操作 ----

/** 递归收集所有目录路径 */
export function collectAllDirPaths(node: TreeNode): string[] {
  const paths: string[] = []
  if (node.isDirectory) {
    paths.push(node.path)
    if (node.children) {
      for (const child of node.children) {
        paths.push(...collectAllDirPaths(child))
      }
    }
  }
  return paths
}

/** 根据路径查找节点 */
export function findNodeByPath(root: TreeNode | null, targetPath: string): TreeNode | null {
  if (!root) return null
  if (root.path === targetPath) return root
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeByPath(child, targetPath)
      if (found) return found
    }
  }
  return null
}

/** 查找节点并就地修改（用于 immer set 回调中） */
export function findAndUpdateNode(
  root: TreeNode | null,
  targetPath: string,
  updater: (node: TreeNode) => void,
): boolean {
  if (!root) return false
  if (root.path === targetPath) {
    updater(root)
    return true
  }
  if (root.children) {
    for (const child of root.children) {
      if (findAndUpdateNode(child, targetPath, updater)) return true
    }
  }
  return false
}

/** 将树扁平化为可见节点列表（用于键盘导航、范围选择） */
export function flattenVisible(
  node: TreeNode,
  expandedPaths: Set<string>,
  filterQuery: string,
): TreeNode[] {
  const result: TreeNode[] = []

  function walk(n: TreeNode) {
    // 搜索过滤
    if (filterQuery) {
      const q = filterQuery.toLowerCase()
      const matchesSelf = n.name.toLowerCase().includes(q)
      const matchesChild = n.children?.some((c) => containsMatch(c, q)) ?? false
      if (!matchesSelf && !matchesChild) return
    }

    result.push(n)

    if (n.isDirectory && expandedPaths.has(n.path) && n.children) {
      for (const child of n.children) {
        walk(child)
      }
    }
  }

  walk(node)
  return result
}

function containsMatch(node: TreeNode, query: string): boolean {
  if (node.name.toLowerCase().includes(query)) return true
  if (node.children) {
    return node.children.some((c) => containsMatch(c, query))
  }
  return false
}

export function findNodeInStoreProjects(
  projects: { root: TreeNode | null }[],
  targetPath: string,
): TreeNode | null {
  for (const proj of projects) {
    const found = findNodeByPath(proj.root, targetPath)
    if (found) return found
  }
  return null
}

// ---- Keyboard Shortcut Hook ----

export function useFileTreeKeyboard(panelRef: RefObject<HTMLDivElement | null>) {
  const store = useFileTreeStore

  useEffect(() => {
    const el = panelRef.current
    if (!el) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!el.contains(e.target as Node)) return

      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') {
          const { renamingPath, searchActive } = store.getState()
          if (renamingPath) {
            store.getState().cancelRename()
            e.preventDefault()
          } else if (searchActive) {
            store.getState().setSearchActive(false)
            e.preventDefault()
          }
        }
        return
      }

      const state = store.getState()

      if (e.key === 'Escape') {
        if (state.contextMenuPath) {
          state.setContextMenu(null)
          e.preventDefault()
          return
        }
        if (state.searchActive) {
          state.setSearchActive(false)
          e.preventDefault()
          return
        }
        state.clearSelection()
        e.preventDefault()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        state.setSearchActive(!state.searchActive)
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && state.selectedPaths.size > 0) {
        e.preventDefault()
        state.setClipboard('copy', [...state.selectedPaths])
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'x' && state.selectedPaths.size > 0) {
        e.preventDefault()
        state.setClipboard('cut', [...state.selectedPaths])
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && state.clipboard) {
        e.preventDefault()
        const target = state.lastSelectedPath
        if (target) {
          const node = findNodeInStoreProjects(state.projects, target)
          const destDir = node?.isDirectory ? target : pathDirname(target)
          state.paste(destDir)
        }
        return
      }

      if (e.key === 'F2' && state.lastSelectedPath) {
        e.preventDefault()
        state.startRename(state.lastSelectedPath)
        return
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedPaths.size > 0) {
        e.preventDefault()
        state.deletePaths([...state.selectedPaths])
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const lastPath = state.lastSelectedPath
        if (!lastPath) return
        const proj = state.projects.find((p) => lastPath.startsWith(p.path))
        if (!proj?.root) return
        const flat = flattenVisible(proj.root, state.expandedPaths, state.searchQuery)
        const idx = flat.findIndex((n: TreeNode) => n.path === lastPath)
        const nextIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1
        if (nextIdx >= 0 && nextIdx < flat.length) {
          state.selectPath(flat[nextIdx].path)
        }
        return
      }

      if (e.key === 'ArrowRight' && state.lastSelectedPath) {
        const node = findNodeInStoreProjects(state.projects, state.lastSelectedPath)
        if (node?.isDirectory && !state.expandedPaths.has(state.lastSelectedPath)) {
          e.preventDefault()
          state.toggleExpand(state.lastSelectedPath)
        }
        return
      }

      if (e.key === 'ArrowLeft' && state.lastSelectedPath) {
        e.preventDefault()
        const node = findNodeInStoreProjects(state.projects, state.lastSelectedPath)
        if (node?.isDirectory && state.expandedPaths.has(state.lastSelectedPath)) {
          state.toggleExpand(state.lastSelectedPath)
        } else {
          const parentPath = pathDirname(state.lastSelectedPath)
          if (parentPath !== state.lastSelectedPath) {
            state.selectPath(parentPath)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [panelRef, store])
}
