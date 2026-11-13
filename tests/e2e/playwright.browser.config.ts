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
    // ⚠️ 浏览器 e2e 只要渲染层。不带这个标记，`npm run dev` 会经
    // `vite-plugin-electron` 起一个 Electron 子进程，而插件里写着
    // `process.electronApp.once("exit", process.exit)` —— 子进程一崩，
    // **dev server 跟着退出**，后续用例全部 `ERR_CONNECTION_REFUSED`。
    // CI 上崩是因为没下 Electron 二进制，本机崩是因为继承了
    // `ELECTRON_RUN_AS_NODE=1`；两者都只影响 e2e，不影响 `npm run dev` 本身。
    env: {
      BIZGRAPH_BROWSER_E2E: '1',
      // ⚠️ 从 WorkBuddy/CodeBuddy 宿主里跑 e2e 时，宿主会往**所有子进程**注入
      // 沙箱 shim：`NODE_OPTIONS=--require .../node-language-shim.cjs`，
      // 文件操作经 `TOYBOX_SANDBOX_SOCK`（/var/folders/.../cbb-*/broker.sock）
      // 代理。broker 会话一过期间歇 `ECONNREFUSED` → vite Internal server error →
      // 页面只渲染错误浮层 → 整批用例假红（`page.click('text=E2E Test Graph')`
      // 等到超时，或在 PlaywrightTest 里显示为 0ms 的「没跑起来」）。
      // dev server 服务的是用户自己的项目，等价于在用户终端里 `npm run dev`，
      // 不需要也不该依赖宿主沙箱 —— 清掉注入（env 是合并语义，空串即覆盖）。
      // BASH_ENV 同理：npm script 经 /bin/sh（bash POSIX 模式）拉起 vite，
      // 不清的话 shim 会经它再次注入孙进程。
      NODE_OPTIONS: '',
      BASH_ENV: '',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
