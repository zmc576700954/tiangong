# BizGraph Phase D 任务清单

> 创建：2026-09-30
> 前置：基座 v1（Phase A/B/C）已交付，见 [ROADMAP.md](./ROADMAP.md)
> 工作分支：建议每个任务独立 `claude/phase-d-<task>` worktree

## 任务优先级与依赖

| ID | 任务 | 工作量 | 优先级 | 依赖 | 可并行？ |
|----|------|--------|--------|------|---------|
| D1 | AgentManager god file 拆解 | 2-3 周 | 高 | 无 | 否（基础设施） |
| D2 | FloatingPanel 共享 shell | 1 周 | 中 | 无 | 与 D1 并行 |
| D3 | WikiPageEditor + SmartContextResolver 单测覆盖 | 1 周 | 中 | 无 | 是 |
| D4 | MCP 健康度面板 UI | 1 周 | 中 | 无 | 是 |
| D5 | Recipe DAG 多步编排 | 4-6 周 | 中 | 无 | D5b/c 依赖 D5a |
| D6 | OpenTelemetry 导出 | 3 天 | 低 | 无 | 是 ✅ 2026-10-01 |
| D7 | Wiki Lint 增强 + 写回回滚 UI | 1-2 周 | 中 | 无 | D7a/D7b 并行 |
| D8 | 节点画布自动布局 | 2-3 周 | 低 | 无 | D8b 依赖 D8a |
| D9 | A2A 协议接入 | 2 周 | 低 | 无 | 是 |
| D10 | Yjs 协作画布 | 4-6 周 | 低 | 无 | 否（最后做）D10a ✅ 2026-10-01 |
| D11 | Tauri 2 评估 | 4-6 周 | 低 | 无 | 等存疑时启动 |

## 推荐执行顺序

```
Phase D 阶段 1（先打基础）:
  D1 → D3 → D7a → D7b           (2-3 周)

Phase D 阶段 2（扩展功能）:
  D2 → D4 → D5a → D5b → D5c     (并行 6-8 周)

Phase D 阶段 3（生态与远期）:
  D6 → D8a → D8b → D9 → D10 → D11  (按需)
```

## 任务粒度与建议会话拆分

每个会话预估：1-5 个工作日工作量，独立 commit、tsc/test/lint 全绿。

| 任务 | 拆分会话数 | 会话 ID 前缀 |
|------|----------|-------------|
| D1 | 2 | D1a, D1b |
| D2 | 1 | D2 |
| D3 | 1 | D3 |
| D4 | 1 | D4 |
| D5 | 3 | D5a, D5b, D5c |
| D6 | 1 | D6 |
| D7 | 2 | D7a, D7b |
| D8 | 2 | D8a, D8b |
| D9 | 1 | D9 |
| D10 | 4 | D10a-D10d |
| D11 | 1 | D11 |

**总计 19 个会话**。

## 详细会话启动 Prompt

每会话独立的 Prompt 见：
- [./prompts/D1a-agent-manager-session-lifecycle.md](./prompts/D1a-agent-manager-session-lifecycle.md)
- [./prompts/D1b-agent-manager-fallback-recovery.md](./prompts/D1b-agent-manager-fallback-recovery.md)
- [./prompts/D2-floating-panel-shell.md](./prompts/D2-floating-panel-shell.md)
- [./prompts/D3-wiki-coverage.md](./prompts/D3-wiki-coverage.md)
- [./prompts/D4-mcp-health-panel.md](./prompts/D4-mcp-health-panel.md)
- [./prompts/D5a-recipe-dag-schema.md](./prompts/D5a-recipe-dag-schema.md)
- [./prompts/D5b-recipe-dag-delegate.md](./prompts/D5b-recipe-dag-delegate.md)
- [./prompts/D5c-recipe-dag-viz.md](./prompts/D5c-recipe-dag-viz.md)
- [./prompts/D6-opentelemetry.md](./prompts/D6-opentelemetry.md)
- [./prompts/D7a-wiki-lint-fix-actions.md](./prompts/D7a-wiki-lint-fix-actions.md)
- [./prompts/D7b-writeback-rollback.md](./prompts/D7b-writeback-rollback.md)
- [./prompts/D8a-canvas-tree-layout.md](./prompts/D8a-canvas-tree-layout.md)
- [./prompts/D8b-canvas-force-layout.md](./prompts/D8b-canvas-force-layout.md)
- [./prompts/D9-a2a-protocol.md](./prompts/D9-a2a-protocol.md)
- [./prompts/D10a-yjs-doc-sync.md](./prompts/D10a-yjs-doc-sync.md)
- [./prompts/D10b-yjs-awareness.md](./prompts/D10b-yjs-awareness.md)
- [./prompts/D10c-yjs-persistence.md](./prompts/D10c-yjs-persistence.md)
- [./prompts/D10d-yjs-conflict.md](./prompts/D10d-yjs-conflict.md)
- [./prompts/D11-tauri-eval.md](./prompts/D11-tauri-eval.md)

## 通用会话执行模板

每个会话启动时遵循以下模式（详见各 Prompt 头部"会话流程"段）：

1. **读基线**：先读本目录的 `../PHASE_D_TASKS.md` + 对应 Prompt + `../../ROADMAP.md` 三份文档
2. **建工作分支**：`git worktree add ../bizgraph-phase-<id>`
3. **建跟踪文档**：`docs/tasks/<YYYY-MM-DD>-<id>.md`，参考 `../tasks/2026-09-30-base-foundation.md` 模板
4. **实施**：按 Prompt 列出的"任务清单"逐项推进
5. **验证**：每个 commit 前必过 `npx tsc --noEmit` + `npm run test` + `npm run lint`
6. **收尾**：PR 合并 + 回到本任务清单勾选完成

## 风险与注意事项

- **D1 是阻塞型**：所有后续 Phase D 任务都从 AgentManager 派生，D1 不完成则其他任务需要绕过 god file
- **D10 Yjs 是兼容性破坏型**：可能涉及数据迁移，建议放最后做
- **D5 DAG 涉及 SubagentManager**：与基座版 Recipe runner 集成，需要先读 `src/main/recipes/runner.ts`
- **D11 Tauri 是评估型**：不是开发任务，是产出报告

## 跟踪本文件

每完成一个会话，把对应行的 `[ ]` 改为 `[x]` 并补充"完成时间"。