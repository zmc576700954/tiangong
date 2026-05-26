/**
 * 关键文件内容分析模块
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { FileAnalysis } from './types'
import { Semaphore } from './types'

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript/React',
  '.js': 'JavaScript', '.jsx': 'JavaScript/React',
  '.vue': 'Vue',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.dart': 'Dart',
  '.cpp': 'C++', '.cc': 'C++', '.c': 'C',
  '.h': 'C/C++', '.hpp': 'C++',
}

export function getLanguage(ext: string): string {
  return LANGUAGE_MAP[ext] ?? ext.replace('.', '').toUpperCase()
}

function identifyKeyFiles(framework: string): string[] {
  const common = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.json', '.yaml', '.yml']

  if (framework.startsWith('Go')) return ['.go', '.mod']
  if (framework.startsWith('Rust')) return ['.rs', '.toml']
  if (framework.startsWith('Python')) return ['.py', '.toml']
  if (framework.startsWith('Java')) return ['.java', '.xml', '.gradle', '.properties']
  if (framework.startsWith('Ruby')) return ['.rb', '.erb', '.yml']
  if (framework.startsWith('PHP')) return ['.php', '.json']

  return common
}

function inferFilePurpose(relPath: string, ext: string): FileAnalysis['purpose'] {
  const lower = relPath.toLowerCase()
  const basename = path.basename(relPath, ext).toLowerCase()

  if (lower.includes('route') || lower.includes('router') ||
      basename === 'urls' || basename === 'endpoints') {
    return 'route'
  }
  if (lower.includes('controller') || lower.includes('handler') ||
       lower.includes('resource')) {
    return 'controller'
  }
  if (lower.includes('service') || lower.includes('usecase') ||
       lower.includes('use-case') || lower.includes('application')) {
    return 'service'
  }
  if (lower.includes('model') || lower.includes('entity') ||
       lower.includes('schema') || lower.includes('dto') ||
       lower.includes('domain')) {
    return 'model'
  }
  if (lower.includes('component') || ext === '.tsx' || ext === '.jsx' || ext === '.vue') {
    return 'component'
  }
  if (basename === 'config' || basename === 'configuration' ||
       ext === '.yaml' || ext === '.yml' || ext === '.toml') {
    return 'config'
  }
  if (lower.includes('util') || lower.includes('helper') || lower.includes('common')) {
    return 'util'
  }
  return 'other'
}

export async function analyzeKeyFiles(
  projectPath: string,
  framework: string,
  structure: string[],
): Promise<FileAnalysis[]> {
  const analyses: FileAnalysis[] = []
  const keyFiles = identifyKeyFiles(framework)
  const semaphore = new Semaphore(20)

  const tasks = structure.map(async (relPath) => {
    if (relPath.endsWith('/')) return

    const ext = path.extname(relPath)
    const purpose = inferFilePurpose(relPath, ext)

    // 只读取关键文件的内容
    if (keyFiles.includes(ext) || purpose !== 'other') {
      await semaphore.acquire()
      try {
        const content = await fs.readFile(path.join(projectPath, relPath), 'utf-8')
        if (content.length > 50000) return // 跳过超大文件
        analyses.push({
          filePath: relPath,
          content,
          language: getLanguage(ext),
          purpose,
        })
      } catch (err) {
        console.warn(`[ProjectScanner] Failed to read ${relPath}:`, err)
      } finally {
        semaphore.release()
      }
    }
  })

  await Promise.all(tasks)
  return analyses
}
