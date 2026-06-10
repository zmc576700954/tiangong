/**
 * ModeManager — 运行时 Agent 模式管理器
 *
 * 管理每个项目的工作模式（general/security/performance/refactor），
 * 在 Agent session 启动时将模式配置注入 prompt 上下文，
 * 影响 Agent 的关注点、安全级别和记忆提取策略。
 *
 * 架构：
 *   AgentManager.startSession() → modeManager.resolvePromptContext(projectId)
 *     → 注入到 AgentSessionConfig 的 upstreamContext 后缀
 *   MemoryExtractor.extract() 接收 memoryTypes 过滤
 *   UI 通过 IPC 通道 (mode:getCurrent / mode:setCurrent / mode:getAvailable) 切换
 *
 * 设计约束：
 *   - 单例模式，懒初始化（与 MemoryStore 一致）
 *   - 每个项目独立维护当前模式
 *   - 默认模式为 'general'
 *   - DEFAULT_MODE_CONFIGS 从 @shared/types 导入，允许运行时局部覆盖
 */

import { DEFAULT_MODE_CONFIGS } from '@shared/types'
import type { AgentMode, AgentModeConfig } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('ModeManager')

export class ModeManager {
  /** 每个项目的当前模式：projectId → AgentMode */
  private currentMode = new Map<string, AgentMode>()

  /**
   * 可选：运行时覆盖默认模式配置
   * 未覆盖的字段从 DEFAULT_MODE_CONFIGS 继承
   */
  private overrides = new Map<AgentMode, Partial<AgentModeConfig>>()

  /**
   * 获取指定项目的当前模式（默认 'general'）
   */
  getMode(projectId: string): AgentMode {
    return this.currentMode.get(projectId) ?? 'general'
  }

  /**
   * 设置指定项目的当前模式
   */
  setMode(projectId: string, mode: AgentMode): void {
    this.currentMode.set(projectId, mode)
    logger.info(`Mode for project ${projectId} set to ${mode}`)
  }

  /**
   * 获取指定项目的完整模式配置（含运行时覆盖）
   */
  getConfig(projectId: string): AgentModeConfig {
    const mode = this.getMode(projectId)
    const baseConfig = { ...DEFAULT_MODE_CONFIGS[mode] }
    const override = this.overrides.get(mode)
    if (override) {
      // 合并覆盖（顶层字段替换，数组字段覆盖）
      const merged = { ...baseConfig, ...override }
      if (override.investigationFocus) merged.investigationFocus = [...override.investigationFocus]
      if (override.reviewPriorities) merged.reviewPriorities = [...override.reviewPriorities]
      if (override.memoryTypes) merged.memoryTypes = [...override.memoryTypes]
      return merged
    }
    return baseConfig
  }

  /**
   * 获取所有可用模式配置
   */
  getAvailableModes(): AgentModeConfig[] {
    return Object.values(DEFAULT_MODE_CONFIGS).map((config) => {
      const override = this.overrides.get(config.name)
      if (!override) return { ...config }
      const merged = { ...config, ...override }
      if (override.investigationFocus) merged.investigationFocus = [...override.investigationFocus]
      if (override.reviewPriorities) merged.reviewPriorities = [...override.reviewPriorities]
      if (override.memoryTypes) merged.memoryTypes = [...override.memoryTypes]
      return merged
    })
  }

  /**
   * 运行时覆盖某个模式的配置（可选功能，用于高级用户定制）
   * @param mode - 要覆盖的模式
   * @param partial - 部分配置覆盖
   */
  setConfigOverride(mode: AgentMode, partial: Partial<AgentModeConfig>): void {
    this.overrides.set(mode, { ...(this.overrides.get(mode) ?? {}), ...partial })
    logger.info(`Config override applied for mode ${mode}`)
  }

  /**
   * 清除某个模式的运行时覆盖
   */
  clearConfigOverride(mode: AgentMode): void {
    this.overrides.delete(mode)
  }

  /**
   * 生成注入 Agent prompt 的模式上下文字段
   *
   * 返回：
   *   - suffix: 追加到 system prompt 的后缀文本
   *   - focusAreas: 调查关注点列表
   *   - safety: 修复安全级别
   *   - memoryTypes: 该模式下应记录的记忆类型
   */
  resolvePromptContext(projectId: string): {
    suffix: string
    focusAreas: string[]
    safety: 'strict' | 'standard' | 'aggressive'
    memoryTypes: string[]
  } {
    const config = this.getConfig(projectId)
    return {
      suffix: config.systemPromptSuffix,
      focusAreas: [...config.investigationFocus],
      safety: config.fixSafety,
      memoryTypes: [...config.memoryTypes],
    }
  }

  /**
   * 格式化模式上下文为 Agent 可读的文本块
   * 用于注入到 upstreamContext 中
   */
  formatModePromptSection(projectId: string): string {
    const config = this.getConfig(projectId)
    const sections: string[] = []

    sections.push(`# Agent 工作模式: ${config.name}`)
    sections.push(config.description)
    sections.push(`\n## 调查关注点`)
    sections.push(config.investigationFocus.map((f) => `- ${f}`).join('\n'))
    sections.push(`\n## 审查优先级`)
    sections.push(config.reviewPriorities.map((p) => `- ${p}`).join('\n'))
    sections.push(`\n## 修复安全级别: ${config.fixSafety}`)
    sections.push(`\n${config.systemPromptSuffix}`)

    return sections.join('\n')
  }

  /**
   * 清除指定项目的模式记录（项目删除时调用）
   */
  clearProjectMode(projectId: string): void {
    this.currentMode.delete(projectId)
  }

  /**
   * 获取所有有自定义模式的项目 ID
   */
  getCustomizedProjects(): string[] {
    return Array.from(this.currentMode.keys()).filter(
      (id) => this.currentMode.get(id) !== 'general',
    )
  }
}

/** 全局单例（懒初始化） */
let _instance: ModeManager | null = null

export function getModeManager(): ModeManager {
  if (!_instance) {
    _instance = new ModeManager()
  }
  return _instance
}

/** 测试用：替换全局实例 */
export function setModeManagerForTesting(manager: ModeManager): void {
  _instance = manager
}
