import { commonZh, commonEn } from './domains/common'
import { menuZh, menuEn } from './domains/menu'
import { settingsZh, settingsEn } from './domains/settings'
import { nodeZh, nodeEn } from './domains/node'
import { graphZh, graphEn } from './domains/graph'
import { projectsZh, projectsEn } from './domains/projects'
import { canvasZh, canvasEn } from './domains/canvas'
import { agentZh, agentEn } from './domains/agent'
import { wikiZh, wikiEn } from './domains/wiki'
import { recipesZh, recipesEn } from './domains/recipes'

/**
 * zh 是 key 的真值来源——TranslationKey 由它推导。
 * 按域拆成独立文件：每个域由一个任务独占，避免并行改同一文件。
 */
export const zh = {
  ...commonZh,
  ...menuZh,
  ...settingsZh,
  ...nodeZh,
  ...graphZh,
  ...projectsZh,
  ...canvasZh,
  ...agentZh,
  ...wikiZh,
  ...recipesZh,
}

/**
 * en 的类型是 Record<TranslationKey, string>——
 * 「zh 有、en 没有」在编译期就报错，不必等测试发现。
 */
export const en: Record<keyof typeof zh, string> = {
  ...commonEn,
  ...menuEn,
  ...settingsEn,
  ...nodeEn,
  ...graphEn,
  ...projectsEn,
  ...canvasEn,
  ...agentEn,
  ...wikiEn,
  ...recipesEn,
}

export type TranslationKey = keyof typeof zh
