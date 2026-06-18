/**
 * PromptOrchestrator — Unified prompt assembly entry point.
 *
 * Replaces scattered prompt construction in AgentManager by assembling
 * five distinct layers with independent token budgets:
 *
 *   1. System   (fixed, not compressible) — adapter type + role definition
 *   2. Scope    (compressible)            — from buildScopePrompt()
 *   3. Context  (compressible)            — from ContextCompiler.compile() + render()
 *   4. Waterline(not compressible, low)   — from WaterlineSync.formatContext()
 *   5. User     (not compressible)        — the user's command
 *
 * Budget allocation: system 10%, scope 25%, context 35%, waterline 5%, user 25%.
 * Compressible layers that exceed their budget are compressed via
 * compressScopeByPriority() (scope) or ContextCompiler.render() (context).
 * Non-compressible layers are always included even if over budget.
 */

import type {
  AgentOutput,
  AgentSessionConfig,
  ResolvedContext,
  TokenEconomics,
} from '@shared/types'

import { buildScopePrompt } from '../adapters/scope-prompt-builder'
import { ContextCompiler } from './context-compiler'
import { getWaterlineSync } from './waterline-sync'
import { estimateTokens } from '../shared/token-utils'
import { createLogger } from '../shared/logger'

const logger = createLogger('prompt-orchestrator')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssembleOptions {
  sessionId: string
  adapterName: string
  projectId?: string
  nodeId?: string
  nodeTitle?: string
  userCommand: string
  totalBudget: number
  sessionConfig?: AgentSessionConfig
  resolvedContexts?: ResolvedContext[]
  codeContext?: string
  outputs?: AgentOutput[]
}

export interface LayerBreakdown {
  name: string
  tokens: number
  included: boolean
  compressionLevel?: number
}

export interface AssembleResult {
  text: string
  totalTokens: number
  layerBreakdown: LayerBreakdown[]
  economics: TokenEconomics
}

// ---------------------------------------------------------------------------
// Layer descriptors
// ---------------------------------------------------------------------------

interface LayerDescriptor {
  name: string
  budgetPct: number
  compressible: boolean
}

