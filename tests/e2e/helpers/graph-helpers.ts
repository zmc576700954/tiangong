import type { Page } from '@playwright/test'

/**
 * 等待画布加载完成（ReactFlow 渲染就绪）
 */
export async function waitForCanvas(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="graph-canvas"]', { timeout: 10_000 })
}

/**
 * 在画布空白处右键，打开节点创建菜单
 */
export async function openCanvasMenu(page: Page, position: { x: number; y: number }): Promise<void> {
  const canvas = page.locator('[data-testid="graph-canvas"]')
  await canvas.click({ button: 'right', position })
}

/**
 * 通过右键菜单创建指定类型的节点
 */
export async function createNodeViaMenu(
  page: Page,
  nodeType: string,
  position: { x: number; y: number },
): Promise<void> {
  await openCanvasMenu(page, position)
  await page.click(`[data-testid="canvas-menu-create-${nodeType}"]`)
}
