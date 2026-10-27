import { defineConfig, devices } from '@playwright/test'

// ⚠️ 用 `127.0.0.1` 而不是 `localhost` —— macOS 上 `localhost` 优先解析成 IPv6 `::1`，
// 而 vite 的 dev server 绑的是 **IPv4** `127.0.0.1`（`vite.config.ts` 的
// `server.host = '127.0.0.1'`）。若同一个端口被**另一个项目**以 IPv6 占了
// （本机上就有一个不相干的项目占着 `[::1]:5173`），那么：
//   - Playwright 拿 `localhost` 去探活 → 探到的是**别人的服务器** → 判定「已就绪」
//     → `reuseExistingServer` 让它**不启动**我们的 dev server
//   - 测试于是跑在**别人的应用**上：mock IPC 根本没装，断言要么莫名其妙地红，
//     要么「只断言页面加载成功」的用例**空洞地绿**。
// `vite.config.ts` 里已经为 Electron 侧记过同一个坑（`VITE_DEV_SERVER_URL`
// 显式指向 IPv4），这里是浏览器 e2e 侧的同一处修正。
// CI（Linux / macOS / Windows）上 `127.0.0.1` 与 `localhost` 等价，行为不变。

export default defineConfig({
  testDir: '.',
  testIgnore: 'electron/**',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
