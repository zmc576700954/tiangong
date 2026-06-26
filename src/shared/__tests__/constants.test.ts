import { describe, it, expect } from 'vitest'
import {
  APP_NAME,
  APP_VERSION,
  DB_FILENAME,
  IPC_CHANNEL_PREFIX,
  NODE_STATUS_COLORS,
  NODE_STATUS_LABELS,
  NODE_TYPE_LABELS,
  NODE_TYPE_COLORS,
  CANVAS_NODE_TYPES,
  BUG_SEVERITY_LABELS,
  BUG_STATUS_LABELS,
  GRAPH_TYPE_LABELS,
  EDGE_TYPE_OPTIONS,
  SUPPORTED_AGENTS,
  AGENT_COMMAND_LABELS,
} from '../constants'
import type { EdgeType, NodeStatus, NodeType, BugSeverity, BugStatus, GraphType } from '../types'

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

describe('NODE_STATUS_LABELS', () => {
  it('has a non-empty label for every NodeStatus', () => {
    const statuses: NodeStatus[] = ['draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder']
    for (const status of statuses) {
      expect(NODE_STATUS_LABELS[status]).toBeTruthy()
    }
  })
})

describe('NODE_TYPE_LABELS', () => {
  it('has a non-empty label for every NodeType', () => {
    const types: NodeType[] = ['project', 'module', 'process', 'feature', 'bug']
    for (const type of types) {
      expect(NODE_TYPE_LABELS[type]).toBeTruthy()
    }
  })
})

describe('NODE_TYPE_COLORS', () => {
  it('has a hex color for every NodeType', () => {
    const types: NodeType[] = ['project', 'module', 'process', 'feature', 'bug']
    for (const type of types) {
      expect(NODE_TYPE_COLORS[type]).toMatch(/^#/)
    }
  })
})

describe('CANVAS_NODE_TYPES', () => {
  it('includes all NodeType values with labels and colors', () => {
    const expected: NodeType[] = ['project', 'module', 'process', 'feature', 'bug']
    const types = CANVAS_NODE_TYPES.map((n) => n.type)
    expect(types).toEqual(expected)
    for (const node of CANVAS_NODE_TYPES) {
      expect(node.label).toBeTruthy()
      expect(node.color).toMatch(/^#/)
    }
  })
})

describe('BUG_SEVERITY_LABELS', () => {
  it('has a label for every BugSeverity', () => {
    const severities: BugSeverity[] = ['low', 'medium', 'high', 'critical']
    for (const severity of severities) {
      expect(BUG_SEVERITY_LABELS[severity]).toBeTruthy()
    }
  })
})

describe('BUG_STATUS_LABELS', () => {
  it('has a label for every BugStatus', () => {
    const statuses: BugStatus[] = ['open', 'fixed', 'verified']
    for (const status of statuses) {
      expect(BUG_STATUS_LABELS[status]).toBeTruthy()
    }
  })
})

describe('GRAPH_TYPE_LABELS', () => {
  it('has a label for every GraphType', () => {
    const types: GraphType[] = ['online', 'dev']
    for (const type of types) {
      expect(GRAPH_TYPE_LABELS[type]).toBeTruthy()
    }
  })
})

describe('EDGE_TYPE_OPTIONS', () => {
  it('includes all EdgeType values', () => {
    const expected: EdgeType[] = [
      'default',
      'success',
      'failure',
      'condition',
      'business-flow',
      'semantic',
      'dependency',
      'co-change',
    ]
    const types = EDGE_TYPE_OPTIONS.map((o) => o.type)
    expect(types).toEqual(expected)
  })

  it('provides a label and color for every option', () => {
    for (const option of EDGE_TYPE_OPTIONS) {
      expect(option.label).toBeTruthy()
      expect(option.color).toMatch(/^#/)
      expect(option.description).toBeTruthy()
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

describe('AGENT_COMMAND_LABELS', () => {
  it('has labels for known command types', () => {
    expect(AGENT_COMMAND_LABELS.implement).toBeTruthy()
    expect(AGENT_COMMAND_LABELS.fix_bug).toBeTruthy()
    expect(AGENT_COMMAND_LABELS.refactor).toBeTruthy()
    expect(AGENT_COMMAND_LABELS.add_test).toBeTruthy()
  })
})
