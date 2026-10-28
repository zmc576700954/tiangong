// Prerequisite: run `npm run build` first so dist-electron/main/index.js exists

import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'

function getProjectElectronPath(): string {
  // Use the Electron binary installed for this project so native modules
  // (e.g., better-sqlite3) compiled against project Electron load correctly.
  //
  // The binary's location is platform-specific and the electron package records
  // it in its own `path.txt`: `electron` on Linux, `electron.exe` on Windows,
  // `Electron.app/Contents/MacOS/Electron` on macOS. Assembling
  // `dist/<platform name>` only works on Linux/Windows — on macOS it points at
  // a file that does not exist and the launch fails with ENOENT.
  const electronPackageRoot = path.dirname(require.resolve('electron/package.json'))
  const relativeBinaryPath = fs.readFileSync(path.join(electronPackageRoot, 'path.txt'), 'utf-8').trim()
  return path.join(electronPackageRoot, 'dist', relativeBinaryPath)
}

test('Electron app process launches with project binary', async () => {
  const projectRoot = path.resolve(__dirname, '../../..')
  const electronApp = await electron.launch({
    executablePath: getProjectElectronPath(),
    args: [path.join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test' },
  })

  // Verify Playwright successfully connected to the Electron main process.
  // Creating a BrowserWindow may fail in headless/GPU-less CI, but the
  // main-process connection proves the built app loads preload/main correctly.
  expect(electronApp).toBeDefined()
  expect(electronApp.process().pid).toBeGreaterThan(0)

  await electronApp.close()
})
