/**
 * 模块构建模块
 * 
 * v2 改进：
 * - 功能点描述更丰富，包含文件路径、路由信息、实体字段
 * - 流程名称更具体，体现业务含义而非技术层级
 * - 元数据关联路由和实体信息
 */

import path from 'node:path'
import type { ScanModule, ScanProcess, ScanFeature, ProjectScanResult } from '@shared/types'
import type { RouteInfo, EntityInfo, SourceDirectory, FileAnalysis } from './types'
import { DIR_NAME_MAP } from '../dir-mapping'

export function buildModules(
  projectName: string,
  framework: string,
  packageJson: ProjectScanResult['packageJson'],
  structure: string[],
  fileAnalyses: FileAnalysis[],
  routes: RouteInfo[],
  entities: EntityInfo[],
): ScanModule[] {
  const modules: ScanModule[] = []

  // 从 README 或 package.json 提取描述
  let projectDescription = ''
  const readmeFile = fileAnalyses.find((f) =>
    f.filePath.toLowerCase().includes('readme')
  )
  if (readmeFile) {
    const lines = readmeFile.content.split('\n')
      .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('```'))
    projectDescription = lines.slice(0, 3).join(' ').trim().substring(0, 200)
  }
  if (!projectDescription && packageJson?.description) {
    projectDescription = packageJson.description
  }

  // Task 4.2.1: Pre-compute metadata for auto-fill
  const frameworks = framework ? [framework] : []
  const entryPoints = detectEntryPoints(structure, fileAnalyses)
  const techStack = extractTechStack(packageJson)

  // 策略1：基于 src/ 下的目录识别模块
  const srcDirs = getSourceDirectories(structure)

  if (srcDirs.length > 0) {
    for (const dir of srcDirs) {
      const module = buildModuleFromDir(dir, framework, routes, entities)
      if (module) {
        module.metadata = { frameworks, entryPoints, techStack }
        modules.push(module)
      }
    }
  }

  // 策略2：如果没有 src/ 目录，基于路由分组
  if (modules.length === 0 && routes.length > 0) {
    const routeModules = groupRoutesByModule(routes, entities)
    routeModules.forEach((m) => { m.metadata = { frameworks, entryPoints, techStack } })
    modules.push(...routeModules)
  }

  // 策略3：基于实体分组
  if (modules.length === 0 && entities.length > 0) {
    const entityModules = groupEntitiesByModule(entities)
    entityModules.forEach((m) => { m.metadata = { frameworks, entryPoints, techStack } })
    modules.push(...entityModules)
  }

  // 策略4：兜底 - 从 scripts 或默认生成
  if (modules.length === 0) {
    const fallback = buildFallbackModule(projectName, framework, packageJson, projectDescription)
    fallback.metadata = { frameworks, entryPoints, techStack }
    modules.push(fallback)
  }

  return modules.slice(0, 8)  // 限制最大模块数
}

function getSourceDirectories(structure: string[]): SourceDirectory[] {
  const srcPrefixes = ['src/', 'app/', 'lib/', 'internal/', 'pkg/', 'server/', 'api/', 'core/']
  const dirs = new Map<string, SourceDirectory>()

  for (const relPath of structure) {
    if (!relPath.endsWith('/')) continue

    const parts = relPath.split('/')
    // 寻找 src/xxx/ 或 app/xxx/ 这样的一级子目录
    if (parts.length === 2) {
      const parent = parts[0] + '/'
      if (srcPrefixes.includes(parent)) {
        const subName = parts[1]
        if (!dirs.has(subName)) {
          dirs.set(subName, {
            name: subName,
            path: relPath,
            files: [],
          })
        }
      }
    }

    // 收集每个目录下的文件
    for (const [, dirInfo] of dirs) {
      if (relPath.startsWith(dirInfo.path) && !relPath.endsWith('/')) {
        dirInfo.files.push(relPath)
      }
    }
  }

  return Array.from(dirs.values())
    .filter((d) => d.files.length > 0)
    .sort((a, b) => b.files.length - a.files.length)
}

