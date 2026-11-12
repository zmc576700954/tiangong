/**
 * OpenCode 模型档位：设置面板到 IPC 的端到端。
 *
 * 为什么值得一条 e2e：这条路径上有两处**只有走到真实界面才看得见**的坑。
 *
 * 1. `DefaultModels` 是**整体替换**（`settings:write` 浅合并）。面板上曾经只有
 *    claudeCode / codex / mcp 三档 —— opencode 档位于是成了「只能靠配置文件写、
 *    进设置面板点一次保存就被抹掉」。单元测试盯的是组件发出的 patch，
 *    e2e 盯的是穿过 preload → mock 之后真正落下来的那次写入。
 *
 * 2. 模型 id 必须写成 `provider/model`（裸写会被 CLI 判成 `…/.` 并抛
 *    `ProviderModelNotFoundError`）。这条规则写进了 placeholder 与 hint ——
 *    e2e 断言它确实到了用户眼前，而不是只活在注释里。
 */

import { test, expect, type Page } from '@playwright/test'
import { setupMockIpc } from './helpers/mock-ipc'

/** mock 里的可变状态（`mock-ipc.ts` 把它挂在 window 上供断言用）。 */
interface SettingsWriteLog {
  settingsWrites: Array<{ defaultModels?: Record<string, string> }>
}

async function readSettingsWrites(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { __bizgraphMockState?: SettingsWriteLog }).__bizgraphMockState
    return state?.settingsWrites ?? []
  })
}

async function openDefaultsTab(page: Page) {
  await page.click('[data-testid="open-settings"]')
  await page.getByRole('tab', { name: '默认值' }).click()
  await expect(page.locator('[data-testid="defaults-model-opencode"]')).toBeVisible()
}

test.describe('OpenCode 模型档位', () => {
  test('默认值页签能配 opencode 模型，保存时四个档位一起发', async ({ page }) => {
    await setupMockIpc(page, { graphs: [] })
    await page.goto('http://127.0.0.1:5173')
    await openDefaultsTab(page)

    const input = page.locator('[data-testid="defaults-model-opencode"]')
    // 占位符要把格式教给用户：不带 provider/ 前缀的模型名在 CLI 里根本不存在
    await expect(input).toHaveAttribute('placeholder', /opencode\//)
    await input.fill('opencode/deepseek-v4.1-flash-free')
    await page.click('[data-testid="defaults-models-save"]')

    await expect
      .poll(async () => (await readSettingsWrites(page)).length)
      .toBeGreaterThan(0)
    const writes = await readSettingsWrites(page)
    const written = writes.at(-1)?.defaultModels ?? {}

    // 键少了就是把那一档清空：这是本条用例真正要守住的东西
    expect(Object.keys(written).sort()).toEqual(['claudeCode', 'codex', 'mcp', 'opencode'])
    expect(written.opencode).toBe('opencode/deepseek-v4.1-flash-free')
  })

  test('保存后关掉面板再打开，opencode 的值从设置里读回来', async ({ page }) => {
    await setupMockIpc(page, { graphs: [] })
    await page.goto('http://127.0.0.1:5173')
    await openDefaultsTab(page)

    await page.fill('[data-testid="defaults-model-opencode"]', 'opencode/glm-5.3-flash-free')
    await page.click('[data-testid="defaults-models-save"]')
    await expect.poll(async () => (await readSettingsWrites(page)).length).toBeGreaterThan(0)

    // 关掉浮层再打开：面板会重新走一遍 settings:read，能验回填是否真的落库
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="defaults-model-opencode"]')).toBeHidden()
    await openDefaultsTab(page)

    await expect(page.locator('[data-testid="defaults-model-opencode"]')).toHaveValue(
      'opencode/glm-5.3-flash-free',
    )
  })
})
