// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SubagentTypesTab } from '../SubagentTypesTab'

/**
 * 子代理 scope 策略的默认值测试。
 *
 * 背景：新建自定义子代理类型时，scope 策略（inherit / subset / fresh）应该有
 * 一个显然正确的默认值 —— `subset`（只带子集范围），而不是让用户每次都表态。
 *
 * 现状：`EMPTY_TYPE.scopeStrategy` 就是 `'subset'`，新建时
 * `setEditing({ ...EMPTY_TYPE })` 把它带进表单 state，`<select>` 绑定
 * `editing.scopeStrategy` → 直接显示 subset。
 *
 * 本测试把这个现状**钉住** —— 需求早已满足，这里防止它被改回去。
 */

vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'zh-CN' }),
}))

describe('SubagentTypesTab — scope 策略默认值', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('新建自定义类型时，scope 策略默认选中 subset', () => {
    render(<SubagentTypesTab customTypes={[]} onSave={vi.fn()} />)

    // 打开新建表单
    fireEvent.click(screen.getByText('settings.subagents.new'))

    const select = screen.getByTestId('subagent-scope-strategy') as HTMLSelectElement
    expect(select.value).toBe('subset')
  })

  it('默认的 subset 会被真正保存进新建的类型里', () => {
    const onSave = vi.fn()
    render(<SubagentTypesTab customTypes={[]} onSave={onSave} />)

    fireEvent.click(screen.getByText('settings.subagents.new'))

    const nameInput = screen.getByTestId('subagent-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'reviewer' } })
    fireEvent.click(screen.getByText('settings.subagents.save'))

    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0] as { name: string; scopeStrategy: string }[]
    expect(saved[0].scopeStrategy).toBe('subset')
  })
})
