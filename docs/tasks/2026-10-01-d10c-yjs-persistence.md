# D10c Yjs persistence（Y.Doc 快照持久化 + 启动加载 + 老数据迁移）· 任务跟踪

> 创建：2026-10-01
> 范围：D10a（YjsDocument + WS 同步基础设施）+ D10c（yjs_snapshots 表 + snapshot save/load + 老 SQLite 节点/边一次性迁移到 Y.Doc）
> 前置：D10a / D10b 文档原计划作为前置，但实际未落地 → 本次合并实施 D10a + D10c。D10b（awareness/cursor）仍属后续。

## 当前状态

**✅ 完成**：`npx tsc --noEmit` 零错误，`npm run lint` 零警告，realtime 模块 43 个测试全部通过（yjs-doc: 19 / persistence: 16 / bidirectional-sync: 8）。YjsRealtime 已在 `ipc-handlers.ts` 启动阶段调用，`index.ts` 退出路径补 `shutdown()`。

## 目标

让每张图对应一个 Y.Doc 内存权威；Y.Doc 任意变更 → SQLite 镜像同步 + 防抖 snapshot 保存到 `yjs_snapshots` 表；启动按 `graph_id` 优先加载 snapshot，缺失时从老 `nodes`/`edges` 表回填一次（migrateFromLegacy）；可选 y-protocols/sync WebSocket 端点 `ws://127.0.0.1:1236/graph/<graphId>` 用于渲染端直连。

## 设计要点

- **YjsDocument**（`src/main/realtime/yjs-doc.ts`）：Y.Doc 包一层；节点/边用 `Y.Map<id, Y.Map<key, value>>` 嵌套；`patchNode`/`patchEdge` 走字段级 update；`setNode`/`setEdge` 走顶层 create；`deleteNode`/`deleteEdge` 走顶层 delete；统一通过 `doc.transact()` 包事务；深观察器把 `YEvent` 折叠成扁平的 `(entity, kind, id, data)` 列表；data 携带完整现态便于 SQLite 镜像直接落盘。
- **SnapshotStore**（`src/main/realtime/snapshot-store.ts`）：`yjs_snapshots` 表读写；UPSERT（按 graph_id 唯一）；`migrateFromLegacy()` 一次性把老 `nodes`/`edges` 行编码进 Y.Doc 并保存快照（幂等：已存在快照的图跳过）。
- **SnapshotPersistence**（`src/main/realtime/snapshot-persistence.ts`）：防抖 1s 落盘；`dispose` 时立即 flush（防止最后变更丢失）；`saveSnapshotImmediate` 同步逃生口。
- **BidirectionalSync**（`src/main/realtime/bidirectional-sync.ts`）：`attachDiffHandlers(doc, {nodeRepo, edgeRepo})` 注册观察器 → `nodeRepo.create/update/delete` 与 `edgeRepo.create/update/delete` 镜像；`patchNode` 触发 update 时传完整现状；meta 不写 SQLite；`populateFromRows(doc, nodes, edges)` 反向 hydrate。
- **YjsWsServer**（`src/main/realtime/ws-server.ts`）：y-protocols/sync 二进制协议；URL 路由 `/graph/<graphId>`；服务端发 sync step 1，接收 sync step 2 / update；doc 端 update → 转发到所有 ws client（跳过回声 `origin === ws`）；预留 `MESSAGE_AWARENESS = 1` 给 D10b。
- **YjsRealtime**（`src/main/realtime/yjs-realtime.ts`）：单例协调器；`init()` 跑 `migrateFromLegacy` → 为每张图 `loadDoc`（优先 snapshot applyUpdate，否则 fallback 懒 hydrate）→ 绑 `attachDiffHandlers` + `attachSnapshotPersistence` → 启动 WS server（best-effort，失败不阻塞）。

## 数据库

Schema v11：`yjs_snapshots(graph_id PK, doc_state BLOB, schema_version INTEGER DEFAULT 1, updated_at TEXT)` + 索引 `idx_yjs_snapshots_updated_at(updated_at DESC)`。`CURRENT_SCHEMA_VERSION = 11`。

