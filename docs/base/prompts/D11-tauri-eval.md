# D11: Tauri 2 评估

## 会话元数据

- **ID**: D11
- **前置**: 基座 v1 + 至少 D3
- **工作分支**: `claude/phase-d11-tauri-eval`（**注意：本任务不开发，是评估**）
- **预估工作量**: 1-2 周（**纯研究，产出报告**）
- **依赖**: 无
- **触发条件**: Electron 包体积成为用户痛点时启动

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d11-tauri-eval`
- 路径：`.claude/worktrees/phase-d11`
- ⚠️ 本任务是**评估**，无产品代码改动；产出物在 `docs/eval/`

## 上下文

BizGraph 当前用 Electron（基座版）+ better-sqlite3 + 多进程。生产构建 ~250MB（Mac DMG）。
Tauri 2 用系统 WebView + Rust 后端，理论上可缩到 ~30MB。但迁移成本巨大：需要重写主进程为 Rust、改 IPC 协议、所有 Node.js native 模块（better-sqlite3）都要替换。

D11 **不开发，只评估**。产出 go/no-go 报告。

## 任务清单

### D11-1：建立 Tauri 2 PoC

- 新建独立 worktree：`bizgraph-tauri-poc/`
- 仅迁移基座版**核心功能**：
  - 启动 Electron 窗口 + 渲染 React SPA
  - 1 个 IPC 通道（recipes:list）
  - SQLite 用 `tauri-plugin-sql`（D1 调研）
- 不做：迁移 SubagentManager / MCP / Recipes 全部

### D11-2：性能对比

- 冷启动时间：Electron vs Tauri PoC
- 包体积：基座版 .dmg / .exe vs Tauri
- 内存占用：基座版空闲 vs Tauri PoC 空闲
- SQLite 性能：tauri-plugin-sql vs better-sqlite3

### D11-3：迁移成本估算

- 列出每个主进程模块的迁移难度：
  - 直接迁移：日志、IPC、settings
  - 中等：AdapterRegistry、SubagentManager
  - 困难：better-sqlite3 → tauri-plugin-sql、native modules
- 估算人月（PM）：基座版 ~ 50k 行 TS → 等价 ~ 15k 行 Rust + 重写 IPC

### D11-4：Go / No-Go 报告

`docs/eval/2026-XX-XX-tauri-migration-eval.md`：

- **结论**：建议保留 Electron / 启动 Tauri 迁移
- **理由**：基于上述数据
- **触发条件**：什么时候重做这个评估（包体积 / 性能阈值）
- **备选方案**：瘦身 Electron（删除 unused adapters、Tree-shake）

## 验证门槛

- [ ] Tauri PoC 跑通
- [ ] 报告文档 ≥ 30 页（含数据表 + 决策矩阵）
- [ ] 与基线（基座版 Electron）数据可比
- [ ] PR 不接受代码，仅接受报告（`docs/eval/`）

## 关键参考

- Tauri 2 文档：https://tauri.app/v2/
- `tauri-plugin-sql` 文档：https://v2.tauri.app/plugin/sql/
- 基座版 size profile：`package.json` build config

## 完成定义

- [ ] D11-1 ~ D11-4 全部完成
- [ ] 评估报告 PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D11 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d11.md` 跟踪文档

## ⚠️ 重要

- **这不是开发任务**。不要被诱惑去"实现" Tauri 迁移 — 这是 go/no-go 评估
- 如果结论是 go，则 Phase E 才启动实际迁移（不在 Phase D 范围内）