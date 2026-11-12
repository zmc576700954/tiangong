// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RightPanel } from '../RightPanel'
import { ToastContainer, useToastStore } from '../../lib/toast'
import { useGraphStore } from '../../store/graphStore'
import type { GraphEdge, GraphNode } from '@shared/types'

/**
 * RightPanel「连接线编辑器」分支的静默失败归零（Task 9）。
 *
 * EdgeEditor 的 onUpdate / onDelete 此前返回未接住的 promise ——
 * updateEdge / deleteEdge 失败会回滚并重新抛错（graphStore），用户只看到
 * 「点了没反应」。这里走**真实的 store 实现**、只把 IPC 层打掉，
 * 断言失败转成 error toast 且面板不崩。
 *
 * 本仓库未配置 @testing-library/jest-dom，断言用原生写法。
 */

function makeNode(id: string, title: string): GraphNode {
  return {
    id,
    title,
    type: 'process',
    status: 'draft',
    description: '',
    graphId: 'graph-1',
    graphType: 'dev',
    position: { x: 0, y: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const SOURCE = makeNode('node-1', '下单流程')
const TARGET = makeNode('node-2', '库存流程')

function makeEdge(): GraphEdge {
  return {
    id: 'edge-1',
    source: 'node-1',
    target: 'node-2',
    graphId: 'graph-1',
    edgeType: 'default',
  }
}

/** 当前 toast 列表（按 kind 过滤，'error' 与 'success' 必须能区分）。 */
function toastsOf(kind: 'error' | 'success' | 'info') {
  return useToastStore.getState().toasts.filter((t) => t.kind === kind)
}

describe('RightPanel — 连接线更新/删除失败不再静默', () => {
  const originalElectronAPI = window.electronAPI

  beforeEach(() => {
    useToastStore.getState().clear()
  })

  afterEach(() => {
    useToastStore.getState().clear()
    // 只还原本测试动过的字段 —— store 的动作是真实实现，不换
    useGraphStore.setState({
      nodes: [],
      edges: [],
      selectedNodeId: null,
      selectedEdgeId: null,
    })
    window.electronAPI = originalElectronAPI
  })

  it('updateEdge 拒绝时给出 error toast，且面板不崩', async () => {
    useGraphStore.setState({
      nodes: [SOURCE, TARGET],
      edges: [makeEdge()],
      selectedNodeId: null,
      selectedEdgeId: 'edge-1',
    })
    const edgeUpdate = vi.fn().mockRejectedValue(new Error('连线保存失败'))
    window.electronAPI = {
      ...originalElectronAPI,
      'edge:update': edgeUpdate,
    } as typeof window.electronAPI

    render(
      <>
        <RightPanel />
        <ToastContainer />
      </>,
    )

    // 点一个非当前类型的连接类型按钮 → onUpdate({ edgeType }) → updateEdge → IPC 拒绝
    fireEvent.click(screen.getByText('成功分支'))

    await waitFor(() => {
      expect(toastsOf('error')).toHaveLength(1)
    })
    // 真的走到了 IPC（没有被「找不到旧边」的早退路径静默吞掉）
    expect(edgeUpdate).toHaveBeenCalledWith('edge-1', { edgeType: 'success' })
    expect(toastsOf('error')[0].title).toContain('连线更新失败')
    expect(toastsOf('error')[0].message).toContain('连线保存失败')
    expect(toastsOf('success')).toHaveLength(0)

    // 界面没崩 —— 编辑器还在，起点/终点标题仍渲染
    expect(screen.getByText('下单流程')).toBeTruthy()
    expect(screen.getByText('库存流程')).toBeTruthy()
  })

  it('deleteEdge 拒绝时给出 error toast，面板回到空态', async () => {
    useGraphStore.setState({
      nodes: [SOURCE, TARGET],
      edges: [makeEdge()],
      selectedNodeId: null,
      selectedEdgeId: 'edge-1',
    })
    const edgeDelete = vi.fn().mockRejectedValue(new Error('连线删除失败原因'))
    window.electronAPI = {
      ...originalElectronAPI,
      'edge:delete': edgeDelete,
    } as typeof window.electronAPI

    render(
      <>
        <RightPanel />
        <ToastContainer />
      </>,
    )

    fireEvent.click(screen.getByText('删除连接'))

    await waitFor(() => {
      expect(toastsOf('error')).toHaveLength(1)
    })
    expect(edgeDelete).toHaveBeenCalledWith('edge-1')
    expect(toastsOf('error')[0].title).toContain('连线删除失败')
    expect(toastsOf('error')[0].message).toContain('连线删除失败原因')
    expect(toastsOf('success')).toHaveLength(0)

    // onDelete 立即清空选择 → 面板回到空态而不是崩溃
    expect(screen.getByText('在画布上选择节点或连接')).toBeTruthy()
  })
})
