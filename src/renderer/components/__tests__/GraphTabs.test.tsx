// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { GraphTabs } from '../GraphTabs'
import { normalizeProjectPath } from '../../lib/utils'
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

const deleteIpc = vi.fn(async (_id: string) => true)

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

    // 断言的是**控件不存在**，不是某段文案不存在 —— 「graph-type-selector」是留给
    // 类型选择器的稳定 testid：将来有人把它加回来（哪怕换了文案）这条断言也会红。
    expect(within(dialog()).queryByTestId('graph-type-selector')).toBeNull()
    // 结构上再钉一道：对话框里只剩页脚的「取消 / 创建」两个按钮
    // （旧的类型选择器是正文里的一对按钮）
    expect(within(dialog()).getAllByRole('button').length).toBe(2)
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

  it('同一个目录只列一次（侧边栏原始路径 vs 已存 resolve 过的路径）', () => {
    // 主进程存的是 path.resolve 过的 '/work/alpha'，侧边栏是原始的 '/work/alpha/'
    useFileTreeStore.setState({ projects: [{ ...ALPHA, path: '/work/alpha/' }, BETA] })
    renderTabs(
      <GraphTabs
        graphs={[makeGraph('g-dev', { projectPath: '/work/alpha' })]}
        currentGraphId="g-dev"
      />,
    )
    openDialog()

    const select = within(dialog()).getByTestId('graph-project-select') as HTMLSelectElement
    expect(Array.from(select.options).map(o => o.value)).toEqual(['/work/alpha', '/work/beta'])
    expect(select.value).toBe('/work/alpha')
  })

  it('创建失败 → 错误 toast 且对话框不关闭（不再静默失败）', async () => {
    useFileTreeStore.setState({ projects: [ALPHA] })
    createIpc.mockRejectedValueOnce(new Error('boom'))
    renderTabs(<GraphTabs graphs={[makeGraph('g-dev')]} currentGraphId="g-dev" />)
    openDialog()

    fireEvent.click(screen.getByTestId('create-graph-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('toast-error')).toBeTruthy()
    })
    expect(screen.getByText('boom')).toBeTruthy()
    // 失败时对话框保持打开，用户改完还能重试
    expect(screen.getByTestId('floating-panel')).toBeTruthy()
  })

  it('派生源在对话框开着时被删掉 → 不去派生，按空白图建', async () => {
    useFileTreeStore.setState({ projects: [ALPHA, BETA] })
    const { rerender } = renderTabs(
      <GraphTabs
        graphs={[
          makeGraph('g-online', { type: 'online', projectPath: '/work/alpha' }),
          makeGraph('g-dev', { projectPath: '/work/beta' }),
        ]}
        currentGraphId="g-dev"
      />,
    )
    openDialog()

    const deriveSelect = within(dialog()).getByTestId('graph-derive-select') as HTMLSelectElement
    fireEvent.change(deriveSelect, { target: { value: 'g-online' } })

    // 源图被删掉了（graphs 里没有了）—— 陈旧的 id 不能拿去 graph:derive
    rerender(
      <>
        <GraphTabs graphs={[makeGraph('g-dev', { projectPath: '/work/beta' })]} currentGraphId="g-dev" />
        <ToastContainer />
      </>,
    )

    fireEvent.click(screen.getByTestId('create-graph-btn'))
    await waitFor(() => {
      expect(createIpc).toHaveBeenCalledWith({
        name: expect.any(String),
        type: 'dev',
        projectPath: '/work/beta',
      })
    })
    expect(deriveIpc).not.toHaveBeenCalled()
  })

  it('发给 graph:create 的是原始路径，不是归一化后的（归一化错了会绑到错的目录）', async () => {
    // 侧边栏给的是带反斜杠的 POSIX 目录名 —— 反斜杠在 Linux/macOS 上是合法文件名字符，
    // 把它归一化成 '/work/my/dir' 会让图绑到一个**不存在的**目录。
    useFileTreeStore.setState({ projects: [{ ...ALPHA, path: '/work/my\\dir' }, BETA] })
    renderTabs(<GraphTabs graphs={[makeGraph('g-dev')]} currentGraphId="g-dev" />)
    openDialog()

    fireEvent.click(screen.getByTestId('create-graph-btn'))
    await waitFor(() => {
      expect(createIpc).toHaveBeenCalledWith({
        name: expect.any(String),
        type: 'dev',
        projectPath: '/work/my\\dir',
      })
    })
  })
})

describe('GraphTabs · 删除图失败不再静默', () => {
  beforeEach(() => {
    useToastStore.getState().clear()
    vi.clearAllMocks()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      'graph:create': createIpc,
      'graph:derive': deriveIpc,
      'graph:delete': deleteIpc,
    }
    useGraphStore.setState({ graphs: [], currentGraphId: null })
    useFileTreeStore.setState({ projects: [] })
  })

  it('删除失败 → 错误 toast（此前 deleteGraph 是 fire-and-forget，图还在、用户却以为删掉了）', async () => {
    deleteIpc.mockRejectedValueOnce(new Error('delete boom'))
    renderTabs(<GraphTabs graphs={[makeGraph('g-dev')]} currentGraphId="g-dev" />)

    fireEvent.click(screen.getByTestId('delete-graph-g-dev'))

    await waitFor(() => {
      const errors = useToastStore.getState().toasts.filter((t) => t.kind === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0].title).toContain('删除图失败')
      expect(errors[0].message).toContain('delete boom')
    })
    expect(useToastStore.getState().toasts.filter((t) => t.kind === 'success')).toHaveLength(0)
  })
})

/**
 * 归一化**只能用于比较**（判断「是不是同一个目录」）——
 * 它必须和主进程 `path.resolve` 指向同一个目录，否则会把两个不同目录合并、
 * 或把一个目录拆成两条。
 */
describe('normalizeProjectPath —— 与 path.resolve 指向同一个目录', () => {
  it('POSIX 目录名里的反斜杠是合法字符，一个都不能改', () => {
    const raw = '/work/my\\dir'
    const normalized = normalizeProjectPath(raw)
    expect(normalized).toBe('/work/my\\dir')
    expect(path.posix.resolve(normalized)).toBe(path.posix.resolve(raw))
  })

  it('Windows UNC 保留根前缀，绝不能变成相对路径', () => {
    const raw = '\\\\server\\share\\dir'
    const normalized = normalizeProjectPath(raw)
    expect(normalized).toBe('//server/share/dir')
    expect(path.win32.isAbsolute(normalized)).toBe(true)
    expect(path.win32.resolve(normalized)).toBe(path.win32.resolve(raw))
  })

  it('Windows 盘符根保留盘符，不能退化成盘符相对路径', () => {
    const raw = 'C:\\'
    const normalized = normalizeProjectPath(raw)
    expect(normalized).toBe('C:/')
    expect(path.win32.isAbsolute(normalized)).toBe(true)
    expect(path.win32.resolve(normalized)).toBe(path.win32.resolve(raw))
  })

  it('尾斜杠与 . / .. 的词法归一仍指向同一个目录', () => {
    expect(path.posix.resolve(normalizeProjectPath('/work/alpha/'))).toBe('/work/alpha')
    expect(path.posix.resolve(normalizeProjectPath('/work/./alpha'))).toBe('/work/alpha')
    expect(path.posix.resolve(normalizeProjectPath('/work/x/../alpha'))).toBe('/work/alpha')
  })
})
