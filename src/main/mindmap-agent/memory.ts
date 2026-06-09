/**
 * 项目记忆系统
 *
 * 持久化存储在 .bizgraph/memory.json，随项目走。
 * 存储：业务域理解、精炼历史、用户偏好。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '../shared/logger'
import type { ProjectMemory, RefinementRecord } from '@shared/types'

const logger = createLogger('ProjectMemory')

const MEMORY_DIR = '.bizgraph'
const MEMORY_FILE = 'memory.json'

/** 按项目路径隔离的写入互斥锁，防止并发写导致数据丢失 */
const writeLocks = new Map<string, Promise<void>>()

/**
 * 串行化写入操作：同一项目的写入操作按序执行，避免并发读写丢失数据
 */
function withWriteLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(projectPath) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => { release = resolve })
  // 将当前锁链存储到 Map，后续写入等待前一个完成
  const chain = prev.then(() => next).catch(() => next)
  writeLocks.set(projectPath, chain)
  return prev.then(() => fn()).finally(() => {
    release()
    // 延迟到下一个 microtask 检查：若锁链仍指向当前 chain，说明无后续写入
    queueMicrotask(() => {
      if (writeLocks.get(projectPath) === chain) {
        writeLocks.delete(projectPath)
      }
    })
  })
}

const DEFAULT_PREFERENCES: ProjectMemory['preferences'] = {
  granularity: 'medium',
  namingStyle: 'business',
  maxModules: 6,
  avoidPatterns: [
    'npm scripts 作为功能点',
    '技术栈依赖作为模块',
    '开发工具作为业务功能',
    '目录名称直接作为模块名',
  ],
}

function createDefaultMemory(projectPath: string): ProjectMemory {
  return {
    projectId: '',
    projectPath,
    businessDomains: [],
    architecturePattern: '',
    coreUserFlows: [],
    techConstraints: [],
    refinements: [],
    preferences: { ...DEFAULT_PREFERENCES },
    updatedAt: new Date().toISOString(),
  }
}

function memoryPath(projectPath: string): string {
  return path.join(projectPath, MEMORY_DIR, MEMORY_FILE)
}

/**
 * 读取项目记忆，不存在则返回默认值
 */
export async function readMemory(projectPath: string): Promise<ProjectMemory> {
  try {
    const raw = await fs.readFile(memoryPath(projectPath), 'utf-8')
    const parsed = JSON.parse(raw) as ProjectMemory
    // 合并默认值（防止旧文件缺少新字段）
    return {
      ...createDefaultMemory(projectPath),
      ...parsed,
      preferences: { ...DEFAULT_PREFERENCES, ...parsed.preferences },
    }
  } catch {
    return createDefaultMemory(projectPath)
  }
}

/**
 * 写入项目记忆（原子写入：先写临时文件再 rename，防止写入中断导致损坏）
 * 通过 withWriteLock 串行化同一项目的并发写入
 */
export function writeMemory(projectPath: string, memory: ProjectMemory): Promise<void> {
  return withWriteLock(projectPath, async () => {
    const dir = path.join(projectPath, MEMORY_DIR)
    await fs.mkdir(dir, { recursive: true })
    memory.updatedAt = new Date().toISOString()
    const tmpPath = memoryPath(projectPath) + '.tmp'
    await fs.writeFile(tmpPath, JSON.stringify(memory, null, 2), 'utf-8')
    await fs.rename(tmpPath, memoryPath(projectPath))
  })
}

/**
 * 添加精炼记录并更新偏好
 */
export async function addRefinement(
  projectPath: string,
  record: Omit<RefinementRecord, 'timestamp'>,
): Promise<ProjectMemory> {
  const memory = await readMemory(projectPath)

  const fullRecord: RefinementRecord = {
    ...record,
    timestamp: new Date().toISOString(),
  }
  memory.refinements.push(fullRecord)

  // 从精炼历史中学习偏好
  learnPreferences(memory)

  await writeMemory(projectPath, memory)
  return memory
}

/**
 * 更新业务域理解
 */
export async function updateDomains(
  projectPath: string,
  domains: string[],
  pattern: string,
  flows: string[] = [],
  constraints: string[] = [],
): Promise<void> {
  const memory = await readMemory(projectPath)
  memory.businessDomains = domains
  memory.architecturePattern = pattern
  memory.coreUserFlows = flows
  memory.techConstraints = constraints
  await writeMemory(projectPath, memory)
}

/**
 * 从精炼历史中学习用户偏好（加权评分算法）
 * 每条精炼记录按时间衰减加权，越新的记录权重越高。
 * 评分超过阈值时才更新偏好，避免少量偶然操作影响整体判断。
 */
