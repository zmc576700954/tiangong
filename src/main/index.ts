import { app, BrowserWindow, Menu } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpcHandlers, agentManager, registry } from './ipc-handlers'
import { initDatabase, closeDatabase } from './database'
import { stopCleanup } from './ipc/utils'
import { createLogger } from './shared/logger'
import { getPlatformProvider } from './platform'
import { getLocale, subscribeLocale } from '@shared/i18n'
import { buildMenuTemplate } from './menu'

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
        // 渲染进程同步读取初始语言，避免首屏闪一下默认语言
        additionalArguments: [`--bizgraph-locale=${getLocale()}`],
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
        try {
          // @ts-expect-error Electron type definitions don't include did-fail-load on webContents
          win.webContents?.off('did-fail-load', handleDidFailLoad)
        } catch { /* window already destroyed */ }
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

// Application menu
function buildMenu(): Menu {
  const provider = getPlatformProvider()
  return Menu.buildFromTemplate(
    buildMenuTemplate({
      createWindow: () => windowManager.createWindow(),
      isMac: provider.isMac,
      quitApp: () => app.quit(),
    }),
  )
}

// 语言切换后重建原生菜单
subscribeLocale(() => {
  // app 未就绪时建菜单会抛错——启动阶段由 whenReady 里的显式调用负责
  if (!app.isReady()) return
  Menu.setApplicationMenu(buildMenu())
})

app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  // Validate state machine consistency before anything else
  const { validateTransitionConsistency } = await import('@shared/state-machine')
  const inconsistencies = validateTransitionConsistency()
  if (inconsistencies > 0) {
    logger.error(`State machine has ${inconsistencies} inconsistencies between TRANSITION_RULES and NODE_STATUS_TRANSITIONS`)
  }

  // Initialize database (sync with better-sqlite3)
  initDatabase()

  // Register IPC handlers
  await registerIpcHandlers()

  // Set locale before building the menu — otherwise the first-frame menu is English
  const { readSettings } = await import('./settings')
  const { setLocale, resolveLocale } = await import('@shared/i18n')
  const settings = await readSettings()
  setLocale(resolveLocale(settings.locale))

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
  const provider = getPlatformProvider()
  if (!provider.isMac) {
    app.quit()
  }
})

let isQuitting = false
let cleanupDone = false

app.on('before-quit', async (event) => {
  if (cleanupDone) return
  event.preventDefault()

  if (isQuitting) return // cleanup 已在进行中，等待完成后自动 app.quit()
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
      // Phase B: 显式释放 MCP 连接池 + 清理定时器。
      // 之前完全依赖 child_process 退出时的 OS 级回收，连接池中的客户端可能
      // 持有未关闭的 stdio 句柄，导致子进程变成孤儿。dispose() 显式断开并清空池。
      // 通过鸭子类型判断：仅当适配器实现了 dispose() 才调用，避免破坏其他适配器契约。
      try {
        const mcpAdapter = registry.get('mcp')
        if (mcpAdapter && typeof (mcpAdapter as unknown as { dispose?: () => void }).dispose === 'function') {
          (mcpAdapter as unknown as { dispose: () => void }).dispose()
        }
      } catch (err) {
        logger.error('Failed to dispose MCP adapter:', err)
      }
      // 停止 IPC 频率限制清理定时器
      stopCleanup()
      try {
        closeDatabase()
      } catch (err) {
        logger.error('Failed to close database:', err)
      }
    })(),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000)
      t.unref()
    }),
  ])

  try {
    await cleanupWithTimeout
  } catch (err) {
    logger.error('Cleanup error during quit:', err)
  }
  cleanupDone = true
  app.quit()
})
