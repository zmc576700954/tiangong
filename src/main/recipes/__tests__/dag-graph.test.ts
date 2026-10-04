/**
 * Tests for Recipe DAG Builder (D5c-1)
 *
 * 覆盖：
 *  - 线性 DAG 推断（无 depends_on，数组顺序兜底产生链）
 *  - 并行分组推断（显式 depends_on 把节点分到多个拓扑层级）
 *  - 循环引用检测
 *  - depends_on 显式声明
 *  - ${outputs.X.Y} 模板引用推断
 *  - 缺失依赖（引用了不存在的 stepId）→ missingDeps 字段
 *  - 边界：单节点、空 steps、depends_on 引用 name 而不是 id
 *  - 步骤 id 派生：id → name → 索引
 */

import { describe, it, expect } from 'vitest'
import {
  buildRecipeDag,
  dagToFlowEdges,
  dagToFlowNodes,
  extractOutputRefs,
  resolveStepId,
  resolveStepLabel,
} from '@shared/recipe-dag'
import type { RecipeDefinition } from '@shared/types/recipe'

function makeDef(steps: RecipeDefinition['steps'], id = 'demo'): RecipeDefinition {
  return { id, name: id, version: '1', steps }
}

describe('resolveStepId / resolveStepLabel', () => {
  it('prefers step.id over name over index', () => {
    const step = { kind: 'agent' as const, agent_type: 'explore', description: 'd', prompt: '', id: 'myid', name: 'myname' }
    expect(resolveStepId(step, 5)).toBe('myid')
    expect(resolveStepLabel(step, 5)).toBe('myname')
  })

  it('falls back to name when id missing', () => {
    const step = { kind: 'agent' as const, agent_type: 'explore', description: 'd', prompt: '', name: 'only-name' }
    expect(resolveStepId(step, 5)).toBe('only-name')
    expect(resolveStepLabel(step, 5)).toBe('only-name')
  })

  it('falls back to step_<index> when both missing', () => {
    const step = { kind: 'agent' as const, agent_type: 'explore', description: 'd', prompt: '' }
    expect(resolveStepId(step, 3)).toBe('step_3')
    expect(resolveStepLabel(step, 3)).toBe('Step 4')
  })
})

describe('extractOutputRefs', () => {
  it('parses ${outputs.X.Y} references', () => {
    const refs = extractOutputRefs('use ${outputs.scan.files} and ${outputs.scan.lines}')
    expect(refs).toEqual(['scan'])
  })

  it('parses double-brace {{ outputs.X.Y }} references', () => {
    const refs = extractOutputRefs('{{ outputs.alpha.text }} then {{ outputs.beta.text }}')
    expect(refs).toEqual(['alpha', 'beta'])
  })

  it('returns empty when no refs present', () => {
    expect(extractOutputRefs('plain prompt without refs')).toEqual([])
  })

  it('deduplicates repeated refs', () => {
    expect(extractOutputRefs('${outputs.x.a} ${outputs.x.b} ${outputs.x.c}')).toEqual(['x'])
  })

  it('accepts kebab-case step ids', () => {
    expect(extractOutputRefs('${outputs.step-one.result}')).toEqual(['step-one'])
  })
})

