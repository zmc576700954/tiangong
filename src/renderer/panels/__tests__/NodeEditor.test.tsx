// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NodeEditor } from '../NodeEditor'
import { RightPanel } from '../RightPanel'
import { ToastContainer, useToastStore } from '../../lib/toast'
import { useGraphStore } from '../../store/graphStore'
import type { GraphNode, NodeStatus, NodeType } from '@shared/types'

function makeNode(overrides: Partial<GraphNode> & { type: NodeType; status: NodeStatus }): GraphNode {
  return {
    id: 'node-1',
    title: '示例节点',
    description: '',
    graphId: 'graph-1',
    graphType: 'dev',
    position: { x: 0, y: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** 药丸组里当前渲染出来的状态值（按 DOM 顺序） */
function renderedStatuses(): NodeStatus[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="node-status-pill-"]'),
  ).map(el => el.getAttribute('data-testid')!.replace('node-status-pill-', '') as NodeStatus)
}

function renderEditor(node: GraphNode, onUpdate = vi.fn()) {
  render(
    <NodeEditor
      node={node}
      onUpdate={onUpdate}
      onDelete={vi.fn()}
      onStartAgent={vi.fn()}
    />,
  )
  return { onUpdate }
}

/** 挂上全局 Toast 容器 —— 静默失败的提示走的就是它。 */
function renderEditorWithToast(node: GraphNode, onUpdate = vi.fn()) {
  render(
    <>
      <NodeEditor
        node={node}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onStartAgent={vi.fn()}
      />
      <ToastContainer />
    </>,
  )
  return { onUpdate }
}

/** 当前 toast 列表（按 kind 过滤，'error' 与 'success' 必须能区分）。 */
function toastsOf(kind: 'error' | 'success' | 'info') {
  return useToastStore.getState().toasts.filter((t) => t.kind === kind)
}

describe('NodeEditor — 状态药丸组按 per-type 矩阵过滤', () => {
  it('feature@developing 只给出该类型合法的迁出目标', () => {
    renderEditor(makeNode({ type: 'feature', status: 'developing' }))

    // feature 矩阵里 developing 的迁出：placeholder / testing / confirmed / draft
    expect(renderedStatuses().sort()).toEqual(
      ['confirmed', 'developing', 'draft', 'placeholder', 'testing'].sort(),
    )
    // 非法目标不渲染
    expect(screen.queryByTestId('node-status-pill-review')).toBeNull()
    expect(screen.queryByTestId('node-status-pill-published')).toBeNull()
  })

  it('bug@draft 的迁出集合按 bug 的矩阵走', () => {
    renderEditor(makeNode({ type: 'bug', status: 'draft' }))

    // bug 矩阵里 draft 的迁出：developing / confirmed / placeholder（+ 当前状态本身）
    expect(renderedStatuses().sort()).toEqual(
      ['confirmed', 'developing', 'draft', 'placeholder'].sort(),
    )
    expect(screen.queryByTestId('node-status-pill-testing')).toBeNull()
    expect(screen.queryByTestId('node-status-pill-review')).toBeNull()
  })

  it('feature@placeholder 的药丸集合按 feature 的矩阵走', () => {
    renderEditor(makeNode({ type: 'feature', status: 'placeholder' }))

    // feature 矩阵里 placeholder 的迁出：developing / draft / confirmed
    expect(renderedStatuses().sort()).toEqual(
      ['confirmed', 'developing', 'draft', 'placeholder'].sort(),
    )
  })

  it('bug@placeholder 没有任何迁出 —— 同状态、不同类型给出不同集合', () => {
    renderEditor(makeNode({ type: 'bug', status: 'placeholder' }))

    // bug 的矩阵里 placeholder 没有迁出目标，只剩当前状态
    expect(renderedStatuses()).toEqual(['placeholder'])
    expect(screen.getByTestId('node-status-terminal-hint')).toBeTruthy()
  })

  it('当前状态始终在药丸组里（且高亮）', () => {
    renderEditor(makeNode({ type: 'feature', status: 'confirmed' }))

    const current = screen.getByTestId('node-status-pill-confirmed')
    expect(current).toBeTruthy()
    expect(current.className).toContain('text-white')
  })

  it('补上了 placeholder —— 用户能把节点放回占位', () => {
    renderEditor(makeNode({ type: 'feature', status: 'developing' }))

    expect(screen.getByTestId('node-status-pill-placeholder')).toBeTruthy()
    expect(screen.getByTestId('node-status-pill-placeholder').textContent).toBe('占位')
  })
})

describe('NodeEditor — 终态提示', () => {
  it('published 的 feature 节点显示终态提示，且不给出任何非法迁出', () => {
    renderEditor(makeNode({ type: 'feature', status: 'published' }))

    // 只剩当前状态一个药丸
    expect(renderedStatuses()).toEqual(['published'])
    expect(screen.queryByTestId('node-status-pill-confirmed')).toBeNull()
    expect(screen.queryByTestId('node-status-pill-draft')).toBeNull()

    const hint = screen.getByTestId('node-status-terminal-hint')
    expect(hint.textContent).toContain('终态')
    expect(hint.textContent).toContain('已发布')
  })

  it('非终态节点不显示终态提示', () => {
    renderEditor(makeNode({ type: 'feature', status: 'review' }))

    expect(screen.queryByTestId('node-status-terminal-hint')).toBeNull()
    // review 的迁出：testing / published
    expect(renderedStatuses().sort()).toEqual(['published', 'review', 'testing'].sort())
  })
})

// ============================================================
// 静默失败归零：用户触发了动作却什么都没发生 —— 界面必须给一句提示
// ============================================================

describe('NodeEditor — 空输入给出明确提示', () => {
  beforeEach(() => {
    useToastStore.getState().clear()
  })

  it('标题清空点保存：给 error toast，且留在编辑态、输入内容保留', () => {
    const onUpdate = vi.fn()
    renderEditorWithToast(makeNode({ type: 'feature', status: 'draft' }), onUpdate)

    fireEvent.click(screen.getByTestId('node-title-edit'))
    const input = screen.getByTestId('node-title-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('node-title-save'))

    // 有提示，且是 error（不是 success）
    const errors = toastsOf('error')
    expect(errors).toHaveLength(1)
    expect(errors[0].title).toContain('标题不能为空')
    expect(toastsOf('success')).toHaveLength(0)

    // 保存被跳过
    expect(onUpdate).not.toHaveBeenCalled()

    // 关键：没有静默丢弃 —— 仍留在编辑态，输入内容原样保留
    const stillEditing = screen.getByTestId('node-title-input') as HTMLInputElement
    expect(stillEditing.value).toBe('   ')
  })

  it('业务规则空标题点添加：给 error toast，不新增规则，输入内容保留', () => {
    const onUpdate = vi.fn()
    renderEditorWithToast(makeNode({ type: 'process', status: 'draft' }), onUpdate)

    fireEvent.click(screen.getByTestId('node-rules-toggle'))
    const title = screen.getByTestId('node-rules-title') as HTMLInputElement
    fireEvent.change(title, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('node-rules-add'))

    const errors = toastsOf('error')
    expect(errors).toHaveLength(1)
    expect(errors[0].title).toContain('规则名称不能为空')

    // 没有新增规则
    expect(onUpdate).not.toHaveBeenCalled()

    // 表单还开着，输入内容保留
    expect((screen.getByTestId('node-rules-title') as HTMLInputElement).value).toBe('   ')
  })

  it('验收标准空内容点添加：给 error toast，不新增标准，输入内容保留', () => {
    const onUpdate = vi.fn()
    renderEditorWithToast(makeNode({ type: 'feature', status: 'draft' }), onUpdate)

    const input = screen.getByTestId('node-criteria-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('node-criteria-add'))

    const errors = toastsOf('error')
    expect(errors).toHaveLength(1)
    expect(errors[0].title).toContain('验收标准不能为空')

    expect(onUpdate).not.toHaveBeenCalled()
    expect((screen.getByTestId('node-criteria-input') as HTMLInputElement).value).toBe('   ')
  })

  it('API / 服务 / 实体空输入点添加：三处都给出 error toast', () => {
    const onUpdate = vi.fn()
    renderEditorWithToast(makeNode({ type: 'process', status: 'draft' }), onUpdate)

    for (const testId of ['node-meta-add-apis', 'node-meta-add-services', 'node-meta-add-entities']) {
      fireEvent.click(screen.getByTestId(testId))
    }

    const errors = toastsOf('error')
    expect(errors).toHaveLength(3)
    for (const toast of errors) {
      expect(toast.title).toContain('不能为空')
    }
    expect(toastsOf('success')).toHaveLength(0)

    // 一条都没新增
    expect(onUpdate).not.toHaveBeenCalled()
  })
})

describe('RightPanel — 节点更新失败不再静默', () => {
  const originalUpdateNode = useGraphStore.getState().updateNode
  const originalElectronAPI = window.electronAPI

  beforeEach(() => {
    useToastStore.getState().clear()
  })

  afterEach(() => {
    useToastStore.getState().clear()
    useGraphStore.setState({
      updateNode: originalUpdateNode,
      nodes: [],
      selectedNodeId: null,
    })
    window.electronAPI = originalElectronAPI
  })

  it('updateNode 拒绝时给出 error toast，且面板不崩', async () => {
    const node = makeNode({ type: 'feature', status: 'draft' })
    // 用真实的 store 实现，只把 IPC 层打掉 —— 走的是生产路径
    useGraphStore.setState({ nodes: [node], selectedNodeId: node.id })
    window.electronAPI = {
      ...originalElectronAPI,
      'node:update': vi.fn().mockRejectedValue(new Error('节点保存失败')),
    } as typeof window.electronAPI

    render(
      <>
        <RightPanel />
        <ToastContainer />
      </>,
    )

    fireEvent.click(screen.getByTestId('node-status-pill-confirmed'))

    await waitFor(() => {
      expect(toastsOf('error')).toHaveLength(1)
    })
    expect(toastsOf('error')[0].title).toContain('节点更新失败')
    // 失败原因也带出来了
    expect(toastsOf('error')[0].message).toContain('节点保存失败')
    expect(toastsOf('success')).toHaveLength(0)

    // 界面没崩 —— 节点标题仍在
    expect(screen.getByText('示例节点')).toBeTruthy()
  })

  it('deleteNode 拒绝时给出 error toast', async () => {
    const node = makeNode({ type: 'feature', status: 'draft' })
    useGraphStore.setState({ nodes: [node], selectedNodeId: node.id })
    window.electronAPI = {
      ...originalElectronAPI,
      'node:delete': vi.fn().mockRejectedValue(new Error('节点删除失败原因')),
    } as typeof window.electronAPI

    render(
      <>
        <RightPanel />
        <ToastContainer />
      </>,
    )

    fireEvent.click(screen.getByText('删除节点'))

    await waitFor(() => {
      expect(toastsOf('error')).toHaveLength(1)
    })
    expect(toastsOf('error')[0].title).toContain('节点删除失败')
    expect(toastsOf('error')[0].message).toContain('节点删除失败原因')
  })
})
