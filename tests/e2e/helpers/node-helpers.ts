import type { Page } from '@playwright/test'

/**
 * 右键点击节点，打开上下文菜单
 *
 * 使用 dispatchEvent 触发 contextmenu 事件，避免被 MiniMap 等覆盖层遮挡
 * 导致真实点击失败。
 */
export async function openNodeMenu(page: Page, nodeId: string): Promise<void> {
  const node = page.locator(`[data-id="${nodeId}"]`)
  await node.dispatchEvent('contextmenu')
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

/**
 * 获取画布上所有非 project 类型节点的 data-id 列表
 *
 * GraphCanvas 会自动为每个图创建一个 project 根节点，测试业务节点操作时
 * 需要排除该自动创建的根节点。业务节点内部包含 [role="button"] 元素，
 * 而 project 根节点没有该角色，借此区分。
 */
export async function getNonProjectNodeIds(page: Page): Promise<string[]> {
  const nodes = page.locator('[data-id].react-flow__node').filter({ has: page.locator('[role="button"]') })
  const count = await nodes.count()
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = await nodes.nth(i).getAttribute('data-id')
    if (id) ids.push(id)
  }
  return ids
}
