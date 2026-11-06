import { describe, expect, it } from 'vitest'
import { normalizeClaude } from '../src/normalizer/claude'
import { normalizeOpenCode } from '../src/normalizer/opencode'
import { BACKEND_DRIVERS } from '../src/loop/backend-driver'
import { CHECKPOINT_TYPES, type AgentEventEnvelope } from '../src/types'
import {
  assertContiguousSeq,
  assertOwnership,
  checkpointTypes,
  fidelityOf,
  fixturePath,
  loadJson,
  loadJsonl,
  loadText,
} from './helpers'

const META = { runId: 'run-v1', turnId: 'turn-v1' }
const CANONICAL = [
  'run.started',
  'message.completed',
  'tool.requested',
  'tool.result',
  'run.completed',
] as const

function makeSamples(): Array<{ name: string; events: AgentEventEnvelope[]; backend: string; fidelity: string }> {
  return [
    {
      name: 'claude (逐消息流)',
      events: BACKEND_DRIVERS['claude-code'].normalize(
        loadJsonl(fixturePath('claude', 'session-001.jsonl')),
        META,
      ),
      backend: 'claude-code',
      fidelity: 'token',
    },
    {
      name: 'codex (阻塞单结果)',
      events: BACKEND_DRIVERS.codex.normalize(loadJson(fixturePath('codex', 'session-001.json')), META),
      backend: 'codex',
      fidelity: 'turn',
    },
    {
      name: 'opencode (one-shot)',
      events: BACKEND_DRIVERS.opencode.normalize(
        loadText(fixturePath('opencode', 'session-001.txt')),
        META,
      ),
      backend: 'opencode',
      fidelity: 'session',
    },
  ]
}

describe('V1 事件归一化：三后端同一语义检查点序列', () => {
  it('三种后端产出相同的 checkpoint 序列，seq 连续无断号，归属 100% 正确', () => {
    for (const sample of makeSamples()) {
      assertContiguousSeq(sample.events)
      expect(checkpointTypes(sample.events), `${sample.name} checkpoint 序列`).toEqual([...CANONICAL])
      assertOwnership(sample.events, {
        runId: META.runId,
        turnId: META.turnId,
        backendName: sample.backend,
      })
      expect(fidelityOf(sample.events), `${sample.name} fidelity`).toEqual(new Set([sample.fidelity]))
      expect(new Set(sample.events.map((e) => e.eventId)).size).toBe(sample.events.length)
    }
  })

  it('允许 fidelity 不同，但同一后端的全部事件保真度一致且符合能力矩阵', () => {
    const claude = makeSamples()[0].events
    const codex = makeSamples()[1].events
    const opencode = makeSamples()[2].events
    expect(fidelityOf(claude)).toEqual(new Set(['token']))
    expect(fidelityOf(codex)).toEqual(new Set(['turn']))
    expect(fidelityOf(opencode)).toEqual(new Set(['session']))

    // 事件来源如实标注：Codex/OpenCode 的 tool 事件是宿主合成，不是后端原生
    const codexTool = codex.find((e) => e.type === 'tool.requested')!
    const ocTool = opencode.find((e) => e.type === 'tool.requested')!
    const claudeTool = claude.find((e) => e.type === 'tool.requested')!
    expect(claudeTool.source).toBe('backend')
    expect(codexTool.source).toBe('synthetic')
    expect(ocTool.source).toBe('synthetic')
  })

  it('每个 turn 以终态事件收尾，终态之后没有事件', () => {
    for (const sample of makeSamples()) {
      const terminalIndex = sample.events.findIndex((e) => e.type === 'run.completed')
      expect(terminalIndex).toBeGreaterThan(0)
      expect(terminalIndex).toBe(sample.events.length - 1)
      for (const e of sample.events.slice(0, terminalIndex)) {
        expect(['run.failed', 'run.cancelled']).not.toContain(e.type)
      }
    }
  })

  it('OpenCode 无工具轨迹时降级为最小契约，不伪造 tool 事件', () => {
    const events = normalizeOpenCode(loadText(fixturePath('opencode', 'no-tools.txt')), {
      runId: 'run-v1-degraded',
      turnId: 'turn-v1-degraded',
    })
    assertContiguousSeq(events)
    expect(checkpointTypes(events)).toEqual(['run.started', 'message.completed', 'run.completed'])
    expect(events.some((e) => e.type === 'tool.requested' || e.type === 'tool.result')).toBe(false)
    expect(fidelityOf(events)).toEqual(new Set(['session']))
  })

  it('checkpoint 过滤只排除 delta/usage 等非生命周期事件', () => {
    const claude = normalizeClaude(loadJsonl(fixturePath('claude', 'session-001.jsonl')), META)
    const nonCheckpoint = claude.filter((e) => !CHECKPOINT_TYPES.has(e.type))
    expect(nonCheckpoint.map((e) => e.type)).toEqual(['message.delta', 'message.delta', 'usage.updated'])
  })
})
