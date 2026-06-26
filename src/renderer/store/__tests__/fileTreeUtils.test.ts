import { describe, it, expect, vi } from 'vitest'
import {
  path,
  pathDirname,
  collectAllDirPaths,
  findNodeByPath,
  findAndUpdateNode,
  flattenVisible,
  findNodeInStoreProjects,
  loadTreeRecursive,
  loadChildrenForNode,
} from '../fileTreeUtils'
import type { TreeNode } from '../fileTreeUtils'

describe('path utilities', () => {
  it('dirname returns parent path', () => {
    expect(path.dirname('/project/src/utils.ts')).toBe('/project/src')
    expect(path.dirname('C:/project/src/utils.ts')).toBe('C:/project/src')
  })

  it('dirname returns root for top-level path', () => {
    expect(path.dirname('/project')).toBe('/')
  })

  it('basename returns last segment', () => {
    expect(path.basename('/project/src/utils.ts')).toBe('utils.ts')
    expect(path.basename('C:/project/src')).toBe('src')
  })

  it('pathDirname mirrors path.dirname', () => {
    expect(pathDirname('/a/b/c')).toBe('/a/b')
    expect(pathDirname('/a')).toBe('/')
  })
})

describe('collectAllDirPaths', () => {
  it('collects all directory paths recursively', () => {
    const root: TreeNode = {
      name: 'root',
      path: '/root',
      isDirectory: true,
      children: [
        { name: 'src', path: '/root/src', isDirectory: true, children: [{ name: 'main.ts', path: '/root/src/main.ts', isDirectory: false }] },
        { name: 'package.json', path: '/root/package.json', isDirectory: false },
      ],
    }
    expect(collectAllDirPaths(root)).toEqual(['/root', '/root/src'])
  })
})

describe('findNodeByPath', () => {
  const root: TreeNode = {
    name: 'root',
    path: '/root',
    isDirectory: true,
    children: [{ name: 'main.ts', path: '/root/main.ts', isDirectory: false }],
  }

  it('finds root node', () => {
    expect(findNodeByPath(root, '/root')).toBe(root)
  })

  it('finds nested file', () => {
    const found = findNodeByPath(root, '/root/main.ts')
    expect(found?.name).toBe('main.ts')
  })

  it('returns null for missing path', () => {
    expect(findNodeByPath(root, '/root/missing.ts')).toBeNull()
  })

  it('returns null for null root', () => {
    expect(findNodeByPath(null, '/root')).toBeNull()
  })
})

describe('findAndUpdateNode', () => {
  const root: TreeNode = {
    name: 'root',
    path: '/root',
    isDirectory: true,
    children: [{ name: 'main.ts', path: '/root/main.ts', isDirectory: false }],
  }

  it('updates matching node in place', () => {
    const updated = findAndUpdateNode(root, '/root/main.ts', (node) => {
      node.size = 42
    })
    expect(updated).toBe(true)
    expect(findNodeByPath(root, '/root/main.ts')?.size).toBe(42)
  })

  it('returns false when target is missing', () => {
    const updated = findAndUpdateNode(root, '/root/missing.ts', (node) => {
      node.size = 42
    })
    expect(updated).toBe(false)
  })
})

describe('flattenVisible', () => {
  const root: TreeNode = {
    name: 'root',
    path: '/root',
    isDirectory: true,
    children: [
      {
        name: 'src',
        path: '/root/src',
        isDirectory: true,
        children: [{ name: 'main.ts', path: '/root/src/main.ts', isDirectory: false }],
      },
      { name: 'readme.md', path: '/root/readme.md', isDirectory: false },
    ],
  }

  it('flattens expanded directories', () => {
    const flat = flattenVisible(root, new Set(['/root', '/root/src']), '')
    expect(flat.map((n) => n.path)).toEqual(['/root', '/root/src', '/root/src/main.ts', '/root/readme.md'])
  })

  it('respects collapsed directories', () => {
    const flat = flattenVisible(root, new Set(['/root']), '')
    expect(flat.map((n) => n.path)).toEqual(['/root', '/root/src', '/root/readme.md'])
  })

  it('filters by query', () => {
    const flat = flattenVisible(root, new Set(['/root', '/root/src']), 'main')
    expect(flat.map((n) => n.path)).toEqual(['/root', '/root/src', '/root/src/main.ts'])
  })
})

describe('findNodeInStoreProjects', () => {
  const projects = [{ root: { name: 'p1', path: '/p1', isDirectory: true, children: [{ name: 'a.ts', path: '/p1/a.ts', isDirectory: false }] } }]

  it('finds node across projects', () => {
    expect(findNodeInStoreProjects(projects as { root: TreeNode | null }[], '/p1/a.ts')?.name).toBe('a.ts')
  })

  it('returns null when not found', () => {
    expect(findNodeInStoreProjects(projects as { root: TreeNode | null }[], '/p2/b.ts')).toBeNull()
  })
})

describe('loadTreeRecursive', () => {
  it('returns minimal tree when IPC is unavailable', async () => {
    vi.stubGlobal('window', undefined)
    const node = await loadTreeRecursive('/project', 0, new Set())
    expect(node.path).toBe('/project')
    expect(node.isDirectory).toBe(true)
    expect(node.children).toEqual([])
    vi.unstubAllGlobals()
  })

  it('stops recursion at maxDepth', async () => {
    vi.stubGlobal('window', { electronAPI: { 'fs:readDirDetail': vi.fn() } })
    const node = await loadTreeRecursive('/project', 10, new Set())
    expect(node.children).toEqual([])
    vi.unstubAllGlobals()
  })
})

describe('loadChildrenForNode', () => {
  it('returns empty array when node is not a directory', async () => {
    vi.stubGlobal('window', { electronAPI: { 'fs:readDirDetail': vi.fn() } })
    const children = await loadChildrenForNode('/file.txt', false, new Set())
    expect(children).toEqual([])
    vi.unstubAllGlobals()
  })

  it('returns empty array when IPC is unavailable', async () => {
    vi.stubGlobal('window', undefined)
    const children = await loadChildrenForNode('/project', true, new Set())
    expect(children).toEqual([])
    vi.unstubAllGlobals()
  })
})
