/**
 * 项目结构扫描器
 * 分析项目代码结构，自动生成思维导图初始节点
 *
 * 能力层级：
 * L1 - 文件系统扫描：目录结构、配置文件识别
 * L2 - 内容分析：读取关键文件提取路由/API/实体
 * L3 - Agent 增强（可选）：调用 Claude Code 等 Agent 进行深度业务分析
 */

import path from 'node:path'
import type { ProjectScanResult } from '@shared/types'
import { readConfigs } from './config-reader'
import { detectFramework } from './framework-detector'
import { scanDirectory } from './dir-scanner'
import { analyzeKeyFiles } from './file-analyzer'
import { extractRoutes } from './route-parser'
import { extractEntities } from './entity-parser'
import { buildModules } from './module-builder'

/** 从 package.json 提取统一格式的元数据 */
function mapPackageJson(
  pkg: Record<string, unknown> | undefined | null,
  fallbackName: string,
) {
  if (!pkg) return null
  return {
    name: (pkg.name as string) ?? fallbackName,
    description: (pkg.description as string) ?? '',
    version: (pkg.version as string) ?? '0.0.0',
    scripts: pkg.scripts as Record<string, string> | undefined,
    dependencies: Object.keys((pkg.dependencies as Record<string, string>) ?? {}),
    devDependencies: Object.keys((pkg.devDependencies as Record<string, string>) ?? {}),
  }
}

export class ProjectScanner {
  /**
   * 扫描项目目录（主入口）
   */
  async scan(projectPath: string): Promise<ProjectScanResult> {
    const projectName = path.basename(projectPath)

    // 1. 读取配置文件
    const configs = await readConfigs(projectPath)

    // 2. 检测框架类型
    const framework = detectFramework(configs, projectPath)

    // 3. 扫描目录结构
    const structure = await scanDirectory(projectPath)

    // 4. 内容分析（读取关键文件）
    const fileAnalyses = await analyzeKeyFiles(projectPath, framework, structure)

    // 5. 提取路由/API 信息
    const routes = extractRoutes(fileAnalyses, framework)

    // 6. 提取实体/模型信息
    const entities = extractEntities(fileAnalyses, framework)

    // 7. 构建模块列表
    const modules = buildModules(
      projectName,
      framework,
      mapPackageJson(configs.packageJson, projectName),
      structure,
      fileAnalyses,
      routes,
      entities,
    )

    return {
      projectName,
      projectPath,
      framework,
      packageJson: mapPackageJson(configs.packageJson, projectName),
      modules,
    }
  }
}
