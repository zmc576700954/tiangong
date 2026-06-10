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

import type { MemoryItem } from '@shared/types'
import { createLogger } from '../shared/logger'

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

// ============================================
// WaterlineSync 主类
// ============================================

export class WaterlineSync {
  private config: WaterlineSyncConfig
  /** 每个项目的水位线快照 */
  private waterlines = new Map<string, WaterlineSnapshot>()

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
        wl.openIssues.push(mem.title)
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
   */
  markNodeVerified(projectId: string, nodeId: string): void {
    const wl = this.getWaterline(projectId)
    if (!wl.verifiedNodes.includes(nodeId)) {
      wl.verifiedNodes.push(nodeId)
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

    return lines.join('\n')
  }

  /**
   * 检查某个调查是否已经完成（避免重复工作）
   */
  hasInvestigated(projectId: string, topic: string): boolean {
    const wl = this.getWaterline(projectId)
    const topicLower = topic.toLowerCase()
    return wl.completedInvestigations.some(
      (i) => i.toLowerCase().includes(topicLower) || topicLower.includes(i.toLowerCase()),
    )
  }

  /**
   * 检查某个文件最近是否被修改过（避免冲突）
   */
  recentlyModified(projectId: string, filePath: string): boolean {
    const wl = this.getWaterline(projectId)
    return wl.modifiedFiles.some((f) => f.includes(filePath) || filePath.includes(f))
  }

  /**
   * 清除项目水位线（项目删除时调用）
   */
  clearWaterline(projectId: string): void {
    this.waterlines.delete(projectId)
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
