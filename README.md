# BizGraph — Agent CLI 桌面编排器

> **BizGraph 不是又一个 AI 编码工具，而是第一个 "Agent CLI 的桌面指挥塔"** —— 让 Claude Code、Codex、OpenCode、Kimi Code、Qwen Code 等 Agent 在你的业务地图上按规矩干活，不乱改、不越界、可验收、可回滚。

[English README](./README.en.md) | [中文文档](https://bizgraph.dev)

---

## 产品定位

| 问题 | 解决方案 |
|------|---------|
| Agent CLI 是终端黑盒，改到哪里不知道 | BizGraph 用思维导图定义 "哪里该改、怎么改" |
| 产品经理无法参与验收 | BizGraph 提供可视化的业务语义层 |
| 改完一轮又一轮没有收敛感 | BizGraph 的 Bug 节点追踪，逐支裁剪 |
| 每次重构都是盲人摸象 | BizGraph 版本化的业务蓝图 |
| 长会话上下文爆炸 | BizGraph 的 Context Waterline 自动压缩与 Token 经济学 |

**核心原则：BizGraph 不生成代码，它让 Agent 工具变得更好用、更可控、更可协作。**

## 架构概览

```
BizGraph (Electron + React)
    ├── 思维导图画布 (@xyflow/react)
    ├── Agent 适配器层 (Claude Code / Codex / OpenCode / Cline / Kimi / Qwen ...)
    ├── 范围守卫 (ScopeGuard)
    ├── 代码智能 (Code Intelligence)
    ├── 记忆系统 (Memory Pipeline)
    ├── 上下文水线 (Context Waterline)
    ├── 子代理调度 (Subagent Manager)
    └── 本地数据库 (better-sqlite3)
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
# Claude Code (Anthropic，推荐)
npm install -g @anthropic-ai/claude-code

# Codex CLI (OpenAI)
npm install -g @openai/codex

# OpenCode
npm install -g opencode

# 其他支持的 Agent
npm install -g cline
npm install -g @kilocode/cli
npm install -g @moonshot-ai/kimi-code
npm install -g @qwen-code/qwen-code
npm install -g @tencent-ai/codebuddy-code
```

安装后 BizGraph 会自动检测已安装的 Agent；未安装时会按偏好设置自动回退到下一个可用适配器，最终可回退到基于 API 的 MCP 适配器。

## 核心功能

- **思维导图画布**：7 种节点状态，拖拽创建，连线关系，真实图 / 开发图双轨
- **真实图 vs 开发图**：产品定义业务蓝图，开发派生实现副本
- **占位节点**：产品经理添加灰色虚线占位，开发者点击即启动 Agent，自动 placeholder → developing
- **范围注入**：自动向 Agent 注入白名单/黑名单/业务约束/验收标准
- **范围守卫**：文件系统监控，越界写入自动拦截并回滚
- **Bug 节点**：测试挂 Bug， severity（low/medium/high/critical）+ 状态机追踪
- **多 Agent 支持**：Claude Code、Codex、OpenCode、Cline、Kilo Code、Kimi Code、CodeBuddy、Qoder、Qwen Code、Cursor、MCP/API
- **适配器健康监控**：自动降级、故障恢复、按健康度动态选择适配器
- **会话恢复**：异常退出后自动尝试原生续跑或替换会话恢复
- **代码智能**：基于 AST 的符号索引、智能上下文解析、相关文件推荐
- **记忆系统**：跨会话记忆提取、压缩、幻觉检测、向量检索（借鉴 claude-mem）
- **上下文水线**：Token 预算监控、自动压缩、紧凑历史持久化
- **子代理调度**：Agent 可派发 explore/implement/review/fix/general 子任务，支持写冲突串行化

## 开发路线图

| 阶段 | 时间 | 里程碑 |
|------|------|--------|
| Phase 1 | Week 1-4 | MVP — 画布可运行，数据持久化 |
| Phase 2 | Week 5-7 | Alpha — 占位→派生→编辑→隔离 |
| Phase 3 | Week 8-10 | Beta — 连接 Agent CLI，范围注入，上下文水线 |
| Phase 4 | Week 11-13 | RC — 子代理、记忆系统、Bug→裁剪→合并 |
| Phase 5 | Week 14-16 | v1.0 — 多 Agent + 导出 + 开源发布 |

## 技术栈

- **桌面端**: Electron 33 + React 19 + TypeScript 5.7
- **UI**: shadcn/ui + Radix UI + Tailwind CSS 4
- **状态**: Zustand 5 + Immer
- **画布**: @xyflow/react 12.x
- **数据库**: better-sqlite3 (WAL 模式)
- **Git**: simple-git
- **测试**: Vitest 4 + Playwright 1.50
- **构建**: Vite 6 + vite-plugin-electron + electron-builder 25

## 扩展 BizGraph

### 添加新的 Agent 适配器

BizGraph 的核心扩展点是 **Agent 适配器**。只需实现 4 个方法即可接入新的 Agent CLI：

```typescript
export class MyAdapter extends BaseAdapter {
  readonly name = 'my-agent'
  readonly version = '1.0.0'

  async checkInstalled() { /* ... */ }
  async startSession(config) { /* ... */ }
  protected async doSendCommand(session, command) { /* ... */ }
  protected async doTerminate(session) { /* ... */ }
}
```

然后在 `src/main/adapters/registry.ts` 的 `ADAPTER_REGISTRY` 中注册该适配器。

详见 [Agent 适配器开发指南](src/main/adapters/README.md)。

## 贡献

我们欢迎各种形式的贡献！请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
