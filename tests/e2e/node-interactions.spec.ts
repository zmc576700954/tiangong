import { test, expect } from '@playwright/test'
import { waitForCanvas, createNodeViaMenu } from './helpers/graph-helpers'
import { getNodeIds, deleteNodeViaMenu } from './helpers/node-helpers'

test.describe('Node Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173')
    await waitForCanvas(page)
  })

  test('should create a module node via canvas context menu', async ({ page }) => {
    // Right-click canvas to open menu
    await createNodeViaMenu(page, 'module', { x: 400, y: 300 })

    // Verify a new node appears on canvas
    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(1, { timeout: 5_000 })
  })

  test('should delete a node via context menu', async ({ page }) => {
    // Create a node first
    await createNodeViaMenu(page, 'module', { x: 400, y: 300 })
    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(1, { timeout: 5_000 })

    // Get the node ID and delete it
    const nodeIds = await getNodeIds(page)
    expect(nodeIds.length).toBe(1)

    await deleteNodeViaMenu(page, nodeIds[0])

    // Verify node is removed
    await expect(nodes).toHaveCount(0, { timeout: 5_000 })
  })
})
