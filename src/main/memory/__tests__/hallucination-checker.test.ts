/**
 * HallucinationChecker 单元测试
 */

import { describe, it, expect } from 'vitest'
import { HallucinationChecker } from '../hallucination-checker'
import type { AgentOutput } from '@shared/types'

describe('HallucinationChecker', () => {
  /** Helper: create stdout outputs */
  function outputs(lines: string[]): AgentOutput[] {
    return lines.map((data) => ({
      type: 'stdout' as const,
      data,
      timestamp: Date.now(),
    }))
  }

  describe('verifySync', () => {
    it('passes for consistent, well-evidenced output', () => {
      const checker = new HallucinationChecker()
      const report = checker.verifySync(outputs([
        'Modified: src/main/foo.ts',
        'Modified: src/main/bar.ts',
        'Tests: 5 passed, 0 failed, 5 total ✓',
      ]))
      // Should have low risk score for reasonable output
      expect(report.riskScore).toBeLessThanOrEqual(50)
    })

    it('detects fake completion claims with stderr errors as high severity', () => {
      const checker = new HallucinationChecker()
      const combinedOutputs: AgentOutput[] = [
        { type: 'stdout', data: 'Task completed successfully!', timestamp: Date.now() },
        { type: 'stdout', data: 'All changes have been applied.', timestamp: Date.now() },
        { type: 'stderr', data: 'Error: something went wrong.', timestamp: Date.now() },
        { type: 'stderr', data: 'Error: another problem.', timestamp: Date.now() },
      ]
      const report = checker.verifySync(combinedOutputs)
      const fakeSuccess = report.claims.filter((c) => c.type === 'fake_success')
      expect(fakeSuccess.length).toBeGreaterThan(0)
      // Should have high severity for success claims with stderr errors
      const hasHigh = fakeSuccess.some((c) => c.severity === 'high')
      expect(hasHigh).toBe(true)
    })

    it('detects fake completion claims as medium severity without errors', () => {
      const checker = new HallucinationChecker()
      const report = checker.verifySync(outputs([
        'Task completed successfully!',
        'All changes have been applied.',
        'No actual file modifications were logged.',
      ]))
      const fakeSuccess = report.claims.filter((c) => c.type === 'fake_success')
      expect(fakeSuccess.length).toBeGreaterThan(0)
      // Without error outputs, severity should be medium
      const allMedium = fakeSuccess.every((c) => c.severity === 'medium')
      expect(allMedium).toBe(true)
    })

    it('detects unsupported test claims', () => {
      const checker = new HallucinationChecker()
      const report = checker.verifySync(outputs([
        'All tests pass ✓',
        'Everything looks good.',
      ]))
      const unsupported = report.claims.filter((c) => c.type === 'unsupported_claim')
      expect(unsupported.length).toBeGreaterThan(0)
    })

    it('detects contradictory file counts', () => {
      const checker = new HallucinationChecker()
      const report = checker.verifySync(outputs([
        'Modified 3 files successfully.',
        'Also modified 7 files in the refactor.',
      ]))
      const contradictions = report.claims.filter((c) => c.type === 'internal_contradiction')
      expect(contradictions.length).toBeGreaterThan(0)
    })

    it('detects conflicting error reports', () => {
      const checker = new HallucinationChecker()
      const report = checker.verifySync(outputs([
        'Error: cannot connect to database',
        'No errors found in the system',
      ]))
      const contradictions = report.claims.filter((c) => c.type === 'internal_contradiction')
      expect(contradictions.length).toBeGreaterThan(0)
      const errorConflicts = contradictions.filter((c) => c.claim.includes('Error count contradiction'))
      expect(errorConflicts.length).toBeGreaterThan(0)
    })

    it('detects overconfident claims without evidence', () => {
      const checker = new HallucinationChecker()
      const report = checker.verifySync(outputs([
        'This is definitely the correct approach.',
        'Absolutely no issues with this implementation.',
      ]))
      const overconfident = report.claims.filter((c) => c.type === 'overconfident')
      // Short output with absolute language should trigger overconfident
      expect(overconfident.length).toBeGreaterThan(0)
    })

    it('detects critical severity for overconfident critical bug fix with errors', () => {
      const checker = new HallucinationChecker()
      const combinedOutputs: AgentOutput[] = [
        { type: 'stdout', data: 'Fixed critical authentication bypass vulnerability', timestamp: Date.now() },
        { type: 'stderr', data: 'Error: test suite failed', timestamp: Date.now() },
      ]
      const report = checker.verifySync(combinedOutputs)
      const criticalClaims = report.claims.filter((c) => c.severity === 'critical')
      expect(criticalClaims.length).toBeGreaterThan(0)
      const overconfidentCritical = report.claims.filter((c) => c.type === 'overconfident' && c.severity === 'critical')
      expect(overconfidentCritical.length).toBeGreaterThan(0)
    })

    it('returns clean report for empty output', () => {
      const checker = new HallucinationChecker()
      const report = checker.verifySync([])
      expect(report.passed).toBe(true)
      expect(report.claims.length).toBe(0)
      expect(report.riskScore).toBe(0)
    })

    it('calculates risk score correctly', () => {
      const checker = new HallucinationChecker()
      const report = checker.verifySync(outputs([
        'Task completed successfully!',
        'Error: critical failure.',
        'Modified 2 files.',
        'Modified 5 files.',
        'Definitely no problems here.',
      ]))
      expect(report.riskScore).toBeGreaterThan(0)
      expect(report.riskScore).toBeLessThanOrEqual(100)
      expect(typeof report.summary).toBe('string')
      expect(report.summary.length).toBeGreaterThan(0)
    })
  })

  describe('verify', () => {
    it('handles async verify with no working directory gracefully', async () => {
      const checker = new HallucinationChecker({ enableFileSystemCheck: false })
      const report = await checker.verify(outputs([
        'Modified: src/foo.ts',
        'Tests: 3 passed, 0 failed.',
      ]))
      expect(report.totalLines).toBe(2)
      expect(report.totalClaims).toBeGreaterThanOrEqual(0)
    })
  })

  describe('config', () => {
    it('respects risk threshold', () => {
      const checker = new HallucinationChecker({ riskThreshold: 0 })
      const report = checker.verifySync(outputs([
        'Definitely correct.',
        'Absolutely no issues.',
      ]))
      expect(report.passed).toBe(false)
    })

    it('disables file system check via config', async () => {
      const checker = new HallucinationChecker({ enableFileSystemCheck: false })
      const report = await checker.verify(outputs([
        'Modified: /nonexistent/path/file.ts',
      ]))
      // No file_not_found claims when file system check is disabled
      const fileClaims = report.claims.filter((c) => c.type === 'file_not_found')
      expect(fileClaims.length).toBe(0)
    })
  })

  describe('riskScore edge cases', () => {
    it('caps risk score at 100', () => {
      const checker = new HallucinationChecker()
      // Generate many suspicious claims
      const lines: string[] = []
      for (let i = 0; i < 10; i++) {
        lines.push(`Task ${i} completed successfully!`)
        lines.push(`Modified ${i + 2} files.`)
      }
      lines.push('Error: fatal crash.')
      const report = checker.verifySync(outputs(lines))
      expect(report.riskScore).toBeLessThanOrEqual(100)
    })

    it('returns 0 risk for clean output', () => {
      const checker = new HallucinationChecker()
      const report = checker.verifySync(outputs([
        'Modified: src/utils/helper.ts',
        'Modified: src/components/Header.tsx',
        'Tests: 8 passed, 0 failed, 8 total',
        'Files changed: 2',
      ]))
      // This output has concrete evidence, should have low/no risk
      expect(report.riskScore).toBeLessThanOrEqual(20)
    })
  })
})
