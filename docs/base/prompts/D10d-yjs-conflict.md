# D10d: Yjs 冲突解决策略

## 会话元数据

- **ID**: D10d
- **前置**: D10c 已合并
- **工作分支**: `claude/phase-d10d-yjs-conflict`
- **预估工作量**: 3-5 工作日
- **依赖**: D10c

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d10d-yjs-conflict`
- 路径：`.claude/worktrees/phase-d10d`
- ⚠️ WebSocket server 端口：1237（D10a/b/c 用 1234/1235/1236，请避让）

## 上下文

CRDT 保证最终一致性，但用户期望的语义不是"最后一个写入者赢"：
- 同时改一个节点的 title：A 改成 "Foo"，B 改成 "Bar" → 当前结果是字符串拼接
- 同时删一个节点：A 删除，B 编辑其字段 → 取决于操作顺序

D10d 加冲突解决策略（按业务规则）：
- text 字段用 CRDT（标题、描述）— 自动合并
- enum 字段（status）— 状态机校验，非法转换 reject
- 节点/边的 create / delete — 用 Lamport timestamp 排序

## 任务清单

### D10d-1：字段分类

- 创建 `src/main/realtime/conflict-rules.ts`
- 每个字段标注：merge 策略（text / last-write-wins / state-machine / lamport）
- text 字段：`Y.Text` 而非 `Y.Map` 存值（自动 CRDT 合并）
- enum 字段：写前查状态机，非法转换抛出 conflict error

### D10d-2：状态机校验

- 引入 `src/shared/state-machine.ts`（已存在）的 NodeStatus / BugStatus 转换
- Y.Doc observe → 触发校验 → 非法时 rollback 该字段

### D10d-3：UI 冲突提示

- 当 CRDT 合并产生非用户预期结果时（如 status 被拒绝）→ toast 提示 + 自动恢复
- LintPanel 加冲突报告（按用户分组的「最近 10 次冲突」）

### D10d-4：测试

- `src/main/realtime/__tests__/conflict-resolution.test.ts` ≥ 10 个 case
  - text 字段并发编辑合并
  - status 非法转换拒绝
  - delete vs edit 处理顺序
  - Lamport timestamp 一致性

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动：两个窗口同时改同一节点 title → 字符串合并 → 看到结果

## 关键参考

- `src/shared/state-machine.ts`（已存在）
- `src/main/realtime/yjs-doc.ts`
- Yjs Conflict resolution 文档：https://docs.yjs.dev/guides/managing-conflicts

## 完成定义

- [ ] D10d-1 ~ D10d-4 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D10d 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d10d.md` 跟踪文档

## D10 全任务完成后的总效果

- 多用户实时协作画布
- 离线编辑 → 重连同步
- 业务规则自动校验（CRDT + 状态机）
- 完整可投入生产的实时画布方案

至此 Phase D 结束。可以宣告 v2.0 协作版本。