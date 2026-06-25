/**
 * ProjectIndexer 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { ProjectIndexer } from '../project-indexer'
import { SymbolIndex } from '../symbol-index'

// Mock the database module so SymbolIndex doesn't try to use getClient()
vi.mock('../../database', () => ({
  getClient: vi.fn(),
}))

describe('ProjectIndexer', () => {
  let testDb: BetterSqlite3.Database
  let dbDir: string
  let projectDir: string
  let index: SymbolIndex
  let indexer: ProjectIndexer

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-indexer-test-'))
    const testDbPath = path.join(dbDir, 'test.db')
    testDb = new BetterSqlite3(testDbPath)
    testDb.pragma('journal_mode = WAL')
    index = new SymbolIndex(testDb)
    index.initTables()
    index.clearAll()

    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-indexer-src-'))
    indexer = new ProjectIndexer(index)
  })

  afterEach(() => {
    try {
      testDb.pragma('wal_checkpoint(TRUNCATE)')
      testDb.close()
    } catch {
      // ignore
    }
    // Windows 可能因文件句柄未释放导致删除失败，忽略清理错误
    try {
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 3 })
      fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // temp files will be cleaned by OS eventually
    }
  })

  it('indexes multiple files in a single batch', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'a.ts'),
      `import { helper } from './b'\nexport function foo() { return helper() }\n`,
      'utf-8',
    )
    fs.writeFileSync(
      path.join(projectDir, 'b.ts'),
      `export function helper() { return 42 }\n`,
      'utf-8',
    )

    const result = await indexer.indexProject({
      projectPath: projectDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: ['node_modules/**'],
    })

    expect(result.filesIndexed).toBe(2)
    expect(result.symbolsFound).toBeGreaterThan(0)
    expect(result.importsFound).toBeGreaterThan(0)

    const symbols = index.querySymbols('foo')
    expect(symbols.length).toBeGreaterThan(0)

    const imports = index.getImports(path.join(projectDir, 'a.ts'))
    expect(imports.length).toBe(1)
    expect(imports[0].toFile).toBe(path.join(projectDir, 'b'))
  })
})