const LAYERS: readonly LayerDescriptor[] = [
  { name: 'system',    budgetPct: 0.10, compressible: false },
  { name: 'scope',     budgetPct: 0.25, compressible: true  },
  { name: 'context',   budgetPct: 0.35, compressible: true  },
  { name: 'waterline', budgetPct: 0.05, compressible: false },
  { name: 'user',      budgetPct: 0.25, compressible: false },
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemInstruction(adapterName: string): string {
  return [
    `You are an AI coding agent powered by ${adapterName}.`,
    'Your task is to assist with software development within the defined scope boundaries.',
    'Follow all constraints strictly. Only modify files that are explicitly allowed.',
    'Report what you did clearly and concisely.',
  ].join('\n')
}

function defaultEconomics(): TokenEconomics {
  return { discoveryTokens: 0, readTokens: 0, savings: 0, savingsPct: 0 }
}

/**
 * Priority-ordered scope compression.
 *
 * Sections are classified by heading prefix and removed in a defined order
 * so that the most expendable information is dropped first.  Each
 * compression level is applied incrementally; the function returns as soon
 * as the text fits within `maxTokens`.
 *
 * Levels:
 *   0 — no compression needed
 *   1 — remove invariant-rules sections
 *   2 — also remove upstream & downstream sections
 *   3 — also compress allowed-files to basenames only
 *   4 — hard-truncate whatever remains
 */
function compressScopeByPriority(
  scopeText: string,
  maxTokens: number,
  estimate: (t: string) => number,
): { text: string; compressionLevel: number } {
  if (estimate(scopeText) <= maxTokens) {
    return { text: scopeText, compressionLevel: 0 }
  }

  // Split into sections on double-or-more newlines
  const sections = scopeText.split(/\n{2,}/)

  type SectionClass = 'invariant' | 'upstream' | 'downstream' | 'allowed-files' | 'other'
  const classify = (s: string): SectionClass => {
    const trimmed = s.trim()
    if (trimmed.startsWith('## Invariant Rules')) return 'invariant'
    if (trimmed.startsWith('## Upstream'))       return 'upstream'
    if (trimmed.startsWith('## Downstream'))     return 'downstream'
    if (trimmed.startsWith('## Allowed Files'))  return 'allowed-files'
    return 'other'
  }

  const classified = sections.map((s) => ({ text: s, cls: classify(s) }))

  // --- Level 1: remove invariant rules ---
  let filtered = classified.filter((s) => s.cls !== 'invariant')
  let text = filtered.map((s) => s.text).join('\n\n')
  if (estimate(text) <= maxTokens) {
    return { text, compressionLevel: 1 }
  }

  // --- Level 2: also remove upstream & downstream ---
  filtered = filtered.filter((s) => s.cls !== 'upstream' && s.cls !== 'downstream')
  text = filtered.map((s) => s.text).join('\n\n')
  if (estimate(text) <= maxTokens) {
    return { text, compressionLevel: 2 }
  }

  // --- Level 3: compress allowed-files to basenames only ---
  filtered = filtered.map((s) => {
    if (s.cls !== 'allowed-files') return s
    // Replace each path-like token with its basename
    const compressed = s.text.replace(
      /(?:^|\s)(?:\/[\w.-]+)+\/([\w.-]+)/gm,
      (_, basename) => basename,
    )
    return { text: compressed, cls: s.cls }
  })
  text = filtered.map((s) => s.text).join('\n\n')
  if (estimate(text) <= maxTokens) {
    return { text, compressionLevel: 3 }
  }

  // --- Level 4: hard-truncate remaining text ---
  // Approximate truncation: keep slicing characters until under budget.
  // Use a rough 4-chars-per-token heuristic for the initial slice, then
  // binary-search downward if still over.
  let charBudget = maxTokens * 4
  let truncated = text.slice(0, charBudget)
  // Fix potential surrogate pair split at boundary
  if (truncated.length < text.length && truncated.charCodeAt(truncated.length - 1) >= 0xD800) {
    truncated = truncated.slice(0, -1)
  }
  while (estimate(truncated) > maxTokens && charBudget > 0) {
    charBudget = Math.floor(charBudget * 0.9)
    truncated = text.slice(0, charBudget)
  }
  return { text: truncated, compressionLevel: 4 }
}

// ---------------------------------------------------------------------------
// PromptOrchestrator
// ---------------------------------------------------------------------------

export class PromptOrchestrator {
  private contextCompiler: ContextCompiler

  constructor() {
    this.contextCompiler = new ContextCompiler()
  }

  /**
   * Assemble a full prompt from the five layers, respecting the total
   * token budget. Compressible layers are truncated when they exceed
   * their allocated budget; non-compressible layers are always included.
   */
  async assemble(options: AssembleOptions): Promise<AssembleResult> {
    const {
      sessionId,
      adapterName,
      projectId,
      nodeId: _nodeId,
      nodeTitle: _nodeTitle,
      userCommand,
      totalBudget,
      sessionConfig,
      resolvedContexts,
      codeContext,
      outputs,
    } = options

    // Compute per-layer budgets
    const budgets = LAYERS.map((l) => Math.floor(totalBudget * l.budgetPct))

    // --- Layer 1: System (fixed) ---
    const systemText = buildSystemInstruction(adapterName)
    const systemTokens = estimateTokens(systemText)

    // --- Layer 2: Scope (compressible) ---
    let scopeText = ''
    let scopeTokens = 0
    let scopeCompressionLevel = 0
    if (sessionConfig) {
      scopeText = buildScopePrompt(sessionConfig, resolvedContexts, codeContext)
      scopeTokens = estimateTokens(scopeText)
      if (scopeTokens > budgets[1]) {
        logger.info(`Scope layer (${scopeTokens} tokens) exceeds budget (${budgets[1]}), compressing by priority`)
        const compressed = compressScopeByPriority(scopeText, budgets[1], estimateTokens)
        scopeText = compressed.text
        scopeTokens = estimateTokens(scopeText)
        scopeCompressionLevel = compressed.compressionLevel
        logger.info(`Scope compression level: ${scopeCompressionLevel}, result: ${scopeTokens} tokens`)
      }
    }

    // --- Layer 3: Context (compressible) ---
    let contextText = ''
    let contextTokens = 0
    let contextEconomics = defaultEconomics()
    if (outputs && outputs.length > 0) {
      try {
        const layered = await this.contextCompiler.compile(outputs, {
          sessionId,
          adapterName,
          commandDescription: userCommand,
          projectId,
        })
        const rendered = this.contextCompiler.render(layered, budgets[2])
        contextText = rendered.text
        contextTokens = estimateTokens(contextText)
        contextEconomics = rendered.economics
      } catch (err) {
        logger.warn('Context compilation failed, skipping context layer:', err)
      }
    }

    // --- Layer 4: Waterline (not compressible, low cost) ---
    let waterlineText = ''
    let waterlineTokens = 0
    if (projectId) {
      try {
        const waterlineSync = getWaterlineSync()
        waterlineText = waterlineSync.formatContext(projectId)
        waterlineTokens = estimateTokens(waterlineText)
      } catch (err) {
        logger.warn('Waterline format failed, skipping waterline layer:', err)
      }
    }

    // --- Layer 5: User (not compressible) ---
    const userText = userCommand
    const userTokens = estimateTokens(userText)

    // --- Elastic budget reallocation (post-hoc) ---
    // If scope layer is empty, transfer its budget to context.
    // If waterline exceeds 5% of total budget, borrow excess from context.
    const adjustedBudgets = [...budgets]
    if (scopeTokens === 0) {
      adjustedBudgets[2] += adjustedBudgets[1]
      adjustedBudgets[1] = 0
      logger.info('Scope layer empty: transferred scope budget to context')
    }
    const waterlineThreshold = totalBudget * 0.05
    if (waterlineTokens > waterlineThreshold) {
      const excess = waterlineTokens - Math.floor(waterlineThreshold)
      // Only borrow from context if context has budget to spare
      const borrowable = Math.min(excess, adjustedBudgets[2])
      if (borrowable > 0) {
        adjustedBudgets[2] -= borrowable
        adjustedBudgets[3] += borrowable
        logger.info(`Waterline exceeds 5% budget: borrowed ${borrowable} tokens from context`)
      }
    }

    // Re-compress context if its budget shrank after reallocation
    if (contextTokens > adjustedBudgets[2] && adjustedBudgets[2] > 0 && outputs && outputs.length > 0) {
      try {
        const layered = await this.contextCompiler.compile(outputs, {
          sessionId,
          adapterName,
          commandDescription: userCommand,
          projectId,
        })
        const rendered = this.contextCompiler.render(layered, adjustedBudgets[2])
        contextText = rendered.text
        contextTokens = estimateTokens(contextText)
        contextEconomics = rendered.economics
      } catch (err) {
        logger.warn('Context re-compression after reallocation failed:', err)
      }
    }

    // --- Inter-layer dedup: scope vs context ---
    // Use line-level dedup instead of word-level Jaccard for performance.
    // Remove context lines that already appear in scope (lower priority layer).
    if (scopeText && contextText) {
      const scopeLineSet = new Set<string>()
      for (const line of scopeText.split('\n')) {
        const trimmed = line.trim().toLowerCase()
        if (trimmed) scopeLineSet.add(trimmed)
      }
      const contextLines = contextText.split('\n')
      const dedupedLines = contextLines.filter(
        (line) => !scopeLineSet.has(line.trim().toLowerCase()),
      )
      const removedCount = contextLines.length - dedupedLines.length
      if (removedCount > 0) {
        contextText = dedupedLines.join('\n')
        contextTokens = estimateTokens(contextText)
        logger.info(
          `Inter-layer dedup: removed ${removedCount} duplicate lines from context`,
        )
      }
    }

    // --- Build breakdown ---
    const layerData = [
      { text: systemText,    tokens: systemTokens,    included: true  },
      { text: scopeText,     tokens: scopeTokens,     included: true  },
      { text: contextText,   tokens: contextTokens,   included: contextTokens > 0 },
      { text: waterlineText, tokens: waterlineTokens, included: true  },
      { text: userText,      tokens: userTokens,      included: true  },
    ]

    const layerBreakdown: LayerBreakdown[] = LAYERS.map((l, i) => ({
      name: l.name,
      tokens: layerData[i].tokens,
      included: layerData[i].included,
      ...(l.name === 'scope' && scopeCompressionLevel > 0
        ? { compressionLevel: scopeCompressionLevel }
        : {}),
    }))

    // --- Assemble final text ---
    const parts: string[] = []
    if (systemText)    parts.push(systemText)
    if (scopeText)     parts.push(scopeText)
    if (contextText)   parts.push(contextText)
    if (waterlineText) parts.push(waterlineText)
    if (userText)      parts.push(userText)

    const text = parts.join('\n\n')
    const totalTokens = estimateTokens(text)

    // Compute aggregate economics
    const economics: TokenEconomics = {
      discoveryTokens: contextEconomics.discoveryTokens + waterlineTokens,
      readTokens: contextEconomics.readTokens + scopeTokens,
      savings: contextEconomics.savings,
      savingsPct: contextEconomics.savingsPct,
    }

    logger.info(
      `Assembled prompt for session ${sessionId}: ${totalTokens} tokens ` +
        `(budget ${totalBudget}), layers: ${layerBreakdown.map((l) => `${l.name}=${l.tokens}`).join(', ')}`,
    )

    return { text, totalTokens, layerBreakdown, economics }
  }
}
