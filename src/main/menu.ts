import type { MenuItemConstructorOptions } from 'electron'
import { t } from '@shared/i18n'
import { APP_NAME } from '@shared/constants'

/**
 * Electron 原生菜单模板。
 *
 * 只做类型导入（`import type` 编译期擦除），运行时的 electron 依赖都放在
 * click 回调里动态取——这样本模块能在 vitest 的 node 环境里直接测。
 *
 * role 驱动的系统菜单项（copy / paste / undo / about …）**必须显式给 label**：
 * macOS 只按**系统语言**给 role 项配文案，不跟随应用内的语言切换——不写死
 * 的话，中文界面下会看到「编辑 / Undo / Copy / Paste」这种中英混排。
 * 行为与快捷键仍由 role 提供。
 */
export function buildMenuTemplate(deps: {
  createWindow: () => void
  isMac: boolean
  quitApp?: () => void
}): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.openProject'),
          accelerator: 'CmdOrCtrl+O',
          click: async (_item, focusedWindow) => {
            const win = focusedWindow as Electron.BrowserWindow | null
            if (!win) return
            const { dialog } = await import('electron')
            const result = await dialog.showOpenDialog(win, {
              properties: ['openDirectory'],
              title: t('menu.selectProjectDir'),
            })
            if (result.canceled || result.filePaths.length === 0) return
            win.webContents.send('menu:openProject', result.filePaths[0])
          },
        },
        { type: 'separator' },
        {
          label: t('menu.newWindow'),
          accelerator: 'CmdOrCtrl+N',
          click: () => deps.createWindow(),
        },
        { type: 'separator' },
        {
          label: t('menu.closeWindow'),
          accelerator: deps.isMac ? 'Cmd+W' : 'Ctrl+W',
          click: (_item, focusedWindow) => {
            focusedWindow?.close()
          },
        },
        ...(deps.isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: t('menu.exit'),
                accelerator: 'Alt+F4',
                click: () => deps.quitApp?.(),
              },
            ]),
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { role: 'forceReload', label: t('menu.forceReload') },
        { role: 'toggleDevTools', label: t('menu.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.toggleFullScreen') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        ...(deps.isMac
          ? [
              { role: 'zoom', label: t('menu.zoom') } as const,
              { type: 'separator' as const },
              { role: 'front', label: t('menu.front') } as const,
            ]
          : [{ role: 'close', label: t('menu.closeWindow') } as const]),
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.about'),
          click: async () => {
            const { dialog } = await import('electron')
            dialog.showMessageBox({
              type: 'info',
              title: t('menu.about'),
              message: 'BizGraph v0.1.0',
              detail: t('menu.aboutDetail'),
            })
          },
        },
      ],
    },
  ]

  if (deps.isMac) {
    template.unshift({
      label: 'BizGraph',
      submenu: [
        { role: 'about', label: t('menu.about') },
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hideApp', { app: APP_NAME }) },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.unhide') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit', { app: APP_NAME }) },
      ],
    })
  }

  return template
}
