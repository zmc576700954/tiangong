import { test, expect } from '@playwright/test'
import { waitForCanvas } from './helpers/graph-helpers'
import { getNodeIds } from './helpers/node-helpers'
import { setupMockIpc } from './helpers/mock-ipc'

test.describe('Subagent Dispatch from Canvas', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIpc(page)
    await page.goto('http://localhost:5173')
    await page.click('text=E2E Test Graph')
    await waitForCanvas(page)
  })

  test('dispatches fan-out for multi-selected nodes', async ({ page }) => {
    const nodeIds = await getNodeIds(page)
    expect(nodeIds.length).toBeGreaterThanOrEqual(2)

    const first = page.locator(`[data-id="${nodeIds[0]}"]`)
    const second = page.locator(`[data-id="${nodeIds[1]}"]`)

    await page.keyboard.down('Control')
    await first.click()
    await second.click()
    await page.keyboard.up('Control')

    await first.click({ button: 'right' })
    await page.click('[data-testid="node-menu-fanout"]')

    await expect(page.locator('[data-testid="fanout-dialog"]')).toBeVisible()
    const promptInput = page.locator('[data-testid="fanout-prompt-input"]')
    await expect(promptInput).toContainText(nodeIds[0])
    await expect(promptInput).toContainText(nodeIds[1])

    await page.click('[data-testid="fanout-submit-btn"]')
    await expect(page.locator('[data-testid="fanout-dialog"]')).not.toBeVisible()
  })
})
