/**
 * node:update 的入参校验
 *
 * 覆盖 Task 7 的核心约束：`parentId` 不能经 node:update 改 —— 父子关系的事实
 * 来源是 `nodes.parent_id`，变更入口唯一（`graph:reparent` → HierarchyService）。
 * 绕过它就绕过了防环 / 跨图 / 父子类型校验，还会留下与 parent_id 不一致的
 * `hierarchical` 边。
 *
 * `collapsed` / `sortIndex` 必须仍能经 node:update 落库（Task 12 的折叠持久化
 * 走这条路），所以这里有一条护栏用例盯住「不要把规则写得太宽」。
 */

import { describe, it, expect } from 'vitest'
import { validateNodeUpdate } from '../graph'
import { ErrorCode } from '../../errors'

describe('validateNodeUpdate', () => {
  it('rejects a payload that changes parentId', () => {
    expect(() => validateNodeUpdate('n1', { parentId: 'n2' })).toThrow(/parentId/)
  })

  it('rejects parentId with the IPC_INVALID_ARGUMENT code and points at graph:reparent', () => {
    let caught: unknown
    try {
      validateNodeUpdate('n1', { parentId: 'n2' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect((caught as { code?: string }).code).toBe(ErrorCode.IPC_INVALID_ARGUMENT)
    expect((caught as { message?: string }).message).toMatch(/graph:reparent/)
  })

  it('rejects parentId even when the payload also carries other fields', () => {
    expect(() => validateNodeUpdate('n1', { title: 'x', parentId: 'n2' })).toThrow(/parentId/)
  })

  it('still accepts a payload that changes collapsed', () => {
    expect(() => validateNodeUpdate('n1', { collapsed: true })).not.toThrow()
  })

  it('still accepts a payload that changes sortIndex', () => {
    expect(() => validateNodeUpdate('n1', { sortIndex: 3 })).not.toThrow()
  })
})
