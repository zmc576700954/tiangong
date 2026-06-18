import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(options) {
          options.startup()
        },
        vite: {
          build: {
            sourcemap: process.env.NODE_ENV !== 'production',
            minify: process.env.NODE_ENV === 'production',
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron', '@libsql/client'],
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
          visualizer({
            open: true,
            filename: 'dist/stats.html',
            gzipSize: true,
            brotliSize: true,
          }) as any,
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
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-reactflow': ['@xyflow/react'],
          'vendor-lucide': ['lucide-react'],
        },
      },
    },
  },
})
