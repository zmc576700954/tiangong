// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { GraphTabs } from '../GraphTabs'
import { useFileTreeStore } from '../../store/fileTreeStore'
import { useGraphStore } from '../../store/graphStore'
import { ToastContainer, useToastStore } from '../../lib/toast'
import type { Graph } from '@shared/types'

/**
 * GraphTabs「新建图」对话框的渲染层测试。
 *
 * 覆盖 spec §四.B2 的三条：
 *   1. 类型选择器整体移除（online 蓝图不再手工新建，类型固定 dev）
 *   2. 名称空 → 错误 toast + **对话框不关**（静默失败必须变提示）
 *   3. 多项目时列出全部项目、当前项目默认选中；单项目自动带入且不出选择器
 *   4. 「从蓝图派生」时项目锁定为源图所属项目（选了也不能矛盾）
 *
 * 反馈走全局 Toast（src/renderer/lib/toast.tsx），故测试里挂 <ToastContainer />。
 * 本仓库未配置 @testing-library/jest-dom，自行实现最小断言。
 */

const ALPHA = { id: 'p-alpha', name: 'alpha', path: '/work/alpha', root: null, loading: false }
const BETA = { id: 'p-beta', name: 'beta', path: '/work/beta', root: null, loading: false }
const GAMMA = { id: 'p-gamma', name: 'gamma', path: '/work/gamma', root: null, loading: false }

function makeGraph(id: string, overrides: Partial<Graph> = {}): Graph {
  return {
    id,
    name: id,
    type: 'dev',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  }
}

const createIpc = vi.fn(async (data: { name: string; type: string; projectPath?: string }) => ({
  id: 'graph-created',
  name: data.name,
  type: data.type,
  projectPath: data.projectPath,
  createdAt: '2024-01-02',
  updatedAt: '2024-01-02',
}))

const deriveIpc = vi.fn(async (_sourceId: string, name?: string) => ({
  id: 'graph-derived',
  name: name ?? 'Derived',
  type: 'dev',
  projectPath: '/work/alpha',
  createdAt: '2024-01-02',
  updatedAt: '2024-01-02',
}))

function renderTabs(ui: React.ReactElement) {
  return render(
    <>
      {ui}
      <ToastContainer />
    </>,
  )
}

/** 打开「新建图」对话框 */
function openDialog(): void {
  fireEvent.click(screen.getByTestId('new-graph-btn'))
}

function dialog(): HTMLElement {
  return screen.getByTestId('floating-panel')
}

describe('GraphTabs · 新建图对话框', () => {
  beforeEach(() => {
    useToastStore.getState().clear()
    vi.clearAllMocks()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      'graph:create': createIpc,
      'graph:derive': deriveIpc,
    }
    useGraphStore.setState({ graphs: [], currentGraphId: null })
    useFileTreeStore.setState({ projects: [] })
  })

  it('不再提供 online / dev 类型选择——类型固定为 dev', () => {
    useFileTreeStore.setState({ projects: [ALPHA, BETA, GAMMA] })
    renderTabs(
      <GraphTabs
        graphs={[makeGraph('g-online', { type: 'online' }), makeGraph('g-dev')]}
        currentGraphId="g-dev"
      />,
    )
    openDialog()

    // 旧的类型选择器是两个按钮（文案取自已删除的 graph.tab.type.*）
    expect(within(dialog()).queryByText('已上线')).toBeNull()
    expect(within(dialog()).queryByText('开发中')).toBeNull()
    // 剩下的控件：名称输入 + 项目选择
    expect(within(dialog()).getByTestId('graph-name-input')).toBeTruthy()
    expect(within(dialog()).getByTestId('graph-project-select')).toBeTruthy()
  })

  it('名称为空点保存 → 错误 toast 且对话框不关闭', async () => {
    useFileTreeStore.setState({ projects: [ALPHA, BETA] })
    renderTabs(<GraphTabs graphs={[makeGraph('g-dev')]} currentGraphId="g-dev" />)
    openDialog()

    const input = within(dialog()).getByTestId('graph-name-input') as HTMLInputElement
    expect(input.value.length).toBeGreaterThan(0) // 默认名已预填
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('create-graph-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('toast-error')).toBeTruthy()
    })
    expect(createIpc).not.toHaveBeenCalled()
    // 静默失败 → 有提示；且提示之后对话框仍在，用户能立刻改名重试
    expect(screen.getByTestId('floating-panel')).toBeTruthy()
  })

  it('多项目时列出全部项目，且当前打开图所属项目是默认选中项', () => {
    useFileTreeStore.setState({ projects: [ALPHA, BETA, GAMMA] })
    renderTabs(
      <GraphTabs
        graphs={[makeGraph('g-dev', { projectPath: '/work/beta' })]}
        currentGraphId="g-dev"
      />,
    )
    openDialog()

    const select = within(dialog()).getByTestId('graph-project-select') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '/work/alpha',
      '/work/beta',
      '/work/gamma',
    ])
    expect(select.value).toBe('/work/beta')
  })

  it('保存时类型固定 dev 且带上 project_path', async () => {
    useFileTreeStore.setState({ projects: [ALPHA, BETA] })
    renderTabs(
      <GraphTabs
        graphs={[makeGraph('g-dev', { projectPath: '/work/beta' })]}
        currentGraphId="g-dev"
      />,
    )
    openDialog()

    const input = within(dialog()).getByTestId('graph-name-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  我的工作图  ' } })
    fireEvent.click(screen.getByTestId('create-graph-btn'))

    await waitFor(() => {
      expect(createIpc).toHaveBeenCalledWith({
        name: '我的工作图',
        type: 'dev',
        projectPath: '/work/beta',
      })
    })
  })

  it('单项目时不显示项目选择器，但仍把该项目绑到新图上', async () => {
    useFileTreeStore.setState({ projects: [ALPHA] })
    renderTabs(<GraphTabs graphs={[makeGraph('g-dev')]} currentGraphId="g-dev" />)
    openDialog()

    expect(within(dialog()).queryByTestId('graph-project-select')).toBeNull()

    fireEvent.click(screen.getByTestId('create-graph-btn'))
    await waitFor(() => {
      expect(createIpc).toHaveBeenCalledWith({
        name: expect.any(String),
        type: 'dev',
        projectPath: '/work/alpha',
      })
    })
  })

  it('选了「从蓝图派生」→ 项目锁定为源图所属项目，选择器禁用', async () => {
    useFileTreeStore.setState({ projects: [ALPHA, BETA, GAMMA] })
    renderTabs(
      <GraphTabs
        graphs={[
          makeGraph('g-online', { type: 'online', name: 'P - 产品蓝图', projectPath: '/work/alpha' }),
          makeGraph('g-dev', { projectPath: '/work/beta' }),
        ]}
        currentGraphId="g-dev"
      />,
    )
    openDialog()

    const deriveSelect = within(dialog()).getByTestId('graph-derive-select') as HTMLSelectElement
    fireEvent.change(deriveSelect, { target: { value: 'g-online' } })

    // 派生图继承**源图**的 project_path —— 选择器必须锁到源图，不能让用户选到别的项目
    const projectSelect = within(dialog()).getByTestId('graph-project-select') as HTMLSelectElement
    expect(projectSelect.disabled).toBe(true)
    expect(projectSelect.value).toBe('/work/alpha')

    fireEvent.click(screen.getByTestId('create-graph-btn'))
    await waitFor(() => {
      expect(deriveIpc).toHaveBeenCalledWith('g-online', expect.any(String))
    })
    expect(createIpc).not.toHaveBeenCalled()
  })
})
