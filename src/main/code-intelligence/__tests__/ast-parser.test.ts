/**
 * AstParser 单元测试
 */

import { describe, it, expect } from 'vitest'
import { AstParser } from '../ast-parser'

describe('AstParser', () => {
  const parser = new AstParser()

  it('should parse class definitions', () => {
    const code = `
      /** 用户服务 */
      export class UserService {
        constructor(private repo: UserRepository) {}
        async createUser(data: CreateUserDto): Promise<User> {
          return this.repo.create(data)
        }
      }
    `
    const result = parser.parse('/project/src/user.service.ts', code)

    expect(result.symbols).toHaveLength(3) // class + constructor + method
    const cls = result.symbols.find((s) => s.kind === 'class')
    expect(cls?.name).toBe('UserService')
    expect(cls?.isExported).toBe(true)
    expect(cls?.jsDoc).toContain('用户服务')

    const method = result.symbols.find((s) => s.kind === 'method' && s.name === 'createUser')
    expect(method?.name).toBe('createUser')
    expect(method?.signature).toContain('createUser(data: CreateUserDto): Promise<User>')
    expect(method?.parentId).toBe(cls?.id)
  })

  it('should parse interface definitions', () => {
    const code = `
      export interface User {
        id: string
        name: string
      }
    `
    const result = parser.parse('/project/src/types.ts', code)
    const iface = result.symbols.find((s) => s.kind === 'interface')
    expect(iface?.name).toBe('User')
    expect(iface?.isExported).toBe(true)
  })

  it('should parse import declarations', () => {
    const code = `
      import { UserService } from './user.service'
      import type { User } from '../types'
      import * as path from 'path'
      import fs from 'fs'
    `
    const result = parser.parse('/project/src/controller.ts', code)

    expect(result.imports).toHaveLength(4)
    const namedImport = result.imports.find((i) => i.importedNames.includes('UserService'))
    expect(namedImport?.toFile).toContain('user.service')
    expect(namedImport?.isDefaultImport).toBe(false)
  })

  it('should parse type aliases', () => {
    const code = `export type UserId = string`
    const result = parser.parse('/project/src/types.ts', code)
    const alias = result.symbols.find((s) => s.kind === 'type_alias')
    expect(alias?.name).toBe('UserId')
  })

  it('should parse enums', () => {
    const code = `
      export enum Status {
        Active = 'active',
        Inactive = 'inactive',
      }
    `
    const result = parser.parse('/project/src/enums.ts', code)
    const enumSymbol = result.symbols.find((s) => s.kind === 'enum')
    expect(enumSymbol?.name).toBe('Status')
  })

  it('should parse function declarations', () => {
    const code = `
      export function calculateTotal(items: number[]): number {
        return items.reduce((a, b) => a + b, 0)
      }
    `
    const result = parser.parse('/project/src/utils.ts', code)
    const fn = result.symbols.find((s) => s.kind === 'function')
    expect(fn?.name).toBe('calculateTotal')
    expect(fn?.signature).toContain('calculateTotal(items: number[]): number')
  })
})
