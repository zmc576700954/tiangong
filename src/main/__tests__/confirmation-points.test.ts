/**
 * G2-10 确认点纯函数契约（I.4 D-18/D-19/D-20）。
 *
 * 覆盖：C3/C4 分类、风险只按 G4 两条线判 high（两档，不造第三档）、
 * 必填展示项缺失即拒绝、确认契约序列化/解析容错。
 */

import { describe, expect, it } from 'vitest'
import {
  CONFIRMATION_POINTS,
  ConfirmationDisplayError,
  assertConfirmationDisplay,
  classifyStepConfirmation,
  deriveStepRisk,
  parseStepConfirmationRequest,
  serializeStepConfirmationRequest,
} from '../map/confirmation-points'
import { G4_HIGH_RISK_FILES, G4_HIGH_RISK_LINES } from '../map/gate-engine'

function files(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `src/f${i}.ts`)
}

describe('G2-10 confirmation-points', () => {
  it('确认点分类：test → C3，human → C4，agent 不设计划期确认点', () => {
    expect(classifyStepConfirmation('test')).toBe('C3')
    expect(classifyStepConfirmation('human')).toBe('C4')
    expect(classifyStepConfirmation('agent')).toBeNull()
    expect(classifyStepConfirmation('unknown')).toBeNull()
  })

  it('风险两档：文件数达到 G4 线即 high，未达即 low', () => {
    const below = deriveStepRisk({ scopeFiles: files(G4_HIGH_RISK_FILES - 1), estimatedLines: 10 })
    expect(below.level).toBe('low')
    expect(below.reasons.join()).toContain(`未达 G4 高风险线 ${G4_HIGH_RISK_FILES}`)

    const atLine = deriveStepRisk({ scopeFiles: files(G4_HIGH_RISK_FILES), estimatedLines: 10 })
    expect(atLine.level).toBe('high')
  })

  it('风险两档：预估行数达到 G4 线即 high', () => {
    const below = deriveStepRisk({ scopeFiles: files(1), estimatedLines: G4_HIGH_RISK_LINES - 1 })
    expect(below.level).toBe('low')

    const atLine = deriveStepRisk({ scopeFiles: files(1), estimatedLines: G4_HIGH_RISK_LINES })
    expect(atLine.level).toBe('high')
  })

  it('行数不可预估：只按文件数判定，原因文本显式写出限制（不默认 high）', () => {
    const low = deriveStepRisk({ scopeFiles: files(1), estimatedLines: null })
    expect(low.level).toBe('low')
    expect(low.reasons.join()).toContain('预估行数不可用')

    const high = deriveStepRisk({ scopeFiles: files(G4_HIGH_RISK_FILES), estimatedLines: null })
    expect(high.level).toBe('high')
  })

  it('必填展示项：缺任一项即抛 ConfirmationDisplayError，并列出缺失键', () => {
    const c3 = CONFIRMATION_POINTS.C3
    const complete = Object.fromEntries(c3.requiredDisplay.map((key) => [key, 'x']))
    expect(() => assertConfirmationDisplay('C3', complete)).not.toThrow()

    const missing = { ...complete, planHash: undefined as unknown }
    try {
      assertConfirmationDisplay('C3', missing)
      throw new Error('应当拒绝')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmationDisplayError)
      expect((err as ConfirmationDisplayError).point).toBe('C3')
      expect((err as ConfirmationDisplayError).missing).toEqual(['planHash'])
    }
  })

  it('必填展示项：空串/空数组算缺失，false/0 算已展示', () => {
    const c4 = CONFIRMATION_POINTS.C4
    const base = Object.fromEntries(c4.requiredDisplay.map((key) => [key, 'x']))
    expect(() => assertConfirmationDisplay('C4', { ...base, evidence: [] })).toThrow(
      ConfirmationDisplayError,
    )
    expect(() => assertConfirmationDisplay('C4', { ...base, evidence: '  ' })).toThrow(
      ConfirmationDisplayError,
    )
    expect(() => assertConfirmationDisplay('C4', { ...base, staleEvidence: 0 })).not.toThrow()
    expect(() => assertConfirmationDisplay('C4', { ...base, statusDiff: false })).not.toThrow()
  })

  it('确认契约序列化/解析往返；未知 kind 或坏 JSON 返回 null', () => {
    const risk = deriveStepRisk({ scopeFiles: files(G4_HIGH_RISK_FILES), estimatedLines: 1 })
    const json = serializeStepConfirmationRequest('C3', risk, 123)
    const parsed = parseStepConfirmationRequest(json)
    expect(parsed).toMatchObject({
      kind: 'step_confirmation',
      point: 'C3',
      risk: 'high',
      requested_at: 123,
      required_display: CONFIRMATION_POINTS.C3.requiredDisplay,
    })
    expect(parsed?.reasons.length).toBeGreaterThan(0)

    expect(parseStepConfirmationRequest(null)).toBeNull()
    expect(parseStepConfirmationRequest('{')).toBeNull()
    expect(parseStepConfirmationRequest(JSON.stringify({ kind: 'other' }))).toBeNull()
    expect(parseStepConfirmationRequest(JSON.stringify({ kind: 'step_confirmation', point: 'C1' }))).toBeNull()
  })
})