function buildModuleFromDir(
  dir: SourceDirectory,
  framework: string,
  routes: RouteInfo[],
  entities: EntityInfo[],
): ScanModule | null {
  const dirMeaning = inferDirectoryMeaning(dir.name)
  const processes: ScanProcess[] = []

  // 过滤出该目录相关的路由和实体
  const dirRoutes = routes.filter((r) =>
    r.file?.includes(dir.path) ||
    r.path.toLowerCase().includes(dir.name.toLowerCase())
  )
  const dirEntities = entities.filter((e) =>
    e.file?.includes(dir.path) ||
    e.name.toLowerCase().includes(dir.name.toLowerCase())
  )

  // 分析目录下的文件类型
  const components = dir.files.filter((f) =>
    f.endsWith('.tsx') || f.endsWith('.jsx') || f.endsWith('.vue') ||
    f.endsWith('.svelte') || f.endsWith('.html')
  )
  const services = dir.files.filter((f) =>
    f.includes('service') || f.includes('api') || f.includes('controller') ||
    f.includes('usecase') || f.includes('handler')
  )
  const models = dir.files.filter((f) =>
    f.includes('model') || f.includes('entity') || f.includes('schema') ||
    f.includes('domain') || f.includes('dto')
  )
  const tests = dir.files.filter((f) =>
    f.includes('.test.') || f.includes('.spec.') || f.includes('_test.')
  )

  // 流程1：界面交互（如果有组件）
  if (components.length > 0) {
    const features: ScanFeature[] = components.slice(0, 5).map((f) => {
      const name = path.basename(f, path.extname(f))
      const relPath = f.replace(dir.path, '')
      return {
        name,
        description: `${framework} 组件 · ${relPath}`,
        type: 'feature' as const,
      }
    })
    processes.push({
      name: `${dirMeaning}界面层`,
      description: `${components.length} 个界面组件/页面`,
      features,
    })
  }

  // 流程2：API/服务层（如果有路由或控制器）
  if (services.length > 0 || dirRoutes.length > 0) {
    const features: ScanFeature[] = []
    if (dirRoutes.length > 0) {
      features.push(...dirRoutes.slice(0, 5).map((r) => ({
        name: `${r.method ?? 'GET'} ${r.path}`,
        description: r.handler ? `处理器: ${r.handler}` : 'API 端点',
        type: 'feature' as const,
      })))
    }
    if (features.length === 0) {
      features.push(...services.slice(0, 3).map((f) => {
        const name = path.basename(f, path.extname(f))
        return {
          name,
          description: `${dirMeaning}业务服务处理`,
          type: 'feature' as const,
        }
      }))
    }
    processes.push({
      name: `${dirMeaning}服务层`,
      description: `${services.length || dirRoutes.length} 个服务/API`,
      features,
    })
  }

  // 流程3：数据层（如果有模型/实体）
  if (models.length > 0 || dirEntities.length > 0) {
    const features: ScanFeature[] = []
    if (dirEntities.length > 0) {
      features.push(...dirEntities.slice(0, 5).map((e) => ({
        name: e.name,
        description: e.fields.length > 0
          ? `数据实体 · 字段: ${e.fields.slice(0, 4).join(', ')}${e.fields.length > 4 ? '...' : ''}`
          : `${dirMeaning}数据实体定义`,
        type: 'feature' as const,
      })))
    }
    if (features.length === 0) {
      features.push(...models.slice(0, 3).map((f) => {
        const name = path.basename(f, path.extname(f))
        const relPath = f.replace(dir.path, '')
        return {
          name,
          description: `数据模型 · ${relPath}`,
          type: 'feature' as const,
        }
      }))
    }
    processes.push({
      name: `${dirMeaning}数据层`,
      description: `${models.length || dirEntities.length} 个数据模型`,
      features,
    })
  }

  // 流程4：测试（如果有测试文件）
  if (tests.length > 0) {
    processes.push({
      name: `${dirMeaning}测试`,
      description: `${tests.length} 个测试文件`,
      features: tests.slice(0, 3).map((f) => {
        const name = path.basename(f, path.extname(f))
        return {
          name,
          description: `${dirMeaning}单元测试/集成测试`,
          type: 'feature' as const,
        }
      }),
    })
  }

  // 如果没有识别到任何流程，创建一个通用流程
  if (processes.length === 0) {
    const otherFiles = dir.files.filter((f) =>
      !f.endsWith('.css') && !f.endsWith('.scss') && !f.endsWith('.less')
    )
    if (otherFiles.length > 0) {
      processes.push({
        name: `${dirMeaning}管理`,
        description: `${otherFiles.length} 个代码文件`,
        features: otherFiles.slice(0, 4).map((f) => {
          const name = path.basename(f, path.extname(f))
          const relPath = f.replace(dir.path, '')
          return {
            name,
            description: `${path.extname(f)} 文件 · ${relPath}`,
            type: 'feature' as const,
          }
        }),
      })
    }
  }

  if (processes.length === 0) return null

  return {
    name: dirMeaning,
    description: `${dir.name} 模块 · ${dir.files.length} 个文件 · 框架: ${framework}`,
    processes,
  }
}

