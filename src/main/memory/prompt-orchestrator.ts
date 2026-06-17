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
 * compressScopePrompt(). Non-compressible layers are always included
 * even if over budget.
 */

import type {
  AgentOutput,
  AgentSessionConfig,
  ResolvedContext,
  TokenEconomics,
} from '@shared/types'

import { buildScopePrompt, compressScopePrompt } from '../adapters/scope-prompt-builder'
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
    if (sessionConfig) {
      scopeText = buildScopePrompt(sessionConfig, resolvedContexts, codeContext)
      scopeTokens = estimateTokens(scopeText)
      if (scopeTokens > budgets[1]) {
        logger.info(`Scope layer (${scopeTokens} tokens) exceeds budget (${budgets[1]}), compressing`)
        scopeText = compressScopePrompt(scopeText, budgets[1])
        scopeTokens = estimateTokens(scopeText)
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
