/**
 * 项目记忆系统
 *
 * 持久化存储在 .bizgraph/memory.json，随项目走。
 * 存储：业务域理解、精炼历史、用户偏好。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectMemory, RefinementRecord } from '@shared/types'

const MEMORY_DIR = '.bizgraph'
const MEMORY_FILE = 'memory.json'

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
 * 写入项目记忆
 */
export async function writeMemory(projectPath: string, memory: ProjectMemory): Promise<void> {
  const dir = path.join(projectPath, MEMORY_DIR)
  await fs.mkdir(dir, { recursive: true })
  memory.updatedAt = new Date().toISOString()
  await fs.writeFile(memoryPath(projectPath), JSON.stringify(memory, null, 2), 'utf-8')
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
 * 从精炼历史中学习用户偏好
 */
function learnPreferences(memory: ProjectMemory): void {
  const recent = memory.refinements.slice(-10)
  if (recent.length < 2) return

  // 分析命名风格
  const nameChanges = recent.filter((r) =>
    r.reason.includes('命名') || r.reason.includes('名称') || r.reason.includes('改为'),
  )
  if (nameChanges.length >= 2) {
    const hasBusiness = nameChanges.some((r) =>
      r.after.match(/管理|系统|服务|流程|业务/),
    )
    const hasTechnical = nameChanges.some((r) =>
      r.after.match(/层|器|组件|模块|接口/),
    )
    if (hasBusiness && !hasTechnical) {
      memory.preferences.namingStyle = 'business'
    } else if (hasTechnical && !hasBusiness) {
      memory.preferences.namingStyle = 'technical'
    } else {
      memory.preferences.namingStyle = 'mixed'
    }
  }

  // 分析粒度偏好
  const splitChanges = recent.filter((r) => r.reason.includes('拆分') || r.reason.includes('合并'))
  if (splitChanges.length >= 2) {
    const splits = splitChanges.filter((r) => r.reason.includes('拆分'))
    if (splits.length > splitChanges.length / 2) {
      memory.preferences.granularity = 'fine'
      memory.preferences.maxModules = Math.min(memory.preferences.maxModules + 1, 10)
    } else {
      memory.preferences.granularity = 'coarse'
      memory.preferences.maxModules = Math.max(memory.preferences.maxModules - 1, 3)
    }
  }
}
