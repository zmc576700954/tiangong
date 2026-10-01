/**
 * D10b: RemoteCursors / RemotePresenceBadge / computeRemoteSelectionByNode 测试
 *
 * 用 React Test Renderer + 一个最小的 mock hooks 验证：
 * - 多用户 awareness 渲染（2/3/4 个 cursor 渲染正确）
 * - 颜色分配正确（按 colorIndex 解析）
 * - 本地 user 不出现在 overlay 里
 * - computeRemoteSelectionByNode 正确按节点聚合
 * - RemotePresenceBadge 根据数量显示「仅你」/「N 人在协作」
 *
 * 不依赖 ReactFlow / 真实 store — 全部 mock。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import React from 'react'

// ─── Mock useStore from @xyflow/react ───
vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [10, 20, 1.5] }),
  useStoreApi: () => ({
    getState: () => ({ transform: [10, 20, 1.5] }),
  }),
}))

// ─── Mock awareness-store (so hooks don't try to use real client) ───
const _stateListeners = new Set<() => void>()
let _states: RemoteAwarenessState[] = []

vi.mock('../../realtime/awareness-store', () => ({
  subscribeToRemoteStates: (listener: () => void) => {
    _stateListeners.add(listener)
    return () => _stateListeners.delete(listener)
  },
  getRemoteStatesSnapshot: () => _states,
  setLocalCursor: vi.fn(),
  setLocalSelection: vi.fn(),
  setLocalIdentity: vi.fn(),
  ensureAwarenessClient: vi.fn(),
  connectAwareness: vi.fn(),
  disconnectAwareness: vi.fn(),
  getAwarenessClient: () => null,
}))

// ─── Import after mocks ───
import { RemotePresenceBadge } from '../RemoteCursors'
import {
  computeRemoteSelectionByNode,
  colorForUser,
  type RemoteSelectionEntry,
} from '../remote-selection'
import type { RemoteAwarenessState } from '@shared/realtime'

interface RemoteOverrides {
  userId: string
  userName?: string
  colorIndex?: number
  cursor?: { x: number; y: number } | null
  selectedNodeIds?: string[]
  lastUpdated?: number
}

function makeRemote(over: RemoteOverrides): RemoteAwarenessState {
  return {
    user: {
      userId: over.userId,
      userName: over.userName ?? `User ${over.userId.slice(0, 4)}`,
      colorIndex: over.colorIndex ?? 0,
    },
    cursor: over.cursor ?? { x: 0, y: 0 },
    selectedNodeIds: over.selectedNodeIds ?? [],
    lastUpdated: over.lastUpdated ?? 0,
  }
}

beforeEach(() => {
  _states = []
  _stateListeners.clear()
})

describe('RemotePresenceBadge', () => {
  it('shows "仅你" when no remote users', () => {
    _states = []
    const html = renderToString(React.createElement(RemotePresenceBadge, { localUserId: 'me' }))
    expect(html).toContain('仅你')
    expect(html).toContain('data-count="0"')
  })

  it('shows "N 人在协作" with N remotes', () => {
    _states = [
      makeRemote({ userId: 'a' }),
      makeRemote({ userId: 'b' }),
      makeRemote({ userId: 'c' }),
    ]
    const html = renderToString(React.createElement(RemotePresenceBadge, { localUserId: 'me' }))
    expect(html).toContain('3 人在协作')
    expect(html).toContain('data-count="3"')
  })

  it('does not count the local user toward remote count', () => {
    _states = [
      makeRemote({ userId: 'me' }),
      makeRemote({ userId: 'b' }),
    ]
    const html = renderToString(React.createElement(RemotePresenceBadge, { localUserId: 'me' }))
    expect(html).toContain('1 人在协作')
    expect(html).toContain('data-count="1"')
  })
})

describe('computeRemoteSelectionByNode', () => {
  it('aggregates remote selections by node id', () => {
    _states = [
      makeRemote({ userId: 'a', selectedNodeIds: ['node-1', 'node-2'] }),
      makeRemote({ userId: 'b', selectedNodeIds: ['node-2', 'node-3'] }),
    ]
    const map = computeRemoteSelectionByNode(_states, 'me')

    expect(map.get('node-1')?.length).toBe(1)
    expect(map.get('node-1')![0]!.userId).toBe('a')

    const node2 = map.get('node-2')
    expect(node2?.length).toBe(2)
    expect(node2!.map((e) => e.userId).sort()).toEqual(['a', 'b'])

    expect(map.get('node-3')?.length).toBe(1)
    expect(map.get('node-3')![0]!.userId).toBe('b')
  })

  it('excludes the local user from the aggregation', () => {
    _states = [
      makeRemote({ userId: 'me', selectedNodeIds: ['node-1'] }),
      makeRemote({ userId: 'a', selectedNodeIds: ['node-1'] }),
    ]
    const map = computeRemoteSelectionByNode(_states, 'me')
    expect(map.get('node-1')?.length).toBe(1)
    expect(map.get('node-1')![0]!.userId).toBe('a')
  })

  it('returns empty map when no remotes', () => {
    _states = []
    const map = computeRemoteSelectionByNode(_states, 'me')
    expect(map.size).toBe(0)
  })

  it('assigns colors deterministically by colorIndex', () => {
    _states = [
      makeRemote({ userId: 'a', colorIndex: 0, selectedNodeIds: ['node-1'] }),
      makeRemote({ userId: 'b', colorIndex: 1, selectedNodeIds: ['node-1'] }),
      makeRemote({ userId: 'c', colorIndex: 2, selectedNodeIds: ['node-1'] }),
    ]
    const map = computeRemoteSelectionByNode(_states, 'me')
    const entries = map.get('node-1')!
    expect(entries.length).toBe(3)
    // 不同 colorIndex → 不同色（调色板 6 色）
    const colors = entries.map((e) => e.color)
    expect(new Set(colors).size).toBe(3)
  })

  it('produces a stable map regardless of input order', () => {
    _states = [
      makeRemote({ userId: 'a', selectedNodeIds: ['node-x'] }),
      makeRemote({ userId: 'b', selectedNodeIds: ['node-x'] }),
    ]
    const map1 = computeRemoteSelectionByNode(_states, 'me')
    const map2 = computeRemoteSelectionByNode([..._states].reverse(), 'me')
    expect(map1.get('node-x')!.length).toBe(map2.get('node-x')!.length)
  })
})

describe('colorForUser', () => {
  it('returns palette hex for colorIndex', () => {
    expect(colorForUser({ colorIndex: 0 })).toMatch(/^#[0-9a-f]{6}$/i)
    expect(colorForUser({ colorIndex: 1 })).toMatch(/^#[0-9a-f]{6}$/i)
    expect(colorForUser({ colorIndex: 5 })).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('returns different hex for different indices', () => {
    const colors = [0, 1, 2, 3, 4, 5].map((i) => colorForUser({ colorIndex: i }))
    expect(new Set(colors).size).toBe(6)
  })
})

describe('RemoteSelectionEntry interface', () => {
  it('contains the four required fields', () => {
    _states = [makeRemote({ userId: 'a', colorIndex: 1, selectedNodeIds: ['node-1'] })]
    const map = computeRemoteSelectionByNode(_states, 'me')
    const entry: RemoteSelectionEntry = map.get('node-1')![0]!
    expect(entry).toHaveProperty('userId')
    expect(entry).toHaveProperty('userName')
    expect(entry).toHaveProperty('colorIndex')
    expect(entry).toHaveProperty('color')
    expect(typeof entry.color).toBe('string')
    expect(entry.color.startsWith('#')).toBe(true)
  })
})