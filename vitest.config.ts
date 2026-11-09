import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // tests/migration：§8.11 P1–P9 迁移前置验证脚本（G4-7/G4-8）
    // tests/eval：W5-D 评测 harness（U1–U9 / R3）
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/migration/**/*.test.ts', 'tests/eval/**/*.test.ts'],
    setupFiles: ['./vitest.setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['src/main/index.ts', 'src/main/ipc-handlers.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 30,
        branches: 20,
        functions: 25,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.join(__dirname, 'src/renderer'),
      '@shared': path.join(__dirname, 'src/shared'),
      '@main': path.join(__dirname, 'src/main'),
    },
  },
})
