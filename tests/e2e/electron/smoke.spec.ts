import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'node:path'

test('Electron app launches and shows main window', async () => {
  const projectRoot = path.resolve(__dirname, '../../..')
  const electronApp = await electron.launch({
    args: [path.join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test' },
  })
  const window = await electronApp.firstWindow()
  await expect(window).toHaveTitle(/BizGraph/)
  await electronApp.close()
})
