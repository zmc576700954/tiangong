/**
 * 上下文采集器
 *
 * 从项目中收集 Claude 需要理解业务的上下文信息。
 * 不重新扫描，而是读取已有数据 + 额外业务信息源。
 * Token 预算：~8K tokens（约 32KB 文本）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { readMemory } from './memory'
import type { ProjectMemory } from '@shared/types'

export interface MindMapContext {
  projectName: string
  projectPath: string
  framework: string
  /** 格式化的目录树（限深度 3 层） */
  directoryTree: string
  /** package.json 摘要 */
  packageJsonSummary: string
  /** README 内容 */
  readmeContent: string
  /** 入口文件内容 */
  entryPointContent: string
  /** 项目记忆 */
  memory: ProjectMemory
  /** 关键文件片段 */
  keyFileSnippets: string
}

import { estimateTokens } from '../shared/token-utils'

/** 截断到 token 预算 */
function truncateToBudget(text: string, maxTokens: number): string {
  const estimated = estimateTokens(text)
  if (estimated <= maxTokens) return text
  const ratio = maxTokens / estimated
  const charBudget = Math.floor(text.length * ratio * 0.9) // 留 10% 余量
  return text.substring(0, charBudget) + '\n... [截断]'
}

/**
 * 收集项目上下文
 */
export async function collectContext(
  projectPath: string,
  projectName: string,
  framework: string,
): Promise<MindMapContext> {
  const memory = await readMemory(projectPath)

  // 并行采集各数据源
  const [directoryTree, packageJsonSummary, readmeContent, entryPointContent, keyFileSnippets] =
    await Promise.all([
      collectDirectoryTree(projectPath),
      collectPackageJson(projectPath),
      collectReadme(projectPath),
      collectEntryPoint(projectPath, framework),
      collectKeyFiles(projectPath),
    ])

  return {
    projectName,
    projectPath,
    framework,
    directoryTree: truncateToBudget(directoryTree, 1500),
    packageJsonSummary: truncateToBudget(packageJsonSummary, 1000),
    readmeContent: truncateToBudget(readmeContent, 2000),
    entryPointContent: truncateToBudget(entryPointContent, 1500),
    memory,
    keyFileSnippets: truncateToBudget(keyFileSnippets, 2000),
  }
}

/**
 * 生成格式化的目录树
 */
async function collectDirectoryTree(projectPath: string): Promise<string> {
  const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'vendor', 'target', 'dist-electron'])
  const lines: string[] = []

  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > 3) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries = entries
      .filter((e) => !e.name.startsWith('.') && !IGNORED.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, 20) // 每层最多 20 个

    for (const entry of entries) {
      const connector = entries.indexOf(entry) === entries.length - 1 ? '└── ' : '├── '
      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`)
        await walk(path.join(dir, entry.name), prefix + '    ', depth + 1)
      } else {
        lines.push(`${prefix}${connector}${entry.name}`)
      }
    }
  }

  lines.push(`${path.basename(projectPath)}/`)
  await walk(projectPath, '', 0)
  return lines.join('\n')
}

/**
 * 收集 package.json 摘要
 */
async function collectPackageJson(projectPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw)
    const parts: string[] = []
    if (pkg.name) parts.push(`name: ${pkg.name}`)
    if (pkg.description) parts.push(`description: ${pkg.description}`)
    if (pkg.version) parts.push(`version: ${pkg.version}`)

    if (pkg.scripts) {
      const scripts = Object.entries(pkg.scripts)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')
      parts.push(`scripts:\n${scripts}`)
    }

    const deps = Object.keys(pkg.dependencies || {})
    if (deps.length > 0) parts.push(`dependencies: ${deps.join(', ')}`)

    return parts.join('\n')
  } catch {
    return '[无 package.json]'
  }
}

/**
 * 收集 README 内容
 */
async function collectReadme(projectPath: string): Promise<string> {
  const names = ['README.md', 'README.rst', 'README.txt', 'readme.md', 'Readme.md']
  for (const name of names) {
    try {
      const content = await fs.readFile(path.join(projectPath, name), 'utf-8')
      // 去掉 markdown 标题行和图片链接
      return content
        .split('\n')
        .filter((l) => !l.match(/^!\[/) && !l.match(/^```/))
        .slice(0, 80)
        .join('\n')
    } catch {
      // 继续找下一个
    }
  }
  return '[无 README]'
}

/**
 * 收集入口文件
 */
async function collectEntryPoint(projectPath: string, _framework: string): Promise<string> {
  const candidates = [
    'src/main/index.ts',
    'src/main.ts',
    'src/index.ts',
    'src/App.tsx',
    'src/App.vue',
    'src/app/layout.tsx',
    'app/main.ts',
    'index.js',
    'main.py',
    'cmd/main.go',
  ]

  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(path.join(projectPath, candidate), 'utf-8')
      return `// ${candidate}\n${content.substring(0, 2000)}`
    } catch {
      // 继续
    }
  }
  return '[未找到入口文件]'
}

/**
 * 收集关键文件片段（各模块 index 文件的头部注释）
 */
async function collectKeyFiles(projectPath: string): Promise<string> {
  const snippets: string[] = []
  const srcDir = path.join(projectPath, 'src')

  try {
    const entries = await fs.readdir(srcDir, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).slice(0, 8)

    for (const dir of dirs) {
      // 尝试读取 index.ts 的头部注释
      const indexPath = path.join(srcDir, dir.name, 'index.ts')
      try {
        const content = await fs.readFile(indexPath, 'utf-8')
        // 提取文件开头的 JSDoc/行注释
        const commentMatch = content.match(/^\/\*\*[\s\S]*?\*\//)
        if (commentMatch) {
          snippets.push(`[${dir.name}] ${commentMatch[0].replace(/\/?\*\*?\/?/g, '').trim()}`)
        }
      } catch {
        // 没有 index.ts，跳过
      }
    }
  } catch {
    // 没有 src 目录
  }

  return snippets.length > 0 ? snippets.join('\n') : '[无关键文件片段]'
}
