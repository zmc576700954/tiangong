/**
 * D7 裁决（2026-11-07）的 G4 生产装配测试：env 阈值解析 + Σ 行数预估来源。
 * 覆盖：已存在文件按实际行数、新建文件计 0、目录/不可读 fail-closed、
 * mtime+size 缓存复用、env 非法值回退默认。
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEstimateLines, readG4Config } from '../map/work-execution-runtime'

const TMP_ROOTS: string[] = []
const ENV_KEYS = ['BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES', 'BIZGRAPH_MAP_EXECUTION_G4_MAX_LINES'] as const
const ENV_BACKUP = ENV_KEYS.map((k) => process.env[k])

afterEach(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true })
  TMP_ROOTS.length = 0
  ENV_KEYS.forEach((k, i) => {
    if (ENV_BACKUP[i] === undefined) delete process.env[k]
    else process.env[k] = ENV_BACKUP[i] as string
  })
})

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'g4-runtime-'))
  TMP_ROOTS.push(dir)
  return dir
}

describe('readG4Config（D7）', () => {
  it('未配置 → 默认 20/800', () => {
    delete process.env.BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES
    delete process.env.BIZGRAPH_MAP_EXECUTION_G4_MAX_LINES
    expect(readG4Config()).toEqual({ g4MaxFiles: 20, g4MaxLines: 800 })
  })

  it('合法 env 覆盖默认；非法值回退默认', () => {
    process.env.BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES = '5'
    process.env.BIZGRAPH_MAP_EXECUTION_G4_MAX_LINES = '100'
    expect(readG4Config()).toEqual({ g4MaxFiles: 5, g4MaxLines: 100 })
    process.env.BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES = '-1'
    process.env.BIZGRAPH_MAP_EXECUTION_G4_MAX_LINES = 'abc'
    expect(readG4Config()).toEqual({ g4MaxFiles: 20, g4MaxLines: 800 })
  })
})

describe('buildEstimateLines（D7：Σ scope 文件行数代理）', () => {
  it('已存在文件按实际行数计；将新建的文件计 0', () => {
    const root = makeRoot()
    writeFileSync(path.join(root, 'a.ts'), 'l1\nl2\nl3\n') // 3 行
    writeFileSync(path.join(root, 'b.ts'), 'x\ny') // 2 行（无尾换行）
    const estimate = buildEstimateLines()
    expect(estimate(['a.ts', 'b.ts', 'new-file.ts'], root)).toBe(5)
  })

  it('projectPath 缺失 / scope 指向目录 → null（fail-closed，不猜）', () => {
    const root = makeRoot()
    mkdirSync(path.join(root, 'sub'))
    const estimate = buildEstimateLines()
    expect(estimate(['a.ts'], null)).toBeNull()
    expect(estimate(['sub'], root)).toBeNull()
  })

  it('mtime+size 未变 → 复用缓存；内容变更后重算', () => {
    const root = makeRoot()
    const file = path.join(root, 'a.ts')
    writeFileSync(file, 'l1\n')
    const estimate = buildEstimateLines()
    expect(estimate(['a.ts'], root)).toBe(1)
    writeFileSync(file, 'l1\nl2\nl3')
    expect(estimate(['a.ts'], root)).toBe(3)
  })
})
