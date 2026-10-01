/**
 * Field classification tests (D10d-1)
 *
 * 覆盖：
 *   - 每个 NodeType 的 status 字段走 state-machine
 *   - title / description / wikiContent 走 text-crdt
 *   - id / graphId / graphType / createdAt 走 identity-immutable
 *   - position / parentId / ownerRole 走 lamport-ordered
 *   - BugNode 的 severity 与 status 都 state-machine
 *   - Edge 的 source / target / id 走 identity-immutable
 *   - rule.field 名称覆盖 GraphNode / GraphEdge / BugNode 顶层字段
 */

import { describe, it, expect } from 'vitest'
import {
  NODE_FIELD_RULES,
  EDGE_FIELD_RULES,
  BUG_FIELD_RULES,
  NODE_TEXT_FIELDS,
  EDGE_TEXT_FIELDS,
  BUG_TEXT_FIELDS,
  type FieldRule,
} from '../conflict-rules'
import type { NodeType } from '@shared/types/graph'

const NODE_TYPES: NodeType[] = ['project', 'module', 'process', 'feature', 'bug', 'wiki-page']

describe('NODE_FIELD_RULES', () => {
  for (const t of NODE_TYPES) {
    describe(`${t}:`, () => {
      const rules = NODE_FIELD_RULES[t]
      const ruleMap = new Map<string, FieldRule>(rules.map((r) => [r.field, r]))

      it('title 走 text-crdt', () => {
        expect(ruleMap.get('title')?.strategy).toBe('text-crdt')
      })

      it('description 走 text-crdt', () => {
        expect(ruleMap.get('description')?.strategy).toBe('text-crdt')
      })

      it('status 走 state-machine', () => {
        const statusRule = ruleMap.get('status')
        expect(statusRule?.strategy).toBe('state-machine')
        expect(typeof statusRule?.validate).toBe('function')
      })

      it('id / graphId / graphType / createdAt 走 identity-immutable', () => {
        expect(ruleMap.get('id')?.strategy).toBe('identity-immutable')
        expect(ruleMap.get('graphId')?.strategy).toBe('identity-immutable')
        expect(ruleMap.get('graphType')?.strategy).toBe('identity-immutable')
        expect(ruleMap.get('createdAt')?.strategy).toBe('identity-immutable')
      })

      it('position / parentId / ownerRole 走 lamport-ordered', () => {
        expect(ruleMap.get('position')?.strategy).toBe('lamport-ordered')
        expect(ruleMap.get('parentId')?.strategy).toBe('lamport-ordered')
        expect(ruleMap.get('ownerRole')?.strategy).toBe('lamport-ordered')
      })

      it('updatedAt / type / communityId 走 last-write-wins', () => {
        expect(ruleMap.get('updatedAt')?.strategy).toBe('last-write-wins')
        expect(ruleMap.get('type')?.strategy).toBe('last-write-wins')
        expect(ruleMap.get('communityId')?.strategy).toBe('last-write-wins')
      })
    })
  }

  it('NODE_TEXT_FIELDS 集合与规则表 text-crdt 字段一致', () => {
    for (const f of NODE_TEXT_FIELDS) {
      expect(NODE_FIELD_RULES.module.find((r) => r.field === f)?.strategy).toBe('text-crdt')
    }
  })
})

describe('EDGE_FIELD_RULES', () => {
  const rules = EDGE_FIELD_RULES.default
  const ruleMap = new Map(rules.map((r) => [r.field, r]))

  it('source / target / id / graphId 走 identity-immutable', () => {
    expect(ruleMap.get('source')?.strategy).toBe('identity-immutable')
    expect(ruleMap.get('target')?.strategy).toBe('identity-immutable')
    expect(ruleMap.get('id')?.strategy).toBe('identity-immutable')
    expect(ruleMap.get('graphId')?.strategy).toBe('identity-immutable')
  })

  it('label / description / dataFlow 走 text-crdt', () => {
    expect(ruleMap.get('label')?.strategy).toBe('text-crdt')
    expect(ruleMap.get('description')?.strategy).toBe('text-crdt')
    expect(ruleMap.get('dataFlow')?.strategy).toBe('text-crdt')
  })

  it('edgeType 走 last-write-wins；strength 走 lamport-ordered', () => {
    expect(ruleMap.get('edgeType')?.strategy).toBe('last-write-wins')
    expect(ruleMap.get('strength')?.strategy).toBe('lamport-ordered')
  })

  it('EDGE_TEXT_FIELDS 集合与规则表 text-crdt 字段一致', () => {
    for (const f of EDGE_TEXT_FIELDS) {
      expect(rules.find((r) => r.field === f)?.strategy).toBe('text-crdt')
    }
  })
})

describe('BUG_FIELD_RULES', () => {
  const ruleMap = new Map(BUG_FIELD_RULES.map((r) => [r.field, r]))

  it('id / nodeId / graphId / createdAt 走 identity-immutable', () => {
    expect(ruleMap.get('id')?.strategy).toBe('identity-immutable')
    expect(ruleMap.get('nodeId')?.strategy).toBe('identity-immutable')
    expect(ruleMap.get('graphId')?.strategy).toBe('identity-immutable')
    expect(ruleMap.get('createdAt')?.strategy).toBe('identity-immutable')
  })

  it('title / description 走 text-crdt', () => {
    expect(ruleMap.get('title')?.strategy).toBe('text-crdt')
    expect(ruleMap.get('description')?.strategy).toBe('text-crdt')
  })

  it('status 与 severity 走 state-machine', () => {
    const statusRule = ruleMap.get('status')
    const severityRule = ruleMap.get('severity')
    expect(statusRule?.strategy).toBe('state-machine')
    expect(severityRule?.strategy).toBe('state-machine')
    expect(typeof statusRule?.validate).toBe('function')
    expect(typeof severityRule?.validate).toBe('function')
  })

  it('severity 验证：low → critical 合法（升级路径）；同 val 转 no-op', () => {
    const sevRule = ruleMap.get('severity')!
    expect(() => sevRule.validate!('low', 'critical')).not.toThrow()
    expect(() => sevRule.validate!('critical', 'low')).not.toThrow()
    expect(() => sevRule.validate!('low', 'low')).not.toThrow()
  })

  it('BUG_TEXT_FIELDS 集合与规则表 text-crdt 字段一致', () => {
    for (const f of BUG_TEXT_FIELDS) {
      expect(BUG_FIELD_RULES.find((r) => r.field === f)?.strategy).toBe('text-crdt')
    }
  })
})