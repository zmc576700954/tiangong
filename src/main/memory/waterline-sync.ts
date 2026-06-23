/**
 * 水位线同步 —— 跨会话状态同步机制
 *
 * 在多个 Agent 会话之间维护一个"水位线"标记，
 * 记录已完成的调查领域、已修复的问题和已验证的节点。
 *
 * 新会话启动时，可以通过水位线查询：
 *   - 哪些调查已经完成（避免重复工作）
 *   - 哪些修复已应用（防止冲突修改）
 *   - 哪些节点已通过验证（跳过已验证范围）
 *
 * 数据流:
 *   terminateSession() → WaterlineSync.advance(sessionId, findings)
 *   startSession() → WaterlineSync.getContext(projectId) → 注入 Agent prompt
 *
 * 存储: 基于 MemoryStore，使用特殊的 'waterline' 记忆类型来持久化
 *   实际使用内存 Map + MemoryStore 作为持久化后端
 */

import type { MemoryItem, MemoryKind } from '@shared/types'
import { createLogger } from '../shared/logger'
import { getMemoryStore } from './memory-store'
import { getClient } from '../database'

const logger = createLogger('WaterlineSync')

// ============================================
// 类型定义
// ============================================

/** 水位线快照：一个时间点的项目状态摘要 */
export interface WaterlineSnapshot {
  /** 项目 ID */
  projectId: string
  /** 最后更新时间 */
  updatedAt: string
  /** 已完成的调查领域 */
  completedInvestigations: string[]
  /** 已修复的问题摘要 */
  fixedIssues: string[]
  /** 已验证通过的节点 ID 列表 */
  verifiedNodes: string[]
  /** 已修改的文件列表 */
  modifiedFiles: string[]
  /** 跨适配器发现（Agent A 的发现供 Agent B 使用） */
  crossAdapterFindings: Array<{
    adapter: string
    finding: string
    confidence: number
  }>
  /** 开放问题（尚未解决） */
  openIssues: string[]
  /** 避免重复的操作 */
  avoidedRepetitions: string[]
  /** 会话计数 */
  sessionCount: number
  /** 累计 token 消耗 */
  totalTokens: number
}

/** 水位线差异：新会话启动时与上次水位线的对比 */
export interface WaterlineDelta {
  /** 上次水位线以来的新发现 */
  newFindings: string[]
  /** 仍需处理的问题 */
  pendingIssues: string[]
  /** 已从水位线移除的项（已解决/已验证） */
  resolvedSinceLast: string[]
  /** 自上次以来新增的会话数 */
  sessionsSinceLast: number
}

/** WaterlineSync 配置 */
export interface WaterlineSyncConfig {
  /** 最多保留的调查领域数 */
  maxInvestigations: number
  /** 最多保留的修复记录数 */
  maxFixes: number
}

const DEFAULT_CONFIG: WaterlineSyncConfig = {
  maxInvestigations: 50,
  maxFixes: 50,
}

/**
 * 判断 fix 标题是否真正解决 issue
 *
 * 旧实现 `fixTitle.toLowerCase().includes(issue.toLowerCase())` 会让短词 issue（如 "bug"）
 * 被任意含该词的 fix 误关。
 *
 * 改进策略（兼顾合理短词与抗误关）：
 *   1. 归一化后完全相等 → 命中。
 *   2. issue 长度 < 3 的极短串（"a"/"x"/"#"）禁止子串匹配，几乎一定是噪音。
 *   3. 其余按"完整词"匹配：issue 在 fix 标题中作为独立词出现（前后是分隔符
 *      或字符串边界），这样 "CSRF"/"OOM"/"JWT" 等真实短词缩写可被正常关联，
 *      但不会把 "Fix unrelated job in build" 误判为修了 "bug"。
 */
function isFixingIssue(fixTitle: string, issue: string): boolean {
  const f = fixTitle.toLowerCase().trim()
  const i = issue.toLowerCase().trim()
  if (f.length === 0 || i.length === 0) return false
  if (f === i) return true
  if (i.length < 3) return false  // 过短关键词不允许子串匹配
  // 词边界匹配：issue 在 fix 标题中作为独立词出现
  const idx = f.indexOf(i)
  if (idx < 0) return false
  const boundary = /[\s\-:：,，.。()（）/\\]/
  const before = idx === 0 ? ' ' : f[idx - 1]
  const after = idx + i.length === f.length ? ' ' : f[idx + i.length]
  return boundary.test(before) && boundary.test(after)
}

