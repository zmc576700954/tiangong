import { test, expect } from '@playwright/test'
import { waitForCanvas } from './helpers/graph-helpers'
import { setupMockIpc, MOCK_INVOCATION_ID, setMockInvocationStatus, emitSubagentProgress } from './helpers/mock-ipc'

test.describe('Subagent Invocations Panel', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIpc(page, { initialStatus: 'queued' })
    await page.goto('http://localhost:5173')
    await page.click('text=E2E Test Graph')
    await waitForCanvas(page)
    await page.click('[data-testid="right-panel-agent-tab"]')
  })

  test('opens panel and shows invocation card', async ({ page }) => {
    await page.click('[data-testid="chat-header-subagents-btn"]')

    await expect(page.locator('[data-testid="subagent-panel"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator(`[data-testid="subagent-card-${MOCK_INVOCATION_ID}"]`)).toBeVisible()
    await expect(page.locator(`[data-testid="subagent-card-${MOCK_INVOCATION_ID}"] [data-testid="subagent-card-status"]`)).toContainText('queued')
  })

  test('updates card status on progress event', async ({ page }) => {
    await page.click('[data-testid="chat-header-subagents-btn"]')
    await expect(page.locator(`[data-testid="subagent-card-${MOCK_INVOCATION_ID}"] [data-testid="subagent-card-status"]`)).toContainText('queued')

    await setMockInvocationStatus(page, 'running')
    await emitSubagentProgress(page, 'running')
    await expect(page.locator(`[data-testid="subagent-card-${MOCK_INVOCATION_ID}"] [data-testid="subagent-card-status"]`)).toContainText('running')
  })
})
