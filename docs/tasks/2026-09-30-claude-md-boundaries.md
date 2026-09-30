# CLAUDE.md Boundaries 章节 · 任务跟踪

> 创建：2026-09-30
> 范围：纯文档改动（`D:\tiangong\CLAUDE.md`）

## 当前状态

**完成** — 借鉴 `dsh-synapse` 的「Boundaries with DSH」设计哲学，在 CLAUDE.md 新增顶级章节「Boundaries with Agent CLI」并补 3 条 Key Conventions。本次无代码改动、无 commit（纯文档）。

## 目标

BizGraph 编排 Agent CLI 但严格保持自身职责边界。把"不做什么"写在最显眼位置，让贡献者一眼看清哪些是红线。

## 任务清单

- [x] T1: 更新 CLAUDE.md「最后更新」日期 `2026-08-01 → 2026-09-30`
- [x] T2: 在 Architecture 之后新增顶级章节「Boundaries with Agent CLI」（7 条边界）
- [x] T3: Key Conventions 末尾新增 3 条（IPC 错误透传 / FloatingPanel 共享外壳 / 状态机收敛于 NodeRepository）
- [x] T4: 本任务跟踪文档

## 验证门槛（纯文档）

- [x] 无代码改动，无需 `npx tsc --noEmit` / `npm run test` / `npm run lint`
- [x] 与现有 Key Conventions 风格一致（简短陈述句 + 文件路径引用）

## 关键决策

- **位置选择**：放在 Architecture 之后而非 Key Conventions 之内。理由：Boundary 是"系统级约束"，与 Architecture 同级；Key Conventions 是"开发规范"。
- **借鉴而非照搬**：`dsh-synapse` 列 5 条 BizGraph 列 7 条。BizGraph 增加 3 条项目特有的边界（多 CLI 协议不归一、IPC 不替代 OS 沙箱、不污染 KV-cache）。
- **Key Conventions 三条对应三类已知债务**：
  - IPC 错误透传 → 对应 Phase A1（`createTypedHandle` 改造）
  - FloatingPanel 共享外壳 → 已知限制（`docs/tasks/2026-07-30-query-writeback.md` 跟进项 #4）
  - 状态机收敛于 NodeRepository → 对应 Phase A1（`agent-manager.ts:968-981` 裸 SQL 旁路修复）
- **不动现有章节**：尊重"不要创建带版本后缀的文档副本"约定，原地更新 `D:\tiangong\CLAUDE.md`。

## 后续跟进（不阻塞）

- 与 `docs/tasks/2026-09-30-state-machine-bypass-fix.md`（Phase A1）联动，任务交付时同步更新 Boundary 章节
- Phase B/C 完成后，检查 Boundary 是否需要增补（例如 MCP 一等公民化后考虑「MCP server 配置不绕过 CLI 工具检测」）

## 已知注意事项

- 本次改动不产生 commit（纯文档，无 CI 触发价值）
- 与 CLAUDE.md 顶部 `> 最后更新：...` 同步刷新