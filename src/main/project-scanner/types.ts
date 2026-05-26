/**
 * ProjectScanner 内部类型定义
 */

export interface FileAnalysis {
  filePath: string
  content: string
  language: string
  purpose: 'route' | 'controller' | 'service' | 'model' | 'entity' | 'component' | 'config' | 'util' | 'other'
}

export interface RouteInfo {
  method?: string
  path: string
  handler?: string
  file?: string
}

export interface EntityInfo {
  name: string
  fields: string[]
  file?: string
}

export interface SourceDirectory {
  name: string
  path: string
  files: string[]
}

// ============================================
// 并发控制 Semaphore
// ============================================

export class Semaphore {
  private tasks: (() => void)[] = []
  private count: number

  constructor(count: number) {
    this.count = count
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--
      return
    }
    return new Promise((resolve) => this.tasks.push(resolve))
  }

  release(): void {
    if (this.tasks.length > 0) {
      const next = this.tasks.shift()!
      next()
    } else {
      this.count++
    }
  }
}
