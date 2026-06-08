/**
 * 配置文件读取模块
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '../shared/logger'

const logger = createLogger('ProjectScanner')

export interface ProjectConfigs {
  packageJson: Record<string, unknown> | null
  goMod: string | null
  cargoToml: Record<string, unknown> | null
  pyprojectToml: Record<string, unknown> | null
  requirementsTxt: string | null
  pomXml: string | null
  gradleBuild: string | null
  gemfile: string | null
  composerJson: Record<string, unknown> | null
}

export async function readConfigs(projectPath: string): Promise<ProjectConfigs> {
  const configs: ProjectConfigs = {
    packageJson: null,
    goMod: null,
    cargoToml: null,
    pyprojectToml: null,
    requirementsTxt: null,
    pomXml: null,
    gradleBuild: null,
    gemfile: null,
    composerJson: null,
  }

  const tryRead = async <T>(
    filename: string,
    parser: (raw: string) => T,
  ): Promise<T | null> => {
    try {
      const raw = await fs.readFile(path.join(projectPath, filename), 'utf-8')
      return parser(raw)
    } catch (err: unknown) {
      // ENOENT 是预期行为（项目可能不使用该技术栈），不输出日志
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      logger.warn(`Failed to read ${filename}:`, err)
      return null
    }
  }

  configs.packageJson = await tryRead('package.json', (raw) => JSON.parse(raw))
  configs.goMod = await tryRead('go.mod', (raw) => raw)
  configs.cargoToml = await tryRead('Cargo.toml', (raw) => parseToml(raw))
  configs.pyprojectToml = await tryRead('pyproject.toml', (raw) => parseToml(raw))
  configs.requirementsTxt = await tryRead('requirements.txt', (raw) => raw)
  configs.pomXml = await tryRead('pom.xml', (raw) => raw)
  configs.gradleBuild = await tryRead('build.gradle', (raw) => raw)
  configs.gemfile = await tryRead('Gemfile', (raw) => raw)
  configs.composerJson = await tryRead('composer.json', (raw) => JSON.parse(raw))

  return configs
}

/**
 * 轻量级 TOML 解析器
 * 支持：section 表、字符串值（含多行）、布尔值、数字、数组
 * 限制：不支持嵌套表、内联表、日期类型
 */
export function parseToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let currentSection = ''
  const lines = content.split('\n')
  let i = 0

  while (i < lines.length) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()

    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }

    // Section: [section] or [[array-of-tables]]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1).replace(/^\[|\]$/g, '')
      if (!result[currentSection]) {
        result[currentSection] = {}
      }
      i++
      continue
    }

    // Key = Value
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim()
      let valueStr = trimmed.slice(eqIdx + 1).trim()

      // 多行字符串 """ ... """
      if (valueStr.startsWith('"""')) {
        const parts: string[] = []
        const first = valueStr.slice(3)
        if (first.endsWith('"""')) {
          valueStr = first.slice(0, -3)
        } else {
          parts.push(first)
          i++
          while (i < lines.length) {
            const l = lines[i]
            if (l.trim().endsWith('"""')) {
              parts.push(l.trim().slice(0, -3))
              break
            }
            parts.push(l)
            i++
          }
          valueStr = parts.join('\n')
        }
      }
      // 单行字符串去除引号
      else if ((valueStr.startsWith('"') && valueStr.endsWith('"')) ||
               (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
        valueStr = valueStr.slice(1, -1)
      }
      // 数组: ["a", "b"]
      else if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
        try {
          const arr = valueStr
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                return s.slice(1, -1)
              }
              return s
            })
          valueStr = arr as unknown as string
        } catch {
          // keep raw string
        }
      }
      // 布尔值
      else if (valueStr === 'true' || valueStr === 'false') {
        const target = currentSection ? (result[currentSection] as Record<string, unknown>) : result
        target[key] = valueStr === 'true'
        i++
        continue
      }
      // 数字
      else if (/^-?\d+(\.\d+)?$/.test(valueStr)) {
        const target = currentSection ? (result[currentSection] as Record<string, unknown>) : result
        target[key] = valueStr.includes('.') ? parseFloat(valueStr) : parseInt(valueStr, 10)
        i++
        continue
      }

      const target = currentSection ? (result[currentSection] as Record<string, unknown>) : result
      target[key] = valueStr
    }
    i++
  }

  return result
}
