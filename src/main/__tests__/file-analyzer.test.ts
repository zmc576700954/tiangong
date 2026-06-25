/**
 * ProjectScanner file-analyzer 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { analyzeKeyFiles, getLanguage } from '../project-scanner/file-analyzer'

describe('getLanguage', () => {
  it('returns TypeScript for .ts', () => {
    expect(getLanguage('.ts')).toBe('TypeScript')
  })

  it('returns uppercase extension for unknown languages', () => {
    expect(getLanguage('.xyz')).toBe('XYZ')
  })
})

describe('analyzeKeyFiles', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-analyzer-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('skips files exceeding the size threshold before reading', async () => {
    // 一个小文件（应被读取）
    await fs.writeFile(path.join(tmpDir, 'small.ts'), 'export const a = 1\n', 'utf-8')

    // 一个大文件（超过 50KB）
    const largeContent = 'x'.repeat(60_000)
    await fs.writeFile(path.join(tmpDir, 'large.ts'), largeContent, 'utf-8')

    const results = await analyzeKeyFiles(tmpDir, 'Node.js', ['small.ts', 'large.ts'])

    const paths = results.map((r) => r.filePath)
    expect(paths).toContain('small.ts')
    expect(paths).not.toContain('large.ts')
  })

  it('returns file content for key files', async () => {
    await fs.writeFile(path.join(tmpDir, 'user.service.ts'), 'export class UserService {}', 'utf-8')

    const results = await analyzeKeyFiles(tmpDir, 'Node.js', ['user.service.ts'])

    expect(results).toHaveLength(1)
    expect(results[0].filePath).toBe('user.service.ts')
    expect(results[0].content).toContain('UserService')
    expect(results[0].language).toBe('TypeScript')
  })
})
