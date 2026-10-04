# D10c: Yjs 持久化与数据迁移

## 会话元数据

- **ID**: D10c
- **前置**: D10a + D10b 已合并
- **工作分支**: `claude/phase-d10c-yjs-persistence`
- **预估工作量**: 7-10 工作日
- **依赖**: D10a, D10b

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d10c-yjs-persistence`
- 路径：`.claude/worktrees/phase-d10c`
- ⚠️ WebSocket server 端口：1236（D10a/b 用 1234/1235，请避让）
- ⚠️ 本任务是数据 schema 破坏性变更，**必须在独立 userData 目录跑 dev**（参 WORKTREE_GUIDE.md 第 6 节）

## 上下文

D10a 实现 Yjs ↔ SQLite 双向同步，但启动从 SQLite 读 + 写 SQLite — 启动慢、容易丢更新。
D10c 改造持久化：
- Y.Doc update 二进制快照存 SQLite（每次有变化时增量保存）
- 启动时从最新 snapshot 加载
- 现有 SQLite 数据自动迁移到 snapshot 格式

## 任务清单

### D10c-1：Snapshot 存储

- 新表 `yjs_snapshots (graph_id, doc_state BLOB, updated_at)`
- 每次 Y.Doc 变化（防抖 1s）→ 编码为 `Y.encodeStateAsUpdate()` → INSERT or UPDATE
- 不再保留原 `nodes` / `edges` 表的数据（保留表结构以兼容老查询）

### D10c-2：启动加载

- 启动时按 graph id 读最新 snapshot
- `Y.applyUpdate(doc, snapshot)` 还原
- 没有 snapshot（首次）→ 走 D10c-3 迁移

### D10c-3：SQLite → Yjs 数据迁移

- 一次性迁移：把现有 `nodes` / `edges` 行转为 Y.Map 项
- 版本号 `CURRENT_SCHEMA_VERSION` 升级
- 老表保留作为只读 fallback（避免破坏现有 query）

### D10c-4：Renderer IndexedDB（可选）

- 用 `y-indexeddb` 在渲染端做本地缓存
- 离线编辑：renderer 缓存 → 重连后 sync 给主进程

### D10c-5：测试

- `src/main/realtime/__tests__/persistence.test.ts` ≥ 10 个 case
  - snapshot 写入正确
  - 启动加载正确
  - 老数据迁移正确
  - 大文档（10k 节点）性能：序列化 < 500ms

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动：用基座版（无 Yjs）创建一些图 → 升级到 Yjs 版本 → 数据完整保留

## ⚠️ 兼容性风险

- 这是**数据 schema 破坏性变更**。需要：
  - 数据库 schema version bump
  - 老用户首次升级走迁移
  - 失败回滚到原 schema（事务包裹）

## 关键参考

- `src/main/database.ts`（schema 版本管理）
- `src/main/realtime/yjs-doc.ts`（D10a）
- `src/main/repositories/graph-repository.ts`（数据源）
- Yjs update API：https://docs.yjs.dev/api/document/documents

## 完成定义

- [ ] D10c-1 ~ D10c-5 全部完成
- [ ] PR 合并到 main（建议加 `BREAKING CHANGE` 标签）
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D10c 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d10c.md` 跟踪文档