function learnPreferences(memory: ProjectMemory): void {
  const recent = memory.refinements.slice(-15)
  if (recent.length < 2) return

  // 时间衰减权重：最新的权重为 1.0，最早的为 0.3
  const weights = recent.map((_r: RefinementRecord, i: number) => 0.3 + 0.7 * (i / Math.max(recent.length - 1, 1)))

  // === 命名风格分析 ===
  let businessScore = 0
  let technicalScore = 0
  let totalNameWeight = 0

  for (let i = 0; i < recent.length; i++) {
    const r = recent[i]
    const w = weights[i]
    const isNameChange = r.reason.includes('命名') || r.reason.includes('名称') || r.reason.includes('改为')
    if (!isNameChange) continue
    totalNameWeight += w
    if (r.after.match(/管理|系统|服务|流程|业务|中心|平台|订单|用户/)) {
      businessScore += w
    }
    if (r.after.match(/层|器|组件|模块|接口|Handler|Service|Controller|Factory/)) {
      technicalScore += w
    }
  }

  if (totalNameWeight >= 1.5) { // 加权总和超过阈值才更新
    const businessRatio = businessScore / totalNameWeight
    const technicalRatio = technicalScore / totalNameWeight
    if (businessRatio > 0.6 && businessRatio > technicalRatio * 1.5) {
      memory.preferences.namingStyle = 'business'
    } else if (technicalRatio > 0.6 && technicalRatio > businessRatio * 1.5) {
      memory.preferences.namingStyle = 'technical'
    } else {
      memory.preferences.namingStyle = 'mixed'
    }
  }

  // === 粒度偏好分析 ===
  let splitScore = 0  // 正=倾向拆分，负=倾向合并
  let totalGranularityWeight = 0

  for (let i = 0; i < recent.length; i++) {
    const r = recent[i]
    const w = weights[i]
    const isSplit = r.reason.includes('拆分')
    const isMerge = r.reason.includes('合并')
    if (!isSplit && !isMerge) continue
    totalGranularityWeight += w
    splitScore += isSplit ? w : -w
  }

  if (totalGranularityWeight >= 1.5) {
    const ratio = splitScore / totalGranularityWeight // -1 ~ +1
    if (ratio > 0.3) {
      memory.preferences.granularity = 'fine'
      memory.preferences.maxModules = Math.min(memory.preferences.maxModules + 1, 10)
    } else if (ratio < -0.3) {
      memory.preferences.granularity = 'coarse'
      memory.preferences.maxModules = Math.max(memory.preferences.maxModules - 1, 3)
    }
    // ratio 在 -0.3 ~ 0.3 之间不调整，保持当前偏好
  }

  logger.debug('learnPreferences', {
    namingStyle: memory.preferences.namingStyle,
    granularity: memory.preferences.granularity,
    maxModules: memory.preferences.maxModules,
    businessScore: businessScore.toFixed(2),
    technicalScore: technicalScore.toFixed(2),
    splitScore: splitScore.toFixed(2),
  })
}

// ============================================
// 记忆衰减与跨项目学习
// ============================================

/** 记忆条目最大存活天数，超过则归档 */
const MEMORY_DECAY_DAYS = 180
/** 记忆权重衰减阈值天数，超过后降低权重 */
const MEMORY_FADE_DAYS = 90

/**
 * 应用记忆衰减：清理过期的精炼记录，降低旧记忆的权重
 * 应在 readMemory 后调用，确保返回的记忆是"新鲜"的
 */
export async function applyMemoryDecay(projectPath: string): Promise<void> {
  const memory = await readMemory(projectPath)
  const now = Date.now()
  const decayMs = MEMORY_DECAY_DAYS * 24 * 60 * 60 * 1000
  const fadeMs = MEMORY_FADE_DAYS * 24 * 60 * 60 * 1000

  let changed = false

  // 1. 清理过期精炼记录（>180 天）
  const originalCount = memory.refinements.length
  memory.refinements = memory.refinements.filter((r) => {
    const recordTime = new Date(r.timestamp).getTime()
    return now - recordTime < decayMs
  })
  if (memory.refinements.length < originalCount) {
    changed = true
    logger.info(`Memory decay: removed ${originalCount - memory.refinements.length} expired refinements`)
  }

  // 2. 降低 faded 记忆的权重（通过标记，不影响现有结构）
  // 这里我们通过重新计算 preferences 来间接实现衰减
  // 因为 learnPreferences 只取最近 15 条，旧的会自动被排除
  if (memory.refinements.length > 0) {
    const newestTime = new Date(memory.refinements[memory.refinements.length - 1].timestamp).getTime()
    if (now - newestTime > fadeMs) {
      logger.warn(`Memory for ${projectPath} is stale (>${MEMORY_FADE_DAYS} days), preferences may be outdated`)
    }
  }

  if (changed) {
    await writeMemory(projectPath, memory)
  }
}

