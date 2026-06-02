/**
 * Schema 校验器
 *
 * 验证 Claude 输出的 JSON 是否符合 ScanModule[] 格式。
 * 含容错处理：缺失字段补全、超限截断、类型修正。
 */

import type { ScanModule, ScanProcess, ScanFeature } from '@shared/types'

interface RawModule {
  name?: unknown
  description?: unknown
  processes?: unknown
}

interface RawProcess {
  name?: unknown
  description?: unknown
  features?: unknown
}

interface RawFeature {
  name?: unknown
  description?: unknown
  type?: unknown
  relatedFiles?: unknown
}

/** 最大限制 */
const LIMITS = {
  maxModules: 8,
  maxProcesses: 6,
  maxFeatures: 8,
  maxNameLen: 50,
  maxDescLen: 200,
}

/** 禁止出现在模块/功能名中的噪音模式 */
const NOISE_PATTERNS = [
  /^(npm|yarn|pnpm)\s+(run\s+)?/i,
  /^(dev|build|test|lint|start|serve|preview|watch)$/i,
  /^(node_modules|dist|build|coverage|\.next|\.nuxt)$/i,
  /^(eslint|prettier|husky|lint-staged|jest|vitest|playwright)$/i,
]

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isNoiseName(name: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(name.trim()))
}

function sanitizeString(v: unknown, maxLen: number, fallback: string): string {
  if (!isString(v)) return fallback
  const trimmed = v.trim()
  return trimmed.length > maxLen ? trimmed.substring(0, maxLen) + '...' : trimmed
}

function sanitizeFeature(raw: unknown): ScanFeature | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as RawFeature

  const name = sanitizeString(obj.name, LIMITS.maxNameLen, '')
  if (!name || isNoiseName(name)) return null

  return {
    name,
    description: sanitizeString(obj.description, LIMITS.maxDescLen, ''),
    type: obj.type === 'bug' ? 'bug' : 'feature',
  }
}

function sanitizeProcess(raw: unknown): ScanProcess | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as RawProcess

  const name = sanitizeString(obj.name, LIMITS.maxNameLen, '')
  if (!name) return null

  const rawFeatures = Array.isArray(obj.features) ? obj.features : []
  const features = rawFeatures
    .map(sanitizeFeature)
    .filter((f): f is ScanFeature => f !== null)
    .slice(0, LIMITS.maxFeatures)

  // 过滤掉全是噪音的流程
  if (features.length === 0) return null

  return {
    name,
    description: sanitizeString(obj.description, LIMITS.maxDescLen, ''),
    features,
  }
}

function sanitizeModule(raw: unknown): ScanModule | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as RawModule

  const name = sanitizeString(obj.name, LIMITS.maxNameLen, '')
  if (!name || isNoiseName(name)) return null

  const rawProcesses = Array.isArray(obj.processes) ? obj.processes : []
  const processes = rawProcesses
    .map(sanitizeProcess)
    .filter((p): p is ScanProcess => p !== null)
    .slice(0, LIMITS.maxProcesses)

  if (processes.length === 0) return null

  return {
    name,
    description: sanitizeString(obj.description, LIMITS.maxDescLen, ''),
    processes,
  }
}

/**
 * 校验并转换 Claude 输出为 ScanModule[]
 *
 * @returns 有效的 ScanModule[]，如果完全无效则返回空数组
 */
export function validateModules(raw: unknown): ScanModule[] {
  let modulesRaw: unknown[]

  if (Array.isArray(raw)) {
    modulesRaw = raw
  } else if (typeof raw === 'object' && raw !== null && Array.isArray((raw as { modules?: unknown }).modules)) {
    modulesRaw = (raw as { modules: unknown[] }).modules
  } else {
    return []
  }

  const modules = modulesRaw
    .map(sanitizeModule)
    .filter((m): m is ScanModule => m !== null)
    .slice(0, LIMITS.maxModules)

  return modules
}

/**
 * 校验 NodeEnrichment 格式
 */
export interface ValidatedEnrichment {
  description: string
  acceptanceCriteria: string[]
  businessRules: Array<{ id: string; title: string; description: string; condition: string; action: string }>
  relatedFiles: string[]
  implementationHints: string[]
  codeSignatures: string[]
}

export function validateEnrichment(raw: unknown): ValidatedEnrichment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>

  const description = sanitizeString(obj.description, 500, '')
  if (!description) return null

  return {
    description,
    acceptanceCriteria: Array.isArray(obj.acceptanceCriteria)
      ? obj.acceptanceCriteria.filter(isString).slice(0, 10)
      : [],
    businessRules: Array.isArray(obj.businessRules)
      ? obj.businessRules
          .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
          .map((r) => ({
            id: sanitizeString(r.id, 50, `rule_${Date.now()}`),
            title: sanitizeString(r.title, 100, ''),
            description: sanitizeString(r.description, 200, ''),
            condition: sanitizeString(r.condition, 200, ''),
            action: sanitizeString(r.action, 200, ''),
          }))
          .filter((r) => r.title && r.condition && r.action)
          .slice(0, 10)
      : [],
    relatedFiles: Array.isArray(obj.relatedFiles)
      ? obj.relatedFiles.filter(isString).slice(0, 20)
      : [],
    implementationHints: Array.isArray(obj.implementationHints)
      ? obj.implementationHints.filter(isString).slice(0, 10)
      : [],
    codeSignatures: Array.isArray(obj.codeSignatures)
      ? obj.codeSignatures.filter(isString).slice(0, 15)
      : [],
  }
}
