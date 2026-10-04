# D4: MCP 健康度面板 UI

## 会话元数据

- **ID**: D4
- **前置**: 基座 v1（Phase B 已实现 `agent:getHealth` IPC + `AdapterHealthMonitor`）
- **工作分支**: `claude/phase-d4-mcp-health-panel`
- **预估工作量**: 3-5 工作日
- **依赖**: 无

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d4-mcp-health-panel`
- 路径：`.claude/worktrees/phase-d4`

## 上下文

基座 v1 已暴露：
- 主进程：`adapterHealthMonitor.recordCall(...)` 在 mcp-adapter connect/call 边界
- IPC：`agent:getHealth` 返回 `AdapterHealthScore[]`
- 类型：`AdapterHealthScore` 在 `src/shared/types/ipc.ts`

但 UI 缺失 — 用户看不到任何适配器健康信息。D4 加一个面板。

## 任务清单

### D4-1：AdapterHealthPanel 组件

- `src/renderer/panels/AdapterHealthPanel.tsx`
- 布局：表格或卡片网格，每个 adapter 一行
- 列：name / status badge (healthy/degraded/unhealthy/unknown) / success rate / avg latency / total calls / recent errors
- 顶部刷新按钮 + 自动 30s 刷新
- 颜色：green / yellow / red / gray

### D4-2：接入入口

- SettingsPanel 内加 tab 或子页面（推荐 tab：「适配器」「健康度」「MCP 服务器」）
- 或独立浮层入口（参考 D2 FloatingPanel）

### D4-3：消费 IPC

- `window.electronAPI['agent:getHealth']()` 拉数据
- loading / data / error 三态
- 用 toast.error 反馈拉取失败

### D4-4：单元测试

- `src/renderer/panels/__tests__/AdapterHealthPanel.test.tsx` ≥ 6 个 case
  - 三种状态渲染（loading/data/error）
  - 颜色映射正确
  - 刷新按钮触发 IPC

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动 `npm run dev`：
  - 启动几次 MCP 调用 → 在面板看到 success rate > 0%
  - 杀掉 MCP 服务器进程 → 在面板看到 status 转 unhealthy
  - recent errors 显示最后 5 条

## 关键参考

- `src/main/agent/adapter-health-monitor.ts`（数据源）
- `src/main/ipc/agent.ts:55`（`agent:getHealth` handler）
- `src/shared/types/ipc.ts:80`（AdapterHealthScore 类型）
- `src/renderer/panels/SubagentTypesTab.tsx`（参考面板组件模式）
- `src/renderer/panels/SettingsPanel.tsx`（参考 tab 集成方式）

## 完成定义

- [ ] D4-1 ~ D4-4 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D4 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d4.md` 跟踪文档