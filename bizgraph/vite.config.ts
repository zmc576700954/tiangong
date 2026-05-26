import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(options) {
          options.startup()
        },
        vite: {
          build: {
            sourcemap: true,
            minify: false,
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron'],
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
            sourcemap: true,
            minify: false,
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.join(__dirname, 'src/renderer'),
      '@main': path.join(__dirname, 'src/main'),
      '@shared': path.join(__dirname, 'src/shared'),
    },
  },
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
