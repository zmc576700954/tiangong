# D6: OpenTelemetry 导出

## 会话元数据

- **ID**: D6
- **前置**: 基座 v1
- **工作分支**: `claude/phase-d6-opentelemetry`
- **预估工作量**: 2-3 工作日
- **依赖**: 无

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d6-opentelemetry`
- 路径：`.claude/worktrees/phase-d6`

## 上下文

基座版日志散落在：
- `createLogger('xxx')` console 输出
- SQLite（agent_logs / compact_history / subagent_invocations）
- 内存 Map（RecipeRun）

D6 加 OpenTelemetry 导出 — 把 Agent 启动/终止/命令/输出/健康度采样为 OTLP spans/metrics，方便接入 Jaeger / Tempo / Honeycomb。

## 任务清单

### D6-1：依赖

- `@opentelemetry/api` + `@opentelemetry/sdk-node` + `@opentelemetry/exporter-trace-otlp-http`
- `npm install --save`（不引 SDK 完整版，避免 electron-builder 打包膨胀）

### D6-2：Telemetry 初始化

- `src/main/telemetry/index.ts`
- `initTelemetry()` 启动时调用一次（main 进程启动）
- OTLP endpoint 从 settings 读（`settings.telemetry.otlpEndpoint`，默认关闭）
- Tracer name: `bizgraph`

### D6-3：埋点

- Agent 启动：`bizgraph.agent.start` span
- 命令发送：`bizgraph.agent.command` span
- Subagent 派发：`bizgraph.subagent.invoke` span（parent = agent.command）
- MCP connect / call：`bizgraph.mcp.connect` / `bizgraph.mcp.call`
- Recipe run：`bizgraph.recipe.run` span
- 健康度：counter `bizgraph.adapter.call{service, success}`

### D6-4：优雅降级

- 没有设置 OTLP endpoint 时，初始化空 tracer（zero overhead）
- OTLP 导出失败时不抛错（best-effort）

### D6-6：测试

- `src/main/telemetry/__tests__/index.test.ts` ≥ 5 个 case
  - 不设 endpoint → 零开销
  - 设了 endpoint → exporter 启动
  - export 失败不抛错

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动：在 settings.json 配 OTLP endpoint → 启动 → 用 [Jaeger all-in-one](https://www.jaegertracing.io/docs/getting-started/) 看 span

## 关键参考

- OTel JS 文档：https://opentelemetry.io/docs/languages/js/
- `src/main/settings.ts`（settings schema 扩展点）
- `src/main/agent/agent-manager.ts`（埋点位置）
- `src/main/agent/subagent-manager.ts`
- `src/main/recipes/runner.ts`

## 完成定义

- [ ] D6-1 ~ D6-6 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D6 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d6.md` 跟踪文档