# D7b: 写回回滚 UI（已接受撤回）

## 会话元数据

- **ID**: D7b
- **前置**: 基座 v1（WritebackPanel 已支持 pending → accepted/discarded）
- **工作分支**: `claude/phase-d7b-writeback-rollback`
- **预估工作量**: 3-5 工作日
- **依赖**: 无
- **并行**: D7a

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d7b-writeback-rollback`
- 路径：`.claude/worktrees/phase-d7b`

## 上下文

基座版 WritebackPanel 状态机：`pending → accepted | discarded`。accepted 后无法撤回 — 用户后悔时只能手动删数据库行 + 删图节点/边。

D7b 加：
- accepted 项目可撤回 → 回到 pending 状态
- 回滚时同时撤销：图节点/边恢复（如已删除）+ Wiki 页面追加删除标记

## 任务清单

### D7b-1：扩展 WritebackItem 状态机

- 当前：`pending | accepted | discarded`
- 改为：`pending | accepted | discarded | rolled_back`
- 转换规则：
  - `pending → accepted | discarded`（不变）
  - `accepted → rolled_back`（新）
  - `discarded → pending`（恢复误操作）

### D7b-2：回滚动作

- 写回类型 = `append-log`：从 Wiki 页面移除该次会话的 `## 会话日志` 段落（精确锚定 session id）
- 写回类型 = `new-page`：删除 Wiki 页面（同时清理 wikilink 反向链接）
- 写回类型 = `graph-node`：恢复图节点（如果用户没手动删除）
- 写回类型 = `graph-edge`：恢复边

### D7b-3：IPC 加 rollback 通道

- `writeback:rollback(itemId)` → 撤销已接受的写回
- 返回：rollbackResult { success, undoneActions: string[] }
- 失败原因：节点已被手动删除 → 部分回滚

### D7b-4：WritebackPanel UI

- accepted 项加「撤回」按钮（带确认 dialog：会撤销 N 个动作）
- rolled_back 项灰色显示 + hover 显示撤销详情
- 历史 tab 保留 30 天回滚记录

### D7b-5：测试

- `src/main/services/__tests__/writeback-rollback.test.ts` ≥ 8 个 case
  - append-log 回滚（移除段落）
  - new-page 回滚（删页 + 反向链接）
  - 部分回滚（节点已被删）
- `src/renderer/components/wiki/__tests__/WritebackPanel.test.tsx` ≥ 4 个 case
  - 撤回按钮
  - 确认 dialog
  - rolled_back 显示

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿（基座版 writeback 测试零回归）
- [ ] `npm run lint` 零警告
- [ ] 手动：接受一个写回 → Wiki 页面有日志 → 点撤回 → 日志消失

## 关键参考

- `src/main/services/writeback-service.ts`（基座版写回引擎）
- `src/main/repositories/writeback-repository.ts`（DB schema）
- `src/renderer/components/wiki/WritebackPanel.tsx`
- `src/main/wiki/ingest-service.ts`（页面操作复用）

## 完成定义

- [ ] D7b-1 ~ D7b-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D7b 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d7b.md` 跟踪文档