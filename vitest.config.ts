import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/main/**/*.ts'],
      exclude: ['src/main/index.ts', 'src/main/ipc-handlers.ts', 'src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@shared': path.join(__dirname, 'src/shared'),
      '@main': path.join(__dirname, 'src/main'),
    },
  },
})
