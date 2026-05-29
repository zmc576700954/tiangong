import { describe, it, expect, vi, beforeEach } from 'vitest'

// Reset modules to ensure fresh evaluation with our mocks
vi.resetModules()

// Set up mocks BEFORE any imports
const mockReadDirDetail = vi.fn()
const mockLocalStorage = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
}

vi.stubGlobal('window', {
  electronAPI: {
    'fs:readDirDetail': mockReadDirDetail,
    'fs:registerProjectPaths': vi.fn().mockResolvedValue(undefined),
    'fs:copy': vi.fn(),
    'fs:move': vi.fn(),
    'fs:delete': vi.fn(),
    'fs:rename': vi.fn(),
    'fs:createFile': vi.fn(),
    'fs:createDir': vi.fn(),
  },
  localStorage: mockLocalStorage,
})
vi.stubGlobal('localStorage', mockLocalStorage)

// enableMapSet must be called before the store creates its zustand+immer store
const { enableMapSet } = await import('immer')
enableMapSet()

// Dynamic import ensures module is evaluated AFTER mocks are set up
const { useFileTreeStore } = await import('../fileTreeStore')

function resetStore() {
  useFileTreeStore.setState({
    projects: [],
    expandedPaths: new Set(),
    selectedPaths: new Set(),
    lastSelectedPath: null,
    clipboard: null,
    contextMenuPath: null,
    contextMenuPos: null,
    toast: null,
  })
}

describe('fileTreeStore toggleExpand', () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
  })

  it('should toggle expand state for a directory path', () => {
    useFileTreeStore.setState({
      projects: [{
        id: 'proj-1',
        name: 'test-project',
        path: '/project',
        root: {
          name: 'test-project',
          path: '/project',
          isDirectory: true,
          children: [
            { name: 'src', path: '/project/src', isDirectory: true, children: [] },
          ],
        },
        loading: false,
      }],
    })

    useFileTreeStore.getState().toggleExpand('/project/src')
    expect(useFileTreeStore.getState().expandedPaths.has('/project/src')).toBe(true)

    useFileTreeStore.getState().toggleExpand('/project/src')
    expect(useFileTreeStore.getState().expandedPaths.has('/project/src')).toBe(false)
  })

  it('should trigger lazy-load when expanding a directory with empty children', async () => {
    mockReadDirDetail.mockResolvedValue([
      { name: 'index.ts', path: '/project/src/index.ts', isDirectory: false, size: 100, mtimeMs: 0 },
    ])

    useFileTreeStore.setState({
      projects: [{
        id: 'proj-1',
        name: 'test-project',
        path: '/project',
        root: {
          name: 'test-project',
          path: '/project',
          isDirectory: true,
          children: [
            { name: 'src', path: '/project/src', isDirectory: true, children: [] },
          ],
        },
        loading: false,
      }],
    })

    useFileTreeStore.getState().toggleExpand('/project/src')

    // Wait for async load
    await vi.waitFor(() => {
      const state = useFileTreeStore.getState()
      const proj = state.projects[0]
      const srcNode = proj.root?.children?.[0]
      expect(srcNode?.children?.length).toBeGreaterThan(0)
    })
  })
})
