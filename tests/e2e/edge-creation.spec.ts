import { test, expect } from '@playwright/test'
import { waitForCanvas } from './helpers/graph-helpers'
import { setupMockIpc, MOCK_NODE_MODULE_ID, MOCK_NODE_PROCESS_ID } from './helpers/mock-ipc'

test.describe('Edge Creation', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIpc(page)
    await page.goto('http://localhost:5173')
    await page.click('text=E2E Test Graph')
    await waitForCanvas(page)
  })

  test('should connect two nodes and show edge type menu', async ({ page }) => {
    // Count only business nodes (excluding the auto-created project root)
    const nodes = page.locator('[data-id].react-flow__node').filter({ has: page.locator('[role="button"]') })
    await expect(nodes).toHaveCount(2, { timeout: 5_000 })

    // Right-click source node and select connect
    const sourceNode = page.locator(`[data-id="${MOCK_NODE_MODULE_ID}"]`)
    await sourceNode.click({ button: 'right' })
    await page.click('[data-testid="node-menu-connect"]')

    // Click target node to trigger connection
    const targetNode = page.locator(`[data-id="${MOCK_NODE_PROCESS_ID}"]`)
    await targetNode.click()

    // Verify edge type menu appears
    await expect(page.locator('[data-testid="edge-type-menu"]')).toBeVisible({ timeout: 5_000 })
  })

  test('should create an edge after selecting type', async ({ page }) => {
    // Count only business nodes (excluding the auto-created project root)
    const nodes = page.locator('[data-id].react-flow__node').filter({ has: page.locator('[role="button"]') })
    await expect(nodes).toHaveCount(2, { timeout: 5_000 })

    // Connect via right-click
    const sourceNode = page.locator(`[data-id="${MOCK_NODE_MODULE_ID}"]`)
    await sourceNode.click({ button: 'right' })
    await page.click('[data-testid="node-menu-connect"]')

    const targetNode = page.locator(`[data-id="${MOCK_NODE_PROCESS_ID}"]`)
    await targetNode.click()

    // Select default edge type
    await page.click('[data-testid="edge-type-default"]')

    // Verify edge appears
    const edges = page.locator('.react-flow__edge')
    await expect(edges).toHaveCount(1, { timeout: 5_000 })
  })
})
