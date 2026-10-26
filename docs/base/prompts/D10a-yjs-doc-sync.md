# D10a: Yjs 文档模型与同步

## 会话元数据

- **ID**: D10a
- **前置**: 基座 v1
- **工作分支**: `claude/phase-d10a-yjs-doc-sync`
- **预估工作量**: 7-10 工作日
- **依赖**: 无
- **后续**: D10b / D10c / D10d

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d10a-yjs-doc-sync`
- 路径：`.claude/worktrees/phase-d10a`
- ⚠️ WebSocket server 端口：1234（多 worktree 并行请参考指南分配不同端口）

## 上下文

Yjs 是 CRDT 库，用于多人实时协作。D10a 把 graph / node / edge 改为 Yjs 文档，主进程 + 渲染进程通过 y-protocols/sync 同步。

后续 D10b 加 awareness（光标/选区），D10c 加 persistence（IndexedDB + SQLite），D10d 处理冲突策略。

## 任务清单

### D10a-1：依赖

- `yjs`
- `y-protocols/sync`（基于 WebSocket 二进制协议）

### D10a-2：Yjs 数据模型

- `src/main/realtime/yjs-doc.ts`
- 每 graph 一个 `Y.Doc`
- 子结构：
  - `nodes: Y.Map<NodeId, Y.Map<key, value>>`
  - `edges: Y.Map<EdgeId, Y.Map<key, value>>`
  - `meta: Y.Map<key, value>`（graph 元数据）

### D10a-3：主进程 sync provider

- `src/main/realtime/ws-server.ts`
- WebSocket server（基座版无 — 引入 `ws` 库）
- 端口从 settings 读（默认 1234）
- 消息路由：client ↔ Y.Doc（基于 doc id = graph id）

### D10a-4：双向同步

- Yjs ↔ SQLite repository 双向转换
- 渲染进程通过 IPC 间接访问 Y.Doc（renderer 不直接连 WS）
- 启动时从 SQLite hydrate，运行时 SQLite 是 Y.Doc 的 mirror

### D10a-5：测试

- `src/main/realtime/__tests__/yjs-doc.test.ts` ≥ 8 个 case
  - Y.Doc 操作 → SQLite 同步
  - SQLite 修改 → Y.Doc 同步
  - 并发修改收敛

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动：启动 BizGraph → 修改节点 → 重启 → 修改从 SQLite 恢复

## 关键参考

- Yjs docs：https://docs.yjs.dev/
- y-protocols：https://github.com/yjs/y-protocols
- `src/main/repositories/graph-repository.ts`（SQLite 层）
- `src/main/ipc/graph.ts`（IPC 同步点）

## ⚠️ 风险

- **D10 是数据模型破坏性变更**：现有 SQLite 行 → Yjs 文档。建议加 migration step（自动转换）
- D10a 不引入迁移；D10c 做

## 完成定义

- [ ] D10a-1 ~ D10a-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D10a 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d10a.md` 跟踪文档