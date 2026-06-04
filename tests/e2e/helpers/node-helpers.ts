import type { Page } from '@playwright/test'

/**
 * 右键点击节点，打开上下文菜单
 */
export async function openNodeMenu(page: Page, nodeId: string): Promise<void> {
  const node = page.locator(`[data-id="${nodeId}"]`)
  await node.click({ button: 'right' })
}

/**
 * 通过节点右键菜单删除节点
 */
export async function deleteNodeViaMenu(page: Page, nodeId: string): Promise<void> {
  await openNodeMenu(page, nodeId)
  await page.click('[data-testid="node-menu-delete"]')
}

/**
 * 获取画布上所有节点的 data-id 列表
 */
export async function getNodeIds(page: Page): Promise<string[]> {
  const nodes = page.locator('[data-id].react-flow__node')
  const count = await nodes.count()
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = await nodes.nth(i).getAttribute('data-id')
    if (id) ids.push(id)
  }
  return ids
}
