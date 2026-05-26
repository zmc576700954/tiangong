# BizGraph 开发环境搭建指南

## 环境诊断结果

| 检查项 | 状态 | 说明 |
|--------|------|------|
| VM Linux 环境 | 可用 | Ubuntu 22.04, Node.js v22.22.0 |
| VM 网络(npm) | 受限 | 无法访问 registry.npmjs.org（安全策略） |
| Windows Node.js | 未安装 | 未检测到 C:\Program Files\nodejs |
| Windows Git | 未知 | 待检查 |

**结论**: 请在 Windows 本机安装 Node.js 后，在项目目录执行 `npm install`。

---

## 快速安装步骤

### 第一步：安装 Node.js

访问 https://nodejs.org 下载 **Node.js 22 LTS** (推荐)，或使用包管理器：

```powershell
# Winget (推荐)
winget install OpenJS.NodeJS.LTS

# 或 Chocolatey
choco install nodejs-lts

# 安装后重启终端
node -v   # 应显示 v22.x.x
npm -v    # 应显示 10.x.x
```

### 第二步：安装项目依赖

在项目目录打开终端（PowerShell 或 CMD）：

```powershell
cd D:\xiangmu\TianGong\bizgraph
npm install
```

如果网络较慢，可切换国内镜像：

```powershell
npm config set registry https://registry.npmmirror.com
npm install
npm config set registry https://registry.npmjs.org
```

### 第三步：安装 Agent CLI（可选，至少装一个）

```powershell
# Claude Code (推荐)
npm install -g @anthropic-ai/claude-code

# Codex CLI
npm install -g @openai/codex

# OpenCode
npm install -g opencode
```

### 第四步：启动开发模式

```powershell
npm run dev
```

应用会自动启动 Electron 窗口，默认地址 `http://localhost:5173`。

---

## 使用自动脚本

我们提供了两个辅助脚本：

### PowerShell 脚本（推荐）

在 `bizgraph` 目录下，右键 `setup-env.ps1` → "使用 PowerShell 运行"，脚本会自动：
- 检查 Node.js / npm / Git
- 安装项目依赖
- 检测已安装的 Agent CLI
- 输出常用命令

### CMD 批处理脚本

双击 `setup-windows.bat` 即可运行。

---

## 验证安装

依赖安装完成后，检查以下命令是否正常：

```powershell
# TypeScript 编译检查
npx tsc --noEmit

# ESLint 检查
npm run lint

# 启动 Electron 开发模式
npm run dev
```

---

## 常见问题

### Q: `npm install` 很慢或卡住？

切换国内镜像：
```powershell
npm config set registry https://registry.npmmirror.com
npm install
```

### Q: Electron 下载失败？

设置 Electron 镜像：
```powershell
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
npm install
```

### Q: `vite-plugin-electron` 不存在？

这是正常的 — 首次安装时会自动下载。如果安装后仍报错：
```powershell
rm -rf node_modules package-lock.json
npm install
```

### Q: 启动后白屏？

检查控制台是否有报错。常见原因：
1. 端口 5173 被占用
2. Vite 配置中的路径问题
3. 缺少 `src` 目录下的某些文件

---

## 项目脚本速查

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Electron 开发模式（热更新） |
| `npm run build` | 构建生产包（+ electron-builder） |
| `npm run build:win` | 构建 Windows 安装包 |
| `npm run lint` | ESLint 代码检查 |
| `npm run test:e2e` | Playwright E2E 测试 |
| `npm run preview` | 预览生产构建 |
