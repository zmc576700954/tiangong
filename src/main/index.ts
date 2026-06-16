import { app, BrowserWindow, Menu, dialog } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpcHandlers, agentManager } from './ipc-handlers'
import { initDatabase, closeDatabase } from './database'
import { stopCleanup } from './ipc/utils'
import { createLogger } from './shared/logger'

const logger = createLogger('Main')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 窗口管理器
class WindowManager {
  private windows = new Map<number, BrowserWindow>()
  private windowId = 0

  createWindow(): BrowserWindow {
    this.windowId++
    const id = this.windowId

    const win = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      title: 'BizGraph',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    this.windows.set(id, win)

    // 加载应用
    if (process.env.VITE_DEV_SERVER_URL) {
      win.loadURL(process.env.VITE_DEV_SERVER_URL)
      win.webContents.openDevTools()

      // 开发模式下 Vite server 可能还没就绪，添加重试逻辑（最多 10 次）
      let loadRetries = 0
      const MAX_LOAD_RETRIES = 10
      const handleDidFailLoad = (_event: Event, _errorCode: number, _errorDescription: string, validatedURL: string) => {
        loadRetries++
        if (loadRetries > MAX_LOAD_RETRIES) {
          logger.error(`Failed to load ${validatedURL} after ${MAX_LOAD_RETRIES} retries, giving up.`)
          return
        }
        // 指数退避 + 抖动：500ms * 1.5^(retries-1) + 随机抖动
        const baseDelay = 500 * Math.pow(1.5, loadRetries - 1)
        const jitter = Math.random() * 200
        logger.info(`Failed to load ${validatedURL}, retrying in ${Math.round(baseDelay + jitter)}ms... (${loadRetries}/${MAX_LOAD_RETRIES})`)
        setTimeout(() => {
          if (process.env.VITE_DEV_SERVER_URL) {
            win?.loadURL(process.env.VITE_DEV_SERVER_URL)
          }
        }, baseDelay + jitter)
      }
      // @ts-expect-error Electron type definitions don't include did-fail-load on webContents
      win.webContents.on('did-fail-load', handleDidFailLoad)

      win.on('closed', () => {
        // @ts-expect-error Electron type definitions don't include did-fail-load on webContents
        win.webContents.off('did-fail-load', handleDidFailLoad)
        this.windows.delete(id)
      })
    } else {
      win.loadFile(path.join(__dirname, '../../dist/index.html'))
      win.on('closed', () => {
        this.windows.delete(id)
      })
    }

    return win
  }

  getAllWindows(): BrowserWindow[] {
    return Array.from(this.windows.values())
  }
}

const windowManager = new WindowManager()

// Application menu template
function buildMenu(): Menu {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            windowManager.createWindow()
          },
        },
        { type: 'separator' },
        {
          label: 'Close Window',
          accelerator: isMac ? 'Cmd+W' : 'Ctrl+W',
          click: (_, focusedWindow) => {
            focusedWindow?.close()
          },
        },
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: 'Exit',
                accelerator: 'Alt+F4',
                click: () => {
                  app.quit()
                },
              },
            ]),
      ],
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' },
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Reset Zoom' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Fullscreen' },
      ],
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize', label: 'Minimize' },
        ...(isMac
          ? [
              { role: 'zoom', label: 'Zoom' } as const,
              { type: 'separator' as const },
              { role: 'front', label: 'Bring All to Front' } as const,
            ]
          : [{ role: 'close', label: 'Close' } as const]),
      ],
    },
    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'About BizGraph',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About BizGraph',
              message: 'BizGraph v0.1.0',
              detail: 'Open Source Agent CLI Desktop Orchestrator',
            })
          },
        },
      ],
    },
  ]

  if (isMac) {
    template.unshift({
      label: 'BizGraph',
      submenu: [
        { role: 'about', label: 'About BizGraph' },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide BizGraph' },
        { role: 'hideOthers', label: 'Hide Others' },
        { role: 'unhide', label: 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit BizGraph' },
      ],
    })
  }

  return Menu.buildFromTemplate(template)
}

app.whenReady().then(async () => {
  // Validate state machine consistency before anything else
  const { validateTransitionConsistency } = await import('@shared/state-machine')
  const inconsistencies = validateTransitionConsistency()
  if (inconsistencies > 0) {
    logger.error(`State machine has ${inconsistencies} inconsistencies between TRANSITION_RULES and NODE_STATUS_TRANSITIONS`)
  }

  // Initialize database
  await initDatabase()

  // Register IPC handlers
  await registerIpcHandlers()

  // Set application menu
  Menu.setApplicationMenu(buildMenu())

  // Create first window
  windowManager.createWindow()

  app.on('activate', () => {
    if (windowManager.getAllWindows().length === 0) {
      windowManager.createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let isQuitting = false
let cleanupDone = false

app.on('before-quit', async (event) => {
  if (cleanupDone) return
  event.preventDefault()

  if (isQuitting) return // cleanup 已在进行中，阻止退出直到完成
  isQuitting = true

  // 5 秒超时保护，防止子进程挂起导致应用无法退出
  const cleanupWithTimeout = Promise.race([
    (async () => {
      try {
        await agentManager.terminateAllSessions()
      } catch (err) {
        logger.error('Failed to terminate sessions:', err)
      }
      agentManager.destroy()
      // 停止 IPC 频率限制清理定时器
      stopCleanup()
      try {
        await closeDatabase()
      } catch (err) {
        logger.error('Failed to close database:', err)
      }
    })(),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ])

  try {
    await cleanupWithTimeout
  } catch (err) {
    logger.error('Cleanup error during quit:', err)
  }
  cleanupDone = true
  app.quit()
})