describe('buildRecipeDag — linear DAG', () => {
  it('infers linear chain from array order when no depends_on given', () => {
    const def = makeDef([
      { kind: 'agent', agent_type: 'explore', description: 'a', prompt: 'first' },
      { kind: 'agent', agent_type: 'implement', description: 'b', prompt: 'second' },
      { kind: 'agent', agent_type: 'review', description: 'c', prompt: 'third' },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.nodes).toHaveLength(3)
    // Edges: step_0 → step_1, step_1 → step_2 (兜底)
    expect(dag.edges).toHaveLength(2)
    expect(dag.edges[0]).toMatchObject({ source: 'step_0', target: 'step_1', kind: 'index' })
    expect(dag.edges[1]).toMatchObject({ source: 'step_1', target: 'step_2', kind: 'index' })
    // Levels: each step has its own level since chain is strictly linear
    expect(dag.levels).toHaveLength(3)
    expect(dag.levels[0]!.map((n) => n.id)).toEqual(['step_0'])
    expect(dag.levels[1]!.map((n) => n.id)).toEqual(['step_1'])
    expect(dag.levels[2]!.map((n) => n.id)).toEqual(['step_2'])
    expect(dag.cycles).toEqual([])
    expect(dag.missingDeps).toEqual([])
  })

  it('handles single-step recipe with no edges', () => {
    const def = makeDef([
      { id: 'only', kind: 'agent', agent_type: 'explore', description: 'solo', prompt: 'do' },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.nodes).toHaveLength(1)
    expect(dag.edges).toHaveLength(0)
    expect(dag.levels).toHaveLength(1)
    expect(dag.levels[0]!.map((n) => n.id)).toEqual(['only'])
    expect(dag.cycles).toEqual([])
  })
})

describe('buildRecipeDag — parallel groups via depends_on', () => {
  it('groups nodes with shared dependencies into the same topological level', () => {
    // 拓扑：
    //   setup (level 0)
    //     ├── parallel-a (level 1)
    //     ├── parallel-b (level 1)
    //     └── parallel-c (level 1)
    //         └── finalize (level 2)
    const def = makeDef([
      { id: 'setup', kind: 'agent', agent_type: 'explore', description: 's', prompt: 'setup' },
      { id: 'pa', kind: 'agent', agent_type: 'general', description: 'a', prompt: 'a', depends_on: ['setup'] },
      { id: 'pb', kind: 'agent', agent_type: 'general', description: 'b', prompt: 'b', depends_on: ['setup'] },
      { id: 'pc', kind: 'agent', agent_type: 'general', description: 'c', prompt: 'c', depends_on: ['setup'] },
      { id: 'final', kind: 'agent', agent_type: 'review', description: 'f', prompt: 'final', depends_on: ['pa', 'pb', 'pc'] },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.nodes).toHaveLength(5)
    expect(dag.levels).toHaveLength(3)
    expect(dag.levels[0]!.map((n) => n.id)).toEqual(['setup'])
    expect(dag.levels[1]!.map((n) => n.id).sort()).toEqual(['pa', 'pb', 'pc'])
    expect(dag.levels[2]!.map((n) => n.id)).toEqual(['final'])
    // 验证 depends_on 边存在（数组兜底边不应补到已有入度的节点）
    // 显式依赖：setup→pa, setup→pb, setup→pc, pa→final, pb→final, pc→final = 6 条
    const depEdges = dag.edges.filter((e) => e.kind === 'depends_on')
    expect(depEdges).toHaveLength(6)
    const sources = new Set(depEdges.map((e) => e.source))
    expect(sources).toEqual(new Set(['setup', 'pa', 'pb', 'pc']))
    expect(dag.cycles).toEqual([])
  })

  it('accepts depends_on by name (not id)', () => {
    const def = makeDef([
      { name: 'first', kind: 'agent', agent_type: 'explore', description: 'a', prompt: '1' },
      { name: 'second', kind: 'agent', agent_type: 'general', description: 'b', prompt: '2', depends_on: ['first'] },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.levels[1]!.map((n) => n.id)).toEqual(['second'])
    expect(dag.edges.some((e) => e.source === 'first' && e.target === 'second' && e.kind === 'depends_on')).toBe(true)
  })
})

describe('buildRecipeDag — output template references', () => {
  it('infers edges from ${outputs.X.Y} in agent prompts', () => {
    const def = makeDef([
      { id: 'scan', kind: 'agent', agent_type: 'explore', description: 's', prompt: 'scan code' },
      { id: 'analyze', kind: 'agent', agent_type: 'general', description: 'a', prompt: 'use ${outputs.scan.summary}' },
      { id: 'report', kind: 'agent', agent_type: 'implement', description: 'r', prompt: 'compile ${outputs.analyze.findings}' },
    ])
    const dag = buildRecipeDag(def)
    const outEdges = dag.edges.filter((e) => e.kind === 'output-ref')
    expect(outEdges).toHaveLength(2)
    expect(outEdges).toContainEqual(expect.objectContaining({ source: 'scan', target: 'analyze' }))
    expect(outEdges).toContainEqual(expect.objectContaining({ source: 'analyze', target: 'report' }))
  })

  it('combines depends_on + output-ref without duplicating edges', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'explore', description: 'a', prompt: 'first' },
      { id: 'b', kind: 'agent', agent_type: 'general', description: 'b', prompt: 'use ${outputs.a.x}', depends_on: ['a'] },
    ])
    const dag = buildRecipeDag(def)
    // 同一对 a→b 出现一次（output-ref 优先，因为 depends_on 也会补；should dedup）
    const aToB = dag.edges.filter((e) => e.source === 'a' && e.target === 'b')
    // 至少有一个；不允许重复
    expect(aToB.length).toBeGreaterThanOrEqual(1)
    expect(new Set(aToB.map((e) => `${e.kind}`)).size).toBe(aToB.length)
  })
})

