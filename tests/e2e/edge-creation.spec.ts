import { test, expect } from '@playwright/test'
import { waitForCanvas, createNodeViaMenu } from './helpers/graph-helpers'
import { getNodeIds } from './helpers/node-helpers'

test.describe('Edge Creation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173')
    await waitForCanvas(page)
  })

  test('should connect two nodes and show edge type menu', async ({ page }) => {
    // Create two nodes
    await createNodeViaMenu(page, 'module', { x: 200, y: 300 })
    await createNodeViaMenu(page, 'process', { x: 500, y: 300 })

    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(2, { timeout: 5_000 })

    // Right-click first node and select connect
    const nodeIds = await getNodeIds(page)
    const sourceNode = page.locator(`[data-id="${nodeIds[0]}"]`)
    await sourceNode.click({ button: 'right' })
    await page.click('[data-testid="node-menu-connect"]')

    // Click second node to trigger connection
    const targetNode = page.locator(`[data-id="${nodeIds[1]}"]`)
    await targetNode.click()

    // Verify edge type menu appears
    await expect(page.locator('[data-testid="edge-type-menu"]')).toBeVisible({ timeout: 5_000 })
  })

  test('should create an edge after selecting type', async ({ page }) => {
    // Create two nodes
    await createNodeViaMenu(page, 'module', { x: 200, y: 300 })
    await createNodeViaMenu(page, 'process', { x: 500, y: 300 })

    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(2, { timeout: 5_000 })

    // Connect via right-click
    const nodeIds = await getNodeIds(page)
    const sourceNode = page.locator(`[data-id="${nodeIds[0]}"]`)
    await sourceNode.click({ button: 'right' })
    await page.click('[data-testid="node-menu-connect"]')

    const targetNode = page.locator(`[data-id="${nodeIds[1]}"]`)
    await targetNode.click()

    // Select default edge type
    await page.click('[data-testid="edge-type-default"]')

    // Verify edge appears
    const edges = page.locator('.react-flow__edge')
    await expect(edges).toHaveCount(1, { timeout: 5_000 })
  })
})
