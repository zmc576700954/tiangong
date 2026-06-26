import { test, expect } from '@playwright/test'
import { waitForCanvas, createNodeViaMenu } from './helpers/graph-helpers'
import { getNonProjectNodeIds, deleteNodeViaMenu } from './helpers/node-helpers'
import { setupMockIpc } from './helpers/mock-ipc'

test.describe('Node Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIpc(page, { nodes: [] })
    await page.goto('http://localhost:5173')
    await page.click('text=E2E Test Graph')
    await waitForCanvas(page)
  })

  test('should create a module node via canvas context menu', async ({ page }) => {
    // Right-click canvas to open menu
    await createNodeViaMenu(page, 'module', { x: 400, y: 300 })

    // Verify a new business node appears on canvas (excluding the auto-created project root)
    const nodes = page.locator('[data-id].react-flow__node').filter({ has: page.locator('[role="button"]') })
    await expect(nodes).toHaveCount(1, { timeout: 5_000 })
  })

  test('should delete a node via context menu', async ({ page }) => {
    // Create a node first
    await createNodeViaMenu(page, 'module', { x: 400, y: 300 })
    const nodes = page.locator('[data-id].react-flow__node').filter({ has: page.locator('[role="button"]') })
    await expect(nodes).toHaveCount(1, { timeout: 5_000 })

    // Get the non-project node ID and delete it
    const nodeIds = await getNonProjectNodeIds(page)
    expect(nodeIds.length).toBe(1)

    await deleteNodeViaMenu(page, nodeIds[0])

    // Verify business node is removed (project root remains)
    await expect(nodes).toHaveCount(0, { timeout: 5_000 })
  })
})
