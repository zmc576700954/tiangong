# BizGraph — Agent CLI 桌面编排器

> **BizGraph 不是又一个 AI 编码工具，而是第一个 "Agent CLI 的桌面指挥塔"** —— 让 Claude Code、Codex、OpenCode 在你的业务地图上按规矩干活，不乱改、不越界、可验收、可回滚。

[English README](./README.en.md) | [中文文档](https://bizgraph.dev)

---

## 产品定位

| 问题 | 解决方案 |
|------|---------|
| Agent CLI 是终端黑盒，改到哪里不知道 | BizGraph 用思维导图定义 "哪里该改、怎么改" |
| 产品经理无法参与验收 | BizGraph 提供可视化的业务语义层 |
| 改完一轮又一轮没有收敛感 | BizGraph 的 Bug 节点追踪，逐支裁剪 |
| 每次重构都是盲人摸象 | BizGraph 版本化的业务蓝图 |

**核心原则：BizGraph 不生成代码，它让 Agent 工具变得更好用、更可控、更可协作。**

## 架构概览

```
BizGraph (Electron + React)
    ├── 思维导图画布 (@xyflow/react)
    ├── Agent 适配器层 (Claude Code / Codex / OpenCode)
    ├── 范围守卫 (ScopeGuard)
    └── 本地数据库 (LibSQL)
```

## 快速开始

### 安装 BizGraph

```bash
# 克隆仓库
git clone https://github.com/yourusername/bizgraph.git
cd bizgraph

# 安装依赖
npm install

# 启动开发模式
npm run dev
```

### 安装 Agent CLI（至少选一个）

```bash
# Claude Code (Anthropic)
npm install -g @anthropic-ai/claude-code

# Codex CLI (OpenAI)
npm install -g @openai/codex

# OpenCode
npm install -g opencode
```

## 核心功能

- **思维导图画布**：6 种业务节点类型，拖拽创建，连线关系
- **真实图 vs 开发图**：产品定义业务蓝图，开发派生实现副本
- **占位节点**：产品经理添加灰色虚线占位，开发者点击即启动 Agent
- **范围注入**：自动向 Agent 注入白名单/黑名单/业务约束
- **范围守卫**：文件系统监控，越界写入自动拦截回滚
- **Bug 节点**：测试挂 Bug，开发者逐支裁剪
- **多 Agent 支持**：Claude Code / Codex / OpenCode

## 开发路线图

| 阶段 | 时间 | 里程碑 |
|------|------|--------|
| Phase 1 | Week 1-4 | MVP — 画布可运行，数据持久化 |
| Phase 2 | Week 5-7 | Alpha — 占位→派生→编辑→隔离 |
| Phase 3 | Week 8-10 | Beta — 连接 Agent CLI，范围注入 |
| Phase 4 | Week 11-13 | RC — Bug→裁剪→合并完整闭环 |
| Phase 5 | Week 14-16 | v1.0 — 多 Agent + 导出 + 开源发布 |

## 技术栈

- **桌面端**: Electron 34 + React 19 + TypeScript 5.5
- **UI**: shadcn/ui + Tailwind CSS 4
- **状态**: Zustand 5 + Immer
- **画布**: @xyflow/react 12.x
- **数据库**: LibSQL (SQLite 超集)
- **Git**: simple-git

## 扩展 BizGraph

### 添加新的 Agent 适配器

BizGraph 的核心扩展点是 **Agent 适配器**。只需实现 4 个方法即可接入新的 Agent CLI：

```typescript
export class MyAdapter extends BaseAdapter {
  name = 'my-agent'

  async checkInstalled() { /* ... */ }
  async startSession(config) { /* ... */ }
  protected async doSendCommand(session, command) { /* ... */ }
  protected async doTerminate(session) { /* ... */ }
}
```

详见 [Agent 适配器开发指南](src/main/adapters/README.md)。

## 贡献

我们欢迎各种形式的贡献！请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
