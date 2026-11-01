// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NodeEditor } from '../NodeEditor'
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
