import { test, expect } from '@playwright/test'
import { setupMockIpc } from './helpers/mock-ipc'

test.describe('BizGraph App', () => {
  test('should display welcome message', async ({ page }) => {
    await setupMockIpc(page, { graphs: [] })
    await page.goto('http://localhost:5173')
    await expect(page.locator('text=欢迎使用 BizGraph')).toBeVisible()
  })

  test('should create a new graph', async ({ page }) => {
    await setupMockIpc(page, { graphs: [] })
    await page.goto('http://localhost:5173')

    // 点击新建图按钮
    await page.click('[data-testid="new-graph-btn"]')

    // 输入图名称
    await page.fill('[data-testid="graph-name-input"]', '测试图')

    // 点击创建
    await page.click('[data-testid="create-graph-btn"]')

    // 验证图已创建
    await expect(page.locator('text=测试图')).toBeVisible()
  })
})
