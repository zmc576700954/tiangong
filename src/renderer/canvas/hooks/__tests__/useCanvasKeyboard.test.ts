// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCanvasKeyboard } from '../useCanvasKeyboard'

function fireKey(key: string, target?: Partial<HTMLElement>) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true })
  if (target) Object.defineProperty(event, 'target', { value: target })
  window.dispatchEvent(event)
}

describe('useCanvasKeyboard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls onDeleteNode when Delete pressed with selected node', () => {
    const onDeleteNode = vi.fn()
    const onDeselect = vi.fn()
    renderHook(() => useCanvasKeyboard({
      selectedNodeId: 'node-1',
      selectedEdgeId: null,
      onDeleteNode,
      onDeleteEdge: vi.fn(),
      onDeselect,
    }))

    fireKey('Delete')

    expect(onDeleteNode).toHaveBeenCalledWith('node-1')
    expect(onDeselect).toHaveBeenCalled()
  })

  it('calls onDeleteEdge when Delete pressed with selected edge', () => {
    const onDeleteEdge = vi.fn()
    const onDeselect = vi.fn()
    renderHook(() => useCanvasKeyboard({
      selectedNodeId: null,
      selectedEdgeId: 'edge-1',
      onDeleteNode: vi.fn(),
      onDeleteEdge,
      onDeselect,
    }))

    fireKey('Delete')

    expect(onDeleteEdge).toHaveBeenCalledWith('edge-1')
    expect(onDeselect).toHaveBeenCalled()
  })

  it('calls onDeselect when Escape pressed', () => {
    const onDeselect = vi.fn()
    renderHook(() => useCanvasKeyboard({
      selectedNodeId: 'node-1',
      selectedEdgeId: null,
      onDeleteNode: vi.fn(),
      onDeleteEdge: vi.fn(),
      onDeselect,
    }))

    fireKey('Escape')

    expect(onDeselect).toHaveBeenCalled()
  })

  it('calls onCancelConnect when Escape pressed in connecting mode', () => {
    const onCancelConnect = vi.fn()
    const onDeselect = vi.fn()
    renderHook(() => useCanvasKeyboard({
      selectedNodeId: null,
      selectedEdgeId: null,
      onDeleteNode: vi.fn(),
      onDeleteEdge: vi.fn(),
      onDeselect,
      isConnecting: true,
      onCancelConnect,
    }))

    fireKey('Escape')

    expect(onCancelConnect).toHaveBeenCalled()
    expect(onDeselect).not.toHaveBeenCalled()
  })

  it('does not delete when Backspace in input field', () => {
    const onDeleteNode = vi.fn()
    renderHook(() => useCanvasKeyboard({
      selectedNodeId: 'node-1',
      selectedEdgeId: null,
      onDeleteNode,
      onDeleteEdge: vi.fn(),
      onDeselect: vi.fn(),
    }))

    fireKey('Backspace', { tagName: 'INPUT' })

    expect(onDeleteNode).not.toHaveBeenCalled()
  })

  it('does not delete when connecting', () => {
    const onDeleteNode = vi.fn()
    renderHook(() => useCanvasKeyboard({
      selectedNodeId: 'node-1',
      selectedEdgeId: null,
      onDeleteNode,
      onDeleteEdge: vi.fn(),
      onDeselect: vi.fn(),
      isConnecting: true,
    }))

    fireKey('Delete')

    expect(onDeleteNode).not.toHaveBeenCalled()
  })

  it('calls onRequestDeleteConfirm when provided', () => {
    const onRequestDeleteConfirm = vi.fn()
    renderHook(() => useCanvasKeyboard({
      selectedNodeId: 'node-1',
      selectedEdgeId: null,
      onDeleteNode: vi.fn(),
      onDeleteEdge: vi.fn(),
      onDeselect: vi.fn(),
      onRequestDeleteConfirm,
    }))

    fireKey('Delete')

    expect(onRequestDeleteConfirm).toHaveBeenCalledWith('node')
  })

  it('does nothing when no selection and Delete pressed', () => {
    const onDeleteNode = vi.fn()
    renderHook(() => useCanvasKeyboard({
      selectedNodeId: null,
      selectedEdgeId: null,
      onDeleteNode,
      onDeleteEdge: vi.fn(),
      onDeselect: vi.fn(),
    }))

    fireKey('Delete')

    expect(onDeleteNode).not.toHaveBeenCalled()
  })

  it('returns clearConfirmPending function', () => {
    const { result } = renderHook(() => useCanvasKeyboard({
      selectedNodeId: null,
      selectedEdgeId: null,
      onDeleteNode: vi.fn(),
      onDeleteEdge: vi.fn(),
      onDeselect: vi.fn(),
    }))

    expect(typeof result.current.clearConfirmPending).toBe('function')
  })
})
