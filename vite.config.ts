import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

const DEV_SERVER_HOST = '127.0.0.1'
const DEV_SERVER_PORT = 5173

/**
 * 浏览器版 e2e（`tests/e2e/playwright.browser.config.ts`）只验渲染层，**不需要
 * Electron 主进程**，而 `vite-plugin-electron` 默认会在 dev server 起来后编译并
 * `spawn` 一个 Electron 子进程。
 *
 * 这条链路是 e2e 大面积假红的根因：插件里有一行
 * `process.electronApp.once("exit", process.exit)` —— 子进程一退出，**父进程（也就是
 * vite dev server）跟着退出**。而子进程在两种环境下必然退出：
 *   - CI：`npm ci --ignore-scripts` 没有下载 Electron 二进制，
 *     `require('electron')` 直接抛 "Electron failed to install correctly"；
 *   - 本机：环境里带 `ELECTRON_RUN_AS_NODE=1`（Electron 宿主进程会注入），
 *     子进程以纯 Node 运行 → `require('electron')` 得到的是**路径字符串** →
 *     主进程代码里 `electron.app.commandLine` 立刻 TypeError。
 *
 * 后果是「前几个用例通过、之后全部 `page.goto: net::ERR_CONNECTION_REFUSED`」：
 * 能过几个纯属和编译抢跑，不是平台差异（Windows 24 失败、macOS 本地 22 失败，
 * 差的只是编译耗时）。
 *
 * 因此 e2e 下不挂这个插件：既不起子进程，也省掉 main/preload 那两次 rollup 构建。
 */
const BROWSER_E2E = process.env.BIZGRAPH_BROWSER_E2E === '1'

export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    ...(BROWSER_E2E ? [] : [electron([
      {
        entry: 'src/main/index.ts',
        onstart(options) {
          // vite-plugin-electron 会把 loopback 地址归一化成 "localhost"，而 macOS 下
          // Chromium 解析 localhost 优先走 IPv6 ::1。若同端口被另一个项目以 IPv6 绑定，
          // Electron 会加载到别人的页面。此处显式指向 server 实际绑定的 IPv4 地址。
          process.env.VITE_DEV_SERVER_URL = `http://${DEV_SERVER_HOST}:${DEV_SERVER_PORT}`
          options.startup()
        },
        vite: {
          build: {
            sourcemap: process.env.NODE_ENV !== 'production',
            minify: process.env.NODE_ENV === 'production',
            outDir: 'dist-electron/main',
            rollupOptions: {
              // bufferutil / utf-8-validate 是 ws 的可选 peer 依赖（纯性能加速，
              // 缺失时 ws 自带 try/catch 回退纯 JS）。不能被 externalize 时 Vite
              // 会给未安装的可选 peer 依赖生成顶层 throw 的 stub，主进程加载即崩。
              external: ['electron', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', 'onnxruntime-node', 'sharp', 'bufferutil', 'utf-8-validate'],
            },
          },
          resolve: {
            alias: {
              '@main': path.join(__dirname, 'src/main'),
              '@shared': path.join(__dirname, 'src/shared'),
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            sourcemap: false,
            minify: false,
            outDir: 'dist-electron/preload',
            lib: {
              entry: 'src/preload/index.ts',
              formats: ['cjs'],
              fileName: 'index',
            },
            rollupOptions: {
              external: ['electron'],
            },
          },
          resolve: {
            // 与 main 子配置同口径：preload 也通过 `@shared/*` 引用共享类型/工具
            // （如 @shared/ipc-error 的结构化错误编解码），缺少 alias 会让
            // `vite build` 的 preload 子构建直接失败。
            alias: {
              '@main': path.join(__dirname, 'src/main'),
              '@shared': path.join(__dirname, 'src/shared'),
            },
          },
        },
      },
    ])]),
    renderer(),
    ...(process.env.BUILD_ANALYZE === 'true'
      ? [
          (await import('rollup-plugin-visualizer')).visualizer({
            open: true,
            filename: 'dist/stats.html',
            gzipSize: true,
            brotliSize: true,
          }) as Plugin,
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.join(__dirname, 'src/renderer'),
      '@main': path.join(__dirname, 'src/main'),
      '@shared': path.join(__dirname, 'src/shared'),
    },
  },
  root: '.',
  server: {
    host: DEV_SERVER_HOST,
    port: DEV_SERVER_PORT,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-reactflow': ['@xyflow/react'],
          'vendor-lucide': ['lucide-react'],
          'vendor-markdown': ['react-markdown', 'react-syntax-highlighter', 'remark-gfm'],
          'vendor-transformers': ['@xenova/transformers'],
        },
      },
    },
  },
}))
