/**
 * 会话文件范围的计算 —— **纯函数**。
 *
 * 抽出来是因为**bug 都在这一段**：范围集合的「显示」与「发送」曾经各算各的
 * （sessionScope 只显示不发送、@ 引用只发送不显示）→ 面板可能显示「本次只读」
 * 而会话实际可写。逻辑一旦是纯函数，就能被直接测。
 */

import type { ProjectDefaults } from '@shared/types'
import { resolveReadonly } from '@shared/readonly'
import { toRelative } from './project-paths'

export interface ScopeInput {
  /** 项目根（绝对路径） */
  projectPath: string
  /** 项目级默认（存的是**相对项目根**的相对路径） */
  projectDefaults: ProjectDefaults | null
  /** 本次会话显式加的（相对路径，规范形态） */
  sessionScope: string[]
  /** 本次消息里 `@` 引用的文件（**绝对**路径） */
  referencedFiles: string[]
}

export interface ScopeResult {
  /** 生效范围 —— **相对项目根的相对路径**（规范形态），显示与发送都用它 */
  relativeFiles: string[]
  /** 范围为空 ⇒ 只读（与主进程 resolveReadonly 同一套语义） */
  readonly: boolean
}

/**
 * 算出本次会话的生效范围。
 *
 * 三个来源合并：项目级默认 ∪ 本次会话显式加的 ∪ 本次消息 `@` 引用的文件。
 * **三者缺一不可** —— 少了任何一个，显示与发送就会不一致。
 *
 * @ 引用文件必须算进来：它们会进 `allowedFiles`，不显示的话面板会显示
 * 「本次只读」而会话其实可写。
 */
export function computeScope(input: ScopeInput): ScopeResult {
  const { projectPath, projectDefaults, sessionScope, referencedFiles } = input

  const fromProject = projectDefaults?.allowedFiles ?? []

  const fromRefs = referencedFiles
    .map((abs) => toRelative(projectPath, abs))
    .filter((rel): rel is string => rel !== null)

  const relativeFiles = [...new Set([...fromProject, ...sessionScope, ...fromRefs])]

  // 只读判定用**主进程同一份** `resolveReadonly` —— 渲染层与主进程不能各写
  // 一遍「空即只读」，否则改了一边另一边不跟着变，界面就会与实际会话不一致。
  return { relativeFiles, readonly: resolveReadonly({ allowedFiles: relativeFiles }) }
}
