/**
 * SymbolIndex 单元测试
 * 使用临时 LibSQL 数据库进行测试
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SymbolIndex } from '../symbol-index'
import { generateId } from '../../shared/env'
import { createClient, type Client } from '@libsql/client'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import type { SymbolInfo, ImportEdge } from '@shared/types'

describe('SymbolIndex', () => {
  let index: SymbolIndex
  let testClient: Client
  let dbDir: string

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-test-'))
    const testDbPath = path.join(dbDir, 'test.db')
    testClient = createClient({ url: `file:${testDbPath}` })
    index = new SymbolIndex(testClient)
    await index.initTables()
    await index.clearAll()
  })

  afterEach(async () => {
    try {
      await testClient.execute('PRAGMA wal_checkpoint(TRUNCATE)')
      await (testClient as any).close?.()
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

  it('should insert and query symbols', async () => {
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
    await index.insertSymbols(symbols)

    const results = await index.querySymbols('UserService')
    expect(results).toHaveLength(1)
    expect(results[0].symbol.name).toBe('UserService')
    expect(results[0].matchedBy).toBe('exact')
    expect(results[0].score).toBe(1.0)
  })

  it('should support fuzzy query', async () => {
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
    await index.insertSymbols(symbols)

    const results = await index.querySymbols('User', { fuzzy: true })
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('should track import dependencies', async () => {
    const edges: ImportEdge[] = [
      {
        fromFile: '/project/src/user/controller.ts',
        toFile: '/project/src/user/service.ts',
        importedNames: ['UserService'],
        isDefaultImport: false,
        line: 1,
      },
    ]
    await index.insertImportEdges(edges)

    const imports = await index.getImports('/project/src/user/controller.ts')
    expect(imports).toHaveLength(1)
    expect(imports[0].toFile).toBe('/project/src/user/service.ts')
  })

  it('should find related files by dependency depth', async () => {
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
    await index.insertImportEdges(edges)

    const related = await index.getRelatedFiles('/project/src/b.ts', 2)
    expect(related.has('/project/src/a.ts')).toBe(true)
    expect(related.has('/project/src/c.ts')).toBe(true)
    expect(related.has('/project/src/d.ts')).toBe(true) // depth=2: b->c->d
  })

  it('should clear file data', async () => {
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
    await index.insertSymbols(symbols)
    await index.clearFile('/project/src/a.ts')
    const results = await index.querySymbols('A')
    expect(results).toHaveLength(0)
  })
})
