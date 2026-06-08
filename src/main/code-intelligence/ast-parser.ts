/**
 * TypeScript AST 解析器
 * 解析单个 .ts/.tsx/.js/.jsx 文件，提取符号定义和 import 关系
 */

import * as ts from 'typescript'
import type { SymbolInfo, ImportEdge } from '@shared/types'
import { generateId } from '../shared/env'

export interface ParseResult {
  symbols: SymbolInfo[]
  imports: ImportEdge[]
  exports: string[] // 导出的符号名列表
}

export class AstParser {
  private compilerOptions: ts.CompilerOptions

  constructor(compilerOptions?: ts.CompilerOptions) {
    this.compilerOptions = compilerOptions ?? {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
    }
  }

  /**
   * 解析文件内容，返回符号和 import 关系
   */
  parse(filePath: string, sourceCode: string): ParseResult {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      this.compilerOptions.target ?? ts.ScriptTarget.ES2020,
      true,
      this.getScriptKind(filePath)
    )

    const symbols: SymbolInfo[] = []
    const imports: ImportEdge[] = []
    const exports: string[] = []

    const visit = (node: ts.Node, parentId?: string) => {
      const symbol = this.extractSymbol(node, filePath, sourceCode, parentId)
      if (symbol) {
        symbols.push(symbol)
        if (symbol.isExported) exports.push(symbol.name)
      }

      if (ts.isImportDeclaration(node)) {
        const importEdge = this.extractImport(node, filePath)
        if (importEdge) imports.push(importEdge)
      }

      // 如果当前节点创建了新的父作用域（如 class），将其 id 传给子节点
      const childParentId = symbol?.id ?? parentId
      ts.forEachChild(node, (child) => visit(child, childParentId))
    }

    visit(sourceFile)

    return { symbols, imports, exports }
  }

  private extractSymbol(node: ts.Node, filePath: string, _sourceCode: string, parentId?: string): SymbolInfo | null {
    let kind: SymbolInfo['kind'] | null = null
    let name: string | null = null
    let isExported = false

    if (ts.isClassDeclaration(node)) {
      kind = 'class'
      name = node.name?.text ?? null
      isExported = this.isExported(node)
    } else if (ts.isInterfaceDeclaration(node)) {
      kind = 'interface'
      name = node.name.text
      isExported = this.isExported(node)
    } else if (ts.isTypeAliasDeclaration(node)) {
      kind = 'type_alias'
      name = node.name.text
      isExported = this.isExported(node)
    } else if (ts.isEnumDeclaration(node)) {
      kind = 'enum'
      name = node.name.text
      isExported = this.isExported(node)
    } else if (ts.isFunctionDeclaration(node)) {
      kind = 'function'
      name = node.name?.text ?? null
      isExported = this.isExported(node)
    } else if (ts.isConstructorDeclaration(node)) {
      kind = 'method'
      name = 'constructor'
      isExported = false
    } else if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
      if (ts.isMethodDeclaration(node)) kind = 'method'
      else kind = 'property'
      name = this.getPropertyName(node.name)
      isExported = false // class 成员通过 class 的 export 状态间接决定
    } else if (ts.isVariableStatement(node)) {
      // 处理 const/let/var 声明
      const decl = node.declarationList.declarations[0]
      if (ts.isIdentifier(decl.name)) {
        kind = 'variable'
        name = decl.name.text
        isExported = this.isExported(node)
      }
    } else if (ts.isModuleDeclaration(node)) {
      kind = 'namespace'
      name = ts.isIdentifier(node.name) ? node.name.text : (node.name as ts.StringLiteral).text
      isExported = this.isExported(node)
    }

    if (!kind || !name) return null

    const { line: startLine, character: startColumn } = ts.getLineAndCharacterOfPosition(
      node.getSourceFile(),
      node.getStart()
    )
    const { line: endLine, character: endColumn } = ts.getLineAndCharacterOfPosition(
      node.getSourceFile(),
      node.getEnd()
    )

    const signature = this.extractSignature(node)
    const jsDoc = this.extractJsDoc(node)

    return {
      id: generateId('symbol'),
      name,
      kind,
      filePath,
      line: startLine + 1,
      column: startColumn,
      endLine: endLine + 1,
      endColumn,
      signature,
      jsDoc,
      parentId,
      isExported,
      sourceCode: node.getText(),
    }
  }

  private extractImport(node: ts.ImportDeclaration, filePath: string): ImportEdge | null {
    const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text
    const importedNames: string[] = []
    let isDefaultImport = false

    if (node.importClause) {
      if (node.importClause.name) {
        importedNames.push(node.importClause.name.text)
        isDefaultImport = true
      }
      if (node.importClause.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            importedNames.push(element.name.text)
          }
        } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
          importedNames.push(`* as ${node.importClause.namedBindings.name.text}`)
        }
      }
    }

    // 将相对路径解析为绝对路径（简化版，实际需要基于项目根目录解析）
    const resolvedPath = moduleSpecifier.startsWith('.')
      ? new URL(moduleSpecifier, `file://${filePath}`).pathname
      : moduleSpecifier // 外部模块保留原样

    const { line } = ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart())

    return {
      fromFile: filePath,
      toFile: resolvedPath,
      importedNames,
      isDefaultImport,
      line: line + 1,
    }
  }

  private isExported(node: ts.Node): boolean {
    return (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
    )
  }

  private getPropertyName(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name)) return name.text
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
    if (ts.isComputedPropertyName(name)) {
      if (ts.isIdentifier(name.expression)) return name.expression.text
      return null
    }
    return null
  }

  private extractSignature(node: ts.Node): string | undefined {
    // 提取函数/方法签名文本
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const params = node.parameters.map((p) => p.getText()).join(', ')
      const returnType = node.type ? `: ${node.type.getText()}` : ''
      return `${node.name?.getText() ?? 'anonymous'}(${params})${returnType}`
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const heritage = node.heritageClauses?.map((h) => h.getText()).join(' ')
      return `class ${node.name.text} ${heritage ?? ''}`.trim()
    }
    if (ts.isInterfaceDeclaration(node)) {
      const heritage = node.heritageClauses?.map((h) => h.getText()).join(' ')
      return `interface ${node.name.text} ${heritage ?? ''}`.trim()
    }
    return undefined
  }

  private extractJsDoc(node: ts.Node): string | undefined {
    const jsDoc = (node as ts.JSDocContainer & ts.Node).jsDoc
    if (jsDoc && jsDoc.length > 0) {
      return jsDoc.map((doc) => doc.getText()).join('\n')
    }
    return undefined
  }

  private getScriptKind(filePath: string): ts.ScriptKind {
    if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
    if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX
    if (filePath.endsWith('.ts')) return ts.ScriptKind.TS
    if (filePath.endsWith('.js')) return ts.ScriptKind.JS
    return ts.ScriptKind.TS
  }
}
