// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NodeContextMenu } from '../NodeContextMenu'
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

/** 右键菜单里渲染出来的状态格子 */
function renderedStatuses(): NodeStatus[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[data-testid^="node-menu-status-"]'),
  ).map(el => el.getAttribute('data-testid')!.replace('node-menu-status-', '') as NodeStatus)
}

function renderMenu(node: GraphNode, onStatusChange = vi.fn()) {
  render(
    <NodeContextMenu
      nodeId={node.id}
      x={10}
      y={10}
      nodes={[node]}
      allowedChildTypes={[]}
      onStatusChange={onStatusChange}
      onDelete={vi.fn()}
      onClose={vi.fn()}
      onAddChild={vi.fn()}
      onStartConnect={vi.fn()}
    />,
  )
  return { onStatusChange }
}

describe('NodeContextMenu — 状态格子按 per-type 矩阵过滤', () => {
  it('feature@confirmed 只给出该类型合法的迁出目标', () => {
    renderMenu(makeNode({ type: 'feature', status: 'confirmed' }))

    // feature 矩阵里 confirmed 的迁出：developing / draft / placeholder
    expect(renderedStatuses().sort()).toEqual(
      ['confirmed', 'developing', 'draft', 'placeholder'].sort(),
    )
    // 非法目标不渲染（review / published / testing 都不合法）
    expect(screen.queryByTestId('node-menu-status-review')).toBeNull()
    expect(screen.queryByTestId('node-menu-status-published')).toBeNull()
    expect(screen.queryByTestId('node-menu-status-testing')).toBeNull()
    expect(screen.queryByTestId('node-menu-status-terminal-hint')).toBeNull()
  })

  it('同状态、不同节点类型给出不同格子集合', () => {
    // placeholder 节点：feature 允许激活为 draft/confirmed/developing，
    // bug 的矩阵里 placeholder 没有任何迁出 —— 判定确实读的是 per-type 矩阵
    renderMenu(makeNode({ type: 'bug', status: 'placeholder' }))
    expect(renderedStatuses()).toEqual(['placeholder'])
    expect(screen.getByTestId('node-menu-status-terminal-hint')).toBeTruthy()
  })

  it('feature@published 只剩当前状态时显示终态解释', () => {
    renderMenu(makeNode({ type: 'feature', status: 'published' }))

    expect(renderedStatuses()).toEqual(['published'])
    const hint = screen.getByTestId('node-menu-status-terminal-hint')
    expect(hint.textContent).toContain('终态')
    expect(hint.textContent).toContain('已发布')
  })

  it('wiki-page@published 仍可迁回 confirmed（唯一允许 published→X 的类型）', () => {
    renderMenu(makeNode({ type: 'wiki-page', status: 'published' }))

    expect(renderedStatuses().sort()).toEqual(
      ['confirmed', 'draft', 'placeholder', 'published'].sort(),
    )
  })

  it('当前状态始终可见', () => {
    renderMenu(makeNode({ type: 'feature', status: 'developing' }))

    const current = screen.getByTestId('node-menu-status-developing')
    expect(current).toBeTruthy()
    expect(current.className).toContain('text-white')
  })
})
