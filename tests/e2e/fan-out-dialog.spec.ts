import { test, expect } from '@playwright/test'
import { waitForCanvas } from './helpers/graph-helpers'
import { getNodeIds } from './helpers/node-helpers'
import { setupMockIpc } from './helpers/mock-ipc'

test.describe('Fan-out Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIpc(page)
    await page.goto('http://localhost:5173')
    await page.click('text=E2E Test Graph')
    await waitForCanvas(page)
  })

  test('opens fan-out dialog from node context menu and pre-fills prompt', async ({ page }) => {
    const nodeIds = await getNodeIds(page)
    expect(nodeIds.length).toBeGreaterThan(0)

    const node = page.locator(`[data-id="${nodeIds[0]}"]`)
    await node.click()
    await node.click({ button: 'right' })
    await page.click('[data-testid="node-menu-fanout"]')

    await expect(page.locator('[data-testid="fanout-dialog"]')).toBeVisible({ timeout: 5_000 })

    const promptInput = page.locator('[data-testid="fanout-prompt-input"]')
    await expect(promptInput).toContainText(nodeIds[0], { timeout: 5_000 })
  })

  test('submits prompt and closes dialog', async ({ page }) => {
    const nodeIds = await getNodeIds(page)
    const node = page.locator(`[data-id="${nodeIds[0]}"]`)
    await node.click()
    await node.click({ button: 'right' })
    await page.click('[data-testid="node-menu-fanout"]')

    await expect(page.locator('[data-testid="fanout-dialog"]')).toBeVisible()

    await page.click('[data-testid="fanout-submit-btn"]')
    await expect(page.locator('[data-testid="fanout-dialog"]')).not.toBeVisible()
  })
})
