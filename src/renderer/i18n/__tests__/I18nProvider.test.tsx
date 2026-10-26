// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '../I18nProvider'
import { useI18n } from '../useI18n'

function Probe() {
  const { locale, t } = useI18n()
  return <div data-testid="probe">{locale}|{t('common.save')}</div>
}

describe('I18nProvider', () => {
  beforeEach(() => {
    // 每个用例重置 window.electronAPI
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      locale: 'zh-CN',
      onLocaleChanged: () => () => {},
    }
  })

  it('renders using the locale exposed by preload', () => {
    render(<I18nProvider><Probe /></I18nProvider>)
    expect(screen.getByTestId('probe').textContent).toBe('zh-CN|保存')
  })

  it('does not throw when a component uses useI18n without a Provider', () => {
    expect(() => render(<Probe />)).not.toThrow()
    // 无 Provider 时回落默认 locale
    expect(screen.getByTestId('probe').textContent).toContain('zh-CN')
  })

  it('applies a locale pushed from the main process', async () => {
    let push: ((locale: string) => void) | undefined
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      locale: 'zh-CN',
      onLocaleChanged: (cb: (locale: string) => void) => {
        push = cb
        return () => {}
      },
    }
    render(<I18nProvider><Probe /></I18nProvider>)
    push?.('en-US')
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId('probe').textContent).toBe('en-US|Save')
  })

  it('keeps the module-level t() in sync with the Provider locale', async () => {
    let push: ((locale: string) => void) | undefined
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      locale: 'zh-CN',
      onLocaleChanged: (cb: (locale: string) => void) => {
        push = cb
        return () => {}
      },
    }
    render(<I18nProvider><Probe /></I18nProvider>)
    push?.('en-US')
    await new Promise((r) => setTimeout(r, 0))
    const { t } = await import('@shared/i18n')
    expect(t('common.save')).toBe('Save')
  })
})
