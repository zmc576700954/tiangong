// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LeftPanel } from '../LeftPanel'

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

function mockIpc() {
  const api = {
    'graph:initFromProject': vi.fn(),
    'graph:list': vi.fn(),
    'fs:registerProjectPaths': vi.fn(),
    'dialog:openDirectory': vi.fn(),
    // 组件挂载时会订阅「菜单打开项目」，返回取消订阅函数
    onMenuOpenProject: vi.fn(() => () => undefined),
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
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