describe('buildRecipeDag — cycle detection', () => {
  it('detects a 2-node cycle via depends_on', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'general', description: 'a', prompt: 'p', depends_on: ['b'] },
      { id: 'b', kind: 'agent', agent_type: 'general', description: 'b', prompt: 'p', depends_on: ['a'] },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.cycles.length).toBeGreaterThan(0)
    expect(dag.cycles[0]!.sort()).toEqual(['a', 'b'])
  })

  it('detects a 3-node cycle', () => {
    const def = makeDef([
      { id: 'x', kind: 'agent', agent_type: 'general', description: 'x', prompt: 'p', depends_on: ['z'] },
      { id: 'y', kind: 'agent', agent_type: 'general', description: 'y', prompt: 'p', depends_on: ['x'] },
      { id: 'z', kind: 'agent', agent_type: 'general', description: 'z', prompt: 'p', depends_on: ['y'] },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.cycles.flat().sort()).toEqual(['x', 'y', 'z'])
  })

  it('returns no cycles when DAG is acyclic even with extra edges', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'general', description: 'a', prompt: 'p' },
      { id: 'b', kind: 'agent', agent_type: 'general', description: 'b', prompt: 'p', depends_on: ['a'] },
      { id: 'c', kind: 'agent', agent_type: 'general', description: 'c', prompt: 'p', depends_on: ['a', 'b'] },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.cycles).toEqual([])
    expect(dag.levels).toHaveLength(3)
  })
})

describe('buildRecipeDag — missing dependencies', () => {
  it('records missing depends_on targets in missingDeps', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'general', description: 'a', prompt: 'p', depends_on: ['ghost'] },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.missingDeps).toHaveLength(1)
    expect(dag.missingDeps[0]).toMatchObject({ from: 'a', reason: 'depends_on', missing: 'ghost' })
  })

  it('records missing output-ref targets in missingDeps', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'general', description: 'a', prompt: 'use ${outputs.phantom.x}' },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.missingDeps).toHaveLength(1)
    expect(dag.missingDeps[0]).toMatchObject({ from: 'a', reason: 'output-ref', missing: 'phantom' })
  })
})

describe('dagToFlowNodes / dagToFlowEdges', () => {
  it('lays out nodes by topological level (left → right)', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'explore', description: 'a', prompt: 'p' },
      { id: 'b', kind: 'agent', agent_type: 'general', description: 'b', prompt: 'p', depends_on: ['a'] },
    ])
    const dag = buildRecipeDag(def)
    const flowNodes = dagToFlowNodes(dag)
    expect(flowNodes).toHaveLength(2)
    const aNode = flowNodes.find((n) => n.id === 'a')!
    const bNode = flowNodes.find((n) => n.id === 'b')!
    expect(aNode.position.x).toBe(0)
    expect(bNode.position.x).toBeGreaterThan(aNode.position.x)
    // Verify data payload
    expect(aNode.data).toMatchObject({ label: 'a', nodeType: 'agent', agentType: 'explore', status: 'pending' })
  })

  it('maps edges with kind data preserved', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'explore', description: 'a', prompt: 'p' },
      { id: 'b', kind: 'agent', agent_type: 'general', description: 'b', prompt: 'p', depends_on: ['a'] },
    ])
    const dag = buildRecipeDag(def)
    const flowEdges = dagToFlowEdges(dag)
    expect(flowEdges).toHaveLength(dag.edges.length)
    const aToB = flowEdges.find((e) => e.source === 'a' && e.target === 'b')!
    expect(aToB.data).toMatchObject({ kind: 'depends_on' })
    expect(aToB.animated).toBe(false)
  })

  it('marks output-ref edges as animated', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'explore', description: 'a', prompt: 'p' },
      { id: 'b', kind: 'agent', agent_type: 'general', description: 'b', prompt: 'use ${outputs.a.x}' },
    ])
    const dag = buildRecipeDag(def)
    const flowEdges = dagToFlowEdges(dag)
    const outEdge = flowEdges.find((e) => e.data?.kind === 'output-ref')!
    expect(outEdge.animated).toBe(true)
  })
})

describe('buildRecipeDag — node metadata', () => {
  it('captures agent_type for agent steps and shellCommand[0] for shell steps', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'explore', description: 'a', prompt: 'p' },
      { id: 's', kind: 'shell', command: ['node', '-e', 'console.log(1)'] },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.nodes[0]!.agentType).toBe('explore')
    expect(dag.nodes[0]!.shellCommand).toBeUndefined()
    expect(dag.nodes[1]!.agentType).toBeUndefined()
    expect(dag.nodes[1]!.shellCommand).toBe('node')
  })

  it('marks every node with status=pending and correct index', () => {
    const def = makeDef([
      { id: 'a', kind: 'agent', agent_type: 'explore', description: 'a', prompt: 'p' },
      { id: 'b', kind: 'agent', agent_type: 'general', description: 'b', prompt: 'p' },
    ])
    const dag = buildRecipeDag(def)
    expect(dag.nodes.every((n) => n.status === 'pending')).toBe(true)
    expect(dag.nodes.map((n) => n.index)).toEqual([0, 1])
  })
})
