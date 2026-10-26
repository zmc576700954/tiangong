import { describe, it, expect } from 'vitest'
import {
  APP_NAME,
  APP_VERSION,
  DB_FILENAME,
  IPC_CHANNEL_PREFIX,
  NODE_STATUS_COLORS,
  NODE_TYPE_COLORS,
  CANVAS_NODE_TYPES,
  SUPPORTED_AGENTS,
} from '../constants'
import type { NodeStatus, NodeType } from '../types'

describe('application constants', () => {
  it('exports app info constants', () => {
    expect(APP_NAME).toBe('BizGraph')
    expect(APP_VERSION).toBe('0.1.0')
    expect(DB_FILENAME).toBe('bizgraph.db')
    expect(IPC_CHANNEL_PREFIX).toBe('bizgraph')
  })
})

describe('NODE_STATUS_COLORS', () => {
  it('has a hex color for every NodeStatus', () => {
    const statuses: NodeStatus[] = ['draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder']
    for (const status of statuses) {
      expect(NODE_STATUS_COLORS[status]).toMatch(/^#/)
    }
  })
})

describe('NODE_TYPE_COLORS', () => {
  it('has a hex color for every NodeType', () => {
    const types: NodeType[] = ['project', 'module', 'process', 'feature', 'bug', 'wiki-page']
    for (const type of types) {
      expect(NODE_TYPE_COLORS[type]).toMatch(/^#/)
    }
  })
})

describe('CANVAS_NODE_TYPES', () => {
  it('includes all NodeType values with colors', () => {
    const expected: NodeType[] = ['project', 'module', 'process', 'feature', 'bug', 'wiki-page']
    const types = CANVAS_NODE_TYPES.map((n) => n.type)
    expect(types).toEqual(expected)
    for (const node of CANVAS_NODE_TYPES) {
      expect(node.color).toMatch(/^#/)
    }
  })
})

describe('SUPPORTED_AGENTS', () => {
  it('includes the core CLI adapters', () => {
    const names = SUPPORTED_AGENTS.map((a) => a.name)
    expect(names).toContain('claude-code')
    expect(names).toContain('codex')
    expect(names).toContain('opencode')
    for (const agent of SUPPORTED_AGENTS) {
      expect(agent.displayName).toBeTruthy()
      expect(agent.npmPackage).toBeTruthy()
    }
  })
})
