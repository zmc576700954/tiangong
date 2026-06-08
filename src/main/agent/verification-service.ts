/**
 * Verification Service
 * Builds verification prompts and parses Agent responses for acceptance criteria checking
 */

import type { ChatMessage, AgentOutput, VerificationResult } from '@shared/types'

export class VerificationService {
  buildVerificationPrompt(
    nodeId: string,
    acceptanceCriteria: string[],
    messages: ChatMessage[],
    fileChanges: AgentOutput[],
  ): string {
    const lines: string[] = []

    lines.push('You are a QA reviewer. Evaluate whether the implementation meets each acceptance criterion.')
    lines.push('')
    lines.push('## Acceptance Criteria')
    acceptanceCriteria.forEach((c, i) => {
      lines.push(`${i + 1}. ${c}`)
    })
    lines.push('')

    lines.push('## Implementation Summary')
    const agentMessages = messages.filter((m) => m.role === 'agent')
    const summary = agentMessages.map((m) => m.content).join('\n').slice(0, 3000)
    lines.push(summary)
    lines.push('')

    lines.push('## Changed Files')
    const uniqueFiles = [...new Set(fileChanges.map((o) => o.filePath).filter(Boolean))]
    uniqueFiles.forEach((fp) => {
      const change = fileChanges.find((o) => o.filePath === fp)
      lines.push(`- ${change?.changeType ?? 'modify'}: ${fp}`)
    })
    lines.push('')

    lines.push('For each criterion, respond with exactly this format:')
    lines.push('CRITERION_N: PASS or FAIL')
    lines.push('JUSTIFICATION_N: Brief justification (1-2 sentences)')
    lines.push('')
    lines.push('Where N is the criterion number (1, 2, 3, ...).')
    lines.push('Do not include any other text between criterion responses.')

    return lines.join('\n')
  }

  parseVerificationResponse(
    response: string,
    acceptanceCriteria: string[],
  ): VerificationResult[] {
    const results: VerificationResult[] = []

    // Single-pass: extract all CRITERION_N: PASS/FAIL matches
    const criterionRegex = /CRITERION_(\d+):\s*(PASS|FAIL)/gi
    const passMap = new Map<number, boolean>()
    let match: RegExpExecArray | null
    while ((match = criterionRegex.exec(response)) !== null) {
      const num = parseInt(match[1], 10)
      passMap.set(num, match[2].toUpperCase() === 'PASS')
    }

    // Single-pass: extract all JUSTIFICATION_N: ... matches
    const justRegex = /JUSTIFICATION_(\d+):\s*(.+?)(?=\n(?:CRITERION_|JUSTIFICATION_)|$)/gis
    const justMap = new Map<number, string>()
    while ((match = justRegex.exec(response)) !== null) {
      const num = parseInt(match[1], 10)
      justMap.set(num, match[2].trim())
    }

    for (let i = 0; i < acceptanceCriteria.length; i++) {
      const n = i + 1
      results.push({
        criterion: acceptanceCriteria[i],
        passed: passMap.get(n) ?? false,
        justification: justMap.get(n) ?? 'No justification provided',
      })
    }

    return results
  }

  buildRetryPrompt(failedResults: VerificationResult[]): string {
    const lines: string[] = []
    lines.push('The following acceptance criteria were not met. Please fix the implementation:')
    lines.push('')
    failedResults.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.criterion}`)
      lines.push(`   Issue: ${r.justification}`)
      lines.push('')
    })
    lines.push('Please address each issue and ensure all criteria are met.')
    return lines.join('\n')
  }
}
