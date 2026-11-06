import type {
  AgentEventEnvelope,
  BackendCapabilities,
  BackendName,
  NormalizeMeta,
} from '../types'
import { BACKEND_CAPABILITIES } from './capabilities'
import { normalizeClaude } from '../normalizer/claude'
import { normalizeCodex } from '../normalizer/codex'
import { normalizeOpenCode } from '../normalizer/opencode'

/**
 * 新文档的 BackendDriver：把「原始执行器输出 → 统一事件」的差异封在驱动里。
 * spike 的驱动只做归一化；真实的 spawn/SDK 调用未实现。
 */
export interface BackendDriver {
  readonly name: BackendName
  readonly capabilities: BackendCapabilities
  normalize(raw: unknown, meta: NormalizeMeta): AgentEventEnvelope[]
}

export const CLAUDE_DRIVER: BackendDriver = {
  name: 'claude-code',
  capabilities: BACKEND_CAPABILITIES['claude-code'],
  normalize: (raw, meta) => normalizeClaude(raw as unknown[], meta),
}

export const CODEX_DRIVER: BackendDriver = {
  name: 'codex',
  capabilities: BACKEND_CAPABILITIES.codex,
  normalize: (raw, meta) => normalizeCodex(raw, meta),
}

export const OPENCODE_DRIVER: BackendDriver = {
  name: 'opencode',
  capabilities: BACKEND_CAPABILITIES.opencode,
  normalize: (raw, meta) => normalizeOpenCode(raw as string, meta),
}

export const BACKEND_DRIVERS: Record<BackendName, BackendDriver> = {
  'claude-code': CLAUDE_DRIVER,
  codex: CODEX_DRIVER,
  opencode: OPENCODE_DRIVER,
}
