# D4: MCP 健康度面板 UI

> 创建：2026-10-01
> 分支：`claude/d4-mcp-health-panel-b7db5b`
> 前置：基座 v1（Phase B 已实现 `AdapterHealthMonitor` + 数据采集）

## 目标

让用户能在 Settings 里看到所有已记录样本的适配器健康评分（成功率 / 平均延迟 / 最近错误），支持手动刷新 + 30s 自动刷新、错误兜底 + 状态徽章。

## 实现清单

| 子任务 | 状态 | 说明 |
|--------|------|------|
| D4-1 AdapterHealthPanel 组件 | ✅ | `src/renderer/panels/AdapterHealthPanel.tsx` — 表格 + 状态徽章 + 最近错误 + 刷新按钮 + 30s 自动刷新 |
| D4-2 SettingsPanel 接入入口 | ✅ | 新增「健康度」tab（基础设置 / 子代理类型 / 上下文水位 / 健康度） |
| D4-3 消费 IPC | ✅ | `agent:getHealth` IPC 通道（preload 白名单 + typedHandle + IpcApi 类型）+ loading/data/error/stale 四态 + toast.error 兜底 |
| D4-4 单元测试 | ✅ | `src/renderer/panels/__tests__/AdapterHealthPanel.test.tsx` 14 个 case（三态/颜色/刷新/自动/stale/toast） |

## 关键文件改动

### 类型层

- `src/shared/types/agent.ts` — 新增 `AdapterHealthMetrics` + `AdapterHealthScore`（renderer 可见）
- `src/shared/types.ts` — barrel export
- `src/shared/types/ipc.ts` — `IpcApi['agent:getHealth']: () => Promise<AdapterHealthScore[]>`

### 主进程

- `src/main/agent/adapter-health-monitor.ts` — 类型从 `@shared/types` 引用（renderer 与 main 同源）
- `src/main/ipc/agent.ts` — 注册 `agent:getHealth` handler，路由到 `agentManager.getAllAdapterHealth()`

### Preload

- `src/preload/index.ts` — 白名单追加 `'agent:getHealth'`

### Renderer

- `src/renderer/panels/AdapterHealthPanel.tsx` — 新组件
- `src/renderer/panels/SettingsPanel.tsx` — 新 tab「健康度」
- `src/renderer/panels/__tests__/AdapterHealthPanel.test.tsx` — 单测

## 设计决策

1. **状态机显式建模** — `LoadState` 联合类型（loading / data / error-with-previous）替代散落的 boolean flag；`displayScores` 单一变量驱动渲染，避免多个 if 分支不一致。
2. **Stale data 兜底** — 手动刷新失败时保留最近一次成功数据（淡灰 + opacity-70），便于诊断而不误导「全是 healthy」。
3. **toast.error 仅手动刷新失败时弹** — auto 失败只在顶部 banner 提示，避免 30s 一条 toast 淹没用户。
4. **零样本不入表** — `AdapterHealthMonitor.getAllHealth()` 内部过滤未调用过的 adapter；面板只展示有真实样本的数据。`unknown` 状态在记录存在但 totalCalls === 0 时出现（实际不会触发，但 UI 已覆盖）。
5. **api prop 注入** — 测试可通过 `api` prop 注入 mock，运行时回退到 `window.electronAPI`，避免硬依赖全局。
6. **类型在 shared 定义** — `AdapterHealthScore` 在 `@shared/types/agent.ts` 定义，main 通过 `@shared/types` 引用；消除 main 与 renderer 类型不一致的可能性。

## 验证门槛

- [x] `npx tsc --noEmit` — 零错误
- [x] `npm run test` — D4 相关 26/26 通过（含原有 `adapter-health-monitor` 12 例）
- [x] `npm run lint` — 零警告
- [ ] 手动 `npm run dev` 验证（MCP 调用 / 杀进程 / recent errors） — 留待 PR review

> 注：基线 `agent-manager.test.ts` + `graph.test.ts`（wiki:ingestFiles）已有 21 个失败，与本任务无关（已在 stash 状态下复现）。

## 完成定义

- [x] D4-1 ~ D4-4 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D4 状态改为 ✅（PR 合并后）
