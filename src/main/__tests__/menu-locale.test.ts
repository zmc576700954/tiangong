import { describe, it, expect } from 'vitest'
import { buildMenuTemplate } from '../menu'
import { setLocale } from '@shared/i18n'

function labels(locale: 'zh-CN' | 'en-US'): string[] {
  setLocale(locale)
  const template = buildMenuTemplate({ createWindow: () => {}, isMac: true })
  return template
    .flatMap((item) => [item.label, ...((item.submenu as Electron.MenuItemConstructorOptions[]) ?? []).map((s) => s.label)])
    .filter((l): l is string => typeof l === 'string')
}

describe('native menu locale', () => {
  it('builds the menu in Chinese by default', () => {
    const all = labels('zh-CN')
    expect(all).toContain('文件')
    expect(all).not.toContain('File')
  })

  it('builds the menu in English when the locale is en-US', () => {
    const all = labels('en-US')
    expect(all).toContain('File')
    expect(all).not.toContain('文件')
    setLocale('zh-CN')
  })

  it('translates the menu item labels, not the accelerator keys', () => {
    setLocale('zh-CN')
    const template = buildMenuTemplate({ createWindow: () => {}, isMac: true })
    const openProject = template
      .flatMap((item) => (item.submenu as Electron.MenuItemConstructorOptions[]) ?? [])
      .find((s) => s.accelerator === 'CmdOrCtrl+O')
    expect(openProject?.label).toBe('打开项目…')
  })
})
