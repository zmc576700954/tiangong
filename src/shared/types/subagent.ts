/**
 * Subagent dispatch — shared types
 *
 * Phase 1 of the context-compaction-and-subagent-dispatch design.
 * Runtime wiring lives in Phase 4 (SubagentManager); UI in Phase 5.
 */

/** How a subagent's sandbox relates to its parent's. */
export type SubagentScopeStrategy = 'inherit' | 'subset' | 'fresh'

/** Which mechanism the host adapter uses to expose dispatch_subagent. */
export type SubagentCapability = 'native-task' | 'api-tool' | 'inline-protocol'

/** Persisted lifecycle status of one subagent_invocations row. */
export type SubagentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Built-in tool names used by the allowedTools list. */
export type SubagentToolName =
  | 'Read'
  | 'Glob'
  | 'Grep'
  | 'WebFetch'
  | 'Edit'
  | 'Write'
  | 'Bash'

/** Definition of one subagent type (built-in or user-defined). */
export interface AgentTypeDefinition {
  /** Stable machine name, lower-kebab-case. */
  name: string
  /** Human-readable label. */
  displayName: string
  /** What the parent agent reads when deciding which type to dispatch. */
  description: string
  /** '*' = full tool set; otherwise an explicit whitelist. */
  allowedTools: SubagentToolName[] | '*'
  /** Optional adapter override. */
  defaultAdapter?: string
  /** Optional model override. */
  defaultModel?: string
  /** Appended to the scope prompt of the child session. */
  systemPromptAddon?: string
  /** Sandbox derivation strategy. */
  scopeStrategy: SubagentScopeStrategy
  /** If true, run a cheap LLM summary on result_text before returning to parent. */
  summarizeResult?: boolean
}

/** Arguments accepted by SubagentManager.invoke() — also the dispatch_subagent tool schema. */
export interface SubagentInvokeArgs {
  parentSessionId: string
  parentMessageId?: string
  agentType: string
  description: string
  prompt: string
  adapterName?: string
  nodeId?: string
  allowedFiles?: string[]
}

/** Persisted subagent_invocations row (renderer-facing shape). */
export interface SubagentInvocation {
  id: string
  parentSessionId: string
  parentMessageId: string | null
  graphId: string | null
  agentType: string
  description: string
  prompt: string
  adapterName: string | null
  nodeId: string | null
  allowedFiles: string[] | null
  status: SubagentStatus
  resultText: string | null
  resultFiles: string[] | null
  tokensUsed: number
  startedAt: number
  finishedAt: number | null
  error: string | null
}

/** Final result returned by SubagentManager.invoke(). */
export interface SubagentResult {
  invocationId: string
  resultText: string
  resultFiles: string[]
  tokensUsed: number
  durationMs: number
}

/** Built-in agent types — registry seed. */
export const BUILT_IN_AGENT_TYPES: AgentTypeDefinition[] = [
  {
    name: 'explore',
    displayName: '探索者',
    description: 'Read-only multi-file search. Returns a structured report of locations and findings. Use for: locating code, mapping a subsystem, gathering context before edits.',
    allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch'],
    scopeStrategy: 'inherit',
  },
  {
    name: 'implement',
    displayName: '实现者',
    description: 'Implements a feature or change within a constrained file set. Use for: small-to-medium feature work where the file list is known.',
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    scopeStrategy: 'subset',
  },
  {
    name: 'review',
    displayName: '审查者',
    description: 'Read-only review of specified files. Returns a problem list. Use for: code review, static checks, security scans.',
    allowedTools: ['Read', 'Glob', 'Grep'],
    scopeStrategy: 'inherit',
  },
  {
    name: 'fix',
    displayName: '修复者',
    description: 'Locates and fixes a specific bug. Use for: bug nodes with reproducible symptoms.',
    allowedTools: ['Read', 'Edit', 'Bash'],
    scopeStrategy: 'subset',
  },
  {
    name: 'general',
    displayName: '通用',
    description: 'Full-tool generalist. Use when no specialised type fits.',
    allowedTools: '*',
    scopeStrategy: 'subset',
  },
]