/**
 * 词边界子串匹配：检查 shorter 是否在 longer 中作为独立词出现
 *
 * 如果 shorter 在 longer 中找到，且其前后字符为分隔符或字符串边界，
 * 则认为匹配。用于 hasInvestigated 的双向子串匹配。
 */
function isWordBoundaryMatch(longer: string, shorter: string): boolean {
  const idx = longer.indexOf(shorter)
  if (idx < 0) return false

  const boundary = /[\s\-:：,，.。()（）/\\]/
  const before = idx === 0 ? ' ' : longer[idx - 1]
  const after = idx + shorter.length === longer.length ? ' ' : longer[idx + shorter.length]
  return boundary.test(before) && boundary.test(after)
}

/**
 * 路径归一化：反斜杠转正斜杠，统一小写
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

// ============================================
// WaterlineSync 主类
// ============================================

export class WaterlineSync {
  private config: WaterlineSyncConfig
  /** 每个项目的水位线快照 */
  private waterlines = new Map<string, WaterlineSnapshot>()
  /** 每个项目上次格式化的时间戳，用于增量输出 */
  private lastFormattedAt = new Map<string, number>()
  /** 每个项目上次格式化时的快照副本，用于增量对比 */
  private lastFormattedSnapshot = new Map<string, WaterlineSnapshot>()

  constructor(config?: Partial<WaterlineSyncConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 获取项目的当前水位线（如不存在则创建初始水位线）
   */
  getWaterline(projectId: string): WaterlineSnapshot {
    let wl = this.waterlines.get(projectId)
    if (!wl) {
      wl = this._createInitialWaterline(projectId)
      this.waterlines.set(projectId, wl)
    }
    return wl
  }

  /**
   * 推进水位线：在会话完成后更新状态
   *
   * @param projectId - 项目 ID
   * @param sessionMemories - 该会话产生的所有记忆
   */
  advance(
    projectId: string,
    sessionMemories: MemoryItem[],
  ): WaterlineSnapshot {
    const wl = this.getWaterline(projectId)
    const now = new Date().toISOString()

    // 合并调查结果
    for (const mem of sessionMemories) {
      if (mem.kind === 'investigation') {
        this._appendIfNew(wl.completedInvestigations, mem.title, this.config.maxInvestigations)
        // 如果包含具体发现，也添加到跨适配器发现
        if (mem.confidence > 0.5 && mem.narrative.length > 20) {
          wl.crossAdapterFindings.push({
            adapter: mem.adapter_name,
            finding: `${mem.title}: ${mem.narrative.substring(0, 120)}`,
            confidence: mem.confidence,
          })
        }
      } else if (mem.kind === 'fix') {
        this._appendIfNew(wl.fixedIssues, mem.title, this.config.maxFixes)
        // 从开放问题中移除：要求 fix 标题与 issue 完全等于或起始包含 issue 全词，
        // 避免短词（如 "bug"）误关任意含 "bug" 的开放问题。
        wl.openIssues = wl.openIssues.filter((issue) => !isFixingIssue(mem.title, issue))
      } else if (mem.kind === 'review_finding') {
        this._appendIfNew(wl.openIssues, mem.title, 50)
      } else if (mem.kind === 'lesson') {
        this._appendIfNew(wl.avoidedRepetitions, mem.title, 30)
      }

      // 累计文件变更
      for (const f of mem.files_modified) {
        if (!wl.modifiedFiles.includes(f)) {
          wl.modifiedFiles.push(f)
        }
      }

      // 累计 token（防 NaN：缺失或非有限值视为 0）
      const cost = mem.token_cost
      if (typeof cost === 'number' && Number.isFinite(cost)) {
        wl.totalTokens += cost
      }
    }

    // 限制列表大小
    wl.crossAdapterFindings = wl.crossAdapterFindings.slice(-30)
    wl.modifiedFiles = wl.modifiedFiles.slice(-100)
    wl.openIssues = wl.openIssues.slice(-50)

    wl.sessionCount++
    wl.updatedAt = now

    logger.debug(`Waterline advanced for ${projectId}: ${wl.sessionCount} sessions, ${wl.fixedIssues.length} fixes`)

    return wl
  }

  /**
   * 标记节点为已验证
   *
   * 当 verifiedNodes 超过 100 时，只保留最近 100 条，
   * 防止列表无限增长。
   */
  markNodeVerified(projectId: string, nodeId: string): void {
    const wl = this.getWaterline(projectId)
    if (!wl.verifiedNodes.includes(nodeId)) {
      wl.verifiedNodes.push(nodeId)
      if (wl.verifiedNodes.length > 100) {
        wl.verifiedNodes = wl.verifiedNodes.slice(-100)
      }
    }
  }

  /**
   * 计算与上次水位线的差异
   * 用于新会话启动时生成上下文
   */
  getDelta(projectId: string, previousSnapshot?: WaterlineSnapshot): WaterlineDelta {
    const current = this.getWaterline(projectId)
    const previous = previousSnapshot ?? this._createInitialWaterline(projectId)

    const newFindings = current.completedInvestigations.filter(
      (i) => !previous.completedInvestigations.includes(i),
    )
    const pendingIssues = current.openIssues.filter(
      (i) => !previous.openIssues.includes(i),
    )
    const resolvedSinceLast = previous.openIssues.filter(
      (i) => !current.openIssues.includes(i),
    )
    const sessionsSinceLast = current.sessionCount - previous.sessionCount

    return { newFindings, pendingIssues, resolvedSinceLast, sessionsSinceLast }
  }

  /**
   * 生成 Agent 可读的水位线上下文字符串
   * 用于注入到新会话的 prompt 中
   */
  formatContext(projectId: string): string {
    const wl = this.getWaterline(projectId)
    const lines: string[] = []

    lines.push('# 项目水位线状态')
    lines.push(`会话数: ${wl.sessionCount} | 最后更新: ${wl.updatedAt}`)
    lines.push(`累计 Token: ${wl.totalTokens.toLocaleString()}`)

    if (wl.completedInvestigations.length > 0) {
      lines.push(`\n## 已完成调查 (${wl.completedInvestigations.length})`)
      wl.completedInvestigations.slice(-10).forEach((i, idx) => {
        lines.push(`${idx + 1}. ${i}`)
      })
      if (wl.completedInvestigations.length > 10) {
        lines.push(`  ... 及另外 ${wl.completedInvestigations.length - 10} 项`)
      }
    }

    if (wl.fixedIssues.length > 0) {
      lines.push(`\n## 已修复问题 (${wl.fixedIssues.length})`)
      wl.fixedIssues.slice(-10).forEach((f, idx) => {
        lines.push(`${idx + 1}. ${f}`)
      })
      if (wl.fixedIssues.length > 10) {
        lines.push(`  ... 及另外 ${wl.fixedIssues.length - 10} 项`)
      }
    }

    if (wl.openIssues.length > 0) {
      lines.push(`\n## 开放问题 (${wl.openIssues.length})`)
      wl.openIssues.slice(-5).forEach((i, idx) => {
        lines.push(`${idx + 1}. ${i}`)
      })
    }

    if (wl.verifiedNodes.length > 0) {
      lines.push(`\n## 已验证节点: ${wl.verifiedNodes.length} 个`)
    }

    if (wl.avoidedRepetitions.length > 0) {
      lines.push(`\n## 经验教训 (${wl.avoidedRepetitions.length})`)
      wl.avoidedRepetitions.slice(-5).forEach((l, idx) => {
        lines.push(`${idx + 1}. ${l}`)
      })
    }

    if (wl.crossAdapterFindings.length > 0) {
      lines.push(`\n## 跨适配器发现 (${wl.crossAdapterFindings.length})`)
      wl.crossAdapterFindings.slice(-5).forEach((f, idx) => {
        lines.push(`${idx + 1}. [${f.adapter}] ${f.finding}`)
      })
    }

    // 记录本次格式化的时间戳和快照，供增量输出使用
    this.lastFormattedAt.set(projectId, Date.now())
    this.lastFormattedSnapshot.set(projectId, structuredClone(wl))

    return lines.join('\n')
  }

  /**
   * 增量格式化：仅输出自上次 formatContext 以来的变更
   *
   * 首次调用（无上次格式化记录）时回退到完整格式输出。
   * 后续调用仅输出 WaterlineDelta 中的新增/变更项。
   *
   * @param projectId - 项目 ID
   * @returns 增量上下文字符串
   */
  getIncrementalContext(projectId: string): string {
    const previous = this.lastFormattedSnapshot.get(projectId)
    const lastTime = this.lastFormattedAt.get(projectId)

    // 首次调用：无历史记录，输出完整水位线
    if (!previous || lastTime === undefined) {
      return this.formatContext(projectId)
    }

    const delta = this.getDelta(projectId, previous)
    const wl = this.getWaterline(projectId)

    // 如果没有任何变更，返回简短提示
    if (
      delta.newFindings.length === 0 &&
      delta.pendingIssues.length === 0 &&
      delta.resolvedSinceLast.length === 0 &&
      delta.sessionsSinceLast === 0
    ) {
      // 更新格式化追踪
      this.lastFormattedAt.set(projectId, Date.now())
      this.lastFormattedSnapshot.set(projectId, structuredClone(wl))
      return '[Waterline] No changes since last check.'
    }

    const lines: string[] = []
    lines.push('# 水位线增量更新')
    lines.push(`会话数: ${wl.sessionCount} | 自上次以来: +${delta.sessionsSinceLast} 会话`)

    if (delta.newFindings.length > 0) {
      lines.push(`\n## 新发现 (${delta.newFindings.length})`)
      delta.newFindings.slice(-10).forEach((f, idx) => {
        lines.push(`${idx + 1}. ${f}`)
      })
    }

    if (delta.pendingIssues.length > 0) {
      lines.push(`\n## 新增待处理问题 (${delta.pendingIssues.length})`)
      delta.pendingIssues.slice(-5).forEach((i, idx) => {
        lines.push(`${idx + 1}. ${i}`)
      })
    }

    if (delta.resolvedSinceLast.length > 0) {
      lines.push(`\n## 已解决问题 (${delta.resolvedSinceLast.length})`)
      delta.resolvedSinceLast.slice(-5).forEach((i, idx) => {
        lines.push(`${idx + 1}. ${i}`)
      })
    }

    // 更新格式化追踪
    this.lastFormattedAt.set(projectId, Date.now())
    this.lastFormattedSnapshot.set(projectId, structuredClone(wl))

    return lines.join('\n')
  }

  /**
   * 检查某个调查是否已经完成（避免重复工作）
   *
   * 改进：短 topic（<3 字符）要求精确匹配，避免 "auth" 误命中
   * "authority delegation"。较长 topic 允许双向子串匹配，
   * 但使用词边界检查防止部分词内嵌入导致误判。
   */
  hasInvestigated(projectId: string, topic: string): boolean {
    const wl = this.getWaterline(projectId)
    const topicLower = topic.toLowerCase().trim()

    if (topicLower.length === 0) return false

    // 极短 topic（<3 字符）只允许精确匹配
    if (topicLower.length < 3) {
      return wl.completedInvestigations.some(
        (i) => i.toLowerCase().trim() === topicLower,
      )
    }

    // 较长 topic：双向子串匹配 + 词边界校验
    return wl.completedInvestigations.some((investigation) => {
      const invLower = investigation.toLowerCase().trim()

      // 精确相等
      if (invLower === topicLower) return true

      // topic 是 investigation 的子串
      if (invLower.includes(topicLower)) {
        return isWordBoundaryMatch(invLower, topicLower)
      }

      // investigation 是 topic 的子串
      if (topicLower.includes(invLower)) {
        return isWordBoundaryMatch(topicLower, invLower)
      }

      return false
    })
  }

  /**
   * 检查某个文件最近是否被修改过（避免冲突）
   *
   * 改进：使用路径感知比较，归一化路径后匹配。
   * 匹配规则：精确相等、后缀匹配（以 /+target 结尾）、
   * 或 target 以 /+path 结尾。
   * 防止 "a.ts" 误命中 "parser.ts"。
   */
  recentlyModified(projectId: string, filePath: string): boolean {
    const wl = this.getWaterline(projectId)
    const normalized = normalizePath(filePath)

    return wl.modifiedFiles.some((f) => {
      const fNorm = normalizePath(f)

      // 精确相等
      if (fNorm === normalized) return true

      // 后缀匹配：fNorm 以 /+normalized 结尾
      if (fNorm.endsWith('/' + normalized)) return true

      // 反向后缀匹配：normalized 以 /+fNorm 结尾
      if (normalized.endsWith('/' + fNorm)) return true

      return false
    })
  }

  /**
   * 清除项目水位线（项目删除时调用）
   */
  clearWaterline(projectId: string): void {
    this.waterlines.delete(projectId)
  }

  /**
   * 持久化水位线快照到 MemoryStore
   *
   * 将当前内存中的 WaterlineSnapshot 序列化为 MemoryItem
   * 并以 kind='waterline' 存入数据库，使水位线在进程重启后可恢复。
   */
  async persist(projectId: string): Promise<void> {
    const wl = this.getWaterline(projectId)

    // Atomic delete+insert using batch to prevent data loss on crash between operations
    const db = getClient()
    const narrative = JSON.stringify(wl)
    const now = new Date().toISOString()

    await db.batch([
      {
        sql: "DELETE FROM memory_items WHERE kind = 'waterline' AND project_id = ?",
        args: [projectId],
      },
      {
        sql: `INSERT INTO memory_items (session_id, kind, project_id, node_id, title, narrative, facts, concepts, files_read, files_modified, adapter_name, token_cost, confidence, created_at)
              VALUES (?, 'waterline', ?, NULL, 'Waterline Snapshot', ?, '[]', '[]', '[]', '[]', 'waterline-sync', 0, 1.0, ?)`,
        args: [`waterline-${projectId}`, projectId, narrative, now],
      },
    ], 'write')

    logger.debug(`Waterline persisted for ${projectId}`)
  }

  /**
   * 从 MemoryStore 恢复水位线快照
   *
   * 加载 kind='waterline' 的最新 MemoryItem，
   * 将其 narrative 反序列化为 WaterlineSnapshot 并覆盖内存状态。
   * 如果数据库中无记录，保留内存中的初始值。
   */
  async restore(projectId: string): Promise<void> {
    const store = getMemoryStore()
    const items = await store.search('waterline', {
      projectId,
      kind: 'waterline' as MemoryKind,
      limit: 1,
    })

    if (items.length === 0) {
      logger.debug(`No waterline record found for ${projectId}, using initial state`)
      return
    }

    try {
      const snapshot = JSON.parse(items[0].narrative) as WaterlineSnapshot
      // Schema validation: ensure critical fields exist and have correct types
      if (
        snapshot &&
        typeof snapshot === 'object' &&
        snapshot.projectId === projectId &&
        Array.isArray(snapshot.completedInvestigations) &&
        Array.isArray(snapshot.fixedIssues)
      ) {
        this.waterlines.set(projectId, snapshot)
        logger.debug(`Waterline restored for ${projectId}: ${snapshot.sessionCount} sessions`)
      } else {
        logger.warn(`Waterline restore skipped for ${projectId}: schema validation failed`)
      }
    } catch (err) {
      logger.warn(`Failed to parse waterline snapshot for ${projectId}:`, err)
    }
  }

  // ============================================
  // 私有方法
  // ============================================

  private _createInitialWaterline(projectId: string): WaterlineSnapshot {
    return {
      projectId,
      updatedAt: new Date().toISOString(),
      completedInvestigations: [],
      fixedIssues: [],
      verifiedNodes: [],
      modifiedFiles: [],
      crossAdapterFindings: [],
      openIssues: [],
      avoidedRepetitions: [],
      sessionCount: 0,
      totalTokens: 0,
    }
  }

  /**
   * 如果项不存在则追加，并限制列表大小
   */
  private _appendIfNew(list: string[], item: string, maxSize: number): void {
    if (!list.includes(item)) {
      list.push(item)
      if (list.length > maxSize) {
        list.splice(0, list.length - maxSize)
      }
    }
  }

  /**
   * 将概念关键词直接添加到已完成调查列表。
   * 用于管线中 compile→waterline 数据流：从 LayeredContext 的 L1/L2 摘要中
   * 提取的概念信息注册为已完成调查，避免后续会话重复探索相同主题。
   */
  addCompletedInvestigations(projectId: string, concepts: string[]): void {
    const wl = this.getWaterline(projectId)
    for (const concept of concepts) {
      this._appendIfNew(wl.completedInvestigations, concept, this.config.maxInvestigations)
    }
  }
}

/** 全局单例 */
let _instance: WaterlineSync | null = null

export function getWaterlineSync(): WaterlineSync {
  if (!_instance) {
    _instance = new WaterlineSync()
  }
  return _instance
}

/** 测试用：替换全局实例 */
export function setWaterlineSyncForTesting(sync: WaterlineSync): void {
  _instance = sync
}