/** 全局知识库路径（存储跨项目学习到的通用模式） */
const GLOBAL_KNOWLEDGE_PATH = path.join(process.env.APPDATA || process.env.HOME || '.', '.bizgraph', 'global-knowledge.json')

/** 跨项目通用模式 */
export interface GlobalKnowledge {
  /** 通用业务域模式 */
  commonDomains: string[]
  /** 通用架构模式 */
  commonArchitectures: string[]
  /** 通用用户流程 */
  commonFlows: string[]
  /** 各项目记忆摘要 */
  projectSummaries: Array<{
    projectPath: string
    projectName: string
    businessDomains: string[]
    architecturePattern: string
    updatedAt: string
  }>
  updatedAt: string
}

function createDefaultGlobalKnowledge(): GlobalKnowledge {
  return {
    commonDomains: [],
    commonArchitectures: [],
    commonFlows: [],
    projectSummaries: [],
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 读取全局知识库
 */
export async function readGlobalKnowledge(): Promise<GlobalKnowledge> {
  try {
    const raw = await fs.readFile(GLOBAL_KNOWLEDGE_PATH, 'utf-8')
    return { ...createDefaultGlobalKnowledge(), ...JSON.parse(raw) }
  } catch {
    return createDefaultGlobalKnowledge()
  }
}

/**
 * 写入全局知识库
 */
export async function writeGlobalKnowledge(knowledge: GlobalKnowledge): Promise<void> {
  await fs.mkdir(path.dirname(GLOBAL_KNOWLEDGE_PATH), { recursive: true })
  knowledge.updatedAt = new Date().toISOString()
  await fs.writeFile(GLOBAL_KNOWLEDGE_PATH, JSON.stringify(knowledge, null, 2), 'utf-8')
}

/**
 * 将当前项目记忆合并到全局知识库
 * 提取通用模式，用于新项目初始化时推荐
 */
export async function contributeToGlobalKnowledge(projectPath: string): Promise<void> {
  const memory = await readMemory(projectPath)
  const knowledge = await readGlobalKnowledge()

  // 更新/添加项目摘要
  const existingIndex = knowledge.projectSummaries.findIndex(
    (s) => s.projectPath === projectPath,
  )
  const projectName = path.basename(projectPath)
  const summary = {
    projectPath,
    projectName,
    businessDomains: memory.businessDomains,
    architecturePattern: memory.architecturePattern,
    updatedAt: new Date().toISOString(),
  }

  if (existingIndex >= 0) {
    knowledge.projectSummaries[existingIndex] = summary
  } else {
    knowledge.projectSummaries.push(summary)
  }

  // 提取跨项目通用域（出现 >=2 次的域）
  const domainCounts = new Map<string, number>()
  for (const s of knowledge.projectSummaries) {
    for (const d of s.businessDomains) {
      domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1)
    }
  }
  knowledge.commonDomains = [...domainCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([domain]) => domain)

  // 提取通用架构模式（出现 >=2 次）
  const archCounts = new Map<string, number>()
  for (const s of knowledge.projectSummaries) {
    if (s.architecturePattern) {
      archCounts.set(s.architecturePattern, (archCounts.get(s.architecturePattern) ?? 0) + 1)
    }
  }
  knowledge.commonArchitectures = [...archCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([arch]) => arch)

  await writeGlobalKnowledge(knowledge)
  logger.info('Global knowledge updated:', {
    projects: knowledge.projectSummaries.length,
    commonDomains: knowledge.commonDomains.length,
    commonArchitectures: knowledge.commonArchitectures.length,
  })
}

/**
 * 为新建项目推荐初始业务域（基于全局知识库）
 */
export async function recommendInitialDomains(
  _projectPath: string,
  framework: string,
): Promise<string[]> {
  const knowledge = await readGlobalKnowledge()
  const recommendations: string[] = []

  // 基于框架推荐常见域
  const frameworkDomains: Record<string, string[]> = {
    'electron': ['桌面应用框架', '进程通信', '窗口管理'],
    'nextjs': ['服务端渲染', 'API 路由', '数据获取'],
    'react': ['组件体系', '状态管理', '路由导航'],
    'vue': ['响应式系统', '组件复用', '指令系统'],
    'nestjs': ['依赖注入', '模块组织', '中间件'],
  }

  const fwKey = Object.keys(frameworkDomains).find((k) =>
    framework.toLowerCase().includes(k.toLowerCase()),
  )
  if (fwKey) {
    recommendations.push(...frameworkDomains[fwKey])
  }

  // 基于全局知识库补充
  recommendations.push(...knowledge.commonDomains.slice(0, 3))

  return [...new Set(recommendations)].slice(0, 5)
}