老 `nodes`/`edges` 表保留（D10c 是渐进升级；D10b/D10d 之后再做切换）。

## IPC / 集成

- `ipc-handlers.ts:242-258` — `registerIpcHandlers` 启动期构造 `YjsRealtime`，`setYjsRealtime(yjs)` 后 `yjs.init().catch(...)`（失败不阻塞主流程）。
- `index.ts:288-296` — 退出期 `getYjsRealtime().shutdown()` flush 所有快照 + 停 WS server。
- Y.Doc → SQLite 镜像写入仍受 `NodeRepository.update` 的 `validateNodeTypeTransition` 校验保护（D10c 不绕过状态机）。

## 任务清单

- [x] T1: package.json — `yjs@13.6.20` / `y-protocols@1.0.6` / `ws@8.18.0` / `lib0@0.2.99` / `@types/ws@^8.5.13`
- [x] T2: `src/shared/yjs.d.ts` — yjs 包无自带 .d.ts，手写 ambient 声明覆盖 `Doc/YMap/YEvent/YMapEvent/encodeStateAsUpdate/applyUpdate`
- [x] T3: tsconfig.json include 加 `src/shared/**/*.d.ts`
- [x] T4: database.ts v11 — `yjs_snapshots` 表 + 索引
- [x] T5: `src/main/realtime/yjs-doc.ts` — YjsDocument 包装层（setNode/patchNode/deleteNode/getNode/listNodes/nodeCount + edges + meta + observe + transaction + encodeState + applyUpdate + fromUpdate + destroy）；≥19 测试覆盖
- [x] T6: `src/main/realtime/snapshot-store.ts` — SnapshotStore（save/getLatest/delete/listGraphIds + migrateFromLegacy）；≥10 测试覆盖
- [x] T7: `src/main/realtime/snapshot-persistence.ts` — attachSnapshotPersistence 防抖 1s + dispose 立即 flush + onError/onSaved 钩子
- [x] T8: `src/main/realtime/bidirectional-sync.ts` — Y.Doc → SQLite 镜像 + populateFromRows 反向 hydrate；≥8 测试覆盖
- [x] T9: `src/main/realtime/ws-server.ts` — YjsWsServer（y-protocols/sync 二进制协议 + URL 路由 + origin 回声跳过）
- [x] T10: `src/main/realtime/yjs-realtime.ts` — YjsRealtime 协调器 + setYjsRealtime/getYjsRealtime/lookupYDoc 单例；43 个测试覆盖
- [x] T11: ipc-handlers.ts 启动期 wiring + index.ts 退出期 shutdown wiring

## 测试结果

- `npx tsc --noEmit` — 零错误
- `npm run lint` — 零警告
- `npx vitest run src/main/realtime/` — 43 passed (3 files)
  - `yjs-doc.test.ts`: 19 case（CRUD + observe 三态 + 事务原子性 + 观察器抛错不阻塞 + round-trip + 10k 节点 < 2s）
  - `persistence.test.ts`: 16 case（save/getLatest/upsert/schema_version/delete/list + 启动还原 + migrateFromLegacy 三态 + 防抖 1s + dispose flush + onError + 10k < 500ms）
  - `bidirectional-sync.test.ts`: 8 case（节点 create/update/delete 路由 + 边 create/update/delete 路由 + meta 不写 SQLite + 错误隔离 + unsubscribe + populateFromRows）

## 未在本次 commit

- **D10b awareness/cursor** — 留待后续 PR；ws-server 已预留 `MESSAGE_AWARENESS = 1` 常量与跳过逻辑。
- **renderer y-indexeddb 直连** — 当前未启用；ws-server 已就位，渲染层接入由后续 D10d 决定。
- **SQLite → Y.Doc 反向同步**（IPC 写老 path 自动更新 Y.Doc）— 仍由调用方在 IPC handler 中显式调 `applySqliteChangesToYDoc()`；后续接入时需要做"老 IPC 路径 → Y.Doc 注入"的最小封装。
