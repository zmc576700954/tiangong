import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 原生模块必须走 Node require，不能被 Vite 打包
    server: {
      deps: {
        external: [/better-sqlite3/],
      },
    },
  },
})