function groupRoutesByModule(routes: RouteInfo[], entities: EntityInfo[]): ScanModule[] {
  // 根据路由路径前缀分组
  const groups = new Map<string, RouteInfo[]>()

  for (const route of routes) {
    const parts = route.path.split('/').filter(Boolean)
    const prefix = parts.length > 0 ? parts[0] : 'api'
    if (!groups.has(prefix)) groups.set(prefix, [])
    groups.get(prefix)!.push(route)
  }

  return Array.from(groups.entries()).slice(0, 6).map(([prefix, groupRoutes]) => {
    const meaning = inferDirectoryMeaning(prefix)
    const relatedEntities = entities.filter((e) =>
      e.name.toLowerCase().includes(prefix.toLowerCase()) ||
      prefix.toLowerCase().includes(e.name.toLowerCase())
    )

    return {
      name: meaning,
      description: `${prefix} API 模块 · ${groupRoutes.length} 个端点`,
      processes: [
        {
          name: `${meaning}接口层`,
          description: `${groupRoutes.length} 个 API 端点`,
          features: groupRoutes.slice(0, 5).map((r) => ({
            name: `${r.method ?? 'GET'} ${r.path}`,
            description: r.handler ? `处理器: ${r.handler}` : 'API 端点',
            type: 'feature' as const,
          })),
        },
        ...(relatedEntities.length > 0 ? [{
          name: `${meaning}数据层`,
          description: `${relatedEntities.length} 个数据实体`,
          features: relatedEntities.slice(0, 5).map((e) => ({
            name: e.name,
            description: e.fields.length > 0
              ? `数据实体 · 字段: ${e.fields.slice(0, 4).join(', ')}`
              : '数据实体定义',
            type: 'feature' as const,
          })),
        }] : []),
      ],
    }
  })
}

function groupEntitiesByModule(entities: EntityInfo[]): ScanModule[] {
  // 简单按实体名首字母分组（前6组）
  const groups = new Map<string, EntityInfo[]>()

  for (const entity of entities) {
    // 尝试从文件名推断模块
    const fileParts = entity.file?.split('/') ?? []
    const moduleHint = fileParts.find((p) =>
      p !== 'src' && p !== 'app' && p !== 'models' && p !== 'entities' && p !== ''
    )
    const group = moduleHint ?? entity.name[0].toUpperCase()
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(entity)
  }

  return Array.from(groups.entries()).slice(0, 6).map(([group, ents]) => ({
    name: inferDirectoryMeaning(group),
    description: `${group} 领域 · ${ents.length} 个实体`,
    processes: [
      {
        name: `${inferDirectoryMeaning(group)}数据模型`,
        description: `${ents.length} 个数据实体`,
        features: ents.slice(0, 5).map((e) => ({
          name: e.name,
          description: e.fields.length > 0
            ? `数据实体 · 字段: ${e.fields.slice(0, 4).join(', ')}`
            : '数据实体定义',
          type: 'feature' as const,
        })),
      },
    ],
  }))
}

