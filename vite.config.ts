import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

const DEV_SERVER_HOST = '127.0.0.1'
const DEV_SERVER_PORT = 5173

export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    electron([
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
              external: ['electron', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', 'onnxruntime-node', 'sharp'],
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
        },
      },
    ]),
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
