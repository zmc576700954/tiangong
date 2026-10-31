// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

/**
 * 设置面板在没有 electronAPI 时的降级渲染。
 *
 * 单独一个文件：SettingsPanel 在**模块加载时**抓取 window.electronAPI，
 * 「没有 bridge」这个场景必须有一份干净的模块注册表才测得到。
 *
 * 这是真实路径：`npm run dev` 起的是 vite（渲染层在 localhost:5173），
 * 开发者用普通浏览器打开这个地址时就没有 preload bridge。
 */

beforeEach(() => {
  // 明确没有 electronAPI
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = undefined
})

describe('SettingsPanel 没有 electronAPI 时', () => {
  it('不得停在永久 spinner 上，要降级渲染并说明原因', async () => {
    const { SettingsPanel } = await import('../SettingsPanel')
    render(<SettingsPanel />)

    // 加载状态必须有终态：不能永远是转圈
    await waitFor(() => {
      expect(screen.getByText(/设置面板需要在桌面应用里使用/)).toBeTruthy()
    })
    // 没有把转圈留在屏幕上
    expect(screen.queryByRole('status')).toBe(null)
    expect(document.querySelector('.animate-spin')).toBe(null)
  })

  it('不抛异常、不产生未处理的 Promise 拒绝', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { SettingsPanel } = await import('../SettingsPanel')
      render(<SettingsPanel />)
      await waitFor(() => {
        expect(screen.getByText(/设置面板需要在桌面应用里使用/)).toBeTruthy()
      })
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