function buildFallbackModule(
  projectName: string,
  framework: string,
  packageJson: ProjectScanResult['packageJson'],
  description: string,
): ScanModule {
  const processes: ScanProcess[] = []

  // 从 scripts 生成
  if (packageJson?.scripts) {
    const scripts = packageJson.scripts as Record<string, string>
    const devScripts = Object.entries(scripts).filter(([k]) =>
      k.includes('dev') || k.includes('start') || k.includes('build') ||
      k.includes('test') || k.includes('lint')
    )
    if (devScripts.length > 0) {
      processes.push({
        name: '开发运维',
        description: `${devScripts.length} 个开发脚本`,
        features: devScripts.slice(0, 5).map(([name, cmd]) => ({
          name,
          description: `脚本命令: ${cmd}`,
          type: 'feature' as const,
        })),
      })
    }
  }

  // 从依赖生成
  const allDeps = [
    ...(packageJson?.dependencies ?? []),
    ...(packageJson?.devDependencies ?? []),
  ]
  if (allDeps.length > 0) {
    const keyDeps = allDeps
      .filter((d) => !d.startsWith('@types/') && !d.includes('eslint') && !d.includes('prettier'))
      .slice(0, 5)
    if (keyDeps.length > 0) {
      processes.push({
        name: '技术栈',
        description: `${allDeps.length} 个依赖包`,
        features: keyDeps.map((d) => ({
          name: d,
          description: '项目核心依赖',
          type: 'feature' as const,
        })),
      })
    }
  }

  // 默认兜底
  if (processes.length === 0) {
    processes.push({
      name: '核心业务',
      description: `${framework} 项目`,
      features: [
        {
          name: '功能实现',
          description: description || '待补充具体功能描述',
          type: 'feature' as const,
        },
      ],
    })
  }

  return {
    name: projectName,
    description: description || `${framework} 项目`,
    processes,
  }
}

/** Detect entry point files from directory structure and file analyses */
function detectEntryPoints(structure: string[], fileAnalyses: FileAnalysis[]): string[] {
  const entryPatterns = [
    'index.ts', 'index.tsx', 'index.js', 'index.jsx',
    'main.ts', 'main.tsx', 'main.js', 'main.jsx',
    'app.ts', 'app.tsx', 'app.js', 'app.jsx',
    'server.ts', 'server.js',
    'index.vue', 'App.vue',
  ]

  const entries: string[] = []

  // Check structure for top-level entry files
  for (const relPath of structure) {
    const basename = relPath.split('/').pop() ?? ''
    if (entryPatterns.includes(basename) && !relPath.includes('node_modules')) {
      entries.push(relPath)
    }
  }

  // Also check file analyses for entry-purpose files
  for (const fa of fileAnalyses) {
    if (fa.purpose === 'route' || fa.purpose === 'controller') {
      const basename = fa.filePath.split('/').pop() ?? ''
      if (entryPatterns.includes(basename) && !entries.includes(fa.filePath)) {
        entries.push(fa.filePath)
      }
    }
  }

  return entries.slice(0, 10)
}

/** Extract tech stack info from packageJson dependencies */
function extractTechStack(packageJson: ProjectScanResult['packageJson']): string[] {
  if (!packageJson) return []

  const allDeps = [
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  ]

  // Filter out type definitions and dev tooling, keep meaningful tech stack entries
  const techStack = allDeps
    .filter((d) => !d.startsWith('@types/') && !d.includes('eslint') && !d.includes('prettier'))
    .slice(0, 15)

  return techStack
}

function inferDirectoryMeaning(dirName: string): string {
  return DIR_NAME_MAP[dirName.toLowerCase()] ?? dirName
}
