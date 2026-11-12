// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LeftPanel } from '../LeftPanel'
import { useToastStore } from '../../lib/toast'

/**
 * LeftPanel 的「扫描生成脑图」按钮可发现性测试。
 *
 * 背景：这个按钮是项目导入后最有价值的动作（把代码库变成脑图），原先却靠
 * `opacity-0 group-hover:opacity-100` —— 鼠标不悬停就看不见，用户根本发现不了。
 *
 * 本测试只关心两件事：
 * 1. 按钮**始终可见**（不需要 hover）
 * 2. 项目尚未扫描时，入口是**带文字的**引导态，用户知道它是什么
 */

const mockProjects = vi.hoisted(() => [] as { id: string; name: string; path: string }[])
const mockGraphs = vi.hoisted(() => [] as { id: string; name: string; projectPath?: string }[])

vi.mock('../../store/fileTreeStore', () => ({
  useFileTreeStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      projects: mockProjects,
      addProject: vi.fn(),
      removeProject: vi.fn(),
      toggleExpand: vi.fn(),
      toast: null,
      clearToast: vi.fn(),
      expandedPaths: new Set<string>(),
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('../../store/graphStore', () => ({
  useGraphStore: (selector?: (s: unknown) => unknown) => {
    const state = { graphs: mockGraphs, loadGraphs: vi.fn() }
    return selector ? selector(state) : state
  },
}))

vi.mock('../../store/agentStore', () => ({
  useAgentStore: (selector: (s: unknown) => unknown) =>
    selector({ openSettingsPanel: false, setOpenSettingsPanel: vi.fn() }),
}))

vi.mock('../../store/appStore', () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector({}),
}))

vi.mock('../../store/fileTreeUtils', () => ({
  useFileTreeKeyboard: vi.fn(),
}))

vi.mock('../TreeNodeItem', () => ({ TreeNodeItem: () => null }))
vi.mock('../FileTreeContextMenu', () => ({ FileTreeContextMenu: () => null }))
vi.mock('../SettingsPanel', () => ({ SettingsPanel: () => null }))

/**
 * `LeftPanel.tsx:25` 的 `ipc` 是**模块级常量** —— import 时就捕获了
 * `window.electronAPI`。所以 mock 必须在**本模块被 import 之前**装好，
 * 否则 `ipc` 会是 null，`handleScanProject` 在第一行就 return。
 * `vi.hoisted` + 顶层调用保证它在 import 之前执行。
 */
const { api } = vi.hoisted(() => {
  const api = {
    'graph:initFromProject': vi.fn(),
    'graph:list': vi.fn(),
    'fs:registerProjectPaths': vi.fn(),
    'dialog:openDirectory': vi.fn(),
    // 组件挂载时会订阅「菜单打开项目」，返回取消订阅函数
    onMenuOpenProject: vi.fn(() => () => undefined),
  }
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = api
  return { api }
})

function mockIpc() {
  vi.clearAllMocks()
  return api
}

describe('LeftPanel — 扫描生成脑图按钮的可发现性', () => {
  beforeEach(() => {
    mockProjects.length = 0
    mockGraphs.length = 0
    vi.clearAllMocks()
    mockIpc()
  })

  it('扫描按钮常显 —— 不依赖 hover 才可见', () => {
    mockProjects.push({ id: 'p1', name: 'demo', path: '/tmp/demo' })
    mockGraphs.push({ id: 'g1', name: 'demo', projectPath: '/tmp/demo' })

    render(<LeftPanel />)

    const btn = screen.getByTestId('scan-project-p1')
    // 关键：不能带 opacity-0（那正是「鼠标不悬停就看不见」的写法）
    expect(btn.className).not.toContain('opacity-0')
    expect(btn.className).not.toContain('group-hover:opacity-100')
  })

  it('尚未扫描的项目给出带文字的引导入口，用户知道它是什么', () => {
    mockProjects.push({ id: 'p1', name: 'demo', path: '/tmp/demo' })
    // 没有该 projectPath 的图 → 尚未扫描

    render(<LeftPanel />)

    const btn = screen.getByTestId('scan-project-p1')
    expect(btn.textContent?.trim().length ?? 0).toBeGreaterThan(0)
  })

  it('已扫描的项目仍可再次扫描（按钮存在）', () => {
    mockProjects.push({ id: 'p1', name: 'demo', path: '/tmp/demo' })
    mockGraphs.push({ id: 'g1', name: 'demo', projectPath: '/tmp/demo' })

    render(<LeftPanel />)

    expect(screen.getByTestId('scan-project-p1')).toBeTruthy()
  })

  it('删除按钮维持原有的 hover 才显示（本次不改它）', () => {
    mockProjects.push({ id: 'p1', name: 'demo', path: '/tmp/demo' })
    mockGraphs.push({ id: 'g1', name: 'demo', projectPath: '/tmp/demo' })

    render(<LeftPanel />)

    const remove = screen.getByTestId('remove-project-p1')
    expect(remove.className).toContain('opacity-0')
  })
})

describe('LeftPanel — 扫描失败不再静默', () => {
  beforeEach(() => {
    mockProjects.length = 0
    mockGraphs.length = 0
    vi.clearAllMocks()
    useToastStore.getState().clear()
  })

  it('扫描失败 → error toast（此前是空 catch，注释称「由 store 统一处理」但无人处理）', async () => {
    mockProjects.push({ id: 'p1', name: 'demo', path: '/tmp/demo' })
    const api = mockIpc()
    api['graph:initFromProject'].mockRejectedValue(new Error('scan boom'))

    render(<LeftPanel />)
    fireEvent.click(screen.getByTestId('scan-project-p1'))

    await waitFor(() => {
      const errors = useToastStore.getState().toasts.filter((t) => t.kind === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0].title).toContain('扫描项目失败')
      expect(errors[0].message).toContain('scan boom')
    })
    expect(useToastStore.getState().toasts.filter((t) => t.kind === 'success')).toHaveLength(0)
  })
})
