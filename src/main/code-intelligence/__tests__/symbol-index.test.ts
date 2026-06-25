/**
 * SymbolIndex 单元测试
 * 使用临时 better-sqlite3 数据库进行测试
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SymbolIndex } from '../symbol-index'
import { generateId } from '../../shared/env'
import BetterSqlite3 from 'better-sqlite3'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import type { SymbolInfo, ImportEdge } from '@shared/types'

// Mock the database module so SymbolIndex doesn't try to use getClient()
vi.mock('../../database', () => ({
  getClient: vi.fn(),
}))

describe('SymbolIndex', () => {
  let index: SymbolIndex
  let testDb: BetterSqlite3.Database
  let dbDir: string

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-test-'))
    const testDbPath = path.join(dbDir, 'test.db')
    testDb = new BetterSqlite3(testDbPath)
    testDb.pragma('journal_mode = WAL')
    index = new SymbolIndex(testDb)
    index.initTables()
    index.clearAll()
  })

  afterEach(() => {
    try {
      testDb.pragma('wal_checkpoint(TRUNCATE)')
      testDb.close()
    } catch {
      // ignore
    }
    // Windows 可能需要延迟删除，使用递归重试
    try {
      fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // temp files will be cleaned by OS eventually
    }
  })

  it('should insert and query symbols', () => {
    const symbols: SymbolInfo[] = [
      {
        id: generateId('symbol'),
        name: 'UserService',
        kind: 'class',
        filePath: '/project/src/user/service.ts',
        line: 10,
        column: 0,
        endLine: 50,
        endColumn: 1,
        isExported: true,
        signature: 'class UserService',
      },
    ]
    index.insertSymbols(symbols)

    const results = index.querySymbols('UserService')
    expect(results).toHaveLength(1)
    expect(results[0].symbol.name).toBe('UserService')
    expect(results[0].matchedBy).toBe('exact')
    expect(results[0].score).toBe(1.0)
  })

  it('should support fuzzy query', () => {
    const symbols: SymbolInfo[] = [
      {
        id: generateId('symbol'),
        name: 'UserService',
        kind: 'class',
        filePath: '/project/src/user/service.ts',
        line: 1,
        column: 0,
        endLine: 1,
        endColumn: 1,
        isExported: true,
      },
      {
        id: generateId('symbol'),
        name: 'UserController',
        kind: 'class',
        filePath: '/project/src/user/controller.ts',
        line: 1,
        column: 0,
        endLine: 1,
        endColumn: 1,
        isExported: true,
      },
    ]
    index.insertSymbols(symbols)

    const results = index.querySymbols('User', { fuzzy: true })
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('should track import dependencies', () => {
    const edges: ImportEdge[] = [
      {
        fromFile: '/project/src/user/controller.ts',
        toFile: '/project/src/user/service.ts',
        importedNames: ['UserService'],
        isDefaultImport: false,
        line: 1,
      },
    ]
    index.insertImportEdges(edges)

    const imports = index.getImports('/project/src/user/controller.ts')
    expect(imports).toHaveLength(1)
    expect(imports[0].toFile).toBe('/project/src/user/service.ts')
  })

  it('should find related files by dependency depth', () => {
    const edges: ImportEdge[] = [
      {
        fromFile: '/project/src/a.ts',
        toFile: '/project/src/b.ts',
        importedNames: ['B'],
        isDefaultImport: false,
        line: 1,
      },
      {
        fromFile: '/project/src/b.ts',
        toFile: '/project/src/c.ts',
        importedNames: ['C'],
        isDefaultImport: false,
        line: 1,
      },
      {
        fromFile: '/project/src/c.ts',
        toFile: '/project/src/d.ts',
        importedNames: ['D'],
        isDefaultImport: false,
        line: 1,
      },
    ]
    index.insertImportEdges(edges)

    const related = index.getRelatedFiles('/project/src/b.ts', 2)
    expect(related.has('/project/src/a.ts')).toBe(true)
    expect(related.has('/project/src/c.ts')).toBe(true)
    expect(related.has('/project/src/d.ts')).toBe(true) // depth=2: b->c->d
  })

  it('should handle wide frontiers without exceeding SQLite parameter limits', () => {
    const centralFile = '/project/src/central.ts'
    const edgeCount = 600
    const edges: ImportEdge[] = []

    for (let i = 0; i < edgeCount; i++) {
      edges.push({
        fromFile: centralFile,
        toFile: `/project/src/deps/lib-${i}.ts`,
        importedNames: [`Lib${i}`],
        isDefaultImport: false,
        line: i + 1,
      })
    }

    index.insertImportEdges(edges)

    const related = index.getRelatedFiles(centralFile, 1)
    expect(related.size).toBe(edgeCount)
    for (let i = 0; i < edgeCount; i++) {
      expect(related.has(`/project/src/deps/lib-${i}.ts`)).toBe(true)
    }
  })

  it('should clear file data', () => {
    const symbols: SymbolInfo[] = [
      {
        id: generateId('symbol'),
        name: 'A',
        kind: 'function',
        filePath: '/project/src/a.ts',
        line: 1,
        column: 0,
        endLine: 1,
        endColumn: 1,
        isExported: true,
      },
    ]
    index.insertSymbols(symbols)
    index.clearFile('/project/src/a.ts')
    const results = index.querySymbols('A')
    expect(results).toHaveLength(0)
  })
})
