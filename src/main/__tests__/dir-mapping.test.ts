import { describe, it, expect } from 'vitest'
import { DIR_NAME_MAP } from '../dir-mapping'

describe('DIR_NAME_MAP', () => {
  it('maps common business directory names', () => {
    expect(DIR_NAME_MAP.user).toBe('用户管理')
    expect(DIR_NAME_MAP.order).toBe('订单管理')
    expect(DIR_NAME_MAP.payment).toBe('支付管理')
  })

  it('maps technical directory names', () => {
    expect(DIR_NAME_MAP.components).toBe('组件库')
    expect(DIR_NAME_MAP.utils).toBe('工具方法')
    expect(DIR_NAME_MAP.api).toBe('API接口')
  })

  it('has many entries', () => {
    expect(Object.keys(DIR_NAME_MAP).length).toBeGreaterThan(100)
  })
})
