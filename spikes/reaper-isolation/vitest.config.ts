import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  resolve: {
    // C17 直接驱动真实 AgentRuntime，需要与主工程一致的 @shared 别名
    alias: {
      '@shared': path.resolve(root, '../../src/shared'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 真实进程树 + 每个 pid 500ms 宽限，单条用例可能接近 10s
    testTimeout: 90_000,
    hookTimeout: 30_000,
    // 同一时刻只跑一个用例：信号探针是进程级单例，且要避免并发父进程干扰 ps 采样
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
