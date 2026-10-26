/**
 * SmartContextResolver 单元测试
 * 使用 fake SymbolIndex（实现同名接口的最小子集），不依赖 better-sqlite3
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SmartContextResolver } from '../smart-context-resolver'
import type { ImportEdge, SymbolInfo, SymbolQueryResult } from '@shared/types'

interface FakeIndexState {
  symbols: SymbolInfo[]
  byName: Map<string, SymbolInfo[]>
  byFuzzyName: Map<string, SymbolInfo[]>
  byFile: Map<string, SymbolInfo[]>
  imports: Map<string, ImportEdge[]>
  related: Map<string, Map<string, number>>
}

function makeFakeSymbolIndex(initial?: Partial<FakeIndexState>) {
  const state: FakeIndexState = {
    symbols: initial?.symbols ?? [],
    byName: initial?.byName ?? new Map(),
    byFuzzyName: initial?.byFuzzyName ?? new Map(),
    byFile: initial?.byFile ?? new Map(),
    imports: initial?.imports ?? new Map(),
    related: initial?.related ?? new Map(),
  }

  return {
    state,
    querySymbols(name: string, options?: { kind?: SymbolInfo['kind']; limit?: number; fuzzy?: boolean }): SymbolQueryResult[] {
      const limit = options?.limit ?? 20
      const all = options?.fuzzy ? state.byFuzzyName.get(name) ?? [] : state.byName.get(name) ?? []
      const filtered = options?.kind ? all.filter((s) => s.kind === options.kind) : all
      return filtered.slice(0, limit).map((s) => ({
        symbol: s,
        score: options?.fuzzy ? 0.7 : 1.0,
        matchedBy: options?.fuzzy ? ('fuzzy' as const) : ('exact' as const),
      }))
    },
    getSymbolsByFile(filePath: string): SymbolInfo[] {
      return state.byFile.get(filePath) ?? []
    },
    getImports(filePath: string): ImportEdge[] {
      return state.imports.get(filePath) ?? []
    },
    getRelatedFiles(filePath: string, depth = 2): Map<string, number> {
      const all = state.related.get(filePath) ?? new Map()
      const result = new Map<string, number>()
      for (const [k, v] of all) {
        if (v <= depth) result.set(k, v)
      }
      return result
    },
  }
}

function makeSymbol(over: Partial<SymbolInfo>): SymbolInfo {
  return {
    id: over.id ?? 'sym-default',
    name: over.name ?? 'sym',
    kind: over.kind ?? 'class',
    filePath: over.filePath ?? '/proj/a.ts',
    line: over.line ?? 1,
    column: over.column ?? 0,
    endLine: over.endLine,
    endColumn: over.endColumn,
    signature: over.signature,
    jsDoc: over.jsDoc,
    parentId: over.parentId,
    isExported: over.isExported ?? true,
    sourceCode: over.sourceCode,
  }
}

/** 通过 unknown-cast 跳过 SmartContextResolver 对 SymbolIndex 严格实现的检查 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildResolver(fake: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (SmartContextResolver as unknown as new (idx: any) => SmartContextResolver)(fake)
}

describe('SmartContextResolver.resolve — cache', () => {
  it('相同请求第二次走缓存，不重新查询', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['UserService', [makeSymbol({ id: 'sym-1', name: 'UserService', kind: 'class', filePath: '/proj/u.ts' })]]]),
    })
    const r = buildResolver(fake)

    const first = await r.resolve({ userQuery: 'UserService', projectPath: '/proj' })
    const second = await r.resolve({ userQuery: 'UserService', projectPath: '/proj' })

    expect(second).toBe(first)
  })

  it('不同请求不复用缓存', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([
        ['UserService', [makeSymbol({ id: 'sym-1', name: 'UserService', kind: 'class', filePath: '/proj/u.ts' })]],
        ['OrderService', [makeSymbol({ id: 'sym-2', name: 'OrderService', kind: 'class', filePath: '/proj/o.ts' })]],
      ]),
    })
    const r = buildResolver(fake)

    const a = await r.resolve({ userQuery: 'UserService', projectPath: '/proj' })
    const b = await r.resolve({ userQuery: 'OrderService', projectPath: '/proj' })
    expect(a).not.toBe(b)
    expect(a.primarySymbols[0].symbol.id).toBe('sym-1')
    expect(b.primarySymbols[0].symbol.id).toBe('sym-2')
  })

  it('不同 nodes 参数不复用缓存', async () => {
    const fake = makeFakeSymbolIndex({ byName: new Map() })
    const r = buildResolver(fake)

    const a = await r.resolve({
      userQuery: 'foo',
      projectPath: '/proj',
      nodes: [{ id: 'n1' } as never],
    })
    const b = await r.resolve({
      userQuery: 'foo',
      projectPath: '/proj',
      nodes: [{ id: 'n2' } as never],
    })

    expect(a).not.toBe(b)
  })
})

describe('SmartContextResolver.resolve — 主符号解析', () => {
  it('按实体类型优先级：class > method > interface', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([
        // dotMethodPattern 提取 "UserService" (class) + "createUser" (method)
        // pascalPattern 提取 "UserService" (class) 和 "UserDto" (interface, 因为以 Dto 结尾)
        ['UserService', [makeSymbol({ id: 'sym-class', name: 'UserService', kind: 'class', filePath: '/proj/u.ts' })]],
        ['createUser', [makeSymbol({ id: 'sym-method', name: 'createUser', kind: 'method', filePath: '/proj/u.ts', parentId: 'sym-class' })]],
        ['UserDto', [makeSymbol({ id: 'sym-iface', name: 'UserDto', kind: 'interface', filePath: '/proj/dto.ts' })]],
      ]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({
      userQuery: 'UserService.createUser implementation UserDto',
      projectPath: '/proj',
    })

    const ids = ctx.primarySymbols.map((s) => s.symbol.id)
    // class 应排在 method 之前（findSymbolsFromEntities 优先级 class > method > interface）
    expect(ids.indexOf('sym-class')).toBeLessThan(ids.indexOf('sym-method'))
    expect(ids.indexOf('sym-method')).toBeLessThan(ids.indexOf('sym-iface'))
  })

  it('主符号按 score 排序', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['Target', [
        makeSymbol({ id: 'low', name: 'Target', kind: 'class', filePath: '/proj/a.ts' }),
        makeSymbol({ id: 'high', name: 'Target', kind: 'class', filePath: '/proj/b.ts' }),
      ]]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Target', projectPath: '/proj' })
    expect(ctx.primarySymbols.map((s) => s.symbol.id)).toEqual(['low', 'high'])
  })

  it('文件路径类型实体通过 getSymbolsByFile 获取该文件的导出符号', async () => {
    // filePattern 提取时不包含前导 /（因 \b 要求前为 word char）
    const filePath = 'proj/src/user.ts'
    const fake = makeFakeSymbolIndex({
      byFile: new Map([[filePath, [
        makeSymbol({ id: 'exp-1', name: 'foo', kind: 'function', filePath, isExported: true }),
        makeSymbol({ id: 'exp-2', name: 'bar', kind: 'function', filePath, isExported: true }),
        makeSymbol({ id: 'priv', name: 'baz', kind: 'function', filePath, isExported: false }),
      ]]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: `查看 /${filePath}`, projectPath: '/proj' })
    const ids = ctx.primarySymbols.map((s) => s.symbol.id)
    expect(ids).toContain('exp-1')
    expect(ids).toContain('exp-2')
    expect(ids).not.toContain('priv')
    expect(ctx.primarySymbols.every((s) => s.matchedBy === 'path')).toBe(true)
  })

  it('主符号受 maxSymbols 限制', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['Sym', [
        makeSymbol({ id: 's1', name: 'Sym', kind: 'class', filePath: '/proj/a.ts' }),
        makeSymbol({ id: 's2', name: 'Sym', kind: 'class', filePath: '/proj/b.ts' }),
        makeSymbol({ id: 's3', name: 'Sym', kind: 'class', filePath: '/proj/c.ts' }),
      ]]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Sym', projectPath: '/proj', maxSymbols: 2 })
    expect(ctx.primarySymbols.length).toBeLessThanOrEqual(2)
  })
})

describe('SmartContextResolver.resolve — 相关符号 + 文件', () => {
  it('通过依赖图扩展相关文件（按 distance 排序）', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['Entry', [makeSymbol({ id: 'sym-entry', name: 'Entry', kind: 'class', filePath: '/proj/entry.ts' })]]]),
      byFile: new Map([
        ['/proj/entry.ts', [makeSymbol({ id: 'sym-entry', name: 'Entry', kind: 'class', filePath: '/proj/entry.ts' })]],
        ['/proj/dep1.ts', [makeSymbol({ id: 'sym-d1', name: 'Dep1', kind: 'class', filePath: '/proj/dep1.ts', isExported: true })]],
        ['/proj/dep2.ts', [makeSymbol({ id: 'sym-d2', name: 'Dep2', kind: 'class', filePath: '/proj/dep2.ts', isExported: true })]],
      ]),
      related: new Map([['/proj/entry.ts', new Map([
        ['/proj/dep1.ts', 1],
        ['/proj/dep2.ts', 2],
      ])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Entry', projectPath: '/proj' })

    expect(ctx.relatedFiles.length).toBe(2)
    expect(ctx.relatedFiles[0].filePath).toBe('/proj/dep1.ts')
    expect(ctx.relatedFiles[0].distance).toBe(1)
    expect(ctx.relatedFiles[1].filePath).toBe('/proj/dep2.ts')
    expect(ctx.relatedFiles[0].reason).toContain('直接')

    const d1 = ctx.relatedSymbols.find((s) => s.symbol.id === 'sym-d1')
    expect(d1?.matchedBy).toBe('exact')
    const d2 = ctx.relatedSymbols.find((s) => s.symbol.id === 'sym-d2')
    expect(d2?.matchedBy).toBe('fuzzy')
  })

  it('主文件不出现在相关文件列表（避免重复）', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['Main', [makeSymbol({ id: 'sym-main', name: 'Main', kind: 'class', filePath: '/proj/main.ts' })]]]),
      related: new Map([['/proj/main.ts', new Map([['/proj/main.ts', 1]])]]), // 自环
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Main', projectPath: '/proj' })
    expect(ctx.relatedFiles.find((f) => f.filePath === '/proj/main.ts')).toBeUndefined()
  })

  it('每个相关文件最多取 3 个导出符号', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['Entry', [makeSymbol({ id: 'sym-entry', name: 'Entry', kind: 'class', filePath: '/proj/entry.ts' })]]]),
      byFile: new Map([
        ['/proj/entry.ts', [makeSymbol({ id: 'sym-entry', name: 'Entry', kind: 'class', filePath: '/proj/entry.ts' })]],
        ['/proj/dep.ts', [
          makeSymbol({ id: 'e1', name: 'E1', kind: 'class', filePath: '/proj/dep.ts', isExported: true }),
          makeSymbol({ id: 'e2', name: 'E2', kind: 'class', filePath: '/proj/dep.ts', isExported: true }),
          makeSymbol({ id: 'e3', name: 'E3', kind: 'class', filePath: '/proj/dep.ts', isExported: true }),
          makeSymbol({ id: 'e4', name: 'E4', kind: 'class', filePath: '/proj/dep.ts', isExported: true }),
          makeSymbol({ id: 'i1', name: 'I1', kind: 'class', filePath: '/proj/dep.ts', isExported: false }),
        ]],
      ]),
      related: new Map([['/proj/entry.ts', new Map([['/proj/dep.ts', 1]])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Entry', projectPath: '/proj' })
    const relatedIds = ctx.relatedSymbols.map((s) => s.symbol.id)
    expect(relatedIds.filter((id) => id.startsWith('e') || id.startsWith('i'))).toEqual(['e1', 'e2', 'e3'])
  })

  it('dependencyDepth 限制展开层级', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['Entry', [makeSymbol({ id: 'sym-entry', name: 'Entry', kind: 'class', filePath: '/proj/entry.ts' })]]]),
      related: new Map([['/proj/entry.ts', new Map([
        ['/proj/dep1.ts', 1],
        ['/proj/dep2.ts', 2], // depth=2 超 depth=1 限制
      ])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Entry', projectPath: '/proj', dependencyDepth: 1 })
    expect(ctx.relatedFiles.map((f) => f.filePath)).toEqual(['/proj/dep1.ts'])
  })
})

describe('SmartContextResolver.resolve — import graph 摘要', () => {
  it('importGraph 仅保留主符号 / 相关符号之间的边', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['A', [makeSymbol({ id: 'a', name: 'A', kind: 'class', filePath: '/proj/a.ts' })]]]),
      byFile: new Map([
        ['/proj/a.ts', [makeSymbol({ id: 'a', name: 'A', kind: 'class', filePath: '/proj/a.ts' })]],
        ['/proj/b.ts', [makeSymbol({ id: 'b', name: 'B', kind: 'class', filePath: '/proj/b.ts' })]],
      ]),
      imports: new Map([
        ['/proj/a.ts', [{ fromFile: '/proj/a.ts', toFile: '/proj/b.ts', importedNames: ['B'], isDefaultImport: false, line: 1 }]],
      ]),
      related: new Map([['/proj/a.ts', new Map([['/proj/b.ts', 1]])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'A', projectPath: '/proj' })
    expect(ctx.importGraph).toEqual([{ from: 'a.ts', to: 'b.ts' }])
  })

  it('importGraph 过滤不在主/相关集合中的目标', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['A', [makeSymbol({ id: 'a', name: 'A', kind: 'class', filePath: '/proj/a.ts' })]]]),
      byFile: new Map([['/proj/a.ts', [makeSymbol({ id: 'a', name: 'A', kind: 'class', filePath: '/proj/a.ts' })]]]),
      imports: new Map([
        ['/proj/a.ts', [{ fromFile: '/proj/a.ts', toFile: '/proj/external.ts', importedNames: ['X'], isDefaultImport: false, line: 1 }]],
      ]),
      related: new Map(),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'A', projectPath: '/proj' })
    expect(ctx.importGraph).toEqual([])
  })
})

describe('SmartContextResolver.resolve — 摘要生成', () => {
  it('summary 包含 intent + 核心符号 + 相关符号', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['TargetClass', [makeSymbol({ id: 'tc', name: 'TargetClass', kind: 'class', filePath: '/proj/t.ts' })]]]),
      byFile: new Map([
        ['/proj/t.ts', [makeSymbol({ id: 'tc', name: 'TargetClass', kind: 'class', filePath: '/proj/t.ts' })]],
        ['/proj/d.ts', [makeSymbol({ id: 'dc', name: 'DepClass', kind: 'class', filePath: '/proj/d.ts', isExported: true })]],
      ]),
      related: new Map([['/proj/t.ts', new Map([['/proj/d.ts', 1]])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: '实现 TargetClass', projectPath: '/proj' })

    expect(ctx.summary).toContain('意图: implement')
    expect(ctx.summary).toContain('核心符号: TargetClass')
    expect(ctx.summary).toContain('相关符号: DepClass')
  })

  it('可识别各 intent 关键字（中文）', async () => {
    const fake = makeFakeSymbolIndex({ byName: new Map() })
    const r = buildResolver(fake)

    // 单关键字匹配：每个 intent 都用专属关键字避免 implement 先匹配
    const cases: Array<[string, string]> = [
      ['fix-it login bug', 'fix'],
      ['refactor this code', 'refactor'],
      ['explain how this works', 'explain'],
      ['write unit test for it', 'test'],
    ]
    for (const [q, intent] of cases) {
      const ctx = await r.resolve({ userQuery: q, projectPath: '/proj' })
      expect(ctx.summary).toContain(`意图: ${intent}`)
    }
  })

  it('没有匹配实体时 summary 也包含 targetDescription', async () => {
    const fake = makeFakeSymbolIndex({ byName: new Map() })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'random text', projectPath: '/proj' })
    expect(ctx.summary).toContain('意图: unknown')
    expect(ctx.summary).toContain('目标: random text')
  })

  it('相关符号超过 5 个时只显示前 5 个', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['Main', [makeSymbol({ id: 'm', name: 'Main', kind: 'class', filePath: '/proj/m.ts' })]]]),
      byFile: new Map([
        ['/proj/m.ts', [makeSymbol({ id: 'm', name: 'Main', kind: 'class', filePath: '/proj/m.ts' })]],
        ['/proj/d.ts', Array.from({ length: 8 }, (_, i) =>
          makeSymbol({ id: `r${i}`, name: `R${i}`, kind: 'class', filePath: '/proj/d.ts', isExported: true }),
        )],
      ]),
      related: new Map([['/proj/m.ts', new Map([['/proj/d.ts', 1]])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Main', projectPath: '/proj' })
    // slice(0, 5) 保证摘要中最多 5 个
    const summaryRelatedSection = ctx.summary.split('相关符号: ')[1] ?? ''
    const names = summaryRelatedSection.split(/[,\n]/).filter((s) => s.trim().startsWith('R'))
    expect(names.length).toBeLessThanOrEqual(5)
  })
})

describe('SmartContextResolver — 文件读取与截断', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartctx-'))
  })

  it('读取失败时返回空内容（catch 分支）', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['Target', [makeSymbol({ id: 't', name: 'Target', kind: 'class', filePath: '/proj/t.ts' })]]]),
      byFile: new Map([['/proj/t.ts', [makeSymbol({ id: 't', name: 'Target', kind: 'class', filePath: '/proj/t.ts' })]]]),
      related: new Map([['/proj/t.ts', new Map([['/proj/missing.ts', 1]])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Target', projectPath: '/proj' })
    const missing = ctx.relatedFiles.find((f) => f.filePath === '/proj/missing.ts')
    expect(missing).toBeDefined()
    expect(missing!.content).toBe('')
  })

  it('大文件智能截断：保留导出符号周围上下文', async () => {
    const filePath = path.join(tmpDir, 'big.ts')
    const header = '// padding line\n'.repeat(700) // ~9000 chars
    const body = [
      'export function exportedFn() { return 1 }',
      'function internalFn() { return 2 }',
    ].join('\n')
    fs.writeFileSync(filePath, header + body)

    const fake = makeFakeSymbolIndex({
      byName: new Map([['Entry', [makeSymbol({ id: 'e', name: 'Entry', kind: 'class', filePath: '/proj/entry.ts' })]]]),
      byFile: new Map([
        ['/proj/entry.ts', [makeSymbol({ id: 'e', name: 'Entry', kind: 'class', filePath: '/proj/entry.ts' })]],
        [filePath, [
          makeSymbol({ id: 'exp', name: 'exportedFn', kind: 'function', filePath, line: 703, endLine: 703, isExported: true }),
        ]],
      ]),
      related: new Map([['/proj/entry.ts', new Map([[filePath, 1]])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Entry', projectPath: '/proj' })
    const related = ctx.relatedFiles.find((f) => f.filePath === filePath)
    expect(related).toBeDefined()
    expect(related!.content).toContain('exportedFn')
  })

  it('大文件无导出符号时返回文件头部截断', async () => {
    const filePath = path.join(tmpDir, 'big-noexp.ts')
    const big = '// padding\n'.repeat(800)
    fs.writeFileSync(filePath, big)

    const fake = makeFakeSymbolIndex({
      byName: new Map([['Entry', [makeSymbol({ id: 'e', name: 'Entry', kind: 'class', filePath: '/proj/entry.ts' })]]]),
      byFile: new Map([
        ['/proj/entry.ts', [makeSymbol({ id: 'e', name: 'Entry', kind: 'class', filePath: '/proj/entry.ts' })]],
        // /proj/big-noexp.ts 不在 byFile 中：getSymbolsByFile 返回 []
      ]),
      related: new Map([['/proj/entry.ts', new Map([[filePath, 1]])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({ userQuery: 'Entry', projectPath: '/proj' })
    const related = ctx.relatedFiles.find((f) => f.filePath === filePath)
    expect(related).toBeDefined()
    // 没有导出符号时返回文件头部前 5000 字符
    expect(related!.content.length).toBeLessThanOrEqual(5000)
  })
})

describe('SmartContextResolver — 性能', () => {
  it('1000 符号项目解析 < 200ms', async () => {
    const symbols: SymbolInfo[] = []
    const byName = new Map<string, SymbolInfo[]>()
    const byFile = new Map<string, SymbolInfo[]>()
    for (let i = 0; i < 1000; i++) {
      const fp = `/proj/file-${i}.ts`
      const s = makeSymbol({
        id: `sym-${i}`,
        name: i === 0 ? 'Target' : `Fn${i}`,
        kind: i === 0 ? 'class' : 'function',
        filePath: fp,
        line: 1,
        isExported: true,
      })
      symbols.push(s)
      byName.set(s.name, [s])
      byFile.set(fp, [s])
    }

    const fake = makeFakeSymbolIndex({ symbols, byName, byFile })
    const r = buildResolver(fake)

    const t0 = Date.now()
    const ctx = await r.resolve({ userQuery: 'Target', projectPath: '/proj' })
    const elapsed = Date.now() - t0

    expect(ctx.primarySymbols.find((s) => s.symbol.id === 'sym-0')).toBeDefined()
    expect(elapsed).toBeLessThan(200)
  })
})

describe('SmartContextResolver — 缓存容量', () => {
  it('超 50 条缓存时仍然能解析（LRU 淘汰后仍正常）', async () => {
    const fake = makeFakeSymbolIndex({ byName: new Map() })
    const r = buildResolver(fake)

    for (let i = 0; i < 55; i++) {
      await r.resolve({ userQuery: `query-${i}`, projectPath: '/proj' })
    }
    // 超出 50 条缓存后仍能正常解析
    const ctx = await r.resolve({ userQuery: 'query-100', projectPath: '/proj' })
    expect(ctx).toBeDefined()
  })
})

describe('SmartContextResolver — 自定义配置', () => {
  it('maxFiles 限制相关文件数', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['X', [makeSymbol({ id: 'x', name: 'X', kind: 'class', filePath: '/proj/x.ts' })]]]),
      byFile: new Map([
        ['/proj/x.ts', [makeSymbol({ id: 'x', name: 'X', kind: 'class', filePath: '/proj/x.ts' })]],
        ['/proj/d1.ts', [makeSymbol({ id: 'd1', name: 'D1', kind: 'class', filePath: '/proj/d1.ts', isExported: true })]],
        ['/proj/d2.ts', [makeSymbol({ id: 'd2', name: 'D2', kind: 'class', filePath: '/proj/d2.ts', isExported: true })]],
        ['/proj/d3.ts', [makeSymbol({ id: 'd3', name: 'D3', kind: 'class', filePath: '/proj/d3.ts', isExported: true })]],
      ]),
      related: new Map([['/proj/x.ts', new Map([
        ['/proj/d1.ts', 1], ['/proj/d2.ts', 1], ['/proj/d3.ts', 1],
      ])]]),
    })
    const r = buildResolver(fake)

    const ctx = await r.resolve({
      userQuery: 'X',
      projectPath: '/proj',
      maxFiles: 2,
    })
    expect(ctx.relatedFiles.length).toBe(2)
  })

  it('symbolLimit 限制相关符号数', async () => {
    const fake = makeFakeSymbolIndex({
      byName: new Map([['X', [makeSymbol({ id: 'x', name: 'X', kind: 'class', filePath: '/proj/x.ts' })]]]),
      byFile: new Map([
        ['/proj/x.ts', [makeSymbol({ id: 'x', name: 'X', kind: 'class', filePath: '/proj/x.ts' })]],
        ['/proj/d.ts', [
          makeSymbol({ id: 'd1', name: 'D1', kind: 'class', filePath: '/proj/d.ts', isExported: true }),
          makeSymbol({ id: 'd2', name: 'D2', kind: 'class', filePath: '/proj/d.ts', isExported: true }),
          makeSymbol({ id: 'd3', name: 'D3', kind: 'class', filePath: '/proj/d.ts', isExported: true }),
        ]],
      ]),
      related: new Map([['/proj/x.ts', new Map([['/proj/d.ts', 1]])]]),
    })
    const r = buildResolver(fake)

    // maxSymbols=1, primary=1 → symbolLimit=0 → 不展开相关符号
    const ctx = await r.resolve({
      userQuery: 'X',
      projectPath: '/proj',
      maxSymbols: 1,
    })
    expect(ctx.relatedSymbols.length).toBe(0)
  })
})