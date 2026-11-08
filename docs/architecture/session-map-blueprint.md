# 会话地图与任务编排蓝图（Session Map Blueprint）

> 状态：设计定稿（产品方已拍板）
> 范围：地图信息架构、字段级表结构、迁移顺序与回退、任务拆解机制、TestExecutor、IPC/渲染改动清单
> 非范围：审批网关内部实现、Agent 内核/驱动协议、上下文水位线、成本账本 —— 见 `agent-architecture.md`

---

## 0. 定位、边界与默认假设

### 0.1 与既有文档的分工

| 文档 | 负责 |
|---|---|
| `agent-architecture.md` | Agent Runtime、审批网关、Bash 策略、会话恢复、能力矩阵、费用账本 |
| `agent-rollout.md` / `verification-ledger.md` | 交付顺序、默认矩阵、验证口径 |
| **本文** | 三真图信息架构、`entity_key` / `node_links`、状态双轨与证据、任务对象、拆解机制、TestExecutor、迁移与回退 |

本文不重复解释审批网关、驱动能力矩阵、会话恢复；需要时直接引用既有章节。`ContextBundle` 与尾块协议（tail-block）同样不在本文定义，以 `agent-architecture.md` 为准。

### 0.2 两个必须分开的问题

这两件事在实现上相关，在产品语义上**不能混为一谈**：

1. **链接准确性**（`entity_key` + `node_links`）：解决"这是不是同一件事"。
   - 用于：跨图对应（产品图 ↔ 开发图 ↔ 测试图）、克隆/拆分/合并后的身份延续、节点与会话/任务/证据的挂载。
2. **完成度真实性**（证据等级 E0–E4 + `evidence_refs`）：解决"到底做完没有"。
   - 用于：执行状态派生、验收判定、过期告警、人工确认时的事实依据。

> **只有链接会得到一张漂亮但会说谎的地图。**
>
> `node_links` 能让地图"连得上、看起来完整"，但它只证明"这两个节点是同/相关的一件事"，不证明"这件事做完了"。任何把链接存在性或链接数量当作完成度的展示、统计或自动化判断，都是错误的。完成度只允许来自 `node_evidence` 与派生 `execution_state`。

### 0.3 默认假设（影响结论处均已标注）

| 编号 | 假设 | 影响 |
|---|---|---|
| A1 | 同一项目**不允许产生第二套 lineage**：导入在写任何图数据之前按 §2.6 强制查重，命中即拒绝；**例外**是"同一仓库的不同分支/副本"（目录名不同），经用户显式勾选后允许并行导入，各自的 `entity_key` 独立 | 决定 `entity_key` 的唯一维度、回填算法与 S1 的导入幂等 |
| A2 | 被管理项目通常位于 git 仓库；**非 git 项目保留 E4 人工签收入口，证据等级最高 E4**，但必须标记 `reproducible=0`、`version_binding='none'`，不得与可复现证据混同（§3.5） | 决定 E3/E4 的可得性、展示口径与失效判据 |
| A3 | 本期测试命令本地串行执行，不并行、不跨机 | 决定 TestExecutor 并发模型 |
| A4 | TestExecutor 只执行计划内白名单命令，不支持交互式/长驻命令 | 决定审批粒度 |
| A5 | 会话内容继续存放在 `chat_threads` / `chat_messages`，不复制、不迁移 | 决定 `node_session_links` 只做引用 |
| A6 | 单机单用户，暂无团队协作；权限主体为本地用户 | 决定确认点与审批主体 |
| A7 | 不新增 `NodeType='task'`；测试资产使用独立 test 图节点 | 决定任务卡与测试资产的建模方式 |
| A8 | 允许一次较长的启动期迁移，无零停机要求 | 决定迁移采用表重建 + 启动期一次性执行 |
| A9 | 本期实现与验证以 POSIX（macOS / Linux）为范围；Windows 路径（盘符、反斜杠、大小写不敏感语义）不在本期验证范围 | 路径规范化按 POSIX 实现（§5.4.1）；遇到非 POSIX 根时 fail-closed，不猜测 Windows 路径规则 |

### 0.4 状态词与事实纪律（硬性）

本文所有关于"代码现在做什么"的陈述，只允许三种状态词：

| 状态词 | 含义 | 判定规则 |
|---|---|---|
| **已实施** | 代码里能 `git grep` 到或实测到 | 必须带 commit 或 `文件:行`；复核不到不得使用 |
| **已批准未实施** | 有裁决/定稿，但无对应代码 | 可以写行为契约，但不得写成"现在会…" |
| **仅建议** | 提案、候选、未决 | 不得进入验收口径 |

- 数字类结论（行数、表数、测试数、上限）必须 `git grep` 或实测复核后才能写；不得沿用外部文档或旧快照的数值。
- 引用外部文档必须标"对方版本 + 快照行数"（如 `Zcode v1.2.1，302 行`）；未标版本与行数的不引用。
- 每次改文档时，凡新增/改写的代码行为陈述，必须在报告里说明复核命令或降级原因。

---

## 1. 已定方案

### 1.1 三张真图 + 会话叠加层

| 图 | `graphs.type` | 职责 | 允许的节点类型 |
|---|---|---|---|
| 产品图 | `online` | 业务模块、流程、需求指引；人写状态 | `project` / `module` / `process` / `feature` / `wiki-page` |
| 开发图 | `dev` | 开发节点、会话、任务卡、证据叠加层 | 同上 + `bug` |
| 测试图 | `test` | 测试资产（套件/用例）、测试结果锚点 | `test-suite` / `test-case` / `wiki-page` |

- **不做第四张"会话地图"图。** 会话地图 = 开发图 + 叠加层（任务卡、会话时间线、执行状态、证据徽标）。
- 三图之间没有跨图 edge：`edges.source/target` 带 `REFERENCES nodes(id)`，跨图边会破坏 FK 与 `graph_id` 语义。跨图关系一律走 `node_links`。

```
                 node_links (cross-graph, key-based)
   online  ───────────────────────────────────────►  dev
  (需求/流程)      derives_from / implements        (开发节点)
        ▲                                              ▲
        │ covers                                       │ verifies
        └──────────────── test ◄───────────────────────┘
                     (test-suite / test-case)
```

同图内仍用 `edges` 表达结构（层级、依赖、业务流）。跨图只用 `node_links`。

### 1.2 `entity_key`：项目内稳定身份

- 定义：UUID，标识"一个业务实体"，与 node id 解耦。
- 同一实体在 online 与 dev 两张图中**共享同一个 `entity_key`**，node id 各自独立。
- 克隆（online → dev、以及未来的 dev → test 资产复制）保留源 `entity_key`。
- 新节点（用户在 dev 图直接新建的 bug、拆分产生的新节点）生成新 `entity_key`。
- `entity_key` 只回答身份，不回答完成度。
- `entity_key` **只在一次导入的身份域内共享**：同一仓库的不同分支/副本经确认并行导入时，两套图的实体键各自独立；"可能是同一实体"用 `node_links(relates_to)` 表达（§2.6），不合并键。

### 1.3 `node_links`：显式关系表

- key-based（`from_entity_key` / `to_entity_key`），`node_id` 仅作为可选快路径。
- 目的：抵抗克隆重生成 id、节点拆分、节点归档、图重建。
- 关系类型固定枚举，禁止自由文本关系。

### 1.4 状态双轨

| 轨道 | 存储 | 谁能写 | 语义 |
|---|---|---|---|
| 人工状态 | `nodes.status`（现有 7 值） | **只有人**（节点编辑、人工确认） | 人的判断与承诺 |
| 派生状态 | `node_execution_state`（缓存表）+ `node_evidence` | 系统按规则计算 | 系统观察到的事实 |

三条硬规则：

1. 证据可点开：每条 evidence 必须带可解析的 `ref_json`（文件路径/提交/会话 turn/测试输出），不允许只存一句"已完成"。
2. 证据带版本锚点：**E3 必须带代码 hash**（git commit sha，可含 dirty 标记），锚点变化后自动标 `stale`；**E4 是人工签收，明确无代码 hash、不可复现**，失效判据见 §3.5。
3. 自动推断只写建议：任何自动推断不得直接提高证据等级，只能写 `evidence_suggestions`，等人接受。

### 1.5 任务对象独立建表

- `work_items`（可嵌套、带 revision）+ `work_steps`（编排步）+ `work_runs`（执行记录）+ `node_session_links`。
- 地图上以**任务卡叠加层**呈现，不新增 `NodeType='task'`。
- 任务可以挂节点（`anchor_entity_key`），也可以挂在项目级（锚点为 NULL）。

### 1.6 拆解机制：结构推导 + 人工确认 + 可修订计划

- 边界由**现有结构**推导，模型只做选择与组织，不发明边界。
- 未过准入条件的子任务不得进入执行队列。
- 计划本身是可修订对象：`revision` + `supersedes`，旧证据冻结。
- 详见第 5 章。

### 1.7 TestExecutor 独立

- 独立服务，计划级一次性审批，隔离 worktree，命令走既有 Bash 策略分类器。
- 不复用 Agent 会话来判定通过，不复用 `RecipeRunner` 的 shell 步骤。
- 测试资产存 test 图节点，与 dev 实体用 `verifies` / `covers` 链接。

### 1.8 本期范围（L1 + L2）

做：

- 任务对象与 revision
- 结构推导拆解 + 人工确认
- 单 Agent 路由（能力票见 §5.9.5，本期只允许 Tier 1）
- 节点会话时间线
- 顺序多步执行（失败分类、超时、重启对账见 §5.9）
- 节点级测试执行与结果回写
- 测试失败 → bug 闭环与定向重测（§6.6）
- 手工用例走 E4 人工签收（§6.7）

不做：

- 流程级 DAG 并行
- 并行写同一节点
- 自动 merge
- 全自动 planner（无人工确认的计划不执行）
- 多 Agent 并行编排
- dev→online 结构变更提案 UI（§2.7，L3）

---

## 2. 链接准确性：`entity_key` 与 `node_links`

### 2.1 唯一性维度

```sql
CREATE UNIQUE INDEX ux_nodes_graph_entity_key ON nodes(graph_id, entity_key);
CREATE INDEX idx_nodes_entity_key ON nodes(entity_key);
```

- 唯一约束按 `(graph_id, entity_key)`：同一图内不允许同键；online 与 dev 是不同 `graph_id`，因此同一实体可共享键。
- `entity_key` 在 DDL 中**必须可空**：旧库迁移要经历 "建列 → 回填 → 建唯一索引"。若 DDL 写成 `NOT NULL`，`rebuildTableIfNeeded` 的 `CREATE TABLE backup AS SELECT *` 恢复路径会因旧行缺值直接失败。
- `entity_key` **必须写进 `nodes.createSql`**（可空、不进 `requiredColumns`）。若只靠 `addColumnSafe` 补列，任何一次 `nodes` 表重建都会把该列值静默丢弃。

### 2.2 生成、保留与回填规则

| 场景 | 行为 |
|---|---|
| 新库首次导入（online + dev 同批生成） | 同一 `tempId` 的两个节点共享一个 `entity_key` |
| `graphs` 克隆（`cloneGraphNodes`） | 直接复制源行 `entity_key`；node id 仍重新生成 |
| 用户在 dev 图手工新建节点 | 新 UUID |
| 拆分（split） | 新节点各自新 UUID + `split_from` 链接指向旧键 |
| 合并（merge） | 目标节点保留自己的键；源节点写 `merged_into` 链接后归档 |
| 测试图资产 | 新 UUID（测试资产是独立实体，不做身份合并） |
| 图快照恢复 / Yjs 重建 | **已实施（cc749ce）**：恢复本身不写 SQLite；恢复之后 doc 变更也不再写回 `nodes`/`edges`，只更新 `yjs_snapshots`。权威仍是 SQLite 权威列，`entity_key` 不因快照恢复而重算（P6 验收见 §8.11） |

#### 2.2.1 Yjs 单向只读：已实施（cc749ce）

**状态：已实施（代码级，`cc749ce`）。** 2026-11-07 以 `git grep` / `sed` 复核 HEAD。

**（历史：`cc749ce` 之前，现已不成立）** 旧实现为双向：恢复路径先 `applyUpdate` 把快照应用到内存 doc，再在 `yjs-realtime.ts:208` 附近挂写回 observer（`attachDiffHandlers`，来自 `bidirectional-sync.ts`），把 doc 变更写回 SQLite `nodes`/`edges`；WS 端接受 `sync step2` / `sync update` 并应用。**因此"恢复之后可经 1236 写回 `nodes`/`edges`"只在 `cc749ce` 之前的旧代码成立**，HEAD 已不成立。下文"以 §2.2.1 已核实结论为准"一律指本节现状段，不再指向旧行为。

**（现状：`cc749ce` 起）**
- `src/main/realtime/snapshot/bidirectional-sync.ts` 已删除；`git grep "attachDiffHandlers|bidirectional-sync" -- src` 无命中。
- doc → SQLite 写回已断开：`applyUpdate` 在前、`attachSnapshotPersistence` 在后，只挂快照持久化，不挂 `nodes`/`edges` 写回 observer。
- **WS 写消息拒绝：已实施（`cc749ce`）**：客户端发 `sync update` / `sync step2` / 其他 sync 子类型 → `ws.close(1008, …)` 且不应用（`ws-server.ts:168`、`:189`、`:193`）；step1 只返回缺失增量，服务端直接下发 step2。
- **1236 默认不启动：已实施（`987c226`）**：`yjs-realtime.ts` 的 `disableWebSocket` 默认值改为按 `BIZGRAPH_YJS_WS` 判定（仅 `1` / `true` / `yes` / `on` 视为显式开启）；`ipc-handlers.ts:348` 仍为 `new YjsRealtime(db)`，未传 options，故默认不再监听 `127.0.0.1:1236`；显式开启后才启动 WS。
- `graphs` 无写回路径；doc 变更只更新 `yjs_snapshots`，不改 `nodes`/`edges`。
- `nodes.entity_key` / `lifecycle_state` **仅建议**（本文规划，代码中不存在；`git grep` 无命中）。
- 已知缺陷（未修）：启动后新建图不进 doc 池（显式开启 WS 时连 `1236` 会被 `1008` 拒绝）；`node_id` 放宽仍是长期待办。

**验收口径（P6）**：默认启动下 `1236` 不监听；显式开启后写消息被拒；doc 变更后 `nodes`/`edges` 无新增/改写；旧快照可读；`entity_key` 不因恢复而重算。

**已批准未实施**：完全移除 Yjs（L3，§2.8）；删依赖/表、改 schema 版本不在本期。外部"拆除"方案本文不背书也不反驳。

#### 旧库回填算法（一次性，幂等）

对每个 `project_path`，配对一张 `online` 图与一张 `dev` 图（A1）。对两侧节点计算**结构签名**：

```
sig(node) = sha256(
  type + '|' +
  title_normalized + '|' +
  parent_signature_chain + '|' +
  sibling_ordinal            -- 按 (parent_id, COALESCE(sort_index, 大数), created_at, id) 排序后的序号
)
```

- `parent_signature_chain` 从根递归拼接；根为空。
- `title_normalized`：去首尾空白、连续空白折叠、大小写保持不变（中文标题不做大小写处理）。
- `sibling_ordinal` 抵消"同名兄弟"歧义。
- 匹配顺序：先精确签名；未命中的再退化为 `(type, title, parent_chain)` 唯一匹配；仍冲突则**不匹配**，各自分配新键。
- 幂等：仅对 `entity_key IS NULL` 的行执行；已有键一律不覆盖。
- 结果落 `map_migration_reports`（见 §7.2），记录 matched / unmatched / ambiguous 计数，供迁移验收。

**重复导入的已知局限**：新图与旧图的节点没有结构证据可以自动证明"同名即同一实体"，因此不做自动归一；且同项目重复导入本身会在入口被拒绝。指纹查重与放行规则见 **§2.6** —— 这是 S1 的硬前置，不是 S2 的增强项。

#### 2.2.2 S1 施工细则（B1）

> 本小节回答"S1 每一步谁写、什么时候写、写失败怎么办、怎么验收"。字段级 DDL 见 §7.2；判定顺序见 §2.6。S1 必须把 `entity_key` 回填与导入查重**放在同一个迁移批次上线**，不允许拆成两次发布。

**S1-a 不变量（先写死，后实现）**

| 编号 | 不变量 | 违反时 |
|---|---|---|
| I1 | `nodes.entity_key` 在 `createSql` 中且可空；不进 `requiredColumns` | 任何 `nodes` 重建都会丢键；拒绝发布 |
| I2 | S1 完成后，所有非删除节点的 `entity_key` 非空；同 `(graph_id, entity_key)` 唯一 | 回填报告 `null_after > 0` 或唯一索引建不起来 → S1 `failed` |
| I3 | 已有非空 `entity_key` 永不改写；回填只处理 `entity_key IS NULL` | 二次启动行数变化 → 回填不幂等，阻断 |
| I4 | 新节点创建必须写 `entity_key`（UUID v4）；克隆复制源键；测试资产新键 | 新行出现 NULL → 应用层 bug，写失败并回滚事务 |
| I5 | 导入查重在任何 graph/node 写入之前；拒绝时 `graphs`/`nodes`/`chat_threads` 新增行数为 0 | 拒绝后出现任一行 → P8 失败 |
| I6 | 允许导入时，`project_fingerprints` 与图创建在同一个事务提交 | 只落指纹不落图 / 只落图不落指纹 → P8 失败 |

**S1-b 迁移步骤（每步一个 `map_migration_reports` 行）**

| 步骤 | `stage` | 操作 | 事务边界 | 失败处理 |
|---|---|---|---|---|
| S1.1 | `S1.tables` | 建 `project_fingerprints` / `import_rejections` / `import_allowances` | 单事务，`CREATE TABLE` + 索引 + report `ok` | 回滚；数据库保持 v24；启动阻断，修 DDL 后重跑 |
| S1.2 | `S1.column` | `addColumnSafe('nodes','entity_key','TEXT')`，再核验 `createSql` 已含该列 | 单事务；只加列，不重建 `nodes` | 回滚；列不存在则下次重试；`createSql` 未含 → 拒绝继续 |
| S1.3 | `S1.backfill` | 按 §2.2 对每个项目回填；**只写 `entity_key IS NULL`** | 一个项目一个事务；项目内全成功才提交 | 项目失败 → 该项目回滚、report `failed`、整体 S1 阻断；已提交项目保留，可续跑 |
| S1.4 | `S1.indexes` | `CREATE UNIQUE INDEX ux_nodes_graph_entity_key` + `idx_nodes_entity_key` | 单事务 | 唯一冲突 → 回退到 S1.3 定位冲突行；不得用 `DROP INDEX` 掩盖冲突后继续 |
| S1.5 | `S1.import_path` | 导入流程改为"扫描 → 指纹 → 查重 → 允许才建图"（§2.6） | 代码路径，无 schema 变更 | 旧导入路径未关闭 → 拒绝发版；这是"重导丢会话"的唯一入口 |
| S1.6 | `S1.report` | 写回填统计与历史重复 lineage 报告（只报告，不自动删除/合并） | 单事务 | 报告失败不阻断数据，但 S1 记 `partial`，必须人工确认 |
| S1.7 | `S1.verify` | 计数、唯一性、二次启动、P1/P8 样本 | 只读 | 任一失败 → S1 `failed`，恢复 S0 备份或修复后重跑 |

**S1-c 回填精确规则（补齐 §2.2 未定的边界）**

1. **项目 → 图配对**：同一 `project_path` 下取 `online` 与 `dev` 各一张。若存在多张，按 `(created_at ASC, id ASC)` 取第一张为基准，其余写入 `details_json.duplicate_graphs`，**不参与回填、不自动归档**。
2. **签名输入**：`type` 用节点当前 `type`；`title_normalized` 按 §2.2 规则；`parent_signature_chain` 递归到根；`sibling_ordinal` 按父节点下 `(COALESCE(sort_index, 2147483647), created_at, id)` 升序从 0 开始。
3. **候选集**：同一 `project_path` 的 online/dev 两侧节点各自计算签名。先按签名精确分组；跨图同签名且**组内各只有 1 个节点**才配对。组内多节点 → 记为 `ambiguous`，不配对。
4. **退化匹配**：精确签名未配对的节点，按 `(type, title_normalized, parent_signature_chain)` 匹配；仅当两侧各只有 1 个候选时成立，否则 `ambiguous`。
5. **新键**：未配对节点（含 online 侧无 dev 对应、dev 侧新增）生成新 UUID v4；同一节点只生成一次。**不允许用标题/路径哈希代替 UUID**，避免改名后键漂移。
6. **占位节点**：`title` 为空、`type` 为 `project` 的根节点不参与跨图配对，各自新键；避免把一个项目的根误配到另一个项目。
7. **执行方式**：单项目事务内先 `SELECT id, ... FROM nodes WHERE entity_key IS NULL ORDER BY id`，再批量 `UPDATE nodes SET entity_key=? WHERE id=? AND entity_key IS NULL`。任何一条 `changes=0`（被并发写入）→ 该项目回滚并重试一次；仍失败则 `failed`。
8. **统计**：`stats_json` 至少含 `matched_exact` / `matched_fallback` / `unmatched` / `ambiguous` / `null_before` / `null_after` / `duplicate_graphs`；`details_json` 含每个未匹配节点的 `id/type/title/parent_id/reason`，用于人工复核。

**S1-d 导入查重精确规则（补齐 §2.6 的实现边界）**

- **指纹采集顺序**：`realpath(root)` → 名称/目录名规范化 → 受管文件枚举（忽略 `.git`、`node_modules`、`dist`、`build`、`.next`、`target`、`coverage`；锁文件**不忽略**，作为依赖内容信号）→ `max(mtime)` → 抽样 → 逐文件 `sha256`。
- **抽样算法**：文件按**项目根相对 POSIX 路径**排序；设可用文件数 `M`，目标 `N=12`：
  - `M ≥ N`：取索引 `floor(i*(M-1)/(N-1))`（`i=0..N-1`），重复索引去重；
  - `M < N`：全部取，`sample_count=M`；相似度分母用 `M`，不把缺失当"不匹配"。
  - 单文件读失败：记入 `errors_json` 并从可用集剔除；若可用集为空 → 走 §2.6 Step 4 抽样失败分支。
  - 二进制判定：前 4KB 含 NUL 或扩展名在黑名单（图片/压缩/可执行/字体）→ 跳过；不因跳过而降低分母。
- **相似度**：`similarity = 相同 sha256 的文件数 / sample_count`，保留 4 位小数写入 `matched_signals_json`；判定用未舍入值，展示用舍入值。
- **目录名规范化**：`basename(realpath(root))` 去首尾空白、转小写；比较用规范化值，落库保留原值。
- **mtime**：只写 `last_modified_at` 并在证据面板显示；**不参与拒绝/放行**（§2.6 规则 4）。
- **事务与并发**：指纹计算在事务外；得到结果后 `BEGIN IMMEDIATE`，重新读取 `project_fingerprints` 与 `import_allowances` 再判定（防止 TOCTOU）；允许时同一事务插入指纹与 `graphs`/`nodes`。`UNIQUE(root_path)` 冲突 → 回滚并按"同路径重复导入"拒绝，不重试覆盖。
- **拒绝记录**：拒绝时写 `import_rejections`，`matched_fingerprint_id` 可空（抽样失败/新项目无匹配时为空），`matched_signals_json` 必含 `dir_name_same`、`similarity`、`sample_count`、`mtime_used=false`、`decision_step`（如 `3b`）。
- **记住规则**：`import_allowances` 只在用户显式勾选时插入；命中时 `allowance_source='remembered_rule'`，并校验 `revoked_at IS NULL`。撤销是更新 `revoked_at/revoked_by`，不物理删除。
- **清理任务**：启动期 + 每日一次删除 `import_rejections.created_at < now-90d`（可配置）；删除前把计数汇总写入 `map_migration_reports(kind='import_dedup', stage='retention')`，聚合永久保留。`import_allowances` 不受 90 天影响。

**S1-e 回滚**

| 回滚点 | 动作 | 数据影响 |
|---|---|---|
| 刚建表、未接导入 | `DROP TABLE import_allowances/import_rejections/project_fingerprints`；`entity_key` 列保留 | 无业务数据丢失 |
| 已接导入、未产生放行 | 关闭查重开关，恢复旧导入路径（需书面确认，会重新暴露"重导丢会话"） | 已拒绝记录保留可查 |
| 已产生放行/回填 | 保留表与键；只回退读路径到 node id；不 `DROP INDEX` 除非唯一冲突已定位 | 键保留无害；不可回退已建图 |
| 唯一索引冲突 | 先定位冲突行并人工处置；禁止直接删索引长期运行 | 删索引 = 放弃唯一性，必须记风险 |

**S1-f 验收判据**

1. 真实库副本：回填两次，`null_after=0`、`matched/ambiguous` 与报告一致、第二次运行 0 行变化。
2. 构造 6 类导入样本：决策与 §2.6 完全一致；拒绝时三表新增 0 行；允许时指纹与图同事务。
3. 并发：两个导入同时指向同一 root，只有一个成功；另一个得到 REJECT 且无半行。
4. 故障注入：S1.1 后崩溃 → 重启可续跑；S1.3 中途崩溃 → 已提交项目不重写、未提交项目重跑；S1.4 冲突 → S1 `failed`，启动阻断。
5. 90 天清理：明细删除、聚合保留；`import_allowances` 保留。

### 2.3 `node_links` 设计要点

| 设计选择 | 理由 |
|---|---|
| 存 `entity_key` 而不是 node id | node id 在克隆/删除/重建后会变；键不会 |
| 不建到 `nodes` 的外键 | 外键会让"节点归档/图删除"直接抹掉关系历史；损坏应表现为 `status='orphan'` 而不是静默消失 |
| `node_id` 冗余保留 | 常用查询走 id 快路径；解析失败再回落到键 |
| `link_type` 固定枚举 | 防止自由文本导致语义漂移 |
| `UNIQUE(from_graph_id, to_graph_id, from_entity_key, to_entity_key, link_type)` | 同一图组合下同一语义的关系只允许一条；`entity_key` 跨图共享，不带 graph_id 会复用别图的端点图信息 |

语义约定：

| `link_type` | 方向 | 典型用途 |
|---|---|---|
| `derives_from` | dev/test → online | 开发节点源自哪个业务节点 |
| `implements` | dev → online | 开发节点在实现哪个需求 |
| `verifies` | test → dev | 用例验证哪个开发节点 |
| `covers` | test → online | 用例覆盖哪个业务流程 |
| `depends_on` | 任意 | 跨图依赖（图内依赖仍用 `edges`） |
| `split_from` | 新 → 旧 | 拆分来源 |
| `merged_into` | 源 → 目标 | 合并去向 |
| `supersedes` | 新 → 旧 | 版本替代 |
| `relates_to` | 对称 | 无更强语义的关联 |

#### 2.3.1 S2 施工细则（B1）

**不变量**

| 编号 | 不变量 | 违反时 |
|---|---|---|
| L1 | 新写入的 `node_links` 必须带 `project_path`（规范化 realpath）；跨项目链接一律拒绝 | 写失败并返回校验错误 |
| L2 | `from_entity_key` / `to_entity_key` 必须非空；不允许自链接 | 拒绝写入 |
| L3 | 每条链接的两端必须能在 `nodes(graph_id, entity_key)` 解析；解析失败只能落 `status='orphan'` 并在巡检报告里出现 | 创建接口拒绝；回填/拆分等系统路径可落 orphan |
| L4 | `(from_entity_key, to_entity_key, link_type)` 唯一；`relates_to` 按字典序规范化端点，避免 A→B 与 B→A 重复 | 冲突返回既有行，不新建 |
| L5 | `link_type` 的图类型方向必须符合矩阵（下表）；不合法组合拒绝，不靠语义约定 | 写失败 |
| L6 | 不建到 `nodes` 的外键；节点/图删除不得级联删除链接 | 任何 `ON DELETE CASCADE` 都驳回 |

**link_type × 图类型矩阵**

| `link_type` | from 允许 | to 允许 | 说明 |
|---|---|---|---|
| `derives_from` | dev / test | online | 开发/测试节点源自业务节点 |
| `implements` | dev | online | 开发节点实现需求 |
| `verifies` | test | dev | 用例验证开发节点 |
| `covers` | test | online | 用例覆盖业务流程 |
| `depends_on` | 任意 | 任意 | 跨图依赖；同图依赖仍用 `edges` |
| `split_from` | 任意 | 任意 | 必须同 `project_path`，建议同图类型 |
| `merged_into` | 任意 | 任意 | 必须同 `project_path` |
| `supersedes` | 任意 | 任意 | 版本替代，方向为新→旧 |
| `relates_to` | 任意 | 任意 | 对称；写入前按端点键字典序排序 |

**写入流程（`LinkService.create`）**

1. 规范化 `project_path`；校验 from/to 的 `graph_id` 属于该项目。
2. 解析 from/to 节点：`SELECT id, graph_type, lifecycle_state FROM nodes WHERE graph_id=? AND entity_key=?`。任一缺失 → 拒绝（系统回填路径例外，落 `orphan` 并写报告）。
3. 校验 link_type 矩阵、自链接、方向；`relates_to` 交换端点使 `from_entity_key <= to_entity_key`。
4. `BEGIN IMMEDIATE`；按唯一键查既有行：存在且 `status='active'` → 返回既有 id（幂等）；存在但 `status IN ('orphan','stale')` → 复活为 active 并更新 `updated_at/reason`，不新建。
5. 插入行：`id` 用 UUID v4；`origin` 按调用方 `human/derived/import`；`confidence` 默认 1.0；`from_node_id/to_node_id` 写解析到的当前 id；`created_at/updated_at` 同值。
6. 提交后发 `event:map-link-changed`；事务失败则回滚且不广播。

**孤儿与失效**

- **orphan**：任一端 `(graph_id, entity_key)` 在 `nodes` 不可解析，或图已删除。只由巡检/删除路径写，不由创建接口写。
- **stale**：端点仍可解析，但语义已过期（例如 `verifies` 的目标节点被新 revision 取代且链接未重建）。标记 stale 不删除，UI 显示"需复核"。
- **巡检**：启动后一次 + 每日一次 + `admin:map:integrity-check` 手动触发。SQL 逐条解析两端；对 `status='active'` 但解析失败的置 `orphan` 并计数；对不再满足 link_type 矩阵的置 `stale`。每轮写 `map_migration_reports(kind='integrity_check', stage='node_links')`，只报告、不自动删除。
- 巡检幂等：同一轮重复执行不改变行数；`updated_at` 只在状态真正变化时更新。

**拆分 / 合并传播（补齐 §2.4 的算法）**

- **拆分**：
  1. 旧节点 `lifecycle_state='split'`，保留原键与原行。
  2. 对每个新节点写 `split_from`（新→旧，`origin='derived'`）。
  3. 复制旧节点的出边类型 `derives_from` / `implements` / `covers` 到每个新节点；`verifies` 只在测试资产明确覆盖新节点时复制，不默认复制。
  4. `depends_on` / `relates_to` 不自动复制；需要时由人或派生规则显式创建。
  5. 旧节点的入边保持 active（历史仍指向旧节点）；不搬移、不改写。
- **合并**：
  1. 源节点 `lifecycle_state='merged'`，写 `merged_into`（源→目标）。
  2. 对源节点每条 active 链接（无论入边/出边），在目标节点补齐对应链接；`relates_to` 先规范化；已存在同键则跳过。
  3. 新链接 `origin='derived'`，`reason='merged_from:<source_key>'`；旧链接保留 active，用于追溯。
  4. 目标节点自身键不变；不把源键合并进目标键。
- 传播在一个事务内完成；任一步失败 → 回滚，节点生命周期不变。

**S2 回填（与 S1 同批上线后的只读阶段）**

1. 对每个项目，取 online/dev 基准图（与 S1 的配对规则一致）。
2. 对每个 online 节点，查同 `entity_key` 的 dev 节点；存在则插 `derives_from`（from=dev, to=online, `origin='import'`）。
3. 测试图未上线前不回填 `verifies/covers`；S4 后由测试资产创建流程补。
4. 回填按项目事务；重复执行按唯一键幂等；冲突行不覆盖人工链接。
5. 回填报告写 `map_migration_reports(kind='link_backfill', stage='S2')`，统计 inserted/skipped/orphan。

**回滚与验收**

- 回滚：关闭读写路径即回到"无链接"；表可保留空置。已人工写入的 `relates_to` 保留（无副作用）。
- 验收：P5 四场景（删/拆/并/删图）+ 重复链接 + 自链接 + 方向非法 + 对称重复 + 并发创建同一链接；孤儿扫描 0 误报；拆分/合并后旧链接仍可追溯、新链接可解析。

### 2.4 生命周期与完整性

**总原则：有历史的节点不硬删。** 节点一旦有 link / work_item / evidence / session，删除语义降级为归档。

| 场景 | 处理 |
|---|---|
| 普通删除（无依赖） | 允许硬删；删后其 `node_links` 行由巡检标记 `status='orphan'` |
| 有依赖删除 | `lifecycle_state='archived'`；节点行保留；叠加层默认隐藏；链接保持 `active`（仍可解析） |
| 拆分 | 旧节点 `lifecycle_state='split'`，新建 `split_from` 链接；下游 `derives_from`/`verifies` 由新节点**新建一份**（`origin='derived'`），不搬移旧链接 |
| 合并 | 源节点 `lifecycle_state='merged'` + `merged_into`；目标节点为源节点的每条 active 链接补建一条新链接，旧链接保留 |
| 图删除 | 前置校验：存在 `running` 的 `work_run` 或未完成 `work_item` 时**拒绝删除**；允许时把该图相关链接标记 `orphan`，并把该图节点的证据标 `stale`，不物理删除证据 |
| 孤儿清理 | `map_integrity_check` 任务：`status='active'` 但任一端 `(graph_id, entity_key)` 在 `nodes` 中不可解析 → 置 `orphan` 并写报告；不自动删除 |

### 2.5 再次强调

`node_links` 保证的是"同一件事"的连续性。一张图可以 100% 链接完整、0 孤儿，同时大部分节点实际没做完 —— 这正是必须有 §3 的原因。

### 2.6 重复导入：导入期强制查重（拒绝，不合并）

#### 已定规则

重复导入**不允许生成第二套 lineage**。导入流程在**写任何 graph/node 数据之前**做指纹查重，命中即拒绝，并展示"哪几项对上了"。不做静默合并，也不提供"关联/合并"入口。

理由：一旦允许并存，"同一实体多个 `entity_key`"就不可避免，之后所有跨图链接、时间线、证据都要处理二义性。在入口拒绝，比事后合并便宜一个数量级。

#### 指纹组成（4 项，全部可解释）

| 信号 | 计算方式 | 角色 |
|---|---|---|
| 项目名称 | 导入时的显示名；有 `package.json` 时用其 `name`，否则用目录名 | 证据 |
| 目录名 | `path.basename(realpath(projectRoot))` 规范化（小写、去首尾空白） | **主判据** |
| 最后修改时间 | 项目根下受管文件的 `max(mtime)`（忽略 `.git`、`node_modules`、构建产物） | 辅助证据，**不参与拒绝** |
| 内容抽样 | 确定性抽取 N=12 个文件（按路径排序后等距取样，跳过二进制/超大文件），逐文件 `sha256` 比对；`similarity = 相同文件数 / 抽样文件数` | **主判据** |

- 抽样清单必须随首次导入存入 `project_fingerprints.sample_files_json`（`path/size/sha256`），否则跨次无法比较。
- 缺失信号记 `null`，并在证据面板标注"未采到"，不得当成"不匹配"。

**已定参数**（写入配置，不硬编码）：`sampleSize=12`、`similarityReject=0.6`、`similarityBranchVariant=0.8`。先按默认值上线，后续按 `import_rejections` 的真实分布调整。

#### 可执行判定顺序（命中即停）

```
Step 0 规范化：root = realpath(projectRoot)；dirName = basename(root)；name = 项目名

Step 1 同路径：
  存在 fingerprint.root_path == root
    → REJECT（同一工作区重复导入）

Step 2 目录名相同：
  2a dirName 相同 且 content_similarity ≥ 0.6
        → REJECT（同一项目重导；mtime 只作证据展示）
  2b dirName 相同 且 content_similarity < 0.6
        → ALLOW_WITH_WARNING（同名目录但内容差异大，可能是另一个项目）

Step 3 目录名不同：
  3a content_similarity ≥ 0.8
        → 若存在 import_allowances(fingerprint_id, dirName) 且未撤销：
             ALLOW_AS_BRANCH_VARIANT，allowance_source='remembered_rule'（记录来源，不静默）
        → 否则交互导入：ALLOW_AS_BRANCH_VARIANT（同一仓库的不同分支/副本）
             用户在导入确认框显式勾选"这是不同分支/副本，允许并行导入"
             可再勾选"对同一指纹记住" → 写 import_allowances
             → 记录 decision='allowed_branch'，allowance_source='this_time'
        → 自动导入（无交互）：REJECT_BY_SIMILARITY（不得默认放行）
  3b 0.6 ≤ content_similarity < 0.8
        → REJECT_BY_SIMILARITY（按重复处理；证据列明相似度与命中项）
  3c content_similarity < 0.6
        → ALLOW（不同项目）

Step 4 抽样失败（无可采文件 / 全是二进制）：
  4a dirName 相同 且 name 相同 → REJECT（退回"名称 + 目录名"判据）
  4b 否则 → ALLOW_WITH_WARNING（提示"未能完成内容比对"，要求用户确认）
```

**明确规则**：

1. **同一仓库的不同分支允许并行导入**。不同分支在本地通常落在不同目录名，目录名是区分依据。
2. **"目录名不同 + 内容几乎一致"判为允许（分支/副本），不判拒绝**。这是同一仓库不同分支/本地副本的典型形态；但必须由用户显式勾选确认，避免把"复制一份继续做"当成新项目。
3. **"目录名相同 + 内容相似度高"判为拒绝**。不同分支不会落在同一个目录（同一目录只会是同一工作区，Step 1 会先命中）。
4. `mtime` 只作为证据展示（"上次导入时间"），不参与拒绝 —— 切换分支、格式化、`touch` 都会改变它。
5. 自动导入（无交互）不允许 `allowed_branch`：拿不准一律拒绝，防止无人值守产生副本。
6. **图被删除后允许"重建"，不算重复导入**：判据是"指纹在且图在"才拒绝。若 `project_fingerprints.graph_ids_json` 指向的图均已不存在，导入走"重建同一项目"路径（复用原指纹、更新 `graph_ids_json`），不新建 lineage；删除项目本身时指纹一并删除，下次按新项目处理。
7. **分支/副本放行默认只对本次导入有效**。用户可在确认框额外勾选"对同一指纹记住"；只有主动勾选才长期生效。
   - 记住的规则落 `import_allowances`，必须**可查看、可撤销**（对应 IPC `project:import:allowance:list` / `revoke`）。
   - 命中记住规则时，`import_rejections.allowance_source='remembered_rule'`，导入记录与证据展示必须标明"本次放行来自记住的规则"，**不允许静默豁免**。
   - 记住规则的最小粒度是 `(fingerprint_id, dir_name)`：只自动放行同一目录名，其它新目录仍逐次确认。

#### 执行位置与原子性

```
扫描目录 → 读取元数据 → 计算指纹 → 查重 → [拒绝：写记录并返回] → [允许：创建 graphs/nodes]
```

- 查重在**任何写操作之前**；拒绝时 `graphs` / `nodes` / `chat_threads` 均不产生任何行。
- 允许时，指纹行与图创建在**同一事务**内提交；事务失败则指纹不落库，下次可重试。
- 生成阶段需要实时写进度的 `chat_thread` 在长耗时任务前创建、不在图事务内；TOCTOU 冲突或拒绝时必须显式删除该 thread（含消息），否则事务回滚会留下孤儿行（已实施：`GraphService.initFromProject` 冲突分支 `deleteThread`）。

#### 数据结构

三张表的 DDL 见 **§7.2**（`project_fingerprints` / `import_rejections` / `import_allowances`），此处不重复，避免两处定义漂移。

- 拒绝/放行明细留存 **90 天**（可配置），由启动期清理任务删除；聚合计数写 `map_migration_reports.kind='import_dedup'`，**永久保留**。
- `import_allowances`（用户主动记住的分支/副本规则）不随 90 天清理，保留至撤销。
- `project_fingerprints` 随项目删除而删除；图被删但项目仍在时保留（继续拦截重复导入）。

#### 与 S1 的关系

- 查重表与导入流程属于 **S1**，与 `entity_key` 同批上线（`entity_key` 在 S1 只是加列，真正防漂移的是查重）。
- 缺这一步的后果：重导生成新图 → 节点换新 `entity_key` → 打开新节点时间线为空 → 用户判断"会话丢了"（数据仍在旧图）。
- 不做合并入口：入口拒绝后不会产生需要合并的第二套 lineage，因此 `lineage_links` 表取消、`graphs.project_lineage_id` 取消（§7 已移除）。

### 2.7 产品图 ↔ 开发图：不做自动回写（缺口补齐）

外部蓝图指出一个我们此前未明确的场景：**开发过程中发现产品图结构本身需要调整**（模块该拆、流程该改、需求该合并）。我们的默认口径是：

- `online` 图是产品事实来源，**任何 dev 侧推导都不得直接写 online 图**。
- L1/L2 只允许**人在 online 图手工修改**；系统不提供"自动同步"开关。
- 违反时后果是什么：若不设此规则，模型很容易把"代码里长这样"当成"产品应该这样"，产品图会被实现细节反向污染，且无法区分"需求变更"与"实现偏差"。

**后续（L3，非本期）提案机制**（采纳外部蓝图的"提案 → 人工采纳"方向，但不新增表）：

- 提案 = 一个 `work_item`（`origin='human'` 或 `derived_plan`），`anchor_entity_key` 指向待变更的 online 实体；
- 变更内容放 `metadata.proposal`：`{before, after, reason, evidence_refs}`；
- 采纳时由人在 online 图执行真实编辑，并写 `work_items.status='done'` + `node_evidence(E2)`；驳回写 `cancelled` + 理由；
- 提案不自动应用、不可批量静默采纳；撤销 = 人工反向编辑，不做自动回滚。

本期只记录规则，不实现提案 UI；L1/L2 的 online 图仍只接受人工编辑。

### 2.8 Yjs 完全拆除清单（L3，非本期）

> **前置：本期已实施的是"单向只读、SQLite 权威"（§2.2.1，`cc749ce`），不是拆除。** 本节只把"如果 L3 决定完全移除 Yjs"需要覆盖的范围记全，避免漏项；不改变 L1/L2 的实现，也不替任何外部方案背书。完全拆除必须单独决策、单独施工。

| 类别 | 范围 | 关键点 |
|---|---|---|
| 1. schema / 迁移 | Yjs 相关表与列、`snapshots` 表、schema 版本与 checksum | **`snapshots` 是另一张表，不能和迁移 `_backup` 一起删**；S0 备份按表清单逐表迭代，不假设只有 `nodes`/`edges` |
| 2. 启动装配 | `YjsManager` / `YjsDocRegistry`、doc 池初始化、恢复入口 | 只删生产装配与调用；测试替身另行处理 |
| 3. shutdown flush 与 debounce | 关停写回、flush 定时器、debounce 队列 | 拆除后必须确认没有遗留定时器阻止退出 |
| 4. 冲突子系统 | `conflict-docs` + `conflict-rules` + `lamport` + `conflict-reporter`（约 946 行） | 冲突报告/审计的去留要单独决定；不能只删入口留死代码 |
| 5. 测试 | **9 个测试文件、119 个 `it(`**（2026-11-07 `rg -c "\bit\("` 复核：`src/main/realtime/__tests__` 8 个 + `src/main/services/__tests__/conflict-reporter.test.ts`；数字随代码变化，拆除前重测） | 按文件清单逐个处置：删除 / 改写成只读契约测试 / 保留为回归 |
| 6. 依赖 | `yjs` / `y-protocols` / `lib0` + lockfile + bundle 体积 | 需重新生成 lockfile 与打包产物体积基线；不手改 lockfile |
| 7. 旧快照数据处置 | 已有快照文件/DB 行 | 只读保留、归档或删除三选一；删除必须可恢复且有报告 |
| 8. 远端 / 边界清理 | `127.0.0.1:1236` WS、update/sync step2 拒绝逻辑、无鉴权端点 | 已实施"写消息 1008 拒绝"（`cc749ce`）与"默认不监听"（`987c226`）；L3 彻底移除时再删端点代码 |
| 9. 文档同步 | `agent-architecture.md`、本文 §2.2 / §8.11 / P6、运维说明 | 拆除后 P6 改为"已无 WS 端点"；当前验收是"默认启动下 `1236` 不监听、doc 变更不落库"（§8.11） |

**L3 拆除 runbook（8 步，顺序不可换）**

| 步 | 动作 | 验证项 |
|---|---|---|
| 1 | 前置确认：备份、快照导出、schema 版本、`snapshots` 表清单 | 恢复演练通过；快照可读 |
| 2 | 删接线：确认 `attachDiffHandlers` 已不存在；关闭 WS 端点 | 启动无写回；默认 `1236` 不监听（`987c226`）；显式开启后写消息仍 1008 拒绝 |
| 3 | 删代码：`YjsManager` / `YjsDocRegistry` / conflict 子系统 | 类型检查通过；无死代码引用 |
| 4 | drop 迁移：Yjs 表/列 + schema 版本 | 迁移可重入；`_backup` 报告齐全 |
| 5 | 删依赖：`yjs` / `y-protocols` / `lib0` + lockfile | lockfile 由包管理器重生成；bundle 体积基线更新 |
| 6 | 删测试：9 个文件、119 个 `it(` 逐项处置 | 只读契约测试保留；无 `skip` 遗留 |
| 7 | 文档：`agent-architecture.md`、本文 §2.2 / §8.11 / P6 | P6 改为"写回路径已不存在" |
| 8 | 全量验证：启动、恢复、图编辑、导入、测试、打包 | 无 WS 写回；无残留定时器阻止退出 |

> **拒绝口径**："drop 迁移单提交 revert 即可"不成立 —— 代码可回退，已删除的行/列数据回不来。第 4 步必须先备份并演练恢复，不能把 revert 当数据回滚。

**明确不能删（拆除时也必须保留）**

- `ws` 依赖与 awareness 那套：`settings.realtime` 的 `1234`、`ipc/realtime.ts`、`awareness-server.ts`；它们不是 Yjs 写回路径。
- `edges.updated_at` 的写入方是 `edge-repository`，**不是 Yjs**；拆除 Yjs 不得顺带删掉或改写该列语义。
- `snapshots` 表不能按 `%_backup` / `%_new` 规则清理；它是业务数据表，不是迁移临时表。

**判定**：以上 9 类未全部有处置结论前，L3 不得进入"拆除施工"；L1/L2 按 §2.2.1 的单向只读继续。

---

## 3. 完成度真实性：状态双轨与证据

### 3.1 双轨边界（谁能写）

| 写入方 | 允许写 | 禁止 |
|---|---|---|
| 用户（节点编辑/人工确认） | `nodes.status` | — |
| Agent 会话 | `work_runs` / `agent_*` / 证据候选 | `nodes.status` |
| TestExecutor | `test_*` / E3 证据（测试通过 + 代码 hash） | `nodes.status` |
| 派生计算 | `node_execution_state` / `evidence_suggestions` | 直接提高 evidence 等级 |

**必须收敛的现状缺口**：会话启动自动广播 `developing`、渲染层 `agent:onStatusChange` 直接落 `nodes.status` —— 这两条路径本期必须改成"派生状态 + 不写 `nodes.status`"。

### 3.2 证据等级

| 等级 | 含义 | 典型来源 | 版本锚点 |
|---|---|---|---|
| E0 | 无证据 | — | — |
| E1 | 意图证据 | 计划、会话陈述、人工备注 | 否 |
| E2 | 产出证据 | 变更文件清单、产物文件 | 否（可带文件 hash） |
| E3 | 测试通过 + 代码 hash 绑定 | 测试通过，且 `code_version` 与当前代码 hash 一致 | **必须** git commit sha（`version_binding='commit'`） |
| E4 | 人工签收（无 hash、不可复现） | 人工验收并签收 | **必须** `version_binding='none'` |

规则：

- **E3 = 测试通过 + 代码 hash 绑定，可复现。** 缺代码 hash 的测试通过只能记为测试事实，**降级为 E2**，不得称为 E3。
- **E4 = 人工签收，无代码 hash、不可复现。** 必须显式标注"人工签收 · 无代码 hash · 不可复现核验"。
- **E3 与 E4 不是同一标尺上的高低**：E3 可复现，E4 不可复现；任何统计、排序、导出必须按"可复现 / 不可复现"分组，不得把 E4 排在 E3 之上/之下当作等价序列。
- stale 判定：E3 → HEAD 与 `code_version` 不一致即 `stale`；E4 → 按 §3.5 的覆盖文件哈希 / 过期 / 覆盖范围变化判定。
- 任一锚点不一致 → `freshness='stale'`，等级保留（用于追溯），派生状态按 stale 处理。
- 非 git 项目（A2）无 git 代码 hash，**结构上到不了 E3，只能到 E4 人工签收**（§3.5）。

### 3.3 派生 `execution_state` 优先级

取值：`untouched` / `planned` / `in_progress` / `implemented` / `verified` / `signed_off` / `failed` / `blocked` / `stale`

判定顺序（自顶向下，命中即止）：

1. 最近一次绑定当前 revision 的测试结果为 `failed`/`error` → `failed`
2. 存在 `running` 的 `work_run` → `in_progress`
3. 未完成 `work_item` 的 `gate_status='incomplete'`，或依赖未满足 → `blocked`
4. 存在 E3 且 `freshness='fresh'` → `verified`（测试通过 + 代码 hash，可复现）
5. 存在 E4 且未撤销/未过期 → `signed_off`（人工签收，不可复现）
6. 存在 E3 且 `freshness='stale'`，或存在已失效的 E4 → `stale`
7. 存在 E2 → `implemented`
8. 存在 E1 或存在 `draft/queued` 的 `work_item` → `planned`
9. 否则 → `untouched`

`verified` 与 `signed_off` **不是同一个状态**：任何计数、排序、导出、看板都必须分别统计，禁止合并为"已验证"。

`nodes.status` 与 `execution_state` 冲突时**不做自动纠正**，只在叠加层并列展示，并在人工确认点提示差异。

### 3.4 建议机制

`evidence_suggestions` 只承载系统推断：

- 来源：变更文件命中节点 `fileAssociations` / `relatedFiles`、测试结果关联、会话产物。
- 内容：建议等级、证据类型、引用、理由、置信度。
- 状态：`pending` → `accepted`（转 `node_evidence`）/ `dismissed`。
- 自动推断不得直接写 `node_evidence`。

### 3.5 非 git 项目：E4 人工签收（已定方案）

产品方已决定：**E3 = 测试通过 + 代码 hash 绑定（可复现）；E4 = 人工签收（无 hash、不可复现）。** 非 git 项目没有 git 代码 hash，**结构上到不了 E3，最高只能到 E4**；不做"封顶 E2"。

#### 硬约束

1. E4 必须 `version_binding='none'` 且 `reproducible=0`，`code_version` 为空。
2. 展示、导出、看板必须使用**独立状态** `signed_off`（人工签收），不得计入 `verified` 数量，不得与之同列或等价排序。
3. 任何"完成度/验收率"统计必须按 `(execution_state, reproducibility)` 分组；禁止把 `signed_off` 与 `verified` 合并成"已验证"。
4. E4 只能由人写入（`produced_by='human'`）；非 git 的测试通过只记 `test_run` 事实（最高 E2），不自动升 E3/E4。
5. 排序与导出必须**分两组**：可复现组（E3 / `verified`）与不可复现组（E4 / `signed_off`）；组间不比较大小、不混排。

#### E4 签收记录字段

在 `node_evidence` 上增加：

```sql
signed_by               TEXT,   -- 本地用户标识（必填）
signed_by_display_name  TEXT,   -- 可选显示名；不强制真实姓名/角色
signed_at               TEXT,   -- 签收时间
coverage_json           TEXT,   -- 覆盖范围：[{node_entity_key, files[], acceptance_ids[]}]
basis_ref_json          TEXT,   -- 依据/附件：[{kind:'screenshot'|'log'|'external_report'|'note', ref, hash}]
reproducible            INTEGER, -- 冗余派生字段：E3=1，E4=0；用于分组统计
expires_at              TEXT,   -- 过期时间（统一 30 天，可配置）
renewed_from_evidence_id TEXT,  -- 一键续签时引用原 E4 证据；不替代原行
revoked_at              TEXT,
revoked_by              TEXT,
revoke_reason           TEXT
```

- `signed_by` 使用本地用户标识；显示名可选，不强制填写真实姓名/角色。
- `coverage_json` 必须非空，且至少覆盖一条 `acceptance_json` 条目；否则不允许写 E4。
- `basis_ref_json` 的每个引用必须可点开（文件/截图/日志路径 + hash）；只有口头说明时只能记 `kind='note'`，并计入"弱依据"，UI 需提示。
- 签收界面必须展示：覆盖范围、当前 `execution_state`、已有证据列表、与上次签收的差异。

#### 撤销与过期（非 git 无 hash 时的失效判据）

| 判据 | 触发 | 结果 |
|---|---|---|
| 覆盖文件内容变化 | 签收时对 `coverage_json.files` 逐文件记录 `sha256`；请求状态时重算，任一不一致 | `freshness='stale'`，状态从 `signed_off` 降为 `stale` |
| 覆盖范围变化 | 节点 `scope_files` / `acceptance_json` 变更，或所属 `work_item` 产生新 revision | 自动撤销（`revoked_at`），状态降为 `implemented` |
| 时间过期 | `expires_at` 到期（**统一 30 天，可配置**；不按项目风险/类型区分，留作后续可选扩展，不进 L1） | 视为过期（`freshness='stale'`），派生状态为 **`stale`**，不降为 `implemented`。理由：过期签收是"曾经可信、现在不可信"，`implemented` 只能由新签收或新证据产生；**提供"一键续签"方向**：以原 `coverage_json` 为默认值生成新签收记录，并引用原证据（`renewed_from_evidence_id`），减少重复填写；但签收人与覆盖范围仍须显式确认，不允许静默续期 |
| 人工撤销 | 用户显式撤销，必填 `revoke_reason` | 状态降为 `implemented` |
| 无法计算内容哈希 | 文件不可读 / 超过阈值（默认 200 个文件） | `freshness='unknown'`，UI 显示"无法校验，请人工复核"；**不自动撤销** |

- **不允许"完全不检测"**：至少要有"覆盖文件内容哈希"或"时间过期"之一。两者都不可用时，E4 只能保留 30 天并要求人工续签。
- 内容哈希按文件独立记录（不是整树 Merkle），能精确回答"哪个文件变了"，也避免一次全量扫描。
- 撤销/过期不删除证据行：保留 `revoked_at` / `freshness` 作为历史；派生状态只采信未撤销、未过期的 E4。

**实施状态（2026-11-07）**：

- **时间过期扫描——已实施**：`scanExpiredE4All` 在启动后与每日各跑一次，把到期 E4 置
  `freshness='stale'` 并落 `map_migration_reports(kind='derivation', stage='e4_expiry')`；判定只认
  `expires_at`，与 E3 的 HEAD/`code_version` 判定完全分离。
- **覆盖文件内容变化 / 覆盖范围变化扫描——已批准未实施**。理由：现有 `coverage_json` 只存覆盖范围
  （`files` / `acceptance_ids`），没有逐文件内容哈希基线，也没有可比较的 `base_hash`/`current_hash`
  字段；要检测"覆盖文件变了"必须先定义签收时的哈希基线、存储字段与重算口径，属于另一个 schema
  设计改动，不能在扫描实现里顺手猜测。未实施期间 E4 的失效判据只有"时间过期"和"人工撤销"，**不检测
  覆盖内容变化**——这是已知缺口，不是已完成能力。

#### E3 与 E4 的关系（按可复现性分组）

| 维度 | E3（可复现） | E4（不可复现） |
|---|---|---|
| 触发条件 | 测试通过 + 代码 hash 绑定 | 人工签收 |
| 版本锚点 | git commit sha | 无 |
| 派生状态 | `verified` | `signed_off` |
| 是否可复现 | 是 | **否** |
| 统计分组 | 可复现组 | 不可复现组 |
| stale 判据 | HEAD 与 `code_version` 不一致 | 覆盖文件 hash / 过期 / 覆盖范围变化 |

> 统计、排序、导出、看板一律按"**可复现 / 不可复现**"分组；E4 不得与 E3 混排，也不得用"等级高低"的线性顺序解释两者。

#### 非 git 为什么到不了 E3

E3 的"代码 hash"指 git commit sha；非 git 项目没有。`content_hash`（节点 `scope_files` 的逐文件 sha256 聚合值）可以作为 E2 的文件级证据，并用于 E4 的 stale 判据，但**不构成 E3 的代码 hash**。因此非 git 项目的最高证据等级是 E4 人工签收。

### 3.6 项目进度：派生视图，不落库（采纳，但更严格）

外部蓝图提出"项目进度 = 派生视图，不落库；节点状态加权（published 100 / in_progress 70 …）"。方向可采纳，但必须加两条约束，否则会重演"漂亮但说谎"：

- 进度**只按人工状态加权**，叫"发布进度（publish progress）"，**不叫完成度**；不得作为验收依据。
- 证据维度**单独展示**：`verified_count`（E3）与 `signed_off_count`（E4）分别计数，**不进入同一个百分比**。把 `signed_off` 折算进发布进度会被误读为"测试通过"。
- 公式：`publishProgress = Σ(node_status_weight) / Σ(max_weight)`，权重表写配置；`stale` / `failed` 不计入分子，但单列。
- 不落库、不写 `nodes`、不触发任何证据变更；只读查询，缓存必须带 `computed_at` 与所用权重版本。

### 3.7 S6a 施工细则（B1）：证据写入与派生

> 本小节把 §3.2–§3.5 的规则变成"谁在什么时机写、写失败怎么办"。E3 的测试前置条件在 L1 尚未接通时，只有 TestExecutor 上线后才能产生；L1 只需保证写入校验与字段约束先就位。

#### 3.7.1 写入路径与字段校验

| 等级 | 唯一合法写入方 | 必填字段 | 禁止 |
|---|---|---|---|
| E1 | 人（节点编辑/备注）；Agent 只能写 `evidence_suggestions` | `ref_json`、`summary` | Agent 直接写 `node_evidence` |
| E2 | Agent（产物/变更清单候选，经接受）；TestExecutor（无 hash 测试事实） | `ref_json`、`evidence_type` | 冒充 E3；把无 hash 测试通过写成 E3 |
| E3 | TestExecutor | `code_version`、`code_dirty=0`、`version_binding='commit'`、`reproducible=1`、`work_run_id`、`test_run_id` | 工作区 dirty 时产出 E3；无 `test_run_id` |
| E4 | 本地用户 | `signed_by`、`signed_at`、`coverage_json`（非空且含 acceptance）、`version_binding='none'`、`code_version=NULL`、`reproducible=0` | Agent/后台任务代签；无覆盖范围；带代码 hash |

- 写入前统一校验：等级合法、类型合法、`graph_id + node_entity_key` 可解析、`ref_json` 每个引用可解析（文件路径存在/提交存在/测试存在）、E4 覆盖至少一条 `acceptance_json`。
- 写入事务：校验 → 解析节点 → 插入 `node_evidence` → 触发该节点派生重算（同一事务只做标记，重算在提交后异步执行）。
- 唯一性：同一 `work_run_id + evidence_type + node_entity_key` 的 E2/E3 只允许一条（部分唯一索引 §7.2）；重复写入返回既有 id，不新增。
- 写入失败：E3 测试已完成但证据写入失败 → 测试结果保留，`work_run` 记 `evidence_write_failed`，由重试任务补写；在补写成功前不得把该节点展示为 `verified`。
- 会话/任务产生的证据候选走 `evidence_suggestions`，接受时才转 `node_evidence`；拒绝只更新建议状态，不写证据。

#### 3.7.2 E3 的写入前置（与 §6.2.1 一致）

1. 测试结果 `status='passed'`，且 `test_run.worktree` 非空。
2. `code_version` = 该 worktree 的 `HEAD` commit；`code_dirty=0`（工作区 dirty 时**不得**产出 E3）。
3. 当前项目仍在 git 仓库内，`git rev-parse HEAD` 成功。
4. 任一条不成立 → 只能落 E2 或 `test_run` 事实，不写 E3；`dirty_tree_hash` 只用于变更面留痕，不用于把 dirty 状态洗成 E3。

#### 3.7.3 E4 过期与派生（U1，已裁决）

**裁决：过期 E4 派生为 `stale`，不派生 `implemented`。**

| 输入 | 派生结果 |
|---|---|
| `expires_at` 到期、未撤销的 E4 | `stale`；UI 显示"签收已过期，需续签" |
| 未过期、未撤销的 E4 | `signed_off` |
| 已撤销 / 覆盖范围变化的 E4 | 不参与 `signed_off`，按 §3.5 落回 `implemented` |

理由：过期签收是"曾经可信、现在不可信"，与 `stale` 的"曾验证但当前锚点失效"语义一致。对**过期**这一情形，`implemented` 只能由新签收或新证据产生，不能因为时间流逝自动变成"已实现"；撤销与覆盖范围变化是主动结果，仍按 §3.5 落回 `implemented`。§3.5 原"时间过期降为 `implemented`"的表述按本条裁决修正为 `stale`。`30 天` 口径不变；"一键续签 + `renewed_from_evidence_id`"只作为减轻操作负担的方向，不改变过期判据。

#### 3.7.4 派生算法（可执行定义）

输入（同一 `project_path + graph_id + node_entity_key`）：

- `node_evidence`：未撤销行，按 `evidence_level`、`freshness`、`verified_at`、`id` 排序；
- `work_items`：该节点 `anchor_entity_key` 的全部当前 revision（同一 anchor 允许多条 lineage 并存，§4.1）；判定按**活跃集**（非终态）聚合；
- `work_runs`：活跃集 item 的 `status IN ('queued','running')`；
- 测试结果：L1 无 `test_*` 表，`test_fail` 恒为 false；S8 后接入。

判定顺序严格按 §3.3，并补充确定性 tie-break：

1. `test_fail=true` → `failed`。
2. 存在 `work_run.status='running'` → `in_progress`。
3. 活跃集中任一 item 为在途状态且 `gate_status='incomplete'` 或依赖未满足 → `blocked`。
4. 存在 `evidence_level='E3' AND freshness='fresh' AND revoked_at IS NULL` → `verified`；多条取 `verified_at DESC, id ASC` 第一条。
5. 存在 `evidence_level='E4' AND freshness='fresh' AND revoked_at IS NULL` → `signed_off`；多条取 `signed_at DESC, id ASC` 第一条。
6. 存在 `E3 freshness='stale'` → `stale`；存在已过期（`expires_at` 到期）且未撤销的 E4 → `stale`（U1 裁决）。已撤销 / 覆盖范围变化的 E4 不参与 `signed_off`，按 §3.5 落回 `implemented`。
7. 存在 `E2`（未撤销）→ `implemented`。
8. 存在 `E1` 或活跃集中任一 item 为 `draft/queued` → `planned`。
9. 否则 → `untouched`。

- **多 lineage 聚合（`derivation_version=2`）**：只取 `created_at DESC LIMIT 1` 会吞掉其他 lineage 的 `running/blocked/test_fail`。v2 取该 anchor 全部 `is_current=1`，先剔除终态（`done/failed/cancelled/superseded`）得到活跃集，再按上面顺序折叠；活跃集为空时回退到最新一条（`created_at DESC, id ASC`），保持单 lineage 语义。`test_fail` 只从活跃集 item 推导——终态失败不会永久压住后续成功；若唯一 lineage 已失败，走终态回退仍可呈现 `failed`。
- `evidence_level` 取当前参与判定的最高有效等级；`is_reproducible`：E3=1，E4=0，其余 NULL。
- `inputs_hash = sha256(canonical_json({derivation_version, evidence_ids+levels+freshness, work_items: 排序后的 (item_id,status,gate_status,deps_satisfied) 列表, running_run_ids, test_fail}))`。哈希未变则跳过写入；`derivation_version` 参与哈希，保证版本升级后首次重算必写。
- 写入 `node_execution_state` 时同步写 `inputs_hash` / `computed_at` / `derivation_version`；状态变更后发 `event:map-execution-state-changed`。
- `nodes.status` 永不参与派生、也不被派生结果回写。

#### 3.7.5 重算触发、失败与重建

| 触发 | 时机 | 合并策略 |
|---|---|---|
| 证据插入/撤销/失效 | 事务提交后 | 按节点去重，500ms 内合并 |
| `work_item` / `work_run` 状态、gate、revision 变更 | 事务提交后 | 按节点去重；范围仅限「该 item 锚定节点 + 直接依赖它的当前节点」 |
| 节点 `scope_files` / `acceptance_json` 变更 | 保存后 | 立即重算 |
| E3 stale 扫描 | 启动后 + 每小时 | 批量按 `project_path` |
| E4 到期扫描 | 启动后 + 每日 | 已实施：批量置 `freshness='stale'` 并派生 `stale`，落 `kind='derivation', stage='e4_expiry'` |
| E4 覆盖变化扫描 | — | **已批准未实施**：缺逐文件内容哈希基线，见 §3.7.3 |
| 手动 `admin:map:recompute` | 用户触发 | 可全量或单节点 |

- **触发范围（已实施）**：`work_item` 的 `createDraft/transition/setGateResult/convergeIfTerminal/revise` 与 `work_run` 的 `enqueue/claim/complete/fail/timeout/cancel/markInterrupted` 都会调 `scheduleRecomputeForWorkItem`，只重算该 item 锚定节点 + 当前 revision 中把该 item 列为直接依赖的节点；不做全图扫描、不全量重算。`work_step` 本身不改变派生输入，不单独触发（步终态经 `convergeIfTerminal` 落到 item 状态后触发）。每节点仍 500ms 合并 + `inputs_hash` 未变跳过。
- **`test_fail` 的生产来源**：该 item 最近一次 `work_runs`（按 `run_seq`）为 `failed` 且 `failure_class='test_fail'`；重试已入队/正在跑或新 run 成功即解除。由派生时从库读取，不依赖调用方传瞬态 flag（避免 500ms 合并丢失）。
- **读缓存一致性**：`map:overlay:get` 返回 `node_execution_state` 前调用 `flushPendingRecomputes(db, graphId)`，立即兑现挂起重算；随后 `refreshStaleDerivationsForGraph(db, graphId)` 把 `derivation_version < CURRENT` 的行逐节点重算。选择读侧惰性刷新而非启动全盘扫描：缓存唯一消费路径是 `overlay:get`，成本按被查看图有界，且不拖慢启动。
- 重算失败：保留上一行 `node_execution_state` 与原 `computed_at`，另写 `map_migration_reports(kind='derivation', stage='recompute')` 记失败；UI 显示"派生可能过期"。无上一行时宁可不写，不伪造 `untouched`。
- 重建：`DELETE FROM node_execution_state` 后按项目批量重算；重算结果必须与增量结果一致（同一 `inputs_hash` 同一状态）。
- 验收：E0–E4 样本各一条；同一输入两次重算状态一致；证据撤销后 `verified` 消失；E3 换 HEAD 后 `stale`；E4 过期后派生 `stale`（不得出现 `implemented`）；工作区无证据时不写 `untouched` 假行。

---

## 4. 任务对象与执行记录

### 4.1 `work_items` 与 revision 语义

- 每个 revision 是**一行不可变记录**，用 `lineage_id` 归组。
- 计划确认时生成 revision 1；执行中增删合并产生 revision N+1 行，`supersedes_id` 指向上一行。
- `is_current=1` 的行是当前有效计划；其它行只读保留。
- 旧 run 与旧 evidence 冻结在旧 revision 上，不迁移、不删除。

拆分/合并/删除在计划中的语义：

| 操作 | 结果 |
|---|---|
| 新增子任务 | 新 lineage，parent 指向当前 revision 的父项 |
| 删除子任务 | 当前 revision 该项标 `cancelled`，新 revision 中不再出现在执行队列 |
| 合并两个子任务 | 新 lineage 一项，`merged_from` 关系记录在 `metadata`；旧两项标 `cancelled` |
| 拆分一项 | 新 revision 中该项 `cancelled`，两个新 lineage 项 `split_from` 记录在 `metadata` |

#### 4.1.1 `work_items.status` 值域（S5 一次建齐）

| 值 | 含义 | 谁能写 |
|---|---|---|
| `draft` / `awaiting_confirm` | 计划草稿、等待人工确认 | 计划流程 |
| `queued` / `running` | 已入队、正在执行 | 调度器 |
| `blocked` | 依赖未满足或 gate 未通过 | 调度器 / gate |
| `needs_input` | 等待用户补充信息（问题卡，见 §5.9.8） | 执行器 |
| `needs_human` | 需要人工介入（环境/不可自动恢复失败） | 执行器 / 调度器 |
| `paused` | 人工或基础设施原因暂停，可恢复 | 用户 / 调度器（`infra`） |
| `interrupted` | 进程重启导致中断，等待启动对账 | 启动对账 |
| `done` / `failed` / `cancelled` | 终态；父任务全叶子终态且 ≥1 failed 时为 `failed`（§5.5.1） | 调度器 / 用户 |
| `superseded` | 被新 revision 取代，只读 | 计划流程 |

**这四个新增值（`needs_input` / `needs_human` / `paused` / `interrupted`）与既有值一起写进 S5 的 `CREATE TABLE` DDL（§7.2、§8.7），不得留到后续 `ALTER` 或表重建。**

> **一次性修正（已接受）**：为满足 §5.5.1 的父任务终态聚合（≥1 叶子 failed → 父 failed），`work_items.status` 同时补入 `failed`；否则父任务无法表达失败终态。这是状态集的一次性修正，**不是放宽约束**：值域仍为封闭枚举，迁移与写入校验不变。D2 的四个新增值不受影响，状态总数由 12 调整为 13。

#### 4.1.2 编排步独立建表：`work_steps`

编排步（step）是计划内的一次可执行单元，一个 `work_item` 的一个 revision 可以有 1..N 个步。**步专属字段不放进 `work_items`**，统一放 `work_steps`：

- `output_schema_json`（结构化输出契约）、`consults_json`（需要咨询的上游/评审项）、`checker_work_item_id`（maker-checker 审查项）；
- `deadline_at`（步级截止时间）、`attempt`（步级尝试次数）、`invocation_id`（执行器调用号）。

`work_items` 只保留任务级字段（标题、目标、`scope_files`、`acceptance_json`、`depends_on_json`、revision/supersedes 等）。`work_runs` 是执行事实（一次尝试一行），通过 `step_id` 引用所属步；run 级的 `attempt` 是"该步第几次尝试"，与 `work_steps.attempt` 对应，`work_steps` 为准。

步级状态机与落库要求见 §5.9.8。

### 4.2 `work_runs`

- 一次执行尝试一行；`executor_kind` 区分 agent / test / human；`step_id` 引用所属 `work_steps`。
- `status` 与 `agent_runs.status` 不共用：`work_runs` 是任务视角，`agent_runs` 是执行器视角。
- `work_item_revision` 固化"这次执行用的是哪一版计划"，用于偏差度量与证据归属。
- `attempt` 每次真实重试递增；幂等键 `work_item_lineage_id:work_item_revision:attempt`，与 runtime 现有幂等机制对齐。
- `deadline_at` 由调度器写入，到期强杀子会话并落 `timed_out`；不允许只有 schema 列、没有写入方。
- **失败保留部分产出**：`partial_output_ref` 记录已收 stdout / file_change / 失败原因；失败不等于丢弃。
- **启动对账**：启动时把所有 `running` 的 run 置为 `interrupted`，再由规则决定回 `queued` 或 `cancelled`；不自动重放需要审批的步骤。
- **节点忙**（`SESSION_BUSY` / `NODE_BUSY`）→ 回 `queued` 重新排队，**不消耗 attempt**。
- **结构化输出解析链**：① 取最后一个围栏块（```json / ```）→ ② 平衡 `{...}` 扫描（从首个 `{` 起按括号计数，字符串与转义内不计）→ ③ 仍失败则 `output_parse='fallback'`。块上限 16KB，超限截断并标 `truncated`。schema 外字段**丢弃**并记 `output_extra_keys`（JSON 数组）；不因多余字段判失败。`verdict` 缺失默认 `FIX`（保守，要求返工）。
- **`needs_input` 输出格式**：`INPUT_REQUIRED` —— `{type:'INPUT_REQUIRED', question, options?, default?, blocks[]}`；解析到即转 `needs_input`。**原会话不复活**，回答后开新 attempt（§5.9.8）。
- **依赖失败传播**：上游 `failed` / `timed_out` → 下游 `blocked` 不执行；上游 `cancelled` → 下游落 `cancelled(reason='upstream_cancelled')`，**不得记为 `blocked`**；无关分支继续跑完（失败不掩盖已发生事实）。
- **取消落库**：取消时先持久化已产出的 `partial_output_ref`（stdout / 文件变更 / 失败原因），再写终态；取消原因写 `cancel_reason ∈ ('user','upstream_cancelled','deadline','shutdown','approval_denied')`。

### 4.3 `node_session_links`

- 会话本体仍在 `chat_threads`；此表只做"会话 ↔ 节点 ↔ 任务"的多对多引用。
- `link_role` 区分主会话、辅助会话、评审会话、测试会话、调查会话。
- 一个节点可有多个会话；一个会话也可挂多个节点（多节点会话）。
- 现有 `threadStore` 只保留"最后一个 thread"的做法必须由时间线查询取代。

### 4.4 `change_sets` 与 `routing_decisions`

- `change_sets`：一次执行前后的变更面快照（base/head commit、文件清单、增删行数）。用途：偏差度量、证据 `code_version` 来源、变更面推导信号。
- `routing_decisions`：单 Agent 路由的决策记录（候选、得分、能力缺口、最终选择）。用途：可解释、可复盘，不做自动重路由。

### 4.5 与现有 `agent_*` 表的关系

| 现有表 | 保留 | 新增关联 |
|---|---|---|
| `agent_runs` / `agent_sessions` | 是 | 通过 `work_runs.agent_run_id` / `session_id` 挂到任务 |
| `agent_turns` | 是 | `node_session_links.turn_id` 可选指向首轮 |
| `agent_artifacts` | 是 | 本期不作为测试结果载体；测试输出走 `test_results.output_ref` |
| `agent_approvals` | 是 | 扩展 subject（测试计划级审批），见 §6.3；v35 起只放工具调用审批，人工验收确认另见 `acceptance_confirmations`（§M5.12） |
| `chat_threads` / `chat_messages` | 是 | 时间线读取来源 |

已知限制与修订（D8）：

- **取消 `thread:<id>` 伪节点：已实施（`5938001`）**：kernel 派发前必须解析到真实 `node_id`（命令目标 / 会话配置 / `chat_threads` / 持久化 `agent_sessions` 或最近 turn），未挂载节点的自由聊天保持纯 `chat_threads` / `chat_messages`，不产生 `agent_turns` 行；`sendCommandThroughKernel` 在缺节点时 fail-closed 并记录原因，写入侧不再生成 `thread:${state.threadId}` / `session:${sessionId}`。
- **未挂载节点的自由聊天不进 kernel turn 路径（已按此落地，`5938001`）**：只保留纯 `chat_threads` / `chat_messages` 会话，不产生 `agent_turns` 行；会话挂载到节点后才创建带 `node_id` 的会话与 turn。
- `agent_turns.node_id NOT NULL` 列约束本期保留，**列为"长期放宽"待办**：待 `node_id` 可空后再允许未挂载会话进入 turn 路径；在此之前，需要 turn 但又无节点的功能按 fail-closed 处理（不启用），不得回退到伪节点方案。
- 落地时确认的直接后果（`5938001`）：自由聊天走旧路径，不经过 kernel 的写前审批（`claude-code` 旧路径为 `acceptEdits`）；重启后自由聊天没有 `agent_sessions` 记录，CLI 原生会话不可续（按既有恢复失败流程新建会话），`chat_threads` / `chat_messages` 历史仍在。
- **审批缺口已补**：自由聊天的旧路径同样走 `ApprovalGateway`，写类工具由适配器既有 PreToolUse 强制 `ask` 后进入 `canUseTool`（与 kernel 同一套 `bashPolicyForTool` / `targetPathsOf` 规则与会话授权语义），审批落 `agent_approvals`；无 turn 时用可反解的 `legacy-run-*` / `legacy-turn-*` 标识，不伪造 turn 行、不改表结构。无法在宿主侧拦截写类工具的旧路径适配器对自由聊天 fail-closed；有节点会话仍优先走 kernel。
- **内部会话同样不能裸跑（P0-3）**：无 `threadId` 的子代理子会话与 `sendAndWait` 一次性会话只要落到 `claude-code` 旧路径，也注入同一套 `canUseTool` 审批钩子，不再使用 `acceptEdits`；子代理无 `allowed_files` 时强制降级为只读工具（禁写类与 Bash），且禁止从有宿主审批的后端通过 `adapter_name` 降级到无审批后端。
- `node_session_links.node_entity_key` 可空只表达"项目级引用"与历史数据兼容，不代表仍在生成伪节点。

### 4.6 节点活动流与 ExecutionRecord（采纳为派生视图，不新增表）

外部蓝图把"执行记录（ExecutionRecord）"作为绑定原子单元。我们不新增 `execution_records` 表，而是**用现有表合成同构视图**：

| ExecutionRecord 字段 | 本设计的来源 |
|---|---|
| `nodeId` / `graphId` | `work_items.anchor_node_id` / `node_session_links` |
| `kind` | `work_runs.executor_kind` + `work_items.origin` + run 的上下文 |
| `sessionId` / `workItemId` / `stepId` | `work_runs.session_id` / `work_items.id` / `work_steps.id` |
| `filesTouched` | **只来自确定性证据**：`change_sets.files_json`（file_change 事件 + ScopeGuard 工作区差分），不做推断 |
| `diffRef` / `artifactRefs` | `change_sets` 的 base/head 与 `test_runs.report_ref` / `agent_artifacts` |
| `status` / `startedAt` / `endedAt` | `work_runs.status` / `started_at` / `ended_at` |

规则：

- 节点活动流 = 以 `work_runs` 为主轴、按 `node_session_links` 折叠会话、附证据/测试/bug 链接的**只读视图**；不落新表，不产生第二套事实。
- `filesTouched` **不得**由模型自述或摘要推导；没有 `change_set` 就是空，宁可显示"未采集"。
- **`change_sets` 进 L1 最小集**（§8.12）：既然 `filesTouched` 只认 `change_sets`，L1 就不能既承诺展示文件、又不建该表；二选一后选择"建 `change_sets`"，而不是把活动流降级为"不展示文件"。
- 一个节点有多个会话时，UI 必须展示 `{activeThreadId, threadIds[]}`，不得只保留最后一个（当前 `threadStore` 的问题）。
- 父节点活动流聚合其子树的所有 run；聚合是查询，不是写入。

### 4.7 S5a 施工细则（B1）：任务对象、步骤与执行记录

> 本小节补齐 `work_items` / `work_steps` / `work_runs` / `node_session_links` / `change_sets` / `routing_decisions` 的写入者、状态迁移、事务与失败处理。字段 DDL 见 §7.2；编排执行行为见 §5.9（B2）。

#### 4.7.1 写入权与事务边界

| 表 | 唯一写入方 | 写入时机 | 事务要求 |
|---|---|---|---|
| `work_items` | `WorkItemService`（UI/planner 只能发命令） | 创建 revision、确认、状态迁移、取消 | 每次迁移一条 `UPDATE ... WHERE status=?`，受影响行数必须为 1 |
| `work_steps` | `WorkItemService` + 执行器回调 | 计划落库、审批、启动、完成、失败、中断 | 状态迁移与 `attempt` 自增同事务 |
| `work_runs` | `WorkRunService` | 入队、claim、完成/失败/取消、重启对账 | 入队与 `run_seq` 分配同事务；完成用条件更新 |
| `node_session_links` | 会话挂载/结束路径 | 会话首次挂到节点、会话结束 | 幂等插入；结束只写 `ended_at` |
| `change_sets` | 执行器/ScopeGuard | run 开始记录 base，结束记录 head + 文件面 | 与 run 终态同事务或紧随其后；失败留"未采集" |
| `routing_decisions` | 路由服务 | run 创建时一次 | 同一 run 只写一条 |

- 任何状态迁移先 `BEGIN IMMEDIATE`，再条件更新，再插事件 outbox（同事务），提交后广播。广播失败不回滚数据。
- 事件 outbox 行必须带 `aggregate_id` + `aggregate_version`，消费者按版本去重；这是"状态变更即落库"的最小实现。

#### 4.7.2 `work_items` 状态迁移表

状态值：`draft` / `awaiting_confirm` / `queued` / `running` / `done` / `failed` / `blocked` / `needs_input` / `needs_human` / `paused` / `interrupted` / `cancelled` / `superseded`（`done/failed/cancelled/superseded` 为终态）。

| 当前 | 事件 | 下一状态 | 写入方 | 守卫条件 |
|---|---|---|---|---|
| `draft` | 提交计划确认 | `awaiting_confirm` | 用户/planner | 至少 1 个 step；计划快照可序列化 |
| `awaiting_confirm` | 确认通过 | `queued` | 用户 | gate=`pass` 或 G2 `waived`；无环；父/子 revision 一致 |
| `awaiting_confirm` | 退回修改 | `draft` | 用户 | 生成新 revision，旧行 `superseded` |
| `draft`/`awaiting_confirm` | 取消 | `cancelled` | 用户 | 无 running run |
| `queued` | 调度 claim | `running` | 调度器 | 所有依赖终态且成功；无其他 running 写冲突 |
| `queued` | 门禁失效/依赖失败 | `blocked` | 调度器 | 写 `gate_missing_json` |
| `blocked` | 门禁通过/依赖完成 | `queued` | 调度器 | 重新跑 gate，不信任旧结果 |
| `blocked` | 取消 | `cancelled` | 用户 | — |
| `running` | 全部叶子成功 | `done` | 调度器 | 所有叶子终态且 ≥0 failed；无 needs_* |
| `running` | 至少一个叶子失败且全部叶子终态 | `failed` | 调度器 | 聚合规则见 §5.5.1 |
| `running` | 任一步 needs_input | `needs_input` | 执行器 | 写 `work_steps.input_request_json`，同事务 |
| `running` | 任一步 needs_human/审批超时 | `needs_human` | 执行器 | 记录待人工项 |
| `running` | 基础设施暂停 | `paused` | 执行器 | 记 `pause_reason`（如 adapter 不可用） |
| `running` | 进程重启/租约丢失 | `interrupted` | 启动对账 | 只由启动对账写，不由心跳写 |
| `needs_input` | 回答提交 | `queued` | 用户 | 新 attempt；清空当前 step 的待答状态前先落历史 |
| `needs_human` | 人工放行/拒绝 | `queued` / `cancelled` | 用户 | 审批记录先落库 |
| `paused` | 恢复 | `queued` | 用户/调度器 | 重跑 gate；不自动续跑旧 attempt |
| `interrupted` | 恢复 | `queued` | 用户/启动策略 | 旧 run 对账为 `interrupted`；新 attempt |
| 任一非终态 | 用户取消 | `cancelled` | 用户 | 见 §5.9.7；下游级联规则不变 |
| 任一非终态 | 新 revision 生效 | `superseded` | WorkItemService | 旧 revision 无 running run；否则拒绝修订 |
| 终态 | 任何事件 | 不变 | — | 条件更新 `WHERE status=?` 失败 → 返回冲突，不重试写 |

- **取消与完成竞态**：两者都用 `UPDATE ... WHERE id=? AND status IN ('queued','running','needs_input','needs_human','paused','interrupted')`；只有一个能成功，失败方返回 `CONFLICT` 而不是覆盖。
- **父任务聚合**：叶子全终态后由父 revision 聚合；全成功→`done`，≥1 `failed`→`failed`，全 `cancelled`→`cancelled`，混合成功/取消→`cancelled`（`reason='partial_cancel'`）。聚合不改变叶子状态。
- **`done` 不自动等于验收**：`done` 只表示所有步骤完成；节点完成度仍由证据派生（§3）。

#### 4.7.3 revision 与 gate

- 修订事务：`BEGIN IMMEDIATE` → 校验旧 revision 无 `running` run → 旧行 `is_current=0, status='superseded'` → 插入新行 `revision+1, supersedes_id=旧id, is_current=1, lineage_id=旧lineage` → 复制 steps（`status='pending'`，清 `invocation_id/deadline_at`）→ 提交。
- 同一 `lineage_id` 只允许一行 `is_current=1`（部分唯一索引）；插入冲突 → 回滚并提示重试。
- gate 在 `awaiting_confirm → queued` 与 `blocked → queued` 时强制执行；G2 manual 允许 `waived`，必须同时写 `gate_waived_by / gate_waived_at / gate_waive_reason`，缺一即 `gate='incomplete'`。
- gate 结果只存 `pass/incomplete/waived`；具体缺项写 `gate_missing_json`，不得用空数组表示"通过"。

#### 4.7.4 `work_steps` 状态迁移表

| 当前 | 事件 | 下一状态 | 写入方 | 说明 |
|---|---|---|---|---|
| `planning` | 计划确认 | `pending` | WorkItemService | 只存在于计划 revision 内；确认后不再回 `planning` |
| `pending` | 依赖未满足/上游失败 | 保持 `pending` | 调度器 | 不 claim；由父 `work_item` 的 `blocked/failed` 聚合表达，不新增步级 `blocked` 状态 |
| `pending` | 基础设施前置失败（尚未产生 run） | `paused` | 调度器 | 记 `pause_reason`；恢复后新 attempt |
| `pending` | 需审批 | `waiting_approval` | 执行器 | 必须先落 `agent_approvals` 再置状态 |
| `pending` | 可执行 | `running` | 执行器 | 写 `started_at`、`invocation_id`、`deadline_at` |
| `waiting_approval` | 批准 | `running` | 审批回调 | 条件更新；重复回调幂等 |
| `waiting_approval` | 拒绝/超时 | `cancelled` / `timed_out` | 审批回调 | 记原因；不自动重试 |
| `running` | 有 checker | `review` | 执行器 | 只检查结果，不重复执行 |
| `running` | 无 checker 且成功 | `succeeded` | 执行器 | **会话 terminate 完成后才写** |
| `running` | 失败 | `failed` | 执行器 | 写 `failure_class`；不得写 `succeeded` |
| `running` | 超时 | `timed_out` | 超时控制器 | 杀进程组后写；partial 先落库 |
| `running` | 用户取消 | `cancelled` | 用户/调度器 | 与完成竞态用条件更新 |
| `running` | 需要输入 | `needs_input` | 执行器 | 写 `input_request_json`；会话保留或挂起按 B2 |
| `running` | 基础设施错误且当前 run 已终止 | `paused` | 执行器 | 旧 run 先落 `failed(infra)` 或 `interrupted`；恢复走新 attempt |
| `review` | 检查通过 | `succeeded` | 执行器 | — |
| `review` | 检查失败 | `failed` | 执行器 | 写 review 结论 |
| `review` | 需要输入 | `needs_input` | 执行器 | — |
| `needs_input` | 回答提交 | `pending` | WorkItemService | `attempt+1`；旧 run 已是终态 |
| `paused` | 恢复 | `pending` | 调度器 | `attempt+1`；无论暂停发生在 run 前还是 run 后，旧 run 必须已是终态，恢复不得复用旧 run id |
| `pending` | 可选步条件不满足 | `skipped` | 调度器 | 终态；写 `skip_reason`，不得伪装成 `succeeded` |
| 任一非终态 | 上游取消 | `cancelled` | 调度器 | `reason='upstream_cancelled'`，不是 `blocked` |

- 每次进入 `pending` 且由失败/输入/暂停恢复而来，`attempt = attempt + 1`；首次为 1。`work_runs.attempt` 必须等于同次 step attempt。
- **步终态写入必须在 session terminate 之后**：`succeeded/failed/cancelled/timed_out` 的 DB 更新发生在执行器确认会话结束、Phase B 已执行或已明确失败之后；否则下一步可能早于 Phase B 启动。
- `work_steps` 的终态不可回退；重试是新 attempt，不是改旧行状态。

#### 4.7.5 `work_runs` 生命周期与幂等

- **入队**：`BEGIN IMMEDIATE` → `SELECT COALESCE(MAX(run_seq),0)+1` → 插入 `status='queued'`，`idempotency_key = lineage:revision:step_seq:attempt`。唯一冲突 → 返回既有 run（幂等），不新建。
- **入队守卫（入口必查）**：`is_current=1`（被修订/替代的 revision 拒绝，`REVISION_SUPERSEDED`）；状态非终态（`done/failed/cancelled/superseded` 拒绝）；带 `stepId` 时该 step 必须属于该 item 的**当前 revision**（防止旧 revision 的 step 复用错位幂等键）。违反抛 `WorkRunConflictError`，不得静默入队。
- **claim**：`UPDATE work_runs SET status='running', started_at=? WHERE id=? AND status='queued'`；`changes=0` → 已被取消/其他 worker claim，直接返回。
- **终态**：`UPDATE ... SET status=?, ended_at=?, failure_class=?, ... WHERE id=? AND status='running'`；取消先行成功时，完成更新 `changes=0`，保留 `cancelled` 与 partial 输出。
- `run_seq` 按 `work_item_id` 单调递增；并发由 `BEGIN IMMEDIATE` + `UNIQUE(work_item_id, run_seq)` 兜底。
- `partial_output_ref` 统一 JSON：`{stdout_tail, stderr_tail, file_changes[], errors[], artifact_refs[], captured_at, truncated}`；上限为**代码常量**（非配置项）：`PARTIAL_FIELD_MAX_BYTES = 16KB` / `PARTIAL_TOTAL_MAX_BYTES = 64KB`（`work-run-service.ts:66-67`），超限截断并置 `truncated=true`。F2 的 subagent partial 直接映射到此结构；子代理侧另有常量 `MAX_OUTPUT_ENTRY_SIZE = 10_000` 单条截断（`base.ts:40`），两层值不一致，是否统一见 §12.5 第 4 项。
- `failure_class` 取值至少 `agent_error / timeout / cancelled / infra / approval_denied / upstream_cancelled`；`failed` 与 `cancelled` 不得混写。
- 重启对账（**已实施**，`WorkRunService.reconcileOnStartup`，启动时机在 `ipc-handlers.ts`）：
  - `running` → `interrupted`：重启后这些 run 必为僵尸，保留 partial，不自动重跑；
  - 结构性僵尸 `queued` → `cancelled(shutdown)`：item 不存在 / `is_current=0`（已被修订替代）/ item 已终态——永远不会再被合法 claim；
  - 时间性兜底 `queued` → `cancelled(shutdown)`：`created_at < now - 24h`（`QUEUED_STALE_MS`）。L1/L2 单进程串行、队列即排即取，单用户场景不存在 24h 仍合法的排队等待；结构性判定优先，阈值只兜底合法积压；
  - item 收敛：受影响 item 仍为 `running` 且已无 `queued/running` run → `interrupted`；
  - 每次启动写一行 `map_migration_reports(kind='cleanup', stage='work_runs_reconcile')`（stats: interruptedRunning / cancelledStaleQueued / interruptedItems / queuedStaleMs）。
  - 目的：`in_progress` 只由 `queued/running` run 触发；没有对账时任何僵尸 run 都会把节点永久钉在 `in_progress`（多 lineage 并存会放大该风险）。
- 导入 thread 孤儿清扫（**已实施**，`reconcileOrphanImportThreads`，同一启动段）：
  - 判定：`adapter_name='mindmap-internal' AND graph_id IS NULL AND status='running' AND created_at < now-24h`。正常导入完成会把 thread 置 `idle`、失败置 `error`，只有崩溃会停在 `running`；因此再加 `running` 才不会误删成功/失败的历史 thread（导入 thread 本身从不回填 `graph_id`）。
  - 阈值 24h（`ORPHAN_IMPORT_THREAD_STALE_MS`）与 `queued` 兜底一致：单次导入生成是分钟级，单机单实例下不存在 24h 仍合法的导入会话。
  - 留痕：每次启动写一行 `map_migration_reports(kind='cleanup', stage='chat_threads_orphan')`（stats: deletedThreads / deletedThreadIds / staleMs / cutoffMs），不静默删除。

#### 4.7.6 `node_session_links` 与会话时间线

- 创建：会话首次挂到节点时插入 `link_role='primary'`；同一 `(thread_id,node_entity_key,link_role)` 已存在 → 返回既有行。
- 项目级会话 `node_entity_key IS NULL` 使用部分唯一索引（§7.2），同一 thread + role 只一条。
- `started_at` 写会话开始；`ended_at` 只在会话结束时更新，不删除行。会话切换节点新增 link，不覆盖旧 link。
- 时间线查询：`node_session_links.created_at` + `chat_messages`；一个节点多个会话时返回 `threadIds[]`，由 UI 保留全部。

#### 4.7.7 `change_sets` 采集

- **base**：run claim 时记录项目 `HEAD` commit 与 `git status --porcelain`（dirty 标记）；**head**：run 终态时再记录。
- **文件清单**：来自 ScopeGuard 工作区差分 + `file_change` 事件；路径统一按 §5.4.1 规范化；只收录项目根内文件。
- `files_json` 元素：`{path, change:'added'|'modified'|'deleted'|'renamed', old_path?, additions, deletions}`；`file_count` 与 `additions/deletions` 为派生摘要。
- `dirty_tree_hash`：对 run 结束时所有 dirty/untracked 文件按规范化路径排序，拼接 `path + '\0' + sha256(content)` 后取 sha256；计算失败置 NULL 并 `dirty=1`，E3 不得使用。
- 采集失败/超时：不写空行假装"无变更"；`work_run` 标 `change_capture_failed`，活动流显示"未采集"。
- 一个 run 默认一条 `change_sets`；`UNIQUE(work_run_id)` 保证重试不重复插入；多次快照需求留到 B2。

#### 4.7.8 `routing_decisions`

- 每次 run 创建时写一条：`candidate_json` 为候选数组（`{adapter, score, capabilities, gaps}`），`chosen_adapter` 必填，`policy` 必填（取值见 §7.2）。
- 路由失败（无候选/能力不足）：run 不创建；`routing_decisions` 不写半条行（`chosen_adapter` 不允许空串）。失败原因写 `work_item.gate_missing_json` 或事件 `routing_failed`，并保留被拒候选清单。
- 不做自动重路由；重路由必须新 run（新 `attempt`/新 `run_seq`），旧决策保留。

#### 4.7.9 验收判据

1. 13 个 `work_items` 状态逐条构造；非法迁移全部返回 `CONFLICT`，数据不变。
2. 修订并发：两个修订同时提交，只有一个 `is_current=1`；另一个失败且旧行不变。
3. gate：G1–G6 各一条反例；`waived` 缺 `gate_waived_*` 任一字段 → 拒绝。
4. 取消 vs 完成：同一 run 并发触发，终态唯一；下游步骤 `cancelled(reason='upstream_cancelled')`。
5. 重启对账：kill 进程后启动，`running` 全部 `interrupted`，partial 保留，无自动重跑。
6. 幂等：同一 `idempotency_key` 入队两次只产生一条 run。
7. `change_sets`：正常/失败/未采集三态；dirty 下 E3 被拒。
8. 会话：同 thread 同节点重复挂载只一条；项目级 NULL 不重复；结束不删行。

---

## 5. 复杂任务拆解机制（结构推导 + 人工确认 + 可修订计划）

### 5.1 总览：不存在零人工方案

产品方问的是"有没有一劳永逸的办法"。结论：**没有零人工方案**。原因是任务边界本质上是语义判断，而现有结构数据只能提供证据，不能提供意图。本机制的目标不是消灭人工，而是把人工介入收敛为 **2–4 次高信息量决策**，并让每次决策都可被后续数据校准。

```
锚点节点
   │
   ├─[1] 结构信号提取 ── 层级 / fileAssociations / relatedFiles / 依赖边 / 变更面
   │
   ├─[2] 候选边界生成（确定性算法，可复现）
   │        └─ boundary_candidates（含得分、信号、理由）
   │
   ├─[3] 模型选择与组织（只能从候选集中选，不得发明边界）
   │        └─ plan_drafts（含被剔除的越界项，留审计）
   │
   ├─[4] 人工确认点 C1（计划批准）
   │
   ├─[5] 落 work_items + 准入校验（gate）
   │
   ├─[6] 执行 → work_runs → 证据 / 测试
   │
   ├─[7] 偏差度量 → plan_deviations
   │
   └─[8] 规则校准（离线，改阈值/权重，不自动改计划）
```

### 5.2 候选边界推导（算法与数据来源）

#### 数据来源

| 信号 | 来源字段 | 说明 |
|---|---|---|
| 层级 | `nodes.parent_id`、`sort_index` | 子树、兄弟序 |
| 文件关联 | `nodes.metadata.fileAssociations[].path`（`type` 为 `file`/`directory`/`method`） | 结构化关联，优先级最高 |
| 内容关联文件 | `nodes.content.relatedFiles[]` | 分析产物，可能为空 |
| 上下文文件引用 | `nodes.context_refs` 中 `type='file'` 的 `id` | 手工附加，可信 |
| 依赖边 | `edges` 中 `edge_type IN ('dependency','co-change')` | 图内依赖 |
| 变更面 | `change_sets.files_json` / git diff | 与当前工作区相关度 |
| 历史 | 已完成 `work_items` 的 scope_files 与实际变更文件 | 校准用，不参与首次排序权重（冷启动无数据） |

#### 算法（确定性、可复现）

```
输入：anchor（node_entity_key 或项目级）、graph、maxCandidates=20、depthLimit=3

Step 1 锚定
  S0 = {anchor} ∪ descendants(anchor, depth ≤ depthLimit)
  若 anchor 为 wiki-page / project，或子树为空 → 直接进入退化路径 D5/D1

Step 2 文件集提取
  对每个 n ∈ S0:
    F(n) = { fileAssociations[path] (file/directory 展开为前缀) }
         ∪ { content.relatedFiles[] }
         ∪ { contextRefs(type=file).id }
  若所有 F(n) 为空 → 退化 D1

Step 3 依赖闭包
  S1 = S0 ∪ { m : 存在 dependency/co-change 边从 n∈S0 出发或指向 n，depth ≤ 1 }
  依赖边缺失 → 跳过该信号并记 signal_missing，置信度下调（不阻断）

Step 4 变更面加权
  C = change_set.files（当前 worktree 或最近一次提交）
  对每个 n: change_hit(n) = |F(n) ∩ C| / max(1, |F(n)|)

Step 5 候选生成
  以"文件重叠 + 层级邻近"做确定性聚类：
    若 Jaccard(F(a), F(b)) ≥ 0.3 且层级同父或父子 → 归入同一候选
  每个候选 c = { node_keys, files, boundaries_reason }
  打分：
    score(c) = 0.35*hierarchy_proximity
             + 0.25*file_cohesion
             + 0.20*dependency_closure
             + 0.15*change_surface
             + 0.05*history_hit          -- 无历史时为 0，权重归一化
  其中：
    hierarchy_proximity = 1 - (min_depth(c) - depth(anchor)) / depthLimit
    file_cohesion       = 候选内文件对平均 Jaccard
    dependency_closure  = min(1, 内部依赖边数 / max(1, |c|-1))
    change_surface      = mean(change_hit(n))
  阈值：
    score ≥ 0.75 → 建议采纳
    0.50–0.75   → 需人工选择
    < 0.50      → 丢弃，但保留在候选集里供人工查看

Step 6 约束
  候选数 ≤ 20；单候选文件数 ≤ 20；超过 → 按模块层截断并提示（D4）
  重叠候选（同文件被多个候选覆盖 > 30%）→ 标 conflict，C1 必须人工裁决
```

#### 存储

- 一次推导 = 一个 `boundary_candidates.derivation_run_id` 批次。
- 每个候选存 `node_keys_json`（**键，不是 node id**）、`files_json`、`signals_json`、`score`、`confidence`、`reason`。
- 候选一旦被采纳，`status='chosen'` 并写 `plan_drafts` 引用。

### 5.3 模型只做选择与组织

模型输入只包含：候选列表（id、节点标题、文件清单、得分、理由）+ 锚点摘要 + 已确认验收条件。

模型输出只允许：选择候选、组织成层级、为每个子任务写标题/目标/验收条件草案/文件范围草案。

**输出校验（补外部审查项）**：模型的选择结果仍必须经过 schema 校验；校验失败允许**修复 1 轮**，仍不合规则走 §5.8 D7 的纯人工路径。不得把"模型已选择"当作"已通过准入"。

**分层（D3）**：复杂任务固定走"确定性候选推导 → 模型只在候选集内选择、不发明边界 → 越界项剔除并写审计 → gates"；简单任务跳过候选推导，直接生成单步计划（判据见 §5.9.1）。两层都不允许无人工确认直接执行。

强制约束：

- 模型输出中出现候选集之外的节点或文件 → **剔除并记入 `plan_drafts.rejected_boundaries_json`**，用于后续审计与规则改进。
- 模型不得修改 `files_json` 的父级目录前缀，不得把范围扩大到候选并集之外。
- 模型不得自行降低验收条件，只能补充。
- 模型不得生成超过 `maxCandidates` 的子任务。

模型失败或输出不合规 → 保留候选集，进入**纯人工确认**路径（候选卡片直接给用户选），不阻塞流程。

### 5.4 准入条件（gate）

子任务进入执行队列前必须全部满足：

| 编号 | 条件 | 判定 |
|---|---|---|
| G1 | `scope_files` 非空，且全部位于项目根下（realpath 校验，含符号链接） | 自动 |
| G2 | `acceptance_json` 至少 1 条**结构化可判定**项（`type` ∈ `command`/`manual`/`file_check`，带 `expected`） | 自动 |
| G3 | 目标节点在 dev 图（`nodes.graph_type='dev'`），不包含跨图写 | 自动 |
| G4 | 规模上限：文件数 ≤ 20 且预估行数 ≤ 800（可配置） | 自动 |
| G5 | 依赖闭包内无未完成前置；或显式标 `blocked` 并给出依赖 id | 自动 |
| G6 | 与其它 `running` 任务的 `scope_files` 无交集（写冲突预检） | 自动 |

- 未过 → `gate_status='incomplete'`，`gate_missing_json` 写具体缺失项，**不进队列**。
- 只有 G2 的 `manual` 类型允许人工豁免（`gate_status='waived'` 需记录豁免人与理由）；G1/G3/G4 不允许豁免。
- 准入校验是纯确定性代码，模型输出不能覆盖。

#### 5.4.1 路径规范化（统一用于 G1 / G6 / scope_files / fileAssociations / change_sets / node_links）

所有路径比较前必须经过同一条规范化管线，禁止各调用点自行拼接字符串：

1. `realpath` 解析符号链接；路径尚不存在时，对最近的已存在父目录做 `realpath` 再拼回剩余段。
2. Unicode **NFC** 归一（macOS 文件系统常见 NFD，直接比较会误判"同名不同串"）。
3. 分隔符统一为 `/`，去掉末尾 `/`（根除外）。
4. 大小写折叠：macOS 默认大小写不敏感文件系统用 `caseFold`（`toLocaleLowerCase`）；Linux 保持原大小写。折叠结果只用于**比较键**，展示与落库保留原值。
5. 规范化后必须落在项目根之下；越界（`..`、外部绝对路径、指向根外的符号链接）→ G1 直接失败，不允许豁免。

应用范围：G1 的"位于项目根下"、G6 的写冲突预检、`work_items.scope_files`、节点 `metadata.fileAssociations[].path`、`content.relatedFiles[]`、`change_sets.files_json`、`node_links` 的文件级关联。任一表存了未规范化路径，都必须在使用点重新规范化后比较，不得直接字符串相等。

Windows 路径规则不在本期验证范围（A9）；遇到非 POSIX 根 fail-closed，不做猜测性兼容。

### 5.5 可修订计划

状态机：

```
draft ──► awaiting_confirm ──► confirmed ──► (生成 work_items, 计划行只读)
   ▲              │
   └──── revise ◄─┘
任意状态 ──► superseded（被新 revision 取代,只读）
任意状态 ──► rejected
```

规则：

- `revision` 单调递增；`lineage_id` 不变；`supersedes_id` 指向上一行。
- 只有 `is_current=1` 的行参与执行、统计、UI 默认展示。
- **`confirmed` 是计划草稿的终态**：确认后不可 `revise`；同一 lineage 也只允许一次 `confirm`。理由：`confirm` 已按 items 生成 work_items，再修订会把计划行退回 `awaiting_confirm` 并再次确认，产生第二套 parent+children，而旧一套仍是 `draft`（既不 supersede 也不继承）。若确认后要调整，走 work_item 层修订（`WorkItemService.revise`：running-run 守卫 + 旧行 `superseded` + 新 revision 继承/复制 steps），或新建计划草稿（新 lineage）。旧计划行保持 `confirmed`/`is_current=1` 作为"当时确认了什么"的事实；已生成的 work_items 不因计划层操作被 supersede。
- 执行中修订：新 revision 继承未完成项；已完成项默认不重跑，除非显式 `rework`（此时新增 run，旧 run 证据保留并标 `superseded_by_revision`）。
- 旧 revision 的 evidence 不迁移，`plan_deviations` 仍按旧 revision 统计，避免"改计划后看起来偏差变小"。

#### 5.5.1 DAG 正确性（环检测、分层、依赖优先级、父任务聚合）

**环检测（硬性）**：计划确认（C1）时对 `depends_on_json` 建图并做环检测；存在环 → 拒绝确认，写入拒绝原因，**不得进入队列**（否则相关项会永久 `queued`）。执行中不得引入新环。

**分层（Kahn）**：确认后按入度做 Kahn 拓扑分层，层内保持稳定顺序；本期串行执行，层号用于排序与并发上限判断，不代表并行放行。

**依赖优先级**：`显式 depends_on_json` > `隐式引用`（共享 `scope_files` / `verifies` 目标 / 同锚点）> `数组顺序`。某任务一旦有显式依赖，就不再为其推断隐式依赖；完全无依赖时按数组顺序兜底。推断来源写入 `metadata.dependency_source ∈ ('explicit','implicit','order')`，供复盘。

**父任务终态聚合**：父任务只有在**全部叶子后代进入终态**后才进入终态；聚合规则：

| 叶子情况 | 父任务终态 |
|---|---|
| ≥1 `failed` / `timed_out` | `failed` |
| 全部 `cancelled` | `cancelled` |
| 有 `needs_human` / `paused` / `needs_input` | 保持非终态（对应状态） |
| 全部 `done` / `skipped` | `done` |

父任务不得因为"部分子任务完成"而提前标 `done`；聚合只在叶子全部终态时计算一次并落库。

### 5.6 人工确认点

| 编号 | 时机 | 是否强制 | 必须展示 |
|---|---|---|---|
| C1 | 计划批准（`plan_draft` → `work_items`） | 强制 | ①每个子任务的标题/目标；②`scope_files` 完整清单与越界提示；③验收条件逐条；④依赖关系；⑤候选得分与"为什么这样切"；⑥未通过 G1–G6 的项与补齐建议；⑦被模型剔除的越界项；⑧不可推导项（退化标记）；⑨每个锚点节点当前 `execution_state` 与最高证据等级 |
| C2 | 执行中修订（新增/删除/合并/拆分） | 强制 | ①与上一 revision 的 diff（按子任务/文件）；②影响面（哪些 run 会失效、哪些证据会 stale）；③修订原因；④新 revision 的 gate 结果 |
| C3 | 测试计划审批（`test_plan`） | 强制 | ①命令清单与其 `cwd`；②worktree 路径与基线 commit；③影响文件；④策略判定结果（allow/ask/deny 逐条）；⑤计划哈希；⑥预计时长上限 |
| C4 | 完成认定（人工写 `nodes.status` 前） | 强制 | ①当前 `execution_state` 与证据列表（可点开）；②stale 证据清单与原因；③未满足的验收条件；④建议（若有）及其来源；⑤与上次人工状态的差异 |

反例（明确禁止）：只显示"是否同意？"的确认按钮；把 C1/C2 合并成一次；把 C3 的审批做成"记住本次选择"的永久授权；C4 用模态框默认勾选"已完成"。

### 5.7 偏差度量

采集字段（`plan_deviations`，一次 `work_run` 结束写一行）：

| 字段 | 含义 | 主要用途 |
|---|---|---|
| `planned_file_count` / `actual_file_count` | 计划文件数 vs 实际变更文件数 | 判断文件范围推导是否过窄/过宽 |
| `planned_subtask_count` / `actual_subtask_count` | 计划子任务数 vs 实际执行子任务数 | 判断拆分粒度 |
| `turns_used` / `tool_calls` | 该 run 的轮次与工具调用数 | 判断任务复杂度估计 |
| `rework_count` | 同一子任务重复执行次数 | 判断验收条件质量 |
| `test_failures` | 测试失败次数 | 判断边界是否把耦合拆散 |
| `replan_count` | 该 lineage 的 revision 次数 | 判断初始计划质量 |
| `scope_violation` | 是否出现范围外写（0/1） | 判断模型是否越界 |
| `boundary_changed` | 实际边界与计划是否不同（0/1） | 判断推导规则是否有效 |
| `duration_ms` | 执行时长 | 辅助评估 |
| `derivation_version` | 生成计划时固定的计划规则版本 | **归因维度**（计划生成后不可变） |
| `observed_rule_version` | 记录时的配置哈希（阈值/权重快照） | **归因维度**；一批内配置不可变时可删 |
| `task_type` | 记录时快照（锚点类型 / 任务来源分类） | **归因维度** |
| `agent_type` | 记录时快照（实际执行 adapter） | **归因维度**；Tier 1 下通常为单值 |

- `file_domain`（目录前缀）**不存单值**：一次 run 可跨多个目录，由视图 `v_plan_deviations_file_domain` 从 `change_sets.files_json` 展开（§7.2）；路径先按 §5.4.1 规范化再取前缀。
- `observed_rule_version` 保留：阈值/权重允许人工在 run 之间修改，记录时哈希才能对齐配置。若后续锁定"一批内配置不可变"，则删除该列。

用途（三条，不超过这三条）：

1. **阈值校准**（离线）：按 `derivation_version` + `observed_rule_version` + `task_type` / `agent_type` / `file_domain` 聚合，若 `actual/planned` 文件数连续 3 批 > 1.5，则下调 `file_cohesion` 阈值或提高拆分粒度；若 `replan_count` 中位数 > 2，则提高候选数上限并强化 C1 展示。
2. **退化检测**：`scope_violation` 或 `rework_count` 高频的锚点类型（如 wiki-page、跨模块流程）标记为"结构不可推导"，下次直接进退化路径。
3. **确认强度自适应**：`replan_count` 高的项目在 C1 增加"必须逐条勾选验收条件"，低风险项目可折叠次要信息 —— 但**不允许跳过确认**。

校准是离线分析 + 人工改配置，不做在线自动学习、不自动修改历史计划。

**冷启动与回顾口径（D3）**：权重冷启动直接采用 §5.2 的默认值（0.35 / 0.25 / 0.20 / 0.15 / 0.05），不等待历史数据；`history_hit` 无历史时为 0 并归一化。校准只使用 `plan_deviations` 的以下字段：`planned_file_count` / `actual_file_count`、`planned_subtask_count` / `actual_subtask_count`、`rework_count`、`scope_violation`、`boundary_changed`、`replan_count`、`test_failures`，并按 `derivation_version` / `observed_rule_version` / `task_type` / `agent_type` / `file_domain` 分组。**聚合窗口只保留一套：每 20 个 run 或每 2 周（取先到者）一次离线回顾；只调配置阈值/权重，不改历史计划、不做在线学习。**

> **归因（已定）**：`plan_deviations` 的统一归因为 `derivation_version`（计划生成时固定）+ `observed_rule_version`（记录时配置哈希）+ `task_type` / `agent_type` / `file_domain`（目录前缀，视图派生）。**`boundary_changed` / `scope_violation` 只作为路由特征**（退化判定与确认强度自适应），**不进成功率分母**；成功率分母只含正常完成/失败的 run，不含边界变更与范围越界这两个特征位。

**采集时点**：run 终态事务提交后写入；字段取自 `work_items` / `work_runs` / `change_sets`；`change_sets` 未采集时 `actual_file_count=NULL`，不写 0。派生重算失败只记 `map_migration_reports(kind='derivation')`，不阻塞任务终态。

### 5.8 退化与兜底

| 编号 | 触发条件 | 退化策略 |
|---|---|---|
| D1 | 所有节点的 `fileAssociations` + `relatedFiles` + `contextRefs(file)` 为空 | **单任务模式**：整个锚点子树作为一个 `work_item`；文件范围由用户在 C1 手工框选（必须非空才过 G1）；不自动拆解 |
| D2 | 变更面为空（无 git、无未提交变更） | 仅用结构信号，`change_surface` 权重归零并重新归一化；C1 强制展开候选明细 |
| D3 | 依赖边缺失 | 跳过依赖闭包；用目录前缀邻近替代；`confidence` 上限 0.7 |
| D4 | 子树深度 > 3 或跨模块 | 截断到模块层生成候选；提示"更细粒度需人工拆分" |
| D5 | 锚点是 `wiki-page` / `project` | 拒绝自动拆解，只提供"人工新建子任务"入口 |
| D6 | 候选重叠不可分（Jaccard > 0.8 且无法按依赖切分） | 合并为单候选，C1 提示"该范围强耦合，建议作为一个任务" |
| D7 | 模型不可用/输出不合规 | 候选卡片直接人工选择；所有 C1 展示项改为纯数据展示 |

兜底优先级：结构推导 → 候选人工选择 → 单任务模式 → 纯人工拆解。**任何一级兜底都不产出"未经人确认的执行计划"。**

---

### 5.9 执行编排机制（采纳自外部蓝图，补我们此前的空白）

我们此前只定义了"计划怎么来、怎么确认"，没有定义"确认之后怎么跑"。以下机制整体采纳，并受本设计的双轨/证据规则约束。

#### 5.9.1 单步与多步的分流

- `simple`：单文件、无跨节点依赖、`scope_files` 只落在一个节点 → 生成单步计划；仍需一次人工确认（C1/C2 合并为一次点击），**不跳过确认**。
- `complex`：多文件/多节点/存在依赖 → 走结构推导 → 人工确认 C1–C4 → 执行。
- 判据取并集保守判定：任一信号为 complex 即走 complex；不允许模型自称 simple。

#### 5.9.2 失败分类与策略

| `failure_class` | 含义 | 策略 |
|---|---|---|
| `infra` | 解析/本地工具/存储异常 | 同 turn 重试 ≤2，退避 1s/4s；仍失败 → `needs_human` |
| `busy` | 节点或会话忙 | 回 `queued`，**不计 attempt**，按优先级重排 |
| `turn_fail` | 单轮校验失败 | 同 task 重试 ≤2，提示带失败原因 |
| `verify_fail` | 验收未过 | 回 `running` 再产出一轮；仍失败 → `needs_human` |
| `test_fail` | 测试失败 | 进 bug 闭环（§6.6），不重试同一命令 |
| `env_fail` | 依赖/端口/编译环境 | `needs_human`，**不建 bug** |
| `timeout` / `cancel` / `denied` | 超时/取消/审批拒绝 | 落对应终态；`denied` 不改写计划 |

- 每个失败必须写 `failure_class` + `attempt` + 可读原因；没有分类的失败不允许进入重试。
- 重试上限与退避写配置，不硬编码在调用点。

#### 5.9.3 调度、并发与写冲突

- **全局写闸 `WorkspaceWriteGate`**：agent 编排阶段的写操作按项目串行（同一工作区同一时刻只允许一个写者）；测试执行仍走 §6 的隔离 worktree，两者不共用锁。
- 并发上限：全局 2、单图 1、单节点 1；超限任务保持 `queued`，按 `priority DESC, created_at ASC` 出队。
- **节点忙不重试**：`SESSION_BUSY` → 重新排队；`NODE_BUSY` → 等待当前 run 结束再出队。
- **不做自动回滚**：已通过人工审批的 diff 不自动 revert；回滚是新的 work_item。
- 取消语义：`cancel(work_item)` → 当前 run 落 `cancelled`，下游依赖项落 `cancelled(reason='upstream_cancelled')`（**不是 `blocked`**）；已完成的 run 不回滚。完整迁移与进程杀灭见 §5.9.7。

#### 5.9.4 超时与重启

- 单步 `deadline_at` 默认 10 分钟（测试命令默认 60 分钟），由调度器写入并强杀；**不允许出现"有 deadline 但没有写入者"**。
- **任务总 wall clock**：单个 `work_item` 的所有 step / attempt / 重试累计默认 60 分钟（可配置）；到期不再重试，直接落 `timed_out`（`failure_class='timeout'`），已产出部分按 §4.2 保留。
- **队列重排**：出队键 `priority DESC, created_at ASC`；每 60 秒重算一次。等待超过 10 分钟的项按"每 10 分钟 +1 优先级"做轻度 aging，避免长任务持续插队导致饥饿；aging 只影响排序，不改 `priority` 的持久值。
- 启动对账：`running` → `interrupted` → 按"是否需要审批 / 是否幂等"决定 `queued` 或 `cancelled`；不自动重放需审批步骤。
- 幂等键 `work_item_lineage_id:work_item_revision:attempt` 透传到 runtime；同一键重复提交必须幂等。

#### 5.9.5 能力票（Tier）与降级

| Tier | 能力 | 本期策略 |
|---|---|---|
| Tier 1 | 单轮 + 会话续跑 + 审批事件 + 结构化输出 | **唯一允许参与编排（读 + 写）** |
| Tier 2 | 部分事件/续跑不稳；**无写前审批回调**（如 Codex SDK） | **只允许只读编排**（分析、评审、候选推导）；任何写步骤不得由编排器直接执行，只能排队等用户手动开会话处理 |
| Tier 3 | 无事件/无恢复 | 禁止编排，只能人工在会话中手动使用 |

- Tier 由能力探测结果决定并写 `routing_decisions`；不允许按模型名硬编码。
- **编排写路径仅 Tier 1**。Tier 2 不能"降级执行写步骤"：没有写前审批回调就无法满足"不绕过审批网关"，降级等于开后门。
- `degraded` 状态只用于用户手动打开的会话（UI 明示"降级执行，不保证中断恢复"），**不用于编排器**；编排器不得静默换 adapter。
- **MVP 范围（已定）**：仅 Tier 1 参与编排（读 + 写）；Tier 2 只读或排队等人工会话，Tier 3 不参与编排。
- **审计票与审批票分离**：`KERNEL_AUDIT_CAPABLE_BACKENDS` 只决定能否执行只读审计/分析，**不**等于写前审批能力；写步骤仍只认 `approval_callback=1` 的 Tier 1。
- 能力策略统一返回 `{allowed, tier, degraded}`：`allowed` 是本次 step 是否可执行，`tier` 是能力票，`degraded` 只允许手动会话置 1。
- Tier 2 执行只读审计时，`routing_decisions.policy='tier2_audit'`，且该 run 不得包含写步骤；探测失败一律落 Tier 3，禁止按"未知"放行。
- **禁止静默换 adapter**：换 adapter 必须新 run + 新 `routing_decisions`；不得在同一个 run 内改写 `chosen_adapter`。

#### 5.9.6 明确不采纳的部分

- **不采纳"由 LLM planner 直接产出并执行 TaskDAG"**：我们的分解必须来自结构推导 + 人工确认（§5.1–5.6），模型只做选择与组织。
- **不采纳"节点状态由任务完成事件自动推进"**：`nodes.status` 仍只允许人写（§1.4），任务完成只影响 `work_runs` / `work_item` 与派生 `node_execution_state`。
- **不采纳"MVP 不做 worktree"**：TestExecutor 仍用隔离 worktree；全局写闸只覆盖 agent 编排的共享工作区。

#### 5.9.7 取消语义：真杀进程、竞态与下游传播

取消必须作用于真实进程，不只是改数据库状态。

| 起点状态 | 取消动作 | 落点 |
|---|---|---|
| `queued` | 从队列移除，不启动进程 | `cancelled(reason='user')` |
| `awaiting_approval` | 撤销待审批项（标记 `expired` / `cancelled`），从待办列表移除 | `cancelled(reason='user')` |
| `running` | 先写 `cancel_requested_at`，对**进程组**发 `SIGTERM`（含子进程），宽限 10 秒后 `SIGKILL`；等待进程退出 | `cancelled`（或按竞态规则） |
| `blocked` / `needs_input` / `paused` | 无进程，直接落库 | `cancelled(reason='user')` |
| 已终态（`completed` / `failed` / `timed_out` / `cancelled` / `superseded`） | 幂等返回，不改写结果 | 保持原终态 |

硬规则：

1. **进程组杀灭**：执行器以独立进程组启动；取消与超时都杀整组，避免只杀父进程留下子进程。
2. **取消与完成竞态**：终态写入使用条件更新 `WHERE status IN ('queued','running','awaiting_approval','blocked','needs_input','paused')`；若 `completed` 已先落库，取消不覆盖，返回 `already_completed`。`cancel_requested_at` 只作审计，不改变已完成事实。
3. **部分产出先落库**：取消前把已收到的 stdout / 文件变更 / 失败原因写入 `partial_output_ref`，再写 `cancelled`；不允许"取消即丢产出"。
4. **下游传播**：下游未执行项落 `cancelled(reason='upstream_cancelled')`，**不得写 `blocked`**；无关分支继续执行。
5. **worktree 清理**：取消的测试运行不保留失败现场（失败现场只针对 `test_fail`）；先抓取日志，再立即删除 worktree，避免残留。

#### 5.9.8 步级状态机与 `needs_input`

`work_steps.status` 取值与迁移：

| 状态 | 含义 | 允许的下一步 |
|---|---|---|
| `planning` | 计划生成中 | `pending` / `cancelled` |
| `pending` | 已就绪待调度 | `waiting_approval` / `running` / `cancelled` |
| `waiting_approval` | 等待审批 | `running` / `cancelled` / `timed_out` |
| `running` | 执行中 | `review` / `succeeded` / `failed` / `timed_out` / `needs_input` / `paused` / `cancelled` |
| `review` | 产出待评审/checker | `succeeded` / `failed` / `needs_input` / `cancelled` |
| `needs_input` | 等待用户回答 | `pending`（新 attempt） / `cancelled` |
| `paused` | `infra` 等原因暂停 | `pending` / `cancelled` |
| `succeeded` / `failed` / `timed_out` / `cancelled` / `skipped` | 终态 | — |

- **状态变更即落库**：每次迁移立即 `UPDATE work_steps` 并发出 `event:work-step-changed`；禁止只在内存中维护状态、结束才写库。
- **`needs_input` 问题卡**：写 `input_request_json`（问题、可选项、默认值、影响范围、阻塞的后续步）；同步把 `work_items.status` 置 `needs_input`。
- **回答后开新 attempt**：用户回答 → `attempt+1` → 状态回 `pending`；上一个 run 的产出与 `partial_output_ref` 保留，**不把等待时间计入失败**，也不消耗重试上限之外的额外次数。
- `review` 与 `checker_work_item_id` 绑定：checker 不通过时**不得**直接 `succeeded`，按下条 maker-checker 规则处理。
- **maker-checker 循环（B2）**：`PASS` → step `succeeded` 并解锁下游；`FIX` → 新 attempt（`attempt+1`），checker 的 `comments` 放进下一 attempt 的 `attemptContext.comments`；`INPUT_REQUIRED` → `needs_input`。`fixRounds` 默认 2（可配置），超限 → 父任务 `needs_human`，不得无限循环。
- checker 用**独立会话**：上下文只含 `scope + diff + acceptance`，不含 maker 的推理轨迹与兄弟分支产物；只读，不占全局写闸。checker 自身 `infra` 失败按新 attempt 重试一次，不得记 maker 失败。
- checker 的 `PASS` 只证明"产物满足 acceptance"，**不等于 E3**；证据仍按 §3 / §6 的测试与 worktree 规则产生。

#### 5.9.8.1 黑板 / Phase B / L3 fanout 的边界约束

> 以下约束是 L3 黑板与 fanout 的前置条件；L1/L2 不实现黑板，但执行器与状态机必须先满足，否则后续并行化会把"记忆"当成正确性依赖。

1. **步终态写入必须在 session terminate 之后**：`work_steps` 的 `succeeded/failed/cancelled/timed_out` 只能在执行器确认会话结束、Phase B（会话结束后的记忆提取/写回）已执行或明确失败后落库。否则下一步可能在 Phase B 之前启动，读到未写完的记忆。
2. **Phase B 失败只影响记忆可见性，不影响正确性**：证据与验收只来自 `work_runs` + `node_evidence`；黑板/记忆写入失败不得回滚已完成的 run，也不得把 step 改回 `running`。UI 可提示"记忆未同步"，但状态机继续。
3. **L3 fanout 只保证任务边界快照，不保证兄弟步互见**：fanout 时每个子任务拿到的是边界时刻的任务快照（scope/acceptance/依赖）；兄弟步并发产生的中间黑板内容不承诺可见、也不作为合并依据。需要跨步共享的内容必须显式落 `work_runs` / 证据，而不是依赖黑板时序。
4. **上下文最小化**：不注入兄弟分支产物，不注入全图；`depsOutputs` 只含 step 声明引用的输出，按 `work_runs.outputs_json` 的引用解析，不复制全文。声明引用缺失 → `DEP_OUTPUT_MISSING`，step `failed(failure_class='infra')`，不得注入空对象冒充依赖。
5. **检索预算**：`HybridSearchEngine` top-k=5；不可用时降级 `getRecent(3)`；检索片段计入 waterline。
6. **水位线增量**：单步上下文增量 ≤800 tokens；超限先裁检索片段，再裁历史摘要，**不裁 scope / acceptance / 依赖声明**。

#### 5.9.9 编排接口契约（B2）

所有编排动作只经 `WorkItemService` / `WorkRunService`；renderer 只能发命令（§9.2）。接口返回结构化错误码，不抛裸异常。

| 接口 | 输入 | 成功输出 | 失败分支 |
|---|---|---|---|
| `enqueue(workItemId, revision)` | 任务 id、目标 revision | `{runId, runSeq}` 或 `{queued:true, position}` | `GATE_INCOMPLETE`（写 `gate_missing_json`）；`DAG_CYCLE`（确认后计划被改坏，拒绝）；`REVISION_SUPERSEDED`（revision 已非 current）；`ALREADY_RUNNING`（同 lineage 已有 running）；`TIER_UNSUPPORTED`（无 Tier 1 候选） |
| `claimNext(projectPath)` | 项目根 | `{runId, stepId}` 或 `null` | `BUSY`：保持 `queued`，**不消耗 attempt**；`GATE_REVOKED`：转 `blocked`；`TIER_LOST`：转 `needs_human` |
| `startStep(runId, stepId)` | run、step | `{invocationId, sessionId?, threadId?}` | `APPROVAL_REQUIRED`：step 先落 `waiting_approval`；`ADAPTER_UNAVAILABLE`：step `paused(infra)`、run `failed(infra)`；`IDEMPOTENCY_CONFLICT`：返回既有 run |
| `completeStep(stepId, result)` | `{status, outputsJson?, partialOutputRef?, failureClass?}` | 迁移后的 step | `SESSION_NOT_TERMINATED`：拒绝写终态，保持 `running`；`OUTPUT_SCHEMA_INVALID`：降级 `output_parse='fallback'`，成功与否以真实结果为准 |
| `failStep(stepId, failureClass, error)` | 分类、可读原因、partial | `failed` step，并触发父任务聚合 | `INVALID_FAILURE_CLASS`（缺分类不落失败态）；partial 超限 → 截断并标 `truncated` |
| `cancelWorkItem(workItemId, reason)` | `user` / `deadline` / `shutdown` / `approval_denied` | `{cancelledRunIds[], downstreamCancelledIds[]}` | `ALREADY_TERMINAL`：幂等返回原终态；`PROCESS_KILL_FAILED`：**不写 `cancelled`**，写 `failed(failure_class='infra')` 并转 `needs_human` |
| `resumeWorkItem(workItemId, mode)` | `mode ∈ ('input','infra','retry')` | `{newRunId, attempt}` | `NOT_PAUSED` / `NOT_INTERRUPTED`；`GATE_INCOMPLETE`（恢复前重跑 gate）；`RUN_NOT_TERMINAL`（旧 run 未终态） |
| `recomputeAfterRun(runId)` | run | 无（内部） | 派生重算失败只写 `map_migration_reports(kind='derivation')`，不回滚 run |

**调度 tick（每 1 秒，单实例）**

1. 取 `queued` 项：`ORDER BY priority DESC, created_at ASC LIMIT 1`。
2. 重跑 gate（不信任确认时的结果）；不通过 → `blocked` + `gate_missing_json`。
3. 校验依赖：全部上游终态且成功；否则保持 `queued`，不 claim。
4. 路由：只接受 Tier 1；无候选 → `TIER_UNSUPPORTED`，保持 `queued`，写 `routing_failed` 事件。
5. 取写闸：项目被占用 → 本轮跳过，**不写 run、不加 attempt**。
6. 创建/claim run（走幂等键）→ `startStep`；失败按 §5.9.2 分类。

- 同一时刻只允许一个 tick 处理一个项目；并发上限按 §5.9.3。
- tick 内不得留下 `running` 孤儿：run 已 claim 但 step 未启动时，用条件更新 `running → queued`，不计 attempt。
- 所有错误码必须落 `work_runs.failure_class` 或 `work_item.gate_missing_json`，不得只写日志。

#### 5.9.10 路由与 Tier 能力票（B2）

**能力探测**

输入 `{adapter, adapterVersion}`；输出：

| 字段 | 取值 | 用途 |
|---|---|---|
| `tier` | 1 / 2 / 3 | 编排准入 |
| `resume` / `approval_callback` / `structured_output` / `cancel` | 0/1 | 能力明细 |
| `probe_error` | 可空 | 探测失败原因 |

判定：四项齐全 → Tier 1；缺 `approval_callback`（其余可用）→ Tier 2；其余 → Tier 3。**探测失败按 Tier 3 处理（fail-closed）**，不得默认 Tier 1。探测结果只在进程内按 `(adapter, adapterVersion)` 缓存；adapter 升级或探测失败即重探。

**路由算法（单 Agent，不做并行）**

1. 候选 = 已注册 adapter ∩ 满足 step 要求（写步骤要求 Tier 1 且 `approval_callback=1`）。
2. Tier 2 只允许只读步骤（分析、评审、候选推导）；Tier 3 不进候选。
3. 打分：`tier` 优先，其次历史成功率（无历史用默认值），平局按 `adapter` 名稳定排序。
4. 单候选也写 `routing_decisions`（`policy='single_agent'`）；人工指定 adapter 时 `policy='manual_override'`；Tier 2 只读审计时 `policy='tier2_audit'`。
5. 选中后先写一行 `routing_decisions`（`candidate_json` 含每个候选的 tier / gaps），再创建 run。

**失败分支**

| 情况 | 落点 |
|---|---|
| 无 Tier 1 候选 | 不建 run；`event:work-item-changed(reason='manual_session_required')`；任务保持 `queued` |
| 写步骤只有 Tier 2 可用 | 同上；**不得降级执行** |
| 探测失败 | 按 Tier 3；写 `routing_failed`，提示检查 adapter |
| run 中 adapter 不可用 | 当前 step `failed(failure_class='infra')`；不静默换 adapter；恢复走新 attempt |
| 人工覆盖到 Tier 2 的写步骤 | 直接拒绝 `TIER_UNSUPPORTED` |

#### 5.9.11 StepInput / StepResult 字段级契约（B2）

命名对齐：`taskId` → `work_item_id`；`stepId` → `work_steps.id`。

**StepInput**

```ts
interface StepInput {
  workItemId: string;            // 原 taskId
  revision: number;
  stepId: string;                // work_steps.id
  attempt: number;
  scope: { files: string[]; symbols: string[] };
  acceptance: string[];
  depsOutputRefs: Array<{ stepId: string; outputRef: string; summary: string }>; // 只注入声明引用
  attemptContext: {
    lastFailureClass?: string;
    lastPartialRef?: string;
    comments?: string[];         // checker FIX 评论
    userAnswer?: string;         // needs_input 回答
  };
  adapter: { name: string; tier: 1 | 2 | 3 };
  deadlineAt: number;
  outputSchemaRef: string;
}
```

- `depsOutputRefs` 只注入引用，不注入全文；解析失败 → `DEP_OUTPUT_MISSING`（§5.9.8.1）。
- `attemptContext` 只带上一 attempt 的结论，不回放历史对话。

**StepResult**

```ts
interface StepResult {
  status: 'succeeded' | 'failed' | 'needs_input' | 'timed_out' | 'cancelled';
  outputs?: Record<string, unknown>;
  outputParse: 'ok' | 'fallback';
  outputExtraKeys?: string[];
  partial?: {
    resultText?: string; resultFiles?: string[];
    fileChanges?: string[]; tokensUsed?: number; truncated?: boolean;
  };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  failureClass?: 'infra'|'busy'|'turn_fail'|'verify_fail'|'test_fail'|'env_fail'|'timeout'|'cancel'|'denied';
  verdict?: 'PASS' | 'FIX' | 'INPUT_REQUIRED';
  inputRequest?: { question: string; options?: string[]; default?: string; blocks: string[] };
}
```

**落库映射**

| 结果字段 | 落点 |
|---|---|
| `outputs` | `work_runs.outputs_json` |
| `outputExtraKeys` | `work_runs.output_extra_keys` |
| `partial` | `work_runs.partial_output_ref`（统一 JSON） |
| 文件变更 | `change_sets.files_json`（**不是** `outputs`） |
| `usage` | 既有 `agent_usage` 成本账本 |
| `failureClass` | `work_runs.failure_class` |
| `inputRequest` | `work_steps.input_request_json` |

- `outputs` 不得塞文件清单；文件一律走 `change_sets`，避免同一事实两套口径。
- `usage` 缺失写 NULL 并可计费告警，不得用 0 冒充"未消耗"。
- `status='failed'` 必须带 `failureClass`，缺失即 `INVALID_FAILURE_CLASS`；`status='cancelled'` 必须带 `cancel_reason`。

**M3 实施状态（2026-11-07）**

| 项 | 状态 | 说明 |
|---|---|---|
| 驱动真实 Agent turn 并落 run/step 终态（`completed` / `failed` / `cancelled` / `timeout`） | 已实施 | `src/main/map/agent-step-runner.ts`；终态写入在会话 terminate 之后、同一事务内条件更新 |
| `failureClass → work_runs.failure_class` | 已实施 | `agent_turns.failure_class` 经 `TurnOutcome.failureClass` 透出；v34 起同步写 `work_steps.failure_class`（同值域），步级失败不再只能 join 最近 run |
| deadline 路径 | 已实施 | `work_runs.deadline_at`（绝对）→ `AgentCommand.deadlineMs`（相对）；开跑前已过期直接 `timed_out`，不启动会话 |
| `needs_input` 回写 | **未实施** | `TurnOutcome` 无该信号，且明确不解析 `finalText` 中的 `INPUT_REQUIRED`；`work_steps.input_request_json` 保持 NULL，待结构化输出契约落地 |
| `outputs` / `outputParse` / `partial` / `usage` / 文件变更 | **未实施** | 属证据与结构化输出里程碑，本轮不写，不伪造空对象 |
| §5.9.10 Tier 能力探测与完整路由 | **明确偏离** | 仅 pinned adapter + `policy='manual_override'` 写 `routing_decisions`；Tier 探测推迟 |
| IPC / 外部触发入口 | 未接 | 执行器无可达入口，保持不可达 |
| kernel-only 发送契约 | 已实施 | `AgentManager.sendCommandKernelOnly`：runtime 缺失/执行器不在白名单/节点未挂载/driver 缺失一律抛错，不回落 legacy |
| item 级终态聚合（当前 revision 的步级） | 已实施 | `WorkItemService.convergeIfTerminal` + `WorkScheduler.claimNext`：无就绪步且全部步终态时收敛；仍有非终态步则等待。≥1 failed/timed_out → failed；否则有 cancelled → cancelled；全 succeeded/skipped → done |
| 依赖阻断级联 | 已实施 | `WorkStepService.blockUnstartedDependents`：上游 failed/timed_out/cancelled → 下游未开始步（仅 planning/pending）置 **failed + failure_class='blocked_by_dependency'**，沿依赖链 fixpoint 传递。v34 后已能区分人工跳过（`skip_reason`）与连带判负（`failure_class`），但仍不改回 skipped：`DEP_SATISFIED={succeeded,skipped}` 会把 skipped 当满足、聚合还会把全 skipped 收敛为 done，两处语义都得改才算等价。running/waiting_approval/review/needs_input/paused 一律不改 |
| 子 work_item（`parent_work_item_id`）聚合 | **未实施** | 仅聚合单个 item 的 steps，不跨父子 item；多级聚合留待后续里程碑 |
| `partial_cancel` 取消原因落库 | 已实施（v34） | `work_items.cancel_reason`：聚合收敛为 cancelled 时写 `partial_cancel`；人工 `cancel()` / `resolveHuman(cancel)` 写 `user` |


---

## 6. TestExecutor

### 6.1 边界与复用声明

| 声明 | 原因 |
|---|---|
| 不复用 Agent 会话判定通过 | Agent 的"我认为通过了"不是执行证据；判定必须来自真实进程退出码与输出 |
| 不复用 `RecipeRunner` 的 shell 步骤 | `recipe-runner` 直接 `child_process.spawn`，绕过审批网关与 Bash 策略；复用等于开后门 |
| 复用 `evaluateBashPolicy` | 命令分级（只读/ask/deny）必须与 Agent 工具一致 |
| 复用 `evaluateGitDirWriteGuard` | 写 `.git` 一律 deny，fail-closed |
| 复用 `ApprovalGateway` | 审批事实、超时、审计、重启重推都已在网关内实现 |
| 新 worktree | 测试不在主工作区执行，避免污染与并发写 |

### 6.2 执行流程

```
1. 依据 work_item / test_specs 生成 test_plan（命令清单 + cwd + 基线 commit）
   - 基线 commit = 创建 worktree 时的 HEAD；
   - 主工作区的 dirty 状态只作诊断信息，**不进入执行集、不参与任何通过/证据判定**
2. 计算 plan_hash = sha256(规范化命令清单 + cwd + 基线 + 计划内容)
3. 走 ApprovalGateway 提交 subject_type='test_plan' 的一次性审批
4. 批准后由主进程受控 git 能力创建 worktree（不通过 Bash 工具）
   - worktree 固定 `git worktree add --detach <base_commit>`；**不应用主工作区 diff**
5. 逐条执行 test_plan_items：
     - evaluateBashPolicy 判定
     - evaluateGitDirWriteGuard 判定（命中即 deny）
     - cwd 固定为 worktree；超时 kill
6. 结果写 test_results；聚合写 test_runs
7. 执行结束后采集 worktree 的真实内容指纹（`HEAD^{tree}` + worktree 内未提交文件），证据回写按 §6.2.1：
   **执行后仍干净 + worktree 等于 base_commit + 全部命令通过 + 关联 work_run** 才写 E3；
   已真实执行但执行后 worktree 被改脏（或未关联 work_run）→ 只写 E2（内容绑定到实际执行内容）；
   零执行或取不到执行内容 → 不写任何证据（宁缺勿假）
8. 清理 worktree（保留失败现场 N 天，可配置）
```

#### 6.2.1 E3 判据与 E2 内容绑定（修复"假 E3"与"假 E2"）

**两类假证据**：

1. **假 E3**：worktree 从基线 commit 创建、`code_version` 也记基线 commit，而主工作区未提交改动不在 worktree 里，测试通过却被写成"可复现 E3"。
2. **假 E2（2026-11-07 修复）**：E2 内容绑定拿**主工作区脏文件哈希**当代理，但主工作区改动从未进入 worktree；且失败分支无论是否真的执行过都写 E2。结果"从未被执行到的代码"被绑定成 E2，节点被派生成 `implemented`。

**L1 执行集（已实施）**：worktree 固定 `git worktree add --detach <base_commit>`，**不应用主工作区 diff**；主工作区是否 dirty 与本次执行无关，不参与任何判定。

| 执行后状态 | 证据 |
|---|---|
| worktree 干净（`git status --porcelain -uall` 为空）+ 全部命令通过 + 关联 `work_run_id` | E3：`version_binding='commit'`、`code_version=base_commit`、`code_dirty=0`、`reproducible=1`；`ref_json.worktreeTree` = `HEAD^{tree}` |
| 已真实执行，但 worktree 内出现未提交文件（命令自己改出来的改动），或未关联 `work_run_id`，或测试未全过 | 只写 E2：`version_binding='content_hash'`、`current_hash=executedContentHash`、`code_dirty` 留空；`ref_json` 记录 `worktreeCommit`、`worktreeTree`、`executedContentHash`、`worktreeDirtyFiles`、`workspaceChangesIncluded=false` |
| 零执行（全 deny / 全 skip / 仅有 infra error） | **不写任何证据** |
| 取不到执行内容指纹（worktree 已删 / git 异常） | **不写任何证据** |

E2 的 `executedContentHash` 定义：worktree 干净时 = `HEAD^{tree}`；执行后 worktree 有未提交改动时 = `sha256(treeHash + "\n" + sorted(path + ':' + sha256(content)))`，其中 `path` 为规范化相对路径、删除/重命名旧路径按 `absent` 计入。这样 `current_hash` 描述的是**真正被执行的那份内容**，而不是主工作区或猜测值。

E3 必须同时满足：

1. 执行结束后 worktree `git status --porcelain` 为空（含未跟踪文件；`.gitignore` 忽略项不算）；
2. `worktree_commit == code_version`，且 worktree 中无额外未提交改动；
3. test_plan 内所有命令退出码为 0，无 `timed_out` / `error`；
4. 测试结果由本次 run 产生，未复用历史输出；
5. 计划关联了 `work_run_id`（E3 的 `work_run_id` 必填来源）。

任一条件不满足 → 不得写 E3；**确实执行过**时写 E2 `test_run` 事实，并保留失败分类与输出引用；零执行不写。**不允许"先记 E3、事后降级"来掩盖判据缺失。**

##### 6.2.1.1 历史错误 E2 的处理

旧口径写入的错误 E2 特征：`evidence_level='E2' AND evidence_type='test_run'`，`summary` 以 `测试事实(dirty 工作区` 开头（固定文案"不可复现"），`ref_json` 不含 `worktreeCommit`，`current_hash` 常为 NULL 或主工作区脏文件哈希。可用如下查询识别：

```sql
SELECT id, project_path, graph_id, node_entity_key, work_run_id, current_hash, created_at
  FROM node_evidence
 WHERE evidence_level = 'E2' AND evidence_type = 'test_run'
   AND revoked_at IS NULL
   AND ref_json NOT LIKE '%worktreeCommit%'
   AND summary LIKE '测试事实(dirty 工作区%';
```

**本轮决定：可识别，但不自动标记/改写。** 原因：

- 事后无法重建"当时真正被执行的内容"（worktree 失败现场最多保留 7 天，多数已删除；主工作区内容也已变化），任何自动重写都是新的猜测；
- 直接撤销会丢失一条真实的"测试跑过+结果"事实，并影响历史执行态审计；
- 仅改 `freshness` 不会改变派生规则（E2 未撤销即 `implemented`），反而制造"已标记但仍派生"的假象。

处理路径：把上述查询结果作为人工审计清单；对仍依赖这些 E2 的节点，用当前代码**重跑测试计划**产出正确 E2/E3（新证据 `ref_json` 带 `worktreeCommit`）。若确认某条旧 E2 完全不可信，由人通过 `EvidenceService.revoke(id, …, revoke_reason='legacy_dirty_proxy_evidence')` 显式撤销，撤销会自动触发派生重算。

> 说明：`§3.7.1` 中的 `content_hash` 对测试事实 (E2 `test_run`) 指本节的 git 内容指纹；对"变更清单/文件面"类 E2 仍指 `scope_files` 逐文件 sha256 聚合。两者都是内容绑定，但描述的物件不同。

### 6.3 审批 subject 扩展

现状：`agent_approvals.run_id` / `turn_id` 为 `NOT NULL`，只表达"某个 turn 的工具调用"。

扩展方案：

```sql
run_id    TEXT,   -- 由 NOT NULL 放宽为可空
turn_id   TEXT,   -- 同上
subject_type TEXT NOT NULL DEFAULT 'agent_turn'
  CHECK(subject_type IN ('agent_turn','test_plan','work_item')),
subject_id   TEXT
```

- 一次性计划审批：`subject_type='test_plan'`，`subject_id=plan_id`，`tool_name='test.execute_plan'`，`args_json` 存规范化命令清单，`args_hash=plan_hash`。
- 重复使用条件：任何一条命令变更都会改变 `args_hash`；`args_hash` 不匹配即视为未审批，必须重新提交。
- 单条命令执行**逐条经过策略门**；`policy_decision='deny'` 的命令即使计划已批准也不执行（计划审批不能豁免 `deny`）。
- **`ask` 不因计划批准而免审（P0-3 行为变更，2026-11-07）**：计划审批只批准"计划本身"（命令清单 + `plan_hash`），不等于逐条命令已获批准。测试执行时，`evaluateBashPolicy` 判为 `ask` 的命令必须逐条经 `ApprovalGateway`（`subject_type='test_plan'`）放行；未获批准按 `deny` 处理（该条 `skipped` + 后续默认停止）。原口径"计划审批把 `ask` 提升为 `allow`"已废止。
- `execute()` 必须校验 `approval_id` 存在且指向 `subject_type='test_plan'`、`status='allowed'` 的审批行，并复算当前命令清单的 `plan_hash` 与批准时一致；不一致拒绝执行。
- 影响面：任何读取 `agent_approvals` 的查询需处理 `run_id/turn_id` 为空；重启重推逻辑需按 `subject_type` 分流，`test_plan` 未批准则计划作废（`expired`），不自动重放。
- 迁移方式见 §8 S8（该表需要重建，`NOT NULL` 无法用 `ALTER` 放宽）。

**不设独立 `test_approvals` 表（D6）**：测试计划审批统一写入 `agent_approvals`（`subject_type='test_plan'`），不另建一张审批表。理由：**两套审批事实会破坏审计单一来源** —— 一旦 `agent_approvals` 与 `test_approvals` 并存，"这次测试到底批准了没有"就要跨表对账，超时/撤销/重启重推也会出现两边状态不一致。审批只有一个入口、一张表、一套超时与撤销语义。

### 6.4 安全约束

- `evaluateBashPolicy` 与 `evaluateGitDirWriteGuard` 在 TestExecutor 内**逐条调用**，不可批处理跳过。
- worktree 创建走主进程 git 能力（既有受控路径），不暴露给模型，也不由 Bash 工具执行。
- 测试命令环境变量白名单化，不注入 session grants（会话级授权是内存态，重启即失，不可复用为测试授权）。
- 不启用 `unattended` 分支；计划级审批超时即作废。
- 测试输出可能含敏感信息：落盘时按现有 artifact 策略处理，`output_ref` 只存路径与 hash。

### 6.5 测试资产与结果回写

- 测试资产 = test 图节点（`test-suite` / `test-case`），通过 `node_links` 的 `verifies`（→ dev）与 `covers`（→ online）建立关联。
- `test_specs` 绑定 `test-case` 节点，一个节点可有多个 spec（不同命令/环境）。
- 结果回写：`test_results` → 命中 `verifies` 目标节点的 **E3** 证据（测试通过 + 代码 hash）；`test_runs` 聚合 → `node_execution_state` 重算。
- 写证据的前提是**有真实执行**：零执行（全 deny / 全 skip / 仅有 infra error）或取不到执行内容指纹时不写 E2/E3；证据内容一律绑定 worktree 实际执行内容，主工作区 dirty 不作代理（§6.2.1）。
- 失败的测试产生 E3 的反向事实（`status='failed'`），派生状态为 `failed`，但**不自动把 `nodes.status` 打回**。

#### 6.5.1 流程级测试（flow）的可执行定义

`test_specs.kind='flow'` 不是"一段描述"，而是**可执行序列**：

- 一个 flow spec 由有序的 `steps_json` 组成，每步引用一个 `test-case` 节点/子 spec，且有明确的命令、`cwd`、超时；
- 每步单独写一条 `test_results`；flow 聚合结果写 `test_runs`，**全部步骤通过才算 flow 通过**，任一步失败/超时则失败，后续步骤默认 `skipped`（可选 `continue_on_failure=false`）；
- flow 内不允许 `manual` / `llm_acceptance` 步骤（人工与 LLM 判定不能混进自动化通过链）；这类步骤必须作为独立用例走 E4/E2；
- flow 的 `plan_hash` 包含步骤顺序与每步命令，顺序变化即视为未审批；
- **范围（已定）**：流程级测试从 **L2 起做最小版**：框选子图 → 每个节点生成一个验证步 + 一个 shell 测试步 → 产出 `test_report`。**不做可视化编排**（拖拽排序、分支/并行编辑器属 L3）；L1 仍只做节点级测试。

##### 6.5.1.1 flow 最小版执行契约（B2）

**输入**：框选子图 `{graphId, nodeEntityKeys[]}`，节点必须属于 dev 图；每个节点读取 `verifies` 链接到 test-case。

**生成**

1. 校验选择集连通且无环；有环 → `SUBTREE_CYCLE`，拒绝生成计划。
2. 按 `edges` 依赖做拓扑排序；无依赖时按框选顺序。
3. 每个节点生成两步：`verify`（运行其 `verifies` 的 test-case spec）+ `shell`（该节点绑定的测试命令；无绑定 → `MISSING_TEST_COMMAND`）。
4. 写入 `test_specs(kind='flow')`，`steps_json` 固化顺序与命令；`plan_hash` 走 §6.3 审批。

**执行与产物**

- 一个 `test_runs(kind='flow')`；每步一条 `test_results`。
- 任一步 `failed` / `timed_out` / `denied` → flow `failed`，后续 `skipped`；`continue_on_failure` 默认 false；不自动重跑。
- 产出 `test_report`（JSON）：`{flow_run_id, overall, nodes:[{node_entity_key, verify:{status,result_ids[]}, shell:{status,result_ids[]}}]}`，落 `test_runs.report_ref`。
- 执行后 worktree 仍干净且命令通过（且有 `work_run_id`）→ 对目标节点写 E3；已真实执行但执行后被改脏/未关联 run → 只写 E2；零执行不写证据（§6.2.1）。
- `manual` / `llm_acceptance` 不得进 flow（§6.5.1）。

**不做**：拖拽排序、分支/并行编辑、可视化 DAG；改顺序 = 重新生成计划并重新审批。

#### 6.5.2 `published` 软阻断（测试资产）

test 图节点允许 `draft → confirmed → published`。`published` 增加一条**软阻断**：

- 没有任何通过记录（E3 或至少一条 `test_runs.status='passed'`）时，默认按钮不得是"发布"；
- 用户仍可显式确认发布，但必须填写理由并落库（`published_waiver_json`：`{by, at, reason, missing}`）；
- 这是**软阻断，不是硬拒绝**：不阻止人工标记 `published`，只影响徽标与统计口径 —— 无通过记录的发布在叠加层显示"未验证发布"徽标，并计入 `published_without_evidence`（单列，不计入"已验证资产"）；不采用强制测试或二次确认。

##### 6.5.2.1 `published` 判定、徽标与回滚（B2）

- `has_pass_evidence`：该 test-case 节点存在未撤销 E3，或至少一条 `test_runs.status='passed'`。
- `published` 且 `has_pass_evidence=0` → `published_without_evidence` 计数 +1，叠加层显示"未验证发布"；不计入"已验证资产"。
- 人工发布必须写 `published_waiver_json={by, at, reason, missing[]}`；缺任一字段 → 拒绝写入。
- 不做强制测试、不做二次确认；默认按钮可以是"先测试"，但**不得隐藏"仍然发布"入口**。
- 回滚：`published → confirmed` 只改 `nodes.status` 与徽标；**不删除** `test_results` / 证据行。再次发布重新计算 `has_pass_evidence`。
- 发布后测试失败：`nodes.status` 保持 `published`（人工状态不被自动改写），徽标追加"最近测试失败"；`published_without_evidence` 按当前证据重算。

### 6.6 Bug 闭环与定向重测（采纳）

外部蓝图给出了完整的失败→bug→修复→定向重测链路，我们此前只到"回写失败"为止。补齐如下：

1. **测试失败 → 自动建 bug**：在 dev 图 `bug_nodes` 新建一条，`title` = 失败用例名，`severity` 映射：阻断性失败 → `critical`；普通断言失败 → `major`；非功能性/文案 → `minor`。`metadata` 记录 `{test_run_id, test_case_ref, verifies_entity_key, failure_class}`。
2. **不建 bug 的例外**：`env_fail`（缺依赖/端口占用/编译环境）只记 `test_runs.failure_class`，不建 bug；否则会污染缺陷统计。
3. **bug → 修复任务**：bug 节点自动生成一个 `work_item`（`anchor_entity_key` = 被验证的 dev 实体，`origin='derived_plan'`），仍需 C2 确认后执行。
4. **定向重测**：修复完成后只重跑失败用例与同 suite 的相关用例（`test_plan_items.selected_by='targeted'`），不全量重跑；全量重跑是独立动作，需人触发。
5. **回写闭环**：定向重测通过 → 新 E3 证据（新 commit）→ bug 节点 `retested_at` + `verified_by_run_id`；bug 的关闭仍由人确认（`bug_nodes.status` 人工写），系统只给建议。
6. **证据链**：bug 行必须能反查到 `test_run` → `test_result` → 失败输出；缺任一环不允许标"已修复"。

### 6.7 手工用例与"人工验收型测试"（采纳，归 E4）

- `test-case` 节点 `metadata.case_kind` 取：`unit` / `integration` / `e2e` / `manual` / `llm_acceptance`（放在 `metadata` 里，不新增 `nodes` 列，避免再次触发 CHECK 重建）。
- `unit/integration/e2e` → 可产生 E3（命令 + 退出码 + 代码 hash）。
- `manual` → **不产生 E3**；执行时创建 `work_run(executor_kind='human')`，完成后进入 E4 签收流程（§3.5），标注"人工验收，无代码 hash、不可复现"。
- `llm_acceptance` → 只产生 E2 或 `evidence_suggestion`；**LLM 判定不得直接成为 E3/E4**，必须有人工确认或真实测试命令。
- 外部蓝图的"review gate（LLM 验收 + diff 接受 + 人工确认）"因此**降级映射**：LLM 部分 → E2 建议；人工确认部分 → E4；只有测试命令通过 + 代码 hash 才是 E3。

### 6.8 测试命令网关与归属校验（采纳）

- 统一命名 `TestCommandGateway`：所有测试相关 shell 步骤必须经过它；**禁止复用 `RecipeRunner` 的 shell 步骤**，禁止任何旁路 `child_process.spawn`。
- 每次执行前校验：`work_item.graph_id` 与目标节点所属图一致；`test_specs.project_path` 与当前项目根一致；不属于当前会话/图的计划一律拒绝。
- 跨会话的 `pending approvals` 必须按 `subject ownership` 过滤，不能把 A 项目的测试计划审批展示给 B 项目。
- `recipes:run` 的 IPC 入口必须补归属校验（现有实现可被任意工程触发）。

#### 6.8.1 allow-list 纪律（新增规则）

每扩展一条 allow 类测试命令，必须同时补一条测试，断言"该命令消费了哪些配置键"，并写进本网关的测试清单：

- 例：`npm test` 必须断言读取了 `package.json`（`scripts`、`workspaces`）、`.npmrc`（registry/鉴权）、`NODE_ENV`、`tsconfig`（若命令走 `tsc`）；`pytest` 必须断言 `pytest.ini` / `pyproject.toml` / 环境变量白名单。
- 测试要能在"配置键清单变化"时失败（例如新增读取 `.env` 或 `~/.npmrc` 未列入白名单），而不是只验证命令能跑通。
- 未补该测试的 allow 命令不得合入；这防止测试命令在无人注意时读取配置中的凭据或改变行为。

#### 6.8.2 测试执行网关接口契约（B2）

| 接口 | 输入 | 输出 | 失败分支 |
|---|---|---|---|
| `test:plan:create` | `{workItemId, graphId, projectPath, specIds[]}` | `{planId, planHash, items[]}` | `OWNERSHIP_MISMATCH`；`SPEC_NOT_EXECUTABLE`（含 manual 步骤）；`NO_COMMANDS` |
| `test:plan:approve` | `{planId}` | `{approvalId, expiresAt}` | `HASH_MISMATCH`；`APPROVAL_PENDING`（幂等返回既有） |
| `test:plan:run` | `{planId}` | `{testRunId}` | `NOT_APPROVED` / `APPROVAL_EXPIRED`；`HASH_MISMATCH`；`CONCURRENT_TEST`（A3 串行）；`WORKTREE_FAILED`（`env_fail`，不建 bug） |
| `test:run:get` | `{testRunId}` | 结果与步骤状态 | 只读，无失败分支 |

执行顺序：逐条 `evaluateBashPolicy` → `evaluateGitDirWriteGuard` → `ask` 命令经 `ApprovalGateway` 逐条放行 → 以 worktree 为 `cwd` 执行 → 写 `test_results` → 聚合 `test_runs`。`policy_decision='deny'` 的命令即使计划已批准也不执行，写 `denied` 结果；`ask` 命令未获网关批准同样按 `deny` 处理（P0-3：计划审批不提升 `ask`）。计划其余命令默认停止（`continue_on_failure=false`，后续 `skipped`）。每条命令超时独立（默认 60 分钟，可配置），超时即 `timed_out`。

---

## 7. 字段级表结构

> 所有新增表使用 TEXT 时间戳（ISO）以与既有表一致；`agent_*` 相关表使用 INTEGER 毫秒时间戳以与既有 Agent Runtime 一致。以下按各自归属标注。

### 7.1 既有表变更（DDL diff）

#### `graphs`

```sql
type TEXT NOT NULL CHECK(type IN ('online','dev','test'))
-- v24 已补进 createSql（否则表重建会重置用户"关闭写回"设置）：
writeback_disabled INTEGER DEFAULT 0
```

S1 不新增图列：重复导入靠 `project_fingerprints` 在写图之前拦截，不需要 lineage 分组列。

#### `nodes`

```sql
type TEXT NOT NULL CHECK(type IN (
  'project','module','process','feature','bug','wiki-page',
  'test-suite','test-case'))
graph_type TEXT NOT NULL CHECK(graph_type IN ('online','dev','test'))
entity_key TEXT                      -- 可空；不进 requiredColumns
lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK(lifecycle_state IN ('active','archived','merged','split'))
```

#### `edges`

```sql
edge_type TEXT CHECK(edge_type IN (
  'default','success','failure','condition','business-flow','semantic',
  'dependency','co-change','wiki-link','hierarchical',
  'verifies','covers'))
updated_at TEXT                      -- 补进 createSql，避免重建丢值
```

#### `agent_approvals`

```sql
run_id TEXT                          -- 原 NOT NULL → 可空
turn_id TEXT                         -- 原 NOT NULL → 可空
subject_type TEXT NOT NULL DEFAULT 'agent_turn'
  CHECK(subject_type IN ('agent_turn','test_plan','work_item'))
subject_id TEXT
-- 回填：UPDATE agent_approvals SET subject_id = turn_id WHERE subject_id IS NULL
```

**不新增 `test_approvals` 表（D6）**：测试计划审批复用本表的 `subject_type='test_plan'`；独立审批表会造成两套审批事实与审计分裂，理由见 §6.3。

**语义边界（v35）**：本表只承载**工具的调用审批**（一次 `tool_name` + `args_json` 的放行/拒绝），不得写入“人工验收确认”这类非工具事实。后者落 `acceptance_confirmations`（§M5.12）；`9852b77` 的 `tool_name='acceptance_manual_confirm'` 写法已废止，存量行由 v35 迁移搬走。

### 7.2 新增表

#### `node_links`

```sql
CREATE TABLE node_links (
  id              TEXT PRIMARY KEY,
  project_path    TEXT NOT NULL,
  from_entity_key TEXT NOT NULL,
  from_graph_id   TEXT NOT NULL,
  from_graph_type TEXT NOT NULL CHECK(from_graph_type IN ('online','dev','test')),
  from_node_id    TEXT,
  to_entity_key   TEXT NOT NULL,
  to_graph_id     TEXT NOT NULL,
  to_graph_type   TEXT NOT NULL CHECK(to_graph_type IN ('online','dev','test')),
  to_node_id      TEXT,
  link_type       TEXT NOT NULL CHECK(link_type IN (
    'derives_from','implements','verifies','covers','depends_on',
    'split_from','merged_into','supersedes','relates_to')),
  direction       TEXT NOT NULL DEFAULT 'directed'
                  CHECK(direction IN ('directed','symmetric')),
  confidence      REAL NOT NULL DEFAULT 1.0,
  origin          TEXT NOT NULL CHECK(origin IN ('human','derived','import')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active','stale','orphan')),
  reason          TEXT,
  metadata        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(from_graph_id, to_graph_id, from_entity_key, to_entity_key, link_type)
);

CREATE INDEX idx_node_links_from     ON node_links(from_entity_key);
CREATE INDEX idx_node_links_to       ON node_links(to_entity_key);
CREATE INDEX idx_node_links_project  ON node_links(project_path, status);
CREATE INDEX idx_node_links_from_node ON node_links(from_node_id);
CREATE INDEX idx_node_links_to_node   ON node_links(to_node_id);
```

#### `project_fingerprints`（S1，导入查重）

```sql
CREATE TABLE project_fingerprints (
  id                TEXT PRIMARY KEY,
  project_name      TEXT,
  dir_name          TEXT NOT NULL,
  root_path         TEXT NOT NULL,
  last_modified_at  INTEGER,
  sample_files_json TEXT NOT NULL,
  sample_count      INTEGER NOT NULL,
  signature_hash    TEXT,
  graph_ids_json    TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  UNIQUE(root_path)
);

CREATE INDEX idx_project_fingerprints_dir ON project_fingerprints(dir_name);
```

#### `import_rejections`（S1，导入决策记录）

> 表名沿用"拒绝"语义，但同时记录 `allowed_branch` / `allowed_with_warning` 两类放行决策，便于审计"为什么这次允许了"。

```sql
CREATE TABLE import_rejections (
  id                     TEXT PRIMARY KEY,
  attempted_root_path    TEXT NOT NULL,
  attempted_name         TEXT,
  attempted_dir_name     TEXT,
  matched_fingerprint_id TEXT,
  matched_signals_json   TEXT NOT NULL,
  decision               TEXT NOT NULL CHECK(decision IN (
    'rejected','allowed_branch','allowed_with_warning')),
  allowance_source       TEXT CHECK(allowance_source IN ('this_time','remembered_rule')),
  reason                 TEXT,
  created_at             TEXT NOT NULL
);

CREATE INDEX idx_import_rejections_time ON import_rejections(created_at);

-- 记住的分支/副本放行规则（默认不产生；仅用户主动勾选"对同一指纹记住"时写入）
CREATE TABLE import_allowances (
  id              TEXT PRIMARY KEY,
  fingerprint_id  TEXT NOT NULL REFERENCES project_fingerprints(id) ON DELETE CASCADE,
  dir_name        TEXT NOT NULL,
  granted_by      TEXT NOT NULL,
  granted_at      TEXT NOT NULL,
  note            TEXT,
  revoked_at      TEXT,
  revoked_by      TEXT,
  UNIQUE(fingerprint_id, dir_name)
);

CREATE INDEX idx_import_allowances_fp ON import_allowances(fingerprint_id);
```

- 拒绝/放行明细留存 **90 天**；聚合计数写 `map_migration_reports.kind='import_dedup'`，**永久保留**。
- `import_allowances` 不随 90 天清理，保留至用户撤销；撤销后保留 `revoked_at` 审计痕迹。
- 命中记住规则时，`import_rejections.allowance_source='remembered_rule'`，证据面板必须显示"本次放行来自记住的规则"。

#### `node_evidence`

```sql
CREATE TABLE node_evidence (
  id               TEXT PRIMARY KEY,
  project_path     TEXT,
  graph_id         TEXT NOT NULL,
  graph_type       TEXT NOT NULL CHECK(graph_type IN ('online','dev','test')),
  node_entity_key  TEXT NOT NULL,
  node_id          TEXT,
  evidence_level   TEXT NOT NULL CHECK(evidence_level IN ('E1','E2','E3','E4')),
  evidence_type    TEXT NOT NULL CHECK(evidence_type IN (
    'changed_files','commit','test_run','session_turn',
    'artifact','human_confirm','runtime_observation')),
  ref_json         TEXT NOT NULL,
  summary          TEXT,
  version_binding  TEXT NOT NULL DEFAULT 'commit'
                   CHECK(version_binding IN ('commit','content_hash','snapshot','none')),
                   -- E3 只认 'commit'（git 代码 hash）；E4 必须 'none'
                   -- 'content_hash'/'snapshot' 仅用于 E2 文件级证据与 stale 辅助，不构成 E3
  code_version     TEXT,
  code_dirty       INTEGER,
  base_hash        TEXT,
  current_hash     TEXT,
  freshness        TEXT NOT NULL DEFAULT 'fresh'
                   CHECK(freshness IN ('fresh','stale','unknown')),
  produced_by      TEXT NOT NULL
                   CHECK(produced_by IN ('human','agent','test_executor','system')),
  work_item_id     TEXT,
  work_run_id      TEXT,
  session_id       TEXT,
  turn_id          TEXT,
  created_at       TEXT NOT NULL,
  verified_at      TEXT,
  stale_at         TEXT,
  -- E4 人工签收（§3.5）：无代码 hash、不可复现
  signed_by               TEXT,   -- 本地用户标识
  signed_by_display_name  TEXT,   -- 可选显示名
  signed_at               TEXT,
  coverage_json           TEXT,
  basis_ref_json          TEXT,
  reproducible            INTEGER, -- 冗余派生：E3=1；E4=0（用于分组统计）
  expires_at       TEXT,
  renewed_from_evidence_id TEXT, -- 一键续签引用的原 E4 证据
  revoked_at       TEXT,
  revoked_by       TEXT,
  revoke_reason    TEXT,
  -- E3 的字段级硬约束：缺任一条件都不能落成 E3（应用层还要校验测试与工作区状态）
  CHECK (evidence_level <> 'E3' OR (
    version_binding = 'commit'
    AND code_version IS NOT NULL
    AND code_dirty = 0
    AND reproducible = 1
  )),
  -- E4 的字段级硬约束：人工签收、无代码 hash、不可复现
  CHECK (evidence_level <> 'E4' OR (
    version_binding = 'none'
    AND code_version IS NULL
    AND reproducible = 0
    AND signed_by IS NOT NULL
    AND signed_at IS NOT NULL
    AND coverage_json IS NOT NULL
  ))
);

CREATE INDEX idx_node_evidence_node    ON node_evidence(graph_id, node_entity_key);
CREATE INDEX idx_node_evidence_level   ON node_evidence(evidence_level, freshness);
CREATE INDEX idx_node_evidence_run     ON node_evidence(work_run_id);
-- 同一 run 对同一节点产出的同类证据只落一条（重试幂等）；E4 人工签收不在此约束内
CREATE UNIQUE INDEX ux_node_evidence_run_type
  ON node_evidence(graph_id, work_run_id, evidence_type, node_entity_key)
  WHERE work_run_id IS NOT NULL AND evidence_level IN ('E2','E3');
```

未存 E0：证据缺失即 E0。

#### `evidence_suggestions`

```sql
CREATE TABLE evidence_suggestions (
  id               TEXT PRIMARY KEY,
  project_path     TEXT,
  graph_id         TEXT NOT NULL,
  node_entity_key  TEXT NOT NULL,
  node_id          TEXT,
  suggested_level  TEXT NOT NULL CHECK(suggested_level IN ('E1','E2','E3','E4')),
  evidence_type    TEXT NOT NULL,
  ref_json         TEXT NOT NULL,
  rationale        TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 0.5,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending','accepted','dismissed')),
  produced_by_run_id TEXT,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  resolved_by      TEXT
);

CREATE INDEX idx_evidence_suggestions_status ON evidence_suggestions(graph_id, status);
```

#### `node_execution_state`（派生缓存，可整表重建）

```sql
CREATE TABLE node_execution_state (
  graph_id           TEXT NOT NULL,
  node_entity_key    TEXT NOT NULL,
  execution_state    TEXT NOT NULL CHECK(execution_state IN (
    'untouched','planned','in_progress','implemented',
    'verified','signed_off','failed','blocked','stale')),
  evidence_level     TEXT NOT NULL CHECK(evidence_level IN ('E0','E1','E2','E3','E4')),
  is_reproducible    INTEGER,  -- E3=1；E4=0；E0/E1/E2=NULL（不写 0，§3.7.4）
  evidence_count     INTEGER NOT NULL DEFAULT 0,
  stale_count        INTEGER NOT NULL DEFAULT 0,
  derivation_version INTEGER NOT NULL DEFAULT 1,
  inputs_hash        TEXT,
  computed_at        INTEGER NOT NULL,
  PRIMARY KEY (graph_id, node_entity_key)
);

CREATE INDEX idx_node_execution_state_value ON node_execution_state(execution_state);
```

#### `work_items`

```sql
CREATE TABLE work_items (
  id                   TEXT PRIMARY KEY,
  lineage_id           TEXT NOT NULL,
  revision             INTEGER NOT NULL DEFAULT 1,
  supersedes_id        TEXT,
  is_current           INTEGER NOT NULL DEFAULT 1,
  project_path         TEXT,
  graph_id             TEXT NOT NULL,
  anchor_entity_key    TEXT,
  anchor_node_id       TEXT,
  parent_work_item_id  TEXT REFERENCES work_items(id),
  depth                INTEGER NOT NULL DEFAULT 0,
  title                TEXT NOT NULL,
  goal                 TEXT,
  scope_files          TEXT NOT NULL DEFAULT '[]',
  out_of_scope_files   TEXT,
  acceptance_json      TEXT NOT NULL DEFAULT '[]',
  verification_hint    TEXT,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
    'draft','awaiting_confirm','queued','running','blocked',
    'needs_input','needs_human','paused','interrupted',
    'done','failed','cancelled','superseded')),
  cancel_reason        TEXT,                          -- v34: user | partial_cancel
  gate_status          TEXT NOT NULL DEFAULT 'incomplete'
                       CHECK(gate_status IN ('incomplete','pass','waived')),
  gate_missing_json    TEXT,
  gate_waived_by       TEXT,                          -- G2 manual 豁免人（仅 waived 时有值）
  gate_waived_at       INTEGER,
  gate_waive_reason    TEXT,                          -- 豁免理由，必填于 waived
  depends_on_json      TEXT NOT NULL DEFAULT '[]',   -- 上游 work_item id 列表
  origin               TEXT NOT NULL CHECK(origin IN ('human','derived_plan','imported')),
  plan_id              TEXT,
  candidate_id         TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  archived_at          TEXT,
  UNIQUE(lineage_id, revision)
);

CREATE UNIQUE INDEX ux_work_items_current ON work_items(lineage_id) WHERE is_current = 1;
CREATE INDEX idx_work_items_graph  ON work_items(graph_id, status);
CREATE INDEX idx_work_items_anchor ON work_items(graph_id, anchor_entity_key);
CREATE INDEX idx_work_items_parent ON work_items(parent_work_item_id);
```

#### `work_steps`

```sql
CREATE TABLE work_steps (
  id                   TEXT PRIMARY KEY,
  work_item_id         TEXT NOT NULL REFERENCES work_items(id),
  work_item_revision   INTEGER NOT NULL,
  seq                  INTEGER NOT NULL,
  title                TEXT NOT NULL,
  step_kind            TEXT NOT NULL CHECK(step_kind IN ('agent','test','human')),
  scope_files_json     TEXT NOT NULL DEFAULT '[]',
  depends_on_step_ids_json TEXT,
  output_schema_json   TEXT,              -- 结构化输出契约（步级）
  consults_json        TEXT,              -- 需要咨询/评审的上游项
  checker_work_item_id TEXT REFERENCES work_items(id), -- maker-checker 审查项
  deadline_at          INTEGER,           -- 步级截止时间（调度器写入）
  attempt              INTEGER NOT NULL DEFAULT 1,
  invocation_id        TEXT,              -- 执行器调用号
  input_request_json   TEXT,              -- needs_input 问题卡
  status               TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'planning','pending','waiting_approval','running','review',
    'needs_input','paused','succeeded','failed','timed_out',
    'cancelled','skipped')),
  skip_reason          TEXT,              -- v34: condition_unmet | optional_not_required | human
  failure_class        TEXT,              -- v34: work_runs 同值域 + blocked_by_dependency
  started_at           INTEGER,
  ended_at             INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(work_item_id, work_item_revision, seq)
);

CREATE INDEX idx_work_steps_item   ON work_steps(work_item_id, work_item_revision, seq);
CREATE INDEX idx_work_steps_status ON work_steps(status);
```

- 编排步专属字段只在此表；`work_items` 不复制这些列。
- S5 建表时一次写死全部 `status` 值，避免后续重建。
- v34 的 `skip_reason` / `failure_class` / `cancel_reason` 是**纯加列**：写在 `createSql` 但不进 `requiredColumns`，存量库由 `runIncrementalMigrations` 用 `ALTER TABLE ADD COLUMN` 补齐，不触发表重建。

#### `work_runs`

```sql
CREATE TABLE work_runs (
  id                   TEXT PRIMARY KEY,
  work_item_id         TEXT NOT NULL REFERENCES work_items(id),
  work_item_lineage_id TEXT NOT NULL,
  work_item_revision   INTEGER NOT NULL,
  step_id              TEXT REFERENCES work_steps(id),
  run_seq              INTEGER NOT NULL,
  attempt              INTEGER NOT NULL DEFAULT 1,
  idempotency_key      TEXT NOT NULL,   -- lineage:revision:step_seq:attempt
  executor_kind        TEXT NOT NULL CHECK(executor_kind IN ('agent','test','human')),
  adapter_name         TEXT,
  route_decision_id    TEXT,
  status               TEXT NOT NULL CHECK(status IN (
    'queued','running','awaiting_approval','blocked',
    'completed','failed','cancelled','superseded',
    'interrupted','timed_out')),
  session_id           TEXT,
  thread_id            TEXT,
  agent_run_id         TEXT,
  invocation_id        TEXT,
  started_at           INTEGER,
  deadline_at          INTEGER,
  ended_at             INTEGER,
  result_summary       TEXT,
  outputs_json         TEXT,
  output_parse         TEXT CHECK(output_parse IN ('ok','fallback')),
  output_extra_keys    TEXT,            -- schema 外被丢弃的键（JSON 数组）
  partial_output_ref   TEXT,
  failure_class        TEXT CHECK(failure_class IN (
    'infra','busy','turn_fail','verify_fail','test_fail',
    'env_fail','timeout','cancel','denied')),
  cancel_requested_at  INTEGER,
  cancel_reason        TEXT CHECK(cancel_reason IN (
    'user','upstream_cancelled','deadline','shutdown','approval_denied')),
  created_at           INTEGER NOT NULL,
  UNIQUE(work_item_id, run_seq),
  UNIQUE(idempotency_key)
);

CREATE INDEX idx_work_runs_lineage ON work_runs(work_item_lineage_id, run_seq);
CREATE INDEX idx_work_runs_status  ON work_runs(status);
CREATE INDEX idx_work_runs_session ON work_runs(session_id);
```

#### `node_session_links`

```sql
CREATE TABLE node_session_links (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  graph_id         TEXT NOT NULL,
  node_entity_key  TEXT,
  node_id          TEXT,
  work_item_id     TEXT,
  work_run_id      TEXT,
  thread_id        TEXT NOT NULL,
  session_id       TEXT,
  agent_run_id     TEXT,
  turn_id          TEXT,
  link_role        TEXT NOT NULL CHECK(link_role IN (
    'primary','supporting','review','test','investigation')),
  session_origin   TEXT NOT NULL CHECK(session_origin IN (
    'map_task','manual_panel','subagent','test')),
  started_at       INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL
);

-- 节点级链接：同一 thread + 节点 + 角色只允许一条
CREATE UNIQUE INDEX ux_node_session_links_node
  ON node_session_links(thread_id, node_entity_key, link_role)
  WHERE node_entity_key IS NOT NULL;
-- 项目级链接：同一 thread + 角色只允许一条（NULL 不参与普通 UNIQUE，必须用部分索引）
CREATE UNIQUE INDEX ux_node_session_links_project
  ON node_session_links(thread_id, link_role)
  WHERE node_entity_key IS NULL;

CREATE INDEX idx_node_session_links_node    ON node_session_links(graph_id, node_entity_key, created_at);
CREATE INDEX idx_node_session_links_work    ON node_session_links(work_item_id);
CREATE INDEX idx_node_session_links_thread  ON node_session_links(thread_id);
```

#### `change_sets`

```sql
CREATE TABLE change_sets (
  id              TEXT PRIMARY KEY,
  project_path    TEXT NOT NULL,
  graph_id        TEXT,
  work_run_id     TEXT,
  session_id      TEXT,
  base_commit     TEXT,
  head_commit     TEXT,
  dirty           INTEGER NOT NULL DEFAULT 0,
  dirty_tree_hash TEXT,
  files_json      TEXT NOT NULL,
  file_count      INTEGER NOT NULL DEFAULT 0,
  line_additions  INTEGER NOT NULL DEFAULT 0,
  line_deletions  INTEGER NOT NULL DEFAULT 0,
  captured_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_change_sets_run ON change_sets(work_run_id) WHERE work_run_id IS NOT NULL;
CREATE INDEX idx_change_sets_project ON change_sets(project_path, captured_at DESC);
```

#### `routing_decisions`

```sql
CREATE TABLE routing_decisions (
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT,
  work_run_id       TEXT,
  chosen_adapter    TEXT NOT NULL,
  candidate_json    TEXT NOT NULL,
  reason            TEXT,
  policy            TEXT NOT NULL CHECK(policy IN ('single_agent','manual_override','fallback')),
  confidence        REAL,
  created_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_routing_decisions_run ON routing_decisions(work_run_id) WHERE work_run_id IS NOT NULL;
CREATE INDEX idx_routing_decisions_item ON routing_decisions(work_item_id, created_at DESC);
```

#### `boundary_candidates`

```sql
CREATE TABLE boundary_candidates (
  id                 TEXT PRIMARY KEY,
  derivation_run_id  TEXT NOT NULL,
  derivation_version TEXT NOT NULL,
  project_path       TEXT,
  graph_id           TEXT NOT NULL,
  anchor_entity_key  TEXT,
  anchor_node_id     TEXT,
  node_keys_json     TEXT NOT NULL,
  files_json         TEXT NOT NULL,
  signals_json       TEXT,
  score              REAL NOT NULL,
  confidence         REAL,
  reason             TEXT,
  status             TEXT NOT NULL DEFAULT 'proposed'
                     CHECK(status IN ('proposed','chosen','rejected','merged')),
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_boundary_candidates_run  ON boundary_candidates(derivation_run_id);
CREATE INDEX idx_boundary_candidates_anchor ON boundary_candidates(graph_id, anchor_entity_key);
```

#### `plan_drafts`

```sql
CREATE TABLE plan_drafts (
  id                     TEXT PRIMARY KEY,
  lineage_id             TEXT NOT NULL,
  revision               INTEGER NOT NULL DEFAULT 1,
  supersedes_id          TEXT,
  is_current             INTEGER NOT NULL DEFAULT 1,
  project_path           TEXT,
  graph_id               TEXT NOT NULL,
  anchor_entity_key      TEXT,
  anchor_node_id         TEXT,
  derivation_run_id      TEXT,
  items_json             TEXT NOT NULL,
  model_choice_json      TEXT,
  rejected_boundaries_json TEXT,
  status                 TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
    'draft','awaiting_confirm','confirmed','rejected','superseded')),
  confirmed_by           TEXT,
  confirmed_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE(lineage_id, revision)
);

CREATE UNIQUE INDEX ux_plan_drafts_current ON plan_drafts(lineage_id) WHERE is_current = 1;
CREATE INDEX idx_plan_drafts_anchor ON plan_drafts(graph_id, anchor_entity_key, is_current);
```

#### `plan_deviations`

```sql
CREATE TABLE plan_deviations (
  id                    TEXT PRIMARY KEY,
  work_item_id          TEXT,
  work_item_lineage_id  TEXT,
  work_item_revision    INTEGER,
  work_run_id           TEXT,
  derivation_version    TEXT NOT NULL,   -- 计划生成时固定
  observed_rule_version TEXT NOT NULL,   -- 记录时配置哈希
  task_type             TEXT NOT NULL,   -- 记录时快照（锚点类型/任务来源）
  agent_type            TEXT,            -- 记录时快照（实际 adapter）
  planned_file_count    INTEGER,
  actual_file_count     INTEGER,
  planned_subtask_count INTEGER,
  actual_subtask_count  INTEGER,
  turns_used            INTEGER,
  tool_calls            INTEGER,
  rework_count          INTEGER NOT NULL DEFAULT 0,
  test_failures         INTEGER NOT NULL DEFAULT 0,
  replan_count          INTEGER NOT NULL DEFAULT 0,
  scope_violation       INTEGER NOT NULL DEFAULT 0,
  boundary_changed      INTEGER NOT NULL DEFAULT 0,
  duration_ms           INTEGER,
  computed_at           INTEGER NOT NULL
);

CREATE INDEX idx_plan_deviations_rule ON plan_deviations(derivation_version, observed_rule_version);
CREATE INDEX idx_plan_deviations_item ON plan_deviations(work_item_lineage_id);

-- 目录前缀维度：一次 run 可跨多个目录，展开为一行一域；不把 file_domain 存成单值
CREATE VIEW v_plan_deviations_file_domain AS
SELECT d.id AS deviation_id,
       d.work_run_id,
       d.derivation_version,
       d.observed_rule_version,
       d.task_type,
       d.agent_type,
       json_extract(je.value, '$.path') AS file_path,
       CASE
         WHEN instr(json_extract(je.value, '$.path'), '/') > 0
           THEN substr(json_extract(je.value, '$.path'), 1, instr(json_extract(je.value, '$.path'), '/'))
         ELSE ''
       END AS file_domain
FROM plan_deviations d
LEFT JOIN change_sets cs ON cs.work_run_id = d.work_run_id
LEFT JOIN json_each(cs.files_json) je;
```

#### `test_specs`

```sql
CREATE TABLE test_specs (
  id                 TEXT PRIMARY KEY,
  project_path       TEXT NOT NULL,
  graph_id           TEXT,
  test_node_entity_key TEXT NOT NULL,
  test_node_id       TEXT,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK(kind IN ('unit','integration','e2e','flow')),
  command            TEXT NOT NULL,
  cwd                TEXT,
  env_json           TEXT,
  timeout_ms         INTEGER NOT NULL DEFAULT 300000,
  runner             TEXT,
  file_globs_json    TEXT,
  steps_json         TEXT,                      -- kind='flow' 时的有序步骤定义
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_test_specs_node ON test_specs(graph_id, test_node_entity_key);
```

#### `test_plans`

```sql
CREATE TABLE test_plans (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  graph_id         TEXT,
  work_item_id     TEXT,
  work_run_id      TEXT,
  node_keys_json   TEXT NOT NULL,
  base_commit      TEXT,
  worktree_path    TEXT,
  plan_hash        TEXT NOT NULL,
  approval_id      TEXT,
  status           TEXT NOT NULL CHECK(status IN (
    'draft','awaiting_approval','approved','running',
    'completed','failed','cancelled','expired')),
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  approved_at      INTEGER,
  started_at       INTEGER,
  ended_at         INTEGER
);

CREATE INDEX idx_test_plans_status ON test_plans(status);
CREATE INDEX idx_test_plans_item   ON test_plans(work_item_id);
```

#### `test_plan_items`

```sql
CREATE TABLE test_plan_items (
  id                TEXT PRIMARY KEY,
  plan_id           TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  spec_id           TEXT,
  seq               INTEGER NOT NULL,
  command           TEXT NOT NULL,
  cwd               TEXT,
  selected_by       TEXT NOT NULL DEFAULT 'plan'
                    CHECK(selected_by IN ('plan','targeted','rerun')),
  targeted_reason   TEXT,
  policy_decision   TEXT CHECK(policy_decision IN ('allow','deny','ask')),
  status            TEXT NOT NULL CHECK(status IN (
    'pending','running','passed','failed','skipped','error','timed_out')),
  exit_code         INTEGER,
  duration_ms       INTEGER,
  output_ref        TEXT,
  started_at        INTEGER,
  ended_at          INTEGER,
  UNIQUE(plan_id, seq)
);
```

#### `test_runs`

```sql
CREATE TABLE test_runs (
  id               TEXT PRIMARY KEY,
  plan_id          TEXT NOT NULL,
  project_path     TEXT NOT NULL,
  graph_id         TEXT,
  work_item_id     TEXT,
  work_run_id      TEXT,
  base_commit      TEXT,
  head_commit      TEXT,
  worktree_commit  TEXT,
  dirty            INTEGER NOT NULL DEFAULT 0,
  dirty_tree_hash  TEXT,
  status           TEXT NOT NULL CHECK(status IN (
    'pending','running','passed','failed','error','cancelled','stale')),
  total            INTEGER NOT NULL DEFAULT 0,
  passed           INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
  report_ref       TEXT,
  started_at       INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX idx_test_runs_plan ON test_runs(plan_id);
CREATE INDEX idx_test_runs_item ON test_runs(work_item_id);
```

#### `test_results`

```sql
CREATE TABLE test_results (
  id                     TEXT PRIMARY KEY,
  test_run_id            TEXT NOT NULL,
  plan_item_id           TEXT,
  spec_id                TEXT,
  test_node_entity_key   TEXT,
  target_node_entity_key TEXT,
  status                 TEXT NOT NULL CHECK(status IN (
    'passed','failed','skipped','error','timed_out')),
  exit_code              INTEGER,
  duration_ms            INTEGER,
  failure_summary        TEXT,
  failure_class          TEXT CHECK(failure_class IN (
    'assertion','timeout','env_fail','infra','cancelled')),
  output_ref             TEXT,
  created_at             INTEGER NOT NULL
);

CREATE INDEX idx_test_results_run    ON test_results(test_run_id);
CREATE INDEX idx_test_results_target ON test_results(target_node_entity_key, status);
```

#### `map_migration_reports`

```sql
CREATE TABLE map_migration_reports (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN (
    'entity_key_backfill','link_backfill','integrity_check','import_dedup',
    'derivation','cleanup')),
  stage         TEXT,                       -- S1..S8 或具体子步骤
  schema_version INTEGER,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  heartbeat_at  TEXT,
  owner_pid     INTEGER,                    -- 执行迁移的进程；用于区分"另一实例在迁移"
  status        TEXT NOT NULL CHECK(status IN ('running','ok','partial','failed')),
  stats_json    TEXT,
  details_json  TEXT,
  error_json    TEXT
);
```

### 7.3 值域汇总（类型层需同步扩展）

| 类型 | 新增值 |
|---|---|
| `GraphType` | `test` |
| `NodeType` | `test-suite`、`test-case` |
| `EdgeType` | `verifies`、`covers` |
| `NodeStatus` | 不变（7 值） |
| 新增 `WorkItemStatus` | 13 值（见 §4.1.1；四个新值 + 为父任务失败聚合补入 `failed`，均在 S5 DDL 一次写死） |
| 新增 `WorkStepStatus` | 12 值（见 §5.9.8） |
| 新增 `ExecutionState` | 9 值（见 §3.3，含 `signed_off`） |
| 新增 `EvidenceLevel` | `E0`–`E4` |

注意：`NODE_STATUS_TRANSITIONS` 是 `Record<NodeType, ...>`，新增 NodeType 必须补矩阵，否则类型检查失败；test 节点建议只允许 `draft → confirmed → published`（`developing/testing/review` 对测试资产无意义，作为默认假设）。`published` 采用软阻断（无通过记录时显示徽标并计入 `published_without_evidence`，不阻止人工标记），见 §6.5.2。

---

## 8. 迁移与实施顺序

> 当前 `CURRENT_SCHEMA_VERSION = 24`。**v24 是既有缺陷修复**（把增量列正式写进 `createSql`，见 §8.13），不属于蓝图增量。
> 下列 S1–S8 对应 v25–v32。
> **通用前置**：S0 备份完成且校验通过；迁移默认在启动期单事务内执行；`foreign_key_check` 必须为 0。
>
> **B1 例外（可续跑回填）**：`S1.backfill` 与 `S2` 按项目分批事务提交，便于中断后续跑；其余阶段仍按单事务执行。分批阶段必须在 `map_migration_reports` 记录进度与 `resume_from`；启动预检对这批幂等阶段自动续跑，非白名单阶段仍按 §8.14.1 fail-closed。

### 8.1 总览

| 步骤 | 内容 | 版本 | 前置条件 | 可独立上线边界 | 回退方式 |
|---|---|---|---|---|---|
| S0 | 停写备份 + 预检 | — | 无 | 否（运维动作） | 用备份覆盖 DB |
| S1 | 身份：`entity_key` 列 + 回填 + 唯一索引；**导入期查重**（`project_fingerprints` / `import_rejections` / `import_allowances`）+ 拒绝与放行决策 | v25 | 验证项 P1/P6/P8 通过 | 是（读写路径可后置，旧代码忽略列） | 停用读取；查重表可清空；列可保留无害 |
| S2 | `node_links` + 跨图回填（只读展示优先） | v26 | S1 完成 | 是（先只读展示） | 停用写入；表可保留空置 |
| S3 | `lifecycle_state`（nodes/graphs）+ 删除路径改造 + 巡检 | v27 | S2 完成 | 是（先写后读） | 停用归档路径，回退到硬删（接受孤儿） |
| S4 | CHECK 扩展（test 图/节点/边） | v28 | **S1 必须已上线**；验证项 P2/P3/P4 通过 | 是（test 图功能开关关闭时不可见） | **只能恢复 S0 备份**（旧二进制无法兼容新值域） |
| S5 | 任务对象表 | v29 | S2 完成（**不依赖 test 图**） | 是（任务卡叠加层开关） | 关闭开关；表保留 |
| S6 | 证据与派生状态表 | v30 | S5 完成（证据可挂任务） | 是（叠加层状态徽标） | 关闭开关；缓存表可整表重建 |
| S7 | 推导/计划/偏差表 | v31 | S5 完成 | 是（C1 计划确认流） | 关闭开关；草稿表只读保留 |
| S8 | 测试表 + 审批 subject 扩展 | v32 | S4 + S6 完成；验证项 P5 通过 | 是（TestExecutor 开关） | 关闭开关；测试表保留，审批回退到 `agent_turn` 语义（`run_id` 可空但不再使用） |

#### 8.1.1 交付节奏（D5）

> 注意：本小节的 **P1–P4 是交付阶段编号**（沿用外部蓝图口径），与 §8.11 的**验证项 P1–P9** 不是同一套编号；下文引用验证项时会写"验证项 Pn"。

S 编号是**迁移批次编号**，不是发布顺序。交付顺序按下列交付阶段：

| 阶段 | 内容 | 包含 S | 护栏 |
|---|---|---|---|
| P1 | **身份层优先**：`entity_key` + 导入查重 + `node_links` | S1、S2 | 先解决"同一实体是谁"，后续编排才有稳定锚点 |
| P2 | **编排脊柱**：任务对象、步、执行记录、证据与派生状态 | S5（含 `work_steps`）、S6 | 内置 D1/D3 护栏：候选推导只做确定性生成、模型只选择不发明边界、计划不跳过确认、gate 不过不进队列 |
| P3 | 归档语义 + test 图值域 | S3、S4 | S4 不可逆，单独发布 |
| P4 | 推导/计划表 + TestExecutor | S7、S8 | 只读先上线，再开写入 |

- **L1 = P1 + P2**，因此 L1 先落身份层（S1/S2），编排脊柱在 P2 落地；L1 仍**不建 S7/S8**。
- P2 的"内置 D1/D3 护栏"指：`plan_drafts`/`boundary_candidates` 未上线前，编排脊柱只接受**人工单步计划**，不得用模型自由生成替代；S7 上线后再接候选推导，且仍受 §5.3 的越界剔除与 §5.6 的确认约束。

### 8.2 S0：备份与预检（不是代码变更）

1. 退出应用，确认无残留执行器进程。
2. `PRAGMA wal_checkpoint(TRUNCATE)` 后复制 `data/bizgraph.db` 到 `data/backups/bizgraph-v24-<ts>.db`（v24 为 §8.13 修复后的基线）。
3. 记录基准指标：`graphs`/`nodes`/`edges` 行数、`foreign_key_check` 结果、`graphs.writeback_disabled=1` 的项目数、`edges.updated_at` 非空行数。
4. 记录 `schema-checksum.json` 内容：回退必须配合恢复 DB，不能只回退二进制；库里记录的 schema 版本高于旧二进制上限时，旧二进制现在会**拒绝打开**（§8.2.1），不再按旧 `createSql` 重建。

回退：停应用 → 用备份覆盖 `bizgraph.db` 及 `-wal`/`-shm` → 删除 `schema-checksum.json` → 启动旧版本。

#### 8.2.1 版本守卫：库版本高于代码上限时 fail-closed

**状态：已实施（`database.ts` `migrate()`，2026-11-07 复核 HEAD）。**

- 判定：`schema_version` 表记录值 `> CURRENT_SCHEMA_VERSION`（当前 34）时，在**任何重建/增量迁移之前**抛 `DB_SCHEMA_TOO_NEW`，消息包含记录版本、支持上限、库文件路径与处置建议；连接随关闭，不进入预检/回填。
- 动机：旧代码的慢路径会用当前版本的 `createSql` 重建表，`restoreFromBackup` 只恢复**共有列**，新版本写入的列/约束会被静默丢弃，随后 `schema_version` 被回写成更低版本——不可逆退化。v33 的 CHECK 曾因 `test` 行恢复失败偶然挡住，不能作为防线。
- 不做启动期自动"降级"：降级不是默认行为；如确需把更高版本的库交给旧版本使用，必须人工恢复备份并留下可查询记录（本版本不提供降级入口）。
- 结构检测维度（2026-11-07，`rebuildTableIfNeeded` + `reconcileSchemaIndexes`）：慢路径重建判定比较列集合/类型/CHECK/**内联 UNIQUE**；独立 `CREATE UNIQUE INDEX` 定义由索引对账比对，变化时先 `DROP INDEX` 再建。两类 UNIQUE 都进入 `schema-checksum`（内联随 `createSql`、独立随 `INDEX_SQLS`），因此**不升 `CURRENT_SCHEMA_VERSION` 也不会漏掉已有库**——任一 DDL 变化都会让 checksum 失配并强制走慢路径。
- 唯一键 fail-closed：重建表或创建/替换唯一索引前，先只读统计目标键的重复组数（按 SQLite 语义忽略含 NULL 的键行）；存在重复即抛 `DB_MIGRATION_FAILED`，消息含表名、`UNIQUE(...)` 列清单、组数与样例，拒绝重建以避免静默丢行。
- `node_links` 去重约束已带两端图：`UNIQUE(from_graph_id, to_graph_id, from_entity_key, to_entity_key, link_type)`（§7.2）；`entity_key` 跨图共享，旧的三列约束会让不同图组合的链接互相复用端点图信息。
- 版本标记边界：`schema_version` 表是唯一权威的库结构版本；`PRAGMA user_version`（memory FTS 触发器版本，`memory-store.ts`）与 `yjs_snapshots.schema_version`（单图快照写入规则版本，`snapshot-store.ts`）是独立域，不参与本守卫，也不会被 `migrate()` 回写。
- `schema-checksum.json` 是同一版本域的缓存标记：其记录版本高于代码上限时同样触发 `DB_SCHEMA_TOO_NEW`（否则快路径失配会进入按旧 `createSql` 重建的慢路径）。库 `schema_version` 表仍是权威判定；处理不可信缓存属于显式动作。
- v34 取证边界：v34 只对 `work_items` / `work_steps` 做 `ALTER TABLE ADD COLUMN`，**不重建任何表**，因此不进入 S4（`graphs/nodes/edges` 重建前后基线）的取证范围；S4 基线也只在 `currentVersion < 33` 时拍摄。v34 的「新列存在 + 旧行不丢 + 无 `work_*_backup` 残留」由 `database-migration.test.ts` 的 v33→v34 用例直接断言。

### 8.3 S1：身份（`entity_key` + 导入期查重）

前置：

- `nodes.createSql` 增加 `entity_key TEXT`（可空），且**不加入** `requiredColumns`（加进去会让旧库无条件重建）。
- 导入查重表（`project_fingerprints` / `import_rejections` / `import_allowances`）与查重逻辑必须在**建图之前**接入（§2.6）。
- 回填算法落地为独立迁移函数，幂等。
- P1、P6 验证通过。

顺序：

1. 建 `project_fingerprints` / `import_rejections` / `import_allowances` + 索引（v25）
2. `rebuildTableIfNeeded`（本次通常不重建，因为 CHECK/类型未变）
3. `addColumnSafe('nodes','entity_key','TEXT')` 兜底
4. 回填（按 §2.2）
5. `CREATE UNIQUE INDEX ux_nodes_graph_entity_key`
6. **导入流程改为"先指纹查重、再建图"**（§2.6 Step 0–4）；命中即拒绝并写 `import_rejections`，不产生任何 graph/node 行
7. 为历史已有的重复导入数据（S1 之前产生的并行 lineage）生成 `map_migration_reports(kind='import_dedup')` 报告：只报告，不自动删除、不自动合并；由用户决定保留哪一套
8. 写 `map_migration_reports`（`entity_key_backfill`）

上线边界：

- 可先只写不读（新节点写键、克隆复制键）。
- **导入查重必须与本次一起上线**：若只加列不改导入，重复导入仍会新建图，"会话不见了"照旧发生。
- 读取能力（跨图跳转、时间线）在 S2 上线。

回退：

- 读取路径回退到 node id，`entity_key` 列保留（无害）。
- 唯一索引若导致写入冲突，`DROP INDEX ux_nodes_graph_entity_key` 后可继续运行（降级为无唯一约束）。
- 导入查重回退到"总是新建"（会重新暴露会话黑洞），回退前必须书面确认。
- 不重建 `nodes`，因此无数据丢失风险。

### 8.4 S2：`node_links` + 跨图对应

前置：S1 完成；跨图回填样本人工抽检 20 条一致。

顺序：

1. 建 `node_links` + 索引
2. 按 `entity_key` 回填 `derives_from`（online → dev，`origin='import'`）
3. 叠加层只读展示"跨图对应关系"（不提供关联/合并入口 —— 合并入口已被 §2.6 的导入期拒绝替代）

上线边界：只读展示；`map:link:create` 仅允许 `relates_to`（用于已确认的分支/副本），不提供"合并 lineage"。

回退：关闭读取即回到"无链接"状态；表可保留空置。已手工写入的 `relates_to` 链接保留（无副作用）。

### 8.5 S3：归档语义

前置：S2 完成；删除路径改造已评审（`NodeRepository.delete` / `GraphRepository.delete`）。

顺序：

1. `lifecycle_state` 进 createSql（NOT NULL + DEFAULT，重建可安全补默认值）
2. 删除路径改造：有依赖 → 归档；无依赖 → 硬删
3. 图删除前置校验（running run / 未完成 work_item 拒绝）
4. `map_integrity_check`（孤儿巡检）

上线边界：先写不读（叠加层默认仍显示归档节点，只是标记）；后读（默认隐藏归档）。

回退：停用归档路径（回到硬删）。此时会产生孤儿链接，由巡检标记 `orphan`，不阻断。

### 8.6 S4：CHECK 扩展（最危险一步）

前置（**硬性**）：

1. S1 已上线且 `entity_key` 在 `nodes.createSql` 中 —— 否则本次 `nodes` 重建会丢键。
2. `graphs.createSql` / `edges.createSql` 的缺失列**已由 v24 补齐**（`writeback_disabled`、`updated_at`，见 §8.13）；S4 前只需复核 v24 已应用，无需重复修改。
3. P2（耗时）与 P4（不可回退）已书面确认。
4. 备份可恢复演练通过。

顺序：`graphs` 重建 → `edges` 重建 → `nodes` 重建 → 索引 → `foreign_key_check`。

- 重建期间 `foreign_keys` 关闭（既有 `migrate()` 已处理），`DROP TABLE` 不会级联清空 `edges`/`bug_nodes`。
- 重建后逐项校验：行数、内容 hash（对 JSON 列做规范化后比对）、`entity_key` 保留、`writeback_disabled` 保留。
- 若任一项失败：回滚事务 → 抛错 → 用 S0 备份恢复（不要尝试部分修复后再启动）。

上线边界：先发版但测试图功能开关关闭；确认稳定后再开。

回退：**只能恢复 S0 备份**。理由：旧二进制的 `createSql` CHECK 不含 `test`，启动时会判定 CHECK 不一致并重建 `nodes`，restore 时插入 `type='test'` 会违反旧 CHECK，导致迁移失败甚至启动失败。

### 8.7 S5：任务对象

顺序：`work_items` → `work_steps` → `work_runs` → `node_session_links` → `change_sets` → `routing_decisions` → 索引。

**DDL 一次建齐（D2）**：`work_items.status` 的 `needs_input` / `needs_human` / `paused` / `interrupted` 与其它值必须在**本次建表 SQL 中一次写死**，不得留到后续 `ALTER` 或表重建；`work_steps.status` 的全部步级状态同理。建表后修改状态值域只能走重建，成本远高于一次写对。

上线边界：先支持"人工创建单任务 + 手工会话挂载"（M1），再开"任务卡叠加层"（M2）。此步不依赖 TestExecutor。

回退：关闭开关；表保留（无数据破坏）。

### 8.8 S6：证据与派生状态

顺序：`node_evidence` → `evidence_suggestions` → `node_execution_state` → 索引 → 首次全量派生。

上线边界：先只读（叠加层显示状态与证据列表），再开"证据建议"。

回退：关闭开关；`node_execution_state` 可整表 `DELETE` 后重算；不影响 `nodes.status`。

### 8.9 S7：推导与计划

顺序：`boundary_candidates` → `plan_drafts` → `plan_deviations` → 索引。

上线边界：先只做"候选展示 + 人工选"（不接模型），再开"模型组织"。

回退：关闭开关；已确认的计划保持只读。

### 8.10 S8：TestExecutor

前置：S4（test 图可用）+ S6（证据回写可用）+ 验证项 P5 通过；`agent_approvals` 重建方案已评审。

顺序：

1. `test_specs` → `test_plans` → `test_plan_items` → `test_runs` → `test_results`
2. `agent_approvals` 重建（放宽 `run_id`/`turn_id`，加 `subject_type`/`subject_id`，把这两列加入 `requiredColumns` 以强制重建）
3. 回填 `subject_type='agent_turn'`，`subject_id=turn_id`
4. 索引 `idx_agent_approvals_subject`

**不建独立 `test_approvals` 表（D6）**：本步只重建 `agent_approvals`，测试计划审批写 `subject_type='test_plan'`。理由见 §6.3（两套审批事实会破坏审计单一来源）。

上线边界：TestExecutor 开关关闭时表存在但不可调用；先支持"单节点单 spec"，再支持"计划级多命令"。

回退：关闭开关；计划作废（`expired`）。`agent_approvals` 的 `subject_type` 默认值保证旧写入路径继续工作；不能把列改回 `NOT NULL`（SQLite 无此能力），但空值只出现在关闭 TestExecutor 后的历史行，读路径需能处理。

### 8.11 迁移前置条件验证清单

> 口径：这是**迁移前置条件**。任何一项失败，改的是做法（回填方式、重建顺序、链接维护策略），不是推翻 A+ 方案。

| 编号 | 验证目标 | 方法 | 通过判据 | 失败时的替代做法 |
|---|---|---|---|---|
| P1 | `entity_key` 回填正确且幂等 | 真实 DB 副本跑两次启动；构造空 parent / 同名兄弟 / placeholder / 跨项目同名 | 覆盖率 100%；匹配率 ≥ 99%；**错配 0**；二次启动 0 变化；唯一索引存在 | 索引冲突 → partial index + 去重（保留最早 `created_at`）；匹配率低 → 不强求同键，改 graph 内唯一键 + `derives_from`（`confidence` 标注）；重建丢键 → 确认键已进 `createSql` 后重跑 |
| P2 | 重建耗时与数据量 | 生产级副本计时；比对行数、规范化 hash | 单表 < 2s（1 万节点量级）；hash 全等；FK 违规 0 | 超时 → 分表重建 + 首次启动进度提示；hash 不等 → 阻断发布，先修 `restoreFromBackup` 列映射 |
| P3 | 重建不丢非 `createSql` 列 | 重建前置 `writeback_disabled=1`、写 `edges.updated_at`，重建后校验 | 值保留 | **已由 v24 修复**（4 表 8 列补进 `createSql`，见 §8.13）；若仍失败 → 检查 `restoreFromBackup` 列映射是否遗漏，而非再补 `createSql` |
| P4 | 升级后能否降级 | 旧二进制打开新库 | 预期**不能** | 接受"不可逆"，回退统一走备份恢复；发布流程把 S4 标为不可逆里程碑 |
| P5 | `node_links` 完整性 | 四场景（删/拆/并/删图）脚本演练 + 孤儿扫描 | 孤儿 0；软删后会话/证据可查；重复链接被拦 | 删除路径不可改 → IPC 层删除前拦截 + 巡检报告；解析走 `node_id` 快路径 + 定时按键修复 |
| P6 | Yjs 只读处置 / 快照 / SQLite 镜像 / IPC / 渲染兼容 | **已实施（`cc749ce` + `987c226`）**：默认启动下 `1236` 不监听；显式开启后写消息被拒；doc 变更后 `nodes`/`edges` 无新增/改写，只更新 `yjs_snapshots`；旧快照可读；`entity_key` 不因恢复重算。**并行保留** SQLite 权威列 ↔ 镜像一致性：repo 显式写入后查键、镜像恢复后查键、比对镜像与权威列。另测 `graph:get` 返回 `entityKey` | 默认端口无监听；显式开启后写消息被拒；doc 变更不落库；键不丢不重置；旧快照可读；**镜像与权威列一致**；未知 `graphType` 不崩 | 仍能写 `nodes`/`edges` → 阻断发布；写消息未被拒 → 阻断发布；快照重建 id → 快照 v2 恢复后按签名回填；镜像不一致 → 阻断发布；渲染拒新值 → 放宽共享类型 + 未知类型降级展示 |
| P7 | 渲染底座是否需要推翻 | 叠加层原型在 1000 节点图上跑批量 IPC | 不改 React Flow 数据模型；帧率/内存劣化 < 20%；单次批量 IPC | 超出性能预算 → 叠加层改为按视口分页拉取；仍不足则改为独立只读视图（仍不推翻底座） |
| P8 | 导入查重判定正确（§2.6） | 构造 6 类样本：同路径 / 同目录名+高相似 / 不同目录名+高相似 / 不同目录名+中相似 / 抽样失败 / 不同项目 | 每个样本决策与 §2.6 Step 表一致；拒绝时 `graphs`/`nodes` 新增行数为 0；放行时指纹与建图同事务 | 误拒率高 → 调阈值或改为"总是展示证据 + 人工确认"；误放高 → 提高相似度阈值并强制人工确认；抽样失败率高 → 增加 N 或改用目录树结构指纹 |
| P9 | 非 git E4 不混同（§3.5） | 构造 E3（`verified`）+ E4（`signed_off`）混合数据，逐项检查地图徽标/列表/导出/看板 | 按"可复现 / 不可复现"分组；E4 标注"无代码 hash、不可复现"；无同列合并、无等价排序 | 数据层已隔离，先在导出/看板层强制分组；若仍做不到，暂时只允许 UI 展示、关闭该维度导出 |

> **Yjs 处置（已实施，`cc749ce` + `987c226`，见 §2.2.1）**：单向只读、SQLite 权威 —— doc → `nodes`/`edges` 写回已断开，WS 写消息 1008 拒绝，快照持久化、`applyUpdate` 恢复与 shutdown flush 保留；不删依赖/表、不改 schema 版本。**完全移除 Yjs 不在本期**。验收为"默认启动下 `1236` 不监听、doc 变更不落库"；SQLite 镜像一致性验证并行。已知缺陷：启动后新建图不进 doc 池（显式开启 WS 时连 `1236` 被 `1008` 拒绝），挂待办。

**结论**：在满足 P1–P9 的前提下，**可以按 A+ 走**。无任何一项要求推翻渲染底座或重建图数据模型。

### 8.12 阶段 × 表矩阵与 L1 最小集

先对齐规模事实：全量是 **22 张新建表**（原设计 18 张 + §2.6 查重相关 3 张：`project_fingerprints` / `import_rejections` / `import_allowances` + D2 编排步 `work_steps` 1 张），另有 **4 张既有表**被改列或重建（`nodes`、`graphs`、`edges`、`agent_approvals`）。

图例：`建` = 新建，`改` = 加列，`重` = 表重建（改 CHECK/类型），`—` = 本步不涉及。

| 表 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 |
|---|---|---|---|---|---|---|---|---|
| `nodes` | 改 `entity_key` | — | 改 `lifecycle_state` | 重（NodeType CHECK） | — | — | — | — |
| `graphs` | — | — | 改 `lifecycle_state` | 重（GraphType CHECK） | — | — | — | — |
| `edges` | — | — | — | 重（EdgeType CHECK） | — | — | — | — |
| `agent_approvals` | — | — | — | — | — | — | — | 重（subject 扩展） |
| `project_fingerprints` | 建 | | | | | | | |
| `import_rejections` | 建 | | | | | | | |
| `import_allowances` | 建 | | | | | | | |
| `map_migration_reports` | 建 | | | | | | | |
| `node_links` | — | 建 | | | | | | |
| `work_items` | — | — | — | — | 建 | | | |
| `work_steps` | — | — | — | — | 建 | | | |
| `work_runs` | — | — | — | — | 建 | | | |
| `node_session_links` | — | — | — | — | 建 | | | |
| `change_sets` | — | — | — | — | 建 | | | |
| `routing_decisions` | — | — | — | — | 建 | | | |
| `node_evidence` | — | — | — | — | — | 建 | | |
| `evidence_suggestions` | — | — | — | — | — | 建 | | |
| `node_execution_state` | — | — | — | — | — | 建 | | |
| `boundary_candidates` | — | — | — | — | — | — | 建 | |
| `plan_drafts` | — | — | — | — | — | — | 建 | |
| `plan_deviations` | — | — | — | — | — | — | 建 | |
| `test_specs` | — | — | — | — | — | — | — | 建 |
| `test_plans` | — | — | — | — | — | — | — | 建 |
| `test_plan_items` | — | — | — | — | — | — | — | 建 |
| `test_runs` | — | — | — | — | — | — | — | 建 |
| `test_results` | — | — | — | — | — | — | — | 建 |

> 版本号按**实际发布顺序**递增。若 L1 跳过 S3/S4，则后续步骤顺延取号，**不预留空号**；§8.1 的 v25–v32 是全量路径的示意，不是必须照抄的号段。

#### L1 最小表集

L1 定义 = 任务路由 + 会话时间线 + 证据展示（不含测试执行、不含计划推导）。

| 类别 | 表 | 说明 |
|---|---|---|
| 改列 | `nodes` + `entity_key` | 身份必需；不建索引则无法支撑跨图对应 |
| 建 | `project_fingerprints`、`import_rejections`、`import_allowances`、`map_migration_reports` | 导入查重 + 记住规则 + 迁移报告（S1 一并上线，否则"重导即丢会话"照旧） |
| 建 | `node_links` | 跨图对应与时间线聚合的解析基础 |
| 建 | `work_items`、`work_steps`、`work_runs`、`node_session_links`、`change_sets`、`routing_decisions` | 任务对象、编排步、执行记录与变更面（S5 的前半）；`change_sets` 是 §4.6 `filesTouched` 的唯一来源，不能延后 |
| 建 | `node_evidence`、`node_execution_state` | 证据展示与派生状态（S6 的前半） |

**L1 共需 13 张新表 + 1 次改列**，对应迁移批次：S1 → S2 → S5a（`work_items`/`work_steps`/`work_runs`/`node_session_links`/`change_sets`/`routing_decisions`）→ S6a（`node_evidence`/`node_execution_state`）。交付顺序遵循 §8.1.1：**P1（S1/S2）先落身份层，P2（S5a/S6a）再落编排脊柱**。

**L1 明确不建**（避免提前建空表）：

| 延后项 | 归属 | 延后理由 |
|---|---|---|
| `evidence_suggestions` | S6b | L1 只展示人工已写入的证据，不做自动推断 |
| `graphs.lifecycle_state` / `nodes.lifecycle_state` | S3 | L1 期间**不开放删除节点**（只做隐藏/禁用），不存在归档需求 |
| test 图 CHECK 扩展 | S4 | 无 TestExecutor 时不需要 `test` 值域 |
| `boundary_candidates` / `plan_drafts` / `plan_deviations` | S7 | L1 不做自动拆分，只支持手工建任务 |
| `test_*` 5 张表 + `agent_approvals` 重建 | S8 | 不含测试执行 |

**L1 的边界**：L1 期间**不开放删除节点/图**，只提供隐藏/禁用；因此不需要 S3 的归档语义，S3 不提前。隐藏/禁用只改展示与可选状态，不删除行，时间线不会变成孤儿。删除能力与 S3 一起在 L2 上线。

**为什么不一次建全**：空表本身不产生数据风险，但会诱使代码提前依赖尚未验证的结构；且每张表都要进 `TABLE_SCHEMAS` / checksum / 备份 / 回滚验证，提前建会放大每次迁移的失败面。

### 8.13 v24 既有缺陷修复记录（与蓝图解耦）

#### 缺陷确认

`rebuildTableIfNeeded` 的实际路径是：

```
CREATE TABLE <t>_backup AS SELECT * FROM <t>
  → 按新 createSql 建 <t>_new
  → INSERT INTO <t>_new (<公共列>) SELECT <公共列> FROM <t>_backup
```

"公共列" = 旧表列 ∩ 新 `createSql` 列。因此，**只在 `runIncrementalMigrations` 里用 `addColumnSafe` 补出、却没写进 `createSql` 的列**，在一次重建后会连列带值一起消失。不是"列还在、值为 NULL"，而是列本身不存在。

#### 全表逐字段对照结果（4 张表 / 8 列）

| 表 | 缺失列 | 来源 | 重建后后果 |
|---|---|---|---|
| `graphs` | `writeback_disabled INTEGER DEFAULT 0` | `addColumnSafe('graphs','writeback_disabled','INTEGER','0')` | 用户"关闭写回"设置被重置为 0 |
| `edges` | `updated_at TEXT` | `addColumnSafe('edges','updated_at','TEXT')` | 边的更新时间全部丢失 |
| `chat_threads` | `parent_thread_id TEXT` | `addColumnSafe` | 父子线程关系丢失 |
| `chat_threads` | `context_tokens_used INTEGER DEFAULT 0` | `addColumnSafe` | 上下文水位丢失 |
| `chat_threads` | `context_window_max INTEGER DEFAULT 0` | `addColumnSafe` | 上下文窗口上限丢失 |
| `chat_threads` | `last_compacted_at INTEGER` | `addColumnSafe` | 最近压缩时间丢失 |
| `chat_threads` | `metadata TEXT DEFAULT '{}'` | `addColumnSafe` | `metadata.task_kind` 丢失 → A2A 任务过滤失效 |
| `chat_messages` | `token_count INTEGER DEFAULT 0` | `addColumnSafe('chat_messages','token_count','INTEGER','0')` | token 计数清零 |

其余 `TABLE_SCHEMAS` 表逐字段核对**无缺失**：`nodes`、`bug_nodes`、`recipes`、`recipe_runs`、`yjs_snapshots`、`memory_items`、`compact_history`、`subagent_invocations`、`writeback_items`，以及 9 张 `agent_*`（DDL 单一来源在 `agent/runtime/db/schema.ts`，本身没有"增量列不在 createSql"的路径）。`code-intelligence` 的 `CREATE TABLE IF NOT EXISTS` 独立建表、不走重建框架，不属同类风险。

#### 会命中这两张表的既有重建路径

1. 任何改 `graphs` / `edges` / `chat_threads` / `chat_messages` 的 CHECK 或列类型的迁移 —— 包括未来扩展 `chat_threads.status`、`chat_messages.status` 的 CHECK。
2. 本蓝图 **S4**：重建 `graphs` → `nodes` → `edges`，必然先命中 `graphs.writeback_disabled` 与 `edges.updated_at`。
3. P2/P3 演练（人为触发重建）同样命中。
4. 任何手工/运维触发的表重建。

#### 最小修复（已完成，v24）

- 8 列写进各自 `createSql`；**不加入 `requiredColumns`** → 旧库不会因此无条件重建，只保证未来重建时这些列进入"公共列"。
- 新增列一律**可空或带 DEFAULT**，与现网 `ALTER TABLE` 产生的列形态一致（`writeback_disabled` 刻意不加 `NOT NULL`，避免恢复时失败）。
- `CURRENT_SCHEMA_VERSION` 23 → 24；v24 只做 schema 对齐，**不触发重建**。
- **无需一次性回填**：现网这些列已由 `addColumnSafe` 存在；本修复只保证未来重建不丢。若个别库确实缺列，`runIncrementalMigrations` 仍会补。

#### 验证

1. 真实库副本上模拟四表重建：行数不变、缺失列集合为空、`foreign_key_check` 无输出。
2. 合成数据验证：`writeback_disabled=1`、`edges.updated_at` 在重建后保留。
3. 未使用 vitest：`better-sqlite3` 的 ABI 与当前 Node 不匹配（Electron NODE_MODULE_VERSION 130 vs 系统 Node 115），`npm rebuild` 会破坏 Electron 运行时；改用 Python `sqlite3` 在副本上复现同一建表/恢复序列。

#### 提交

`587e25e fix(db): 补齐 createSql 缺失列，避免表重建丢值与设置重置`（只含 `src/main/database.ts`）。

### 8.14 迁移状态机与半迁移恢复（补充审查项）

`map_migration_reports` 承担迁移阶段状态（§7.2 已加 `stage` / `schema_version` / `heartbeat_at` / `error_json`）：

| 阶段状态 | 写入时机 | 启动期行为 |
|---|---|---|
| `running` | 阶段开始，写 `stage` + `schema_version` + `started_at` + `heartbeat_at` | 心跳每 30 秒更新；心跳超过 10 分钟未更新视为"半迁移" |
| `ok` | 阶段完成且校验通过（行数 / FK / hash） | 允许进入下一阶段 |
| `partial` | 阶段部分完成（仅限声明为可续跑的幂等阶段） | 允许续跑该阶段，不重跑已 `ok` 的阶段 |
| `failed` | 校验失败或异常 | 幂等白名单阶段（每次启动重跑）自动重试；其余阶段阻断启动，必须恢复 S0 备份或人工修复 |

`entity_key_backfill` 项目级失败**不再记为阶段 failed**：失败项目的事务回滚，其节点保持
`entity_key IS NULL`（可直接查询），报告行置 `partial`，`details_json.failed_projects` 记录项目路径、
online/dev 图 id 与错误；应用照常启动，下次启动自动对 NULL 行重试（幂等）。

硬规则：

1. **半迁移按幂等白名单自动续跑**：启动预检发现阶段 `running` 且心跳过期时，白名单内的幂等阶段（每次启动重跑的回填/建索引类）自动续跑并记录告警；非白名单阶段拒绝启动并提示恢复备份。不得带着不可证明安全的半迁移库继续读写。
2. **并发迁移互斥**：心跳仍在更新 → 说明另一个进程在迁移，当前进程拒绝启动（或只读），避免双写。
3. **孤儿 `*_backup` 检测**：启动预检扫描 `sqlite_master` 中的 `%_backup` / `%_new` 表；若原表与备份表同时存在，视为中断的重建：**不自动删除任何一张**，先写 `map_migration_reports(kind='integrity_check')`，按"原表行数 / 备份行数 / 是否含新列"决定续跑或恢复；无法判定时只提示人工处理。
4. **续跑边界**：只有 `addColumnSafe`、回填、`CREATE INDEX` 等幂等操作允许续跑；S4 的 CHECK 重建、`agent_approvals` 重建等不可逆步骤一旦 `failed`，只能恢复 S0 备份，不做"部分修复后再启动"。
5. **不静默清理**：任何 `_backup` 表的删除都必须有报告与显式动作，防止把唯一可恢复副本删掉。
6. **报告行保留策略（已实施）**：启动与每日任务都会追加 `map_migration_reports` 行，故按 `(kind, stage)` 每组只保留最近 20 行（`pruneMapMigrationReports`，启动后与每日各执行一次）；`running` 行永不裁剪（半迁移现场不可被掩盖）；有删除时追加 `kind='cleanup', stage='reports'` 行，`stats_json` 记录 deleted / keep_per_stage，不做静默清理。

#### 8.14.1 B1 迁移状态机施工细则

> 本小节把 §8.14 的硬规则展开为可执行的阶段表。所有记录复用 `map_migration_reports`，**不新增表**。

**阶段与状态映射**

| 语义 | `status` 值 | 写入时机 | 备注 |
|---|---|---|---|
| started | `running` | 阶段开始前先提交一行 | `owner_pid` 必填；`started_at` 与 `heartbeat_at` 同值 |
| completed | `ok` | 阶段事务提交且校验通过后 | `finished_at` 必填；`stats_json` 必填 |
| retryable partial | `partial` | 声明为可续跑的阶段只完成一部分 | 只允许 S1.3 / S2 回填；必须留 `details_json.resume_from` |
| failed | `failed` | 校验失败、异常、或不可续跑阶段中断 | `error_json` + `finished_at`；启动阻断 |

- 每个阶段独立一行；重跑同一阶段**新建一行**，不覆盖历史。查询"最新状态"按 `started_at DESC, id DESC`。
- `heartbeat_at` 每 30 秒更新一次；只更新 `status='running'` 的最新行。心跳写失败不阻断阶段，但必须在 `error_json` 记 `heartbeat_lost`。
- 阶段事务与报告：先插入 `running` 并提交；再执行阶段工作；成功后更新该行 `ok`。阶段工作与 `schema_version` 更新放在同一事务提交；崩溃后 `running` 行保留，由启动预检裁决。

**B1 阶段目录**

| 阶段 | 可续跑 | 校验 |
|---|---|---|
| `S1.tables` / `S1.column` / `S1.indexes` | 是（幂等 DDL） | 表/列/索引存在；`nodes.createSql` 含 `entity_key` |
| `S1.backfill` | 是（只写 NULL 行） | `null_after=0`；二次运行 0 变化；唯一索引无冲突 |
| `S1.import_path` | 否（代码路径） | 旧路径已关闭；拒绝时三表 0 新增 |
| `S1.report` / `S1.verify` | 是（只读/可重算） | 报告计数与真实库一致 |
| `S2.tables` / `S2.backfill` | 是 | 链接唯一键无重复；孤儿计数可解释 |
| `S5a.tables` | 是（`CREATE TABLE IF NOT EXISTS`） | 13/12 状态值齐全；索引存在 |
| `S6a.tables` | 是 | 证据 CHECK 约束存在；派生表索引存在 |
| `S6a.verify` | 是（只读） | E0–E4 样本；过期 E4 派生为 `stale`（U1 裁决） |

**启动预检顺序（fail-closed）**

1. `PRAGMA integrity_check` 必须返回 `ok`；否则拒绝启动，提示恢复 S0 备份。
2. `PRAGMA foreign_key_check` 必须为空；否则拒绝启动。
3. 读取每个阶段最新行：
   - `failed` → 幂等白名单阶段自动重试；非白名单阶段拒绝启动，提示恢复 S0 或人工修复；
   - `running` 且 `owner_pid` 是其他仍存活进程 → 拒绝启动（另一实例在迁移）；
   - `running` 且心跳超过 10 分钟或 `owner_pid` 已不存在 → 判定"半迁移"：幂等白名单阶段自动续跑（无需 argv），非白名单阶段拒绝启动，仅允许显式 `--resume-migration` 或恢复备份；
   - `partial` → 只允许续跑声明为可续跑的阶段；不可续跑阶段一律拒绝。
4. 扫描 `sqlite_master` 中 `%_backup` / `%_new`（见下表）；存在歧义即拒绝启动。
5. 校验 `schema_version`、迁移脚本 checksum、S0 备份存在且可读。
6. 全部通过后才进入正常读写；任何一步失败都不降级为只读继续跑业务。

**孤儿 `_backup` / `_new` 判定**

| 现场 | 判定 | 动作 |
|---|---|---|
| 原表 + backup + new 同时存在 | 重建中断在 rename 前后，状态歧义 | 拒绝启动；写 `integrity_check` 报告；人工选择恢复/继续 |
| 仅 backup + new，无原表 | 原表可能已被 rename 走 | 拒绝启动；先校验 backup 行数与 hash，人工恢复 |
| 原表 + backup，无 new | 可能是上次重建完成但未清理 | 若原表校验通过且行数/关键列与 backup 可解释 → 写报告并允许启动；**不自动删 backup** |
| 仅 new，无原表/backup | 严重半迁移 | 拒绝启动；不允许把 `_new` 当正式表 |
| 仅 backup，无原表/new | 原表丢失 | 拒绝启动；提示从 backup 恢复 |

- 上述判定只针对迁移重建产生的 `%_backup` / `%_new`；**Yjs 的 `snapshots` 是另一张表，不得按 `_backup` 规则一起删**（见 §2.8）。
- 删除 backup 必须是显式管理动作，并在 `map_migration_reports(kind='cleanup')` 留痕。

**回滚边界**

| 阶段 | 失败回滚 | 已产生业务数据后 |
|---|---|---|
| S1 | 删新建表/索引；`entity_key` 列可保留 | 不回退键；只回退读路径，禁删唯一索引 |
| S2 | 删表/索引即可 | 保留链接；关闭写入路径 |
| S5a | 删新表（未产生任务时） | 保留任务/run；禁用功能，不 `DROP` |
| S6a | 删新表（未产生证据时） | 保留证据；禁用派生，不删历史 |

**验收（故障注入）**

1. 在每个阶段"插入 running 后、工作提交前"杀进程 → 重启时幂等白名单阶段自动续跑，非白名单阶段拒绝启动；`--resume-migration` 仅作为非白名单阶段的显式人工旁路。
2. 在 S1.3 中途杀进程 → 已提交项目不重写、未提交项目续跑；`entity_key` 无重复。
3. 在 S1.4 建唯一索引时制造冲突 → `failed`，启动阻断，错误指向冲突行。
4. 手工构造四种 `_backup` 现场 → 判定与上表一致；无自动删除。
5. `integrity_check` / `foreign_key_check` 任一失败 → 拒绝启动。
6. `owner_pid` 为存活的其他进程 → 当前进程拒绝启动。

### 8.15 F1–F3 前置修复（B1）

> **状态：已实施（2026-11-07，main）：F1 `231c724`、F2 `2425f0c`、F3-A `e921977`、审批冻结 `7e6e63f`；以上提交均经 `git merge-base --is-ancestor <commit> main` 核实。** 这三项是 S5a / S6a 的前置源码修复，不属于本文档的施工范围；此处只写行为契约、判据与验收，供后续实现与评审对照。**F1 与 F2 先于 F3**；三项都不得改动 Yjs 的只读处置（该处置已实施，见 §2.2.1）。

#### F1 子代理拒绝路径未终止会话

**修复前现状（缺陷；2026-11-07 复核 `subagent-manager.ts`）**：不是"仅成功路径杀会话"。成功路径、`cancel()`、`sendCommand` 失败路径都会 terminate；真正的洞是 **timeout、子 agent error、取消 abort 三条 settle 拒绝分支**跳过 `terminateSession`（`subagent-manager.ts` 约 L580–590 / L546–551 / L564–574，跳过 L623–642）。

**修复契约（已实施：`231c724`；P-F1 级联/计时起点随 `71518ed` 整合）**

1. 只在**拒绝路径**补 terminate，不改成功路径与既有 `cancel()` 行为。
2. **先存输出，再 terminate**：在调用 `terminateSession` 前，把当前 `outputBuffer` / `fileChanges` / tokens 写入 invocation（见 F2），确保 terminate 触发的回调不会清空待保存数据。
3. `terminateSession` 必须**幂等**，并覆盖非 `cancel()` 触发的 abort（timeout / error / shutdown）；重复调用不抛错、不重复发事件。
4. 父会话终止必须级联取消其子代理；`startSession` 的耗时计入超时计时（不能等会话建好才开始计时）。
5. 失败路径也必须执行 Phase B / 记忆提取（若产品要求"失败也提取"）；否则不得在下游把"未执行 Phase B"当成成功。
6. **`terminateSession` 自身失败只记 warn**：不覆写已定终态；不得因清理失败把 `succeeded` 改成 `failed`。
7. **terminate 收尾触发 ScopeGuard 事后校验**：越界改动按 §6.4 回滚；不可回滚时标 `scope_violation` 并保留现场，不得静默通过。

**验收**：timeout / 子 agent error / abort 三条拒绝分支各一条用例，断言 terminate 被调用、invocation 已落 partial、Phase B 执行或明确标记失败、**进程树确死且 proc-registry 已清空**、无孤儿会话。

#### F2 失败路径丢失部分产出与 token

**修复前现状（缺陷；2026-11-07 复核 `subagent-manager.ts` / `src/shared/types/subagent.ts`）**：失败时 `outputBuffer` / `fileChanges` 是局部变量，异常即丢；`tokensUsed` 也只在失败路径才读取、同时丢。仅修 `repo.fail(error)` 不够。

**修复契约（已实施：`2425f0c`；P-F2 计时起点随 `71518ed` 整合）**

1. `SubagentResult` 增加 `status: 'completed'|'failed'|'cancelled'`、`error?`、`partial?`；`partial` 至少含 `resultText` / `resultFiles` / `tokensUsed` / `fileChanges`。
2. **同步 IPC 消费方**：renderer / 主进程所有读取 `SubagentResult` 的地方必须处理 `failed/cancelled`，不得把 `partial` 当完整结果。
3. 失败也落 `subagent_invocations`：写 `status`、`error`、`result_text`、`result_files`、`tokens_used`；不新增表。
4. 截断与大小上限（**代码事实，2026-11-07 复核**）：子代理侧按 `MAX_OUTPUT_ENTRY_SIZE = 10_000`（`base.ts:40`）单条截断并标 `truncated`（`subagent-manager.ts:220-229`）；地图侧 partial 用常量 `PARTIAL_FIELD_MAX_BYTES = 16KB` / `PARTIAL_TOTAL_MAX_BYTES = 64KB`（`work-run-service.ts:66-67`）。**两套值不一致，且均非配置项**；是否统一、统一到哪个值列为待定（§12.5 第 4 项），当前不擅自统一。
5. 明确区分 `failed` 与 `cancelled`：用户取消写 `cancelled`，执行错误写 `failed`；两者都保留 partial，但不得混写。
6. 失败路径必须计 token；`tokensUsed` 在异常包装时一并带出，不能只在成功分支读取。
7. `repo.fail(error, partial?)`：增加可选 `partial` 参数，落 `result_text` / `result_files`；不新增表。
8. 进度事件 `failed` 携带 `partialSummary:{resultTextChars, resultFilesCount, truncated}`；**不使用 `[partial]` 文本前缀**，partial 一律走结构化字段。

**验收**：制造子 agent error + 已产生 stdout/fileChange；断言 invocation 行存在、`status='failed'`、`result_text/result_files` 非空、`tokensUsed>0`；取消路径 `status='cancelled'` 且 partial 保留；IPC 消费方不崩溃。

#### F3 turn 截止时间没有执行者

**修复前现状（缺陷；2026-11-07 复核 `runtime.ts` / `repository.ts`）**：修复前代码中不存在 `agentTurnTimeoutScanner`，也没有每分钟扫描器；"现有 scan 每分钟跑并 0 命中"是对旧代码的错误描述。修复前有五处事实（现均已按 F3-A 处理）：

- `agent_turns.status` 的 CHECK **没有 `timed_out`**（仍如此；F3-A 以 `failed` + `failure_type='timeout'` 映射，不重建表）；
- `attempt` 恒为 1，退避没有意义（仍不实现 turn 级退避，见下）；
- `deadline_at` 没有索引 → 已补部分索引 `idx_agent_turns_deadline`（`schema.ts:298`）；
- 重启时已过期 deadline 的处置未定义 → 已实现 `DEADLINE_EXPIRED_ON_RESTART`（`runtime.ts:997-1010`）；
- 超时值有三套：subagent `timeoutMs` / send-and-wait 300s / 文档 10min + 60min（subagent 仍为 5 分钟独立常量，见下文代码事实）。

**统一来源（设计口径 + 代码事实，2026-11-07 复核）**

| 超时 | 设计键名（**当前未实现**） | 设计默认 | 适用 |
|---|---|---|---|
| turn 执行截止 | `agent.timeouts.turnMs` | 10 分钟 | 单个 `agent_turn`，从 `startSession` 开始计时 |
| step 执行截止 | `agent.timeouts.stepMs` | 10 分钟 | `work_steps.deadline_at`，覆盖整个 step |
| task 总墙钟 | `agent.timeouts.taskMs` | 60 分钟 | `work_items` 的总时长，排队时间不计入 |
| send-and-wait 客户端等待 | `agent.timeouts.sendWaitMs` | `turnMs + 30s` | 只是 IPC 等待，不得早于 turn deadline 触发 |

**代码事实（HEAD 复核）**：`git grep "agent.timeouts" -- src` **无命中**，上表四个键**均未实现**，只是设计键名，不是现有配置面。

- **turn**：唯一生效值是代码常量 `DEFAULT_AGENT_TIMEOUTS.turnMs = 10 分钟`（`src/shared/types/agent-runtime.ts:368-369`），由 `agent-manager.ts:1337` 以 `command.deadlineMs ?? DEFAULT_AGENT_TIMEOUTS.turnMs` 消费；`deadlineMs=0`/缺省表示不启用。
- **step / task**：常量已声明 `stepMs = 10 分钟` / `taskMs = 60 分钟`（同文件 `:370-371`），但**无消费点**（`git grep "stepMs|taskMs" -- src` 仅命中定义处）；L2 编排层尚未实现。
- **send-and-wait**：未实现，无 `sendWaitMs` 常量。
- **subagent**：**仍独立配置**，`SubagentManager` 常量 `DEFAULT_TIMEOUT_MS = 5 分钟`（`subagent-manager.ts:53`），构造参数可覆盖（`:128`），`ipc-handlers.ts:504` 实例化时未传值。"不再独立配置、继承 step/turn 预算"**未实施**。
- 是否引入 `agent.timeouts.turnMs` 配置键属**产品选择**，当前未实现，列 §12.5 第 3 项待定。

- `attempt` 恒为 1：**不实现 turn 级退避**；重试只发生在 `work_steps.attempt` / 新 `work_run`，避免"退避但永不递增"的假机制。
- `agent_turns.status` 无 `timed_out`：**采用 F3-A（已定；与 `Zcode v1.2.1，302 行` 一致）** —— 映射 `status='failed'` + `failure_type='timeout'` + `error_code='DEADLINE_EXCEEDED'`；**不重建 `agent_turns`**。理由：重建表是 S4 级不可逆操作，为一个状态值不值得；UI 需要区分时在展示层由 `failure_type` 派生（"超时失败"徽标与筛选），不新增库内状态。
- **F3-B（已否决）**：重建 `agent_turns` 并把 `timed_out` 加进 CHECK。否决原因：表重建、备份/恢复与迁移窗口成本高，且会与 S1–S6 迁移叠加；收益仅为状态枚举更干净。除用户重新裁决外不再提起。
- 增加索引：`CREATE INDEX idx_agent_turns_deadline ON agent_turns(deadline_at) WHERE status='running'`（只索引运行中行，避免全表）。
- **写入点与禁止复用（F3-A）**：`sendCommandThroughKernel` 透传 `deadlineMs`；`insertTurn` 的 `deadlineAt ?? null` 参数位已存在，写入 `0` 表示**不启用** deadline（不是"立即超时"）。超时路径**不得复用 `cancelTurn`**：后者通过 `finalizeTurnStatus('cancelled', …)` 做终态 CAS，随后再写 `failed` 会因状态已非 `running` 返回 `false`，导致超时永远落不了 `failed`。正确路径：
  1. 超时控制器先杀进程组并 terminate 会话（满足 §5.9.8.1 的"终态在 terminate 之后"）；
  2. 按 F2 落 partial（`result_text` / `result_files` / `tokensUsed`）；
  3. 单次终态 CAS：`UPDATE agent_turns SET status='failed', failure_class='timeout', error_code='DEADLINE_EXCEEDED' WHERE id=? AND status='running'`（列名按代码实况为 `failure_class`，无 CHECK 约束，扩展无需迁移放宽）；
  4. `changes=0` → 已被完成/取消抢先，读取实际终态并保留，不覆盖；
  5. 不调用 `cancelTurn` 的终态分支，不先写 `cancelled`。
- **已裁决方向、当前未实现配置面（2026-11-07）**：超时默认值**目前是代码常量** `DEFAULT_AGENT_TIMEOUTS.turnMs`（10 分钟，`src/shared/types/agent-runtime.ts:368`；消费点 `agent-manager.ts:1337`），**不存在 `agent.timeouts.*` 配置键**。"默认值放配置键、kernel 层不设默认值"是产品选择方向，当前未实现；`260df58` 不在 main（`git merge-base --is-ancestor 260df58 main` 为否），不作为证据。是否引入该配置键列 §12.5 第 3 项待定。
- **已裁决并已实施（2026-11-07，`7e6e63f`）：候选 A（冻结重算）**——审批等待期不计入超时。实现为**运行时内存**：`runtime.ts:844-882` 的 `freezeDeadlineForApproval` / `resumeDeadlineAfterApproval` 维护 `approvalWaitDepth` 与 `approvalFrozenRemaining`，恢复时 `deadline_at = now + remaining`；配合 `repository.ts:630-652` 的 `freezeTurnForApproval` / `resumeTurnFromApproval` 条件更新。**`agent_turns` 没有 `paused_at` 列**（`git grep "paused_at" -- src` 无命中）；扫描器跳过 `waiting_approval` 已随 `e921977` 实施（`deadline-reaper.ts:16-17`）。
- 重启：扫描 `status='running' AND deadline_at <= now`，无存活进程 → 写 `failed` + `failure_type='timeout'` + `error_code='DEADLINE_EXPIRED_ON_RESTART'`；**不自动重跑**。不把过期 deadline 留在 `running`。
- 与 F1 的边界：F3 只负责"到期杀"; 取消/错误仍走 F1 的拒绝路径 terminate。

**验收**：turn 到期被杀、进程组无残留、DB 终态为 `failed/failure_type=timeout`、partial 非空；`waiting_approval` 期间不误杀；重启后过期行不再 `running`；send-and-wait 不早于 turn deadline。

#### F1–F3 同类漏项（一并列入前置清单）

| 编号 | 漏项 | 处理 |
|---|---|---|
| P-F1 | 父会话终止不级联取消子代理 | 父 cancel/shutdown 显式向子会话传播 `cancelled`，子 invocation 保留 partial |
| P-F2 | `startSession` 不在超时计时内 | 计时起点前移到 `startSession` 调用前；建会话耗时计入 |
| P-F3 | 失败不 terminate 导致 Phase B 不执行 | F1 的 `finally` 终止 + 失败也执行 Phase B，或显式标记 `phase_b_skipped` |
| P-F4 | 失败路径不计 token | F2 的 `tokensUsed` 随 partial 一并写入 |

---

## 9. IPC 与渲染层改动清单（只列职责，不设计 UI）

### 9.1 主进程新增服务

| 服务 | 职责 |
|---|---|
| `EntityKeyService` | 生成/保留/回填 `entity_key`；提供键解析；不参与完成度判断 |
| `ImportDedupService` | 扫描后、建图前计算指纹并查重（§2.6 Step 0–4）；返回命中信号与决策；拒绝记录写 `import_rejections`；管理 `import_allowances`（记住/查看/撤销）；允许时与建图同事务写 `project_fingerprints` |
| `LinkService` | `node_links` 读写、去重、孤儿巡检、拆分/合并链接策略 |
| `EvidenceService` | 证据写入/查询/stale 重算/建议接受；**只能由人工接受建议** |
| `ExecutionStateService` | 按 §3.3 规则重算 `node_execution_state`（批量、可重入） |
| `WorkItemService` | 任务 CRUD、revision/supersedes、gate 校验、队列推进 |
| `WorkStepService` | 编排步状态机（§5.9.8）、`needs_input` 问题卡、步级 attempt/deadline/invocation |
| `SessionTimelineService` | 按节点聚合会话/run/证据，供时间线查询 |
| `PlanDerivationService` | 候选边界推导（确定性算法）、`plan_drafts` 生成与越界剔除 |
| `RoutingService` | 单 Agent 选择与 `routing_decisions` 记录（不做并行） |
| `TestExecutor` | 计划审批提交、worktree 管理、逐条命令执行与结果回写 |
| `MapIntegrityService` | 孤儿链接、键缺失、派生状态漂移的巡检与报告 |

`WorkItemService` / `WorkRunService` / `RoutingService` 的接口签名与错误码见 §5.9.9–§5.9.10；StepInput / StepResult 与落库映射见 §5.9.11。所有编排接口返回结构化错误码，调用方不得依赖异常文本分支。

### 9.2 IPC 通道（renderer → main）

| 通道 | 职责 | 备注 |
|---|---|---|
| `map:overlay:get` | 一次返回某图的：任务卡摘要、各节点 `execution_state` + 最高证据等级、stale 计数 | **必须批量**，禁止按节点轮询 |
| `map:link:list` | 按图或节点列链接 | 只读 |
| `map:link:create` / `map:link:delete` | 人工维护链接 | 需权限校验；写 `origin='human'`；**只允许 `relates_to`**，不提供 lineage 合并 |
| `project:import:preview` | 导入前返回指纹命中证据（哪些信号对上、相似度、判定结果、是否命中记住规则） | 不写库；供确认框展示 |
| `project:import:confirm` | 用户确认导入；`allowed_branch` 与 `remember_for_fingerprint` 由用户显式勾选传入 | 自动导入不允许 `allowed_branch`；写入 `allowance_source` |
| `project:import:allowance:list` / `revoke` | 查看/撤销"记住的分支/副本放行"规则 | 必须可查看、可撤销；撤销留 `revoked_at` |
| `map:node:timeline` | 节点会话时间线（分页） | 替代 `threadStore.nodeThreadMap` |
| `map:node:evidence:list` | 节点证据列表（可点开引用） | 只读 |
| `evidence:suggestion:list` / `accept` / `dismiss` | 证据建议处理 | `accept` 才写 `node_evidence` |
| `workitem:list` / `get` | 任务与 revision 查询 | 默认只返回 `is_current=1` |
| `workitem:create` | 人工建任务（含单任务模式） | 走 gate 校验 |
| `workitem:revise` | 执行中修订（增删合并拆分） | 强制产生新 revision |
| `workitem:run:start` / `cancel` | 进队/撤销 | `start` 前必须 gate=pass/waived |
| `plan:derive-candidates` | 生成候选边界 | 返回 `derivation_run_id` |
| `plan:draft:create` / `get` / `revise` / `confirm` / `reject` | 计划草稿生命周期 | `confirm` 生成 `work_items` |
| `test:spec:list` / `create` / `update` | 测试资产绑定 | 写 test 图节点关联 |
| `test:plan:create` | 生成计划并返回待审批信息 | 不直接执行 |
| `test:plan:approve` | 提交审批（走 `ApprovalGateway`） | 不允许直接写 `agent_approvals` 绕过网关 |
| `test:plan:run` | 执行已批准计划 | 校验 `args_hash` |
| `test:run:get` | 运行状态与结果 | 只读 |
| `admin:map:integrity-check` | 触发巡检 + 取报告 | 运维入口 |

### 9.3 事件通道（main → renderer）

| 事件 | 触发 | 载荷 |
|---|---|---|
| `event:node-execution-state` | 派生状态变化 | `{graphId, nodeEntityKey, executionState, evidenceLevel, staleCount}` |
| `event:work-item-changed` | revision / status 变化 | `{lineageId, revision, status}` |
| `event:work-step-changed` | 步级状态迁移 | `{workItemId, stepId, status, attempt}` |
| `event:work-step-partial` | 失败/取消时已收 partial | `{workStepId, attempt, resultTextChars, resultFilesCount, truncated}`（结构化，不用 `[partial]` 文本前缀） |
| `event:test-run-updated` | 测试计划/运行变化 | `{planId, runId, status, passed, failed}` |
| `event:map-link-changed` | 链接增删/孤儿化 | `{graphId, fromEntityKey, toEntityKey, linkType, status}` |

### 9.4 渲染层职责

| 位置 | 改动职责 |
|---|---|
| `GraphCanvas` | 增加**叠加层**：任务卡、状态徽标、证据徽标、时间线入口；不修改节点/边数据模型 |
| 证据徽标展示规则 | **E3** 徽标 = "可复现验证（测试通过 + 代码 hash）"；**E4** 徽标 = "人工签收 · 无代码 hash · 不可复现"，使用独立样式；两组**不得合并排序、不得同色**；`signed_off` 不得显示为"已验证" |
| 导入确认框 | 展示 `project:import:preview` 命中证据；拒绝时展示"哪几项对上了"；允许分支/副本时必须用户显式勾选；可另勾选"对同一指纹记住"；命中记住规则时明确标注"本次放行来自记住的规则" |
| 新增 `sessionMapStore` | 批量拉取 `map:overlay:get`；订阅 4 个事件；本地缓存按图失效 |
| 新增 `workItemStore` | 任务列表、revision 切换、run 状态 |
| 新增 `evidenceStore` | 证据列表、建议处理、stale 展示 |
| `threadStore` | 移除 `nodeThreadMap`"只保留最后一个 thread"语义；改为委托 `map:node:timeline` |
| `AgentChatPanel` | 创建 thread 时必须带 `graphId`（现状缺失，导致会话无法正确挂图） |
| `HistorySidebar` | 支持按 graph/node 过滤（现状全量列表，无法定位节点会话） |
| `graphStore` | **删除** `agent:onStatusChange` → 写 `nodes.status='developing'` 的逻辑（违反双轨） |

### 9.5 必须修复的既有缺口（与本设计直接相关）

1. `event:NODE_STATUS_CHANGE` **有转发链（preload 与 sessionStore 均 re-emit），但没有 `node:statusChange` 订阅者**（`src/preload/index.ts:315`、`src/renderer/store/sessionStore.ts:190`、`src/renderer/store/eventBus.ts:34`；2026-11-07 复核）→ `testing` 自动推进丢失。本期改为：该事件只更新派生状态提示，不再承担 `nodes.status` 写入。
2. `agent-manager` 会话启动自动广播 `developing` → 改为写 `work_runs`/派生状态。
3. `threadStore` 单 thread 映射 → 时间线查询。
4. `AgentChatPanel` 少传 `graphId` → 必须补。
5. `graphStore` 自动写 `developing` → 删除。

---

## 10. 与既有安全模型的一致性

| 约束 | 本设计如何满足 |
|---|---|
| 不绕过审批网关 | TestExecutor 的每条 `ask` 类命令在执行时逐条经 `ApprovalGateway` 放行，审批事实写 `agent_approvals`；计划审批不提升 `ask`，不新增旁路 API |
| 不绕过 Bash 策略 | 逐条调用 `evaluateBashPolicy`；`deny` 不可被计划审批豁免 |
| 不绕过 gitdir 写保护 | 逐条调用 `evaluateGitDirWriteGuard`，命中即 deny（fail-closed）；worktree 创建走主进程受控 git 能力，不经 Bash |
| 不复用 `RecipeRunner` shell | 明确不复用；TestExecutor 自带执行循环 |
| 不复用会话授权 | `session grants` 为内存态，测试执行不读取、不继承 |
| 不使用 `unattended` | 计划审批超时即作废（`expired`），不自动重放 |
| 审计可追溯 | 审批、路由、偏差、证据、迁移都有独立表与报告 |
| 归属校验（采纳） | 测试计划与 bug 修复必须校验"图/项目/会话归属"；`recipes:run` 等既有 IPC 补同样校验，防止跨工程触发 |
| 审批不串场（采纳） | 跨会话 `pending approvals` 必须按 subject ownership 过滤；不得把 A 项目的待审批计划展示到 B 项目 |
| 编排写路径仅 Tier 1（采纳） | 无写前审批回调的 adapter（Tier 2）只读或排队，不得降级执行写步骤；`degraded` 只用于手动会话（§5.9.5） |
| allow 命令的配置键测试（采纳） | 每条新增 allow 命令必须附"消费了哪些配置键"的测试，未附不得合入（§6.8.1） |
| E3/E2 证据不造假（采纳） | 只有执行后 worktree 仍干净 + worktree=base commit + 有 work_run 才能写 E3；否则确实执行过时写 E2，内容绑定 worktree 执行内容（tree + 实际改动）；零执行不写证据（§6.2.1） |

需扩展的唯一安全相关结构：`agent_approvals` 的 `subject_type` / `subject_id` 与 `run_id`/`turn_id` 可空。改法见 §6.3 / §8.10；影响面为所有读取该表的查询与重启重推逻辑（测试计划审批不自动重放）。

---

## 11. 风险与开放问题

### 11.1 需要产品方知晓的三个风险

1. **重复导入导致身份漂移 —— 已在入口拦截。** 导入在写任何图数据之前做指纹查重，命中即拒绝（§2.6），不静默合并、不生成第二套 lineage。残余风险是**误判**：把"内容高度相似的不同项目"当成重复而拒绝（可申诉/换目录重试），或把"内容差异大的同一项目"放行（`ALLOW_WITH_WARNING` 会明确提示）。指纹只做"是否同一工作区/副本"的判定，**不证明业务实体同一**。分支/副本的"记住规则"必须可查看、可撤销，且每次命中都要标明来源，避免变成静默豁免。
2. **非 git 项目无法产生 E3（可复现验证）。** E3 要求"测试通过 + 代码 hash 绑定"，非 git 没有 git commit sha，最高只能到 E4 人工签收，永远不会有自动 `verified`。硬约束是展示/导出/看板必须按"可复现 / 不可复现"分组，E4 不得与 E3 混排；失效判据改为"覆盖文件内容哈希 + 覆盖范围 + 30 天过期"（§3.5），代码变更后只能判"覆盖内容是否变"。
3. **S4 是不可逆里程碑。** CHECK 扩展后旧二进制无法读取新库，回退只能恢复备份；且迁移期间重建 `graphs`/`nodes`/`edges` 三张大表，一旦中途失败必须整体回滚。缓解：发布前完成 P2/P3 演练与备份恢复演练；把 S4 单独作为一次发布，不与功能开关一起上线。

### 11.2 其他开放问题（有默认假设，不阻塞）

| 问题 | 默认假设 |
|---|---|
| 一个项目是否会出现多张 dev 图 | 默认不会（导入期查重）；唯一例外是用户显式确认（可"对同一指纹记住"）的不同分支/副本，各自独立 `entity_key` |
| test 图的节点是否需要人工状态 | 是，但只允许 `draft/confirmed/published` |
| 人工验收是否允许无 `code_version` 的 E4 | **允许**（产品方已定，§3.5）；E4 统一为人工签收、`reproducible=0`、显式标注"无代码 hash、不可复现" |
| E4 过期策略 | 统一 30 天、可配置；不按项目风险/类型区分（后续可选扩展，不进 L1） |
| `signed_by` 口径 | 本地用户标识；显示名可选，不强制真实姓名/角色 |
| 查重阈值（N=12、0.6/0.8） | **已定**：接受默认值，保持可配置，先按默认值上线 |
| `import_rejections` 留存期 | **已定**：明细 90 天，聚合计数永久 |
| 偏差校准的周期 | 按批次（每 20 个 run）或每 2 周（取先到者）离线统计，人工改配置（§5.7） |
| worktree 残留清理周期 | 失败现场保留 7 天，其余即时清理（可配置） |
| 平台范围 | 本期只验证 POSIX（macOS / Linux）；Windows 路径规则不承诺（A9） |
| 编排 MVP 的 Tier 范围 | **已定**：仅 Tier 1 参与编排（读 + 写）；Tier 2 只读或排队等人工会话，Tier 3 不参与 |
| 任务总 wall clock | 单个 `work_item` 累计 60 分钟（可配置），到期落 `timed_out`（§5.9.4） |
| `published` 软阻断 | **已定：软阻断**。不阻止人工标记 `published`，只影响徽标与统计口径（`published_without_evidence` 单列）；不做强制测试/二次确认（§6.5.2） |
| 流程级测试范围 | **已定：L2 起做最小版**。框选子图 → 每节点验证步 + shell 测试步 → `test_report`；不做可视化编排（§6.5.1） |

### 11.3 规模与保留策略（补充审查项）

| 对象 | 默认阈值 / 策略 | 说明 |
|---|---|---|
| 节点会话时间线 | 每页 50 条，按 `created_at DESC` 分页；不一次拉全量 | `map:node:timeline` 必须分页 |
| 节点证据列表 | 每页 50 条；超过 200 条时默认只展示最近 200 条 + "加载更多" | 不因证据多而拖慢叠加层 |
| `node_links` | 单节点 active 链接软上限 500（超过告警，不自动删除）；查询必须走键索引 | 链接是历史，不硬删 |
| `node_session_links` | 单节点软上限 200；超过提示"会话过多，建议归档旧会话引用" | 不删除会话本体 |
| `work_runs` | 按 lineage 分页；单任务展示最近 50 次尝试 | 历史保留，UI 分页 |
| 叠加层批量 | 每图单次 `map:overlay:get` 最多返回视口内节点；全图统计走独立聚合接口 | 避免 1000 节点全量 IPC |
| 测试输出 / 失败现场 | 失败现场保留 7 天；`test_results.output_ref` 指向的产物保留 90 天（可配置） | 超期清理只删产物，不删结果行 |
| `evidence_suggestions` | `dismissed` / `accepted` 保留 90 天后清理（可配置） | 审计需要可查一段时间 |
| `routing_decisions` | 保留 180 天（可配置） | 用于复盘，不是永久账本 |
| `plan_deviations` | **永久保留** | 阈值校准依赖长时间序列；只做归档不做删除 |
| `map_migration_reports` | **永久保留** | 迁移与回退审计 |

- 上述软上限只触发告警与 UI 提示，**不自动删除业务事实**；任何清理都必须有配置项与报告。
- 分页与批量接口的阈值写入配置，不硬编码在渲染层。

---

## 12. 外部蓝图交叉验证记录（2026-11-07）

**来源**：`map-orchestration-blueprint.md`（**Zcode v1.2，364 行**，以附件形式提供，未入库）。本节的逐层对照基于该附件；§12.10–12.13 另行引用本地 **Zcode v1.2.1（勘误版，302 行）**，两者版本与行数不同，不混用。
**方法**：逐层对照；每层给结论；只采纳"补了缺失场景"或"把含糊处变可执行"的内容；已定口径不得被改写。

### 12.1 逐层对照结论

| # | 层 | 结论 | 依据与说明 |
|---|---|---|---|
| 1 | 概念模型 | 各有所长 | 对方以 `ExecutionRecord` 为绑定原子单元、强调节点活动流；我们以 `work_items` + `work_runs` + `node_links` + 证据为主线。已采纳其"执行记录视图"概念，但落到现有表上（§4.6），不新增表 |
| 2 | 表结构与主键/外键 | 我们更完整 | 我们有 **22 张新表**、revision/supersedes、key-based `node_links`；对方 test-case 用 `targets:[{graphId,nodeId}]`，node id 在克隆/重导后失效。采纳 `work_items`/`work_runs` 的依赖、结构化输出、attempt、deadline、`failure_class` 字段（§7.2）；**采纳 D2：步专属字段另立 `work_steps`**；驳回 `targets` |
| 3 | 迁移与版本 | 我们更完整 | 我们有 v24–v32、schema checksum、备份与回滚演练；对方无迁移/回退方案。不采纳 |
| 4 | 任务拆解与编排 | 各有长短 | 对方的**串行**执行机制（失败分类、超时、重启对账）完整且可执行；波次/并行/fanout 属 L3。我们的"结构推导 + 人工确认 + 可修订计划"更严。采纳**串行**执行机制（§5.9）；驳回"LLM planner 直接产出并执行 DAG" |
| 5 | 路由与执行 | 对方更完整 | Tier 1/2/3 能力票比"按能力矩阵选 adapter"更可执行；节点忙排队、幂等键、deadline 写入方都是缺口。采纳（§5.9.4–5.9.5） |
| 6 | 测试闭环 | 对方更完整 | 我们只到"回写失败"，对方补了 bug 闭环、定向重测、manual/LLM 用例分级、测试命令网关。采纳（§6.6–6.8）；但节点类型与跨图引用方式坚持我们的设计 |
| 7 | 多图与 `entity_key` | 我们更完整 | `entity_key`、`node_links`、导入查重是我们的核心，对方没有身份层。仅采纳其"dev→online 结构变更走提案"的方向（§2.7，L3 实现） |
| 8 | 状态机 | **直接冲突** | 对方主张"节点状态由任务完成事件自动推进"，与我们的状态双轨冲突。保持原设计：`nodes.status` 只由人写，任务完成只影响 `work_runs` 与派生状态。采纳其任务级 `failure_class` / `needs_human` / `interrupted`，并按 D2 在 S5 一次补齐 `needs_input` / `needs_human` / `paused` / `interrupted`；步级状态机见 §5.9.8 |
| 9 | 并发与冲突 | 各有长短 | 对方有全局写闸、并发上限、优先级队列；我们有隔离 worktree 与"同节点不并行"。按场景分工：agent 编排用写闸，测试执行用 worktree（§5.9.3） |
| 10 | 权限与安全边界 | 部分一致 | 都复用审批网关/Bash 策略/gitdir 保护。对方补了归属校验与"审批不串场"，这是我们的缺口。采纳（§6.8、§10） |
| 11 | 性能与规模 | 各有长短 | 对方有并发上限、波次调度、运行记录不入图；我们有索引设计、视口分页、批量 IPC。采纳上限，保留索引方案 |
| 12 | 交付节奏 | 不可直接映射 | 对方 P0–P4，我们 S1–S8/v24–v32。**采纳 D5：交付阶段 P1 先身份层（S1/S2），P2 编排脊柱（S5/S6，内置 D1/D3 护栏）**（§8.1.1）；P0 的源码缺陷不属本文；Yjs 已实施单向只读（`cc749ce`，§2.2.1），完全移除不在本期 |

### 12.2 采纳清单（已写入正文）

| 补充内容 | 对方为什么更好 | 落到章节 |
|---|---|---|
| ExecutionRecord 作为派生视图 + 节点活动流 | 补了"一次执行"作为产品可见单元，且明确 filesTouched 必须是确定性证据 | §4.6 |
| `depends_on_json` / `output_schema_json` / `checker_work_item_id` | 把 DAG 依赖、结构化输出、maker-checker 变成表结构可执行 | §7.2 |
| `attempt` / `deadline_at` / `interrupted` / `timed_out` / `partial_output_ref` / `output_parse` | 补了重试、超时、重启、失败保留部分产出 | §4.2、§7.2 |
| 单步/多步分流 | 避免小任务被过度拆解，同时不跳过人工确认 | §5.9.1 |
| `failure_class` 与重试策略 | 把"失败了怎么办"从含糊变成可执行表 | §5.9.2 |
| 全局写闸、并发上限、优先级队列、节点忙不重试 | 补了多任务并发时的写冲突与饥饿问题 | §5.9.3 |
| 启动对账、幂等键、取消传播 | 补了崩溃恢复语义 | §5.9.4 |
| Tier 1/2/3 能力票与降级明示 | 把"能力矩阵"从概念变成可判定规则 | §5.9.5 |
| Bug 闭环 + 定向重测 + 环境失败不建 bug | 补了测试失败后的完整链路 | §6.6 |
| `case_kind`（manual / llm_acceptance）分级 | 明确"人工验收型测试"只能到 E4，LLM 判定不能成为证据 | §6.7 |
| `TestCommandGateway` + 归属校验 + 审批不串场 | 补了安全边界，且指出 `recipes:run` 的既有缺口 | §6.8、§10 |
| dev→online 结构变更提案 | 补了"开发中发现产品结构要改"的缺失场景 | §2.7（L3） |
| 发布进度派生视图 | 补了项目级汇总，但我们加严为"不落库、不叫完成度、证据分组" | §3.6 |
| D2：`work_items` / `work_runs` 命名统一 + 步专属字段独立 `work_steps` | 把"任务"与"编排步"分层，避免把 `outputSchema` / `consults` / `checker` / `deadline` / `attempt` / `invocation_id` 塞进任务表导致身份与执行耦合 | §4.1.2、§7.2；表数 21→22 |
| D2：`work_items.status` 四值一次建齐 | 避免上线后再 `ALTER` / 重建；`needs_input` / `needs_human` / `paused` / `interrupted` 是编排必需状态 | §4.1.1、§7.2、§8.7 |
| D3：planner 分层与权重冷启动 | 复杂任务"候选推导 → 模型只选择 → 越界剔除入审计 → gates"，简单任务直接单步；默认权重 + `plan_deviations` 校准，避免在线学习 | §5.3、§5.7 |
| D5：交付阶段 P1 身份层 / P2 编排脊柱 | 先稳定身份与链接，再上编排；P2 内置 D1/D3 护栏 | §8.1.1 |
| D6：统一 `agent_approvals`，不设 `test_approvals` | 审批事实单一来源，避免两套状态与跨表对账 | §6.3、§7.1、§8.10 |
| D8：取消 `thread:<id>` 伪节点 | 未挂载会话保持纯 thread，挂载后才建会话；`node_id` 放宽列为长期待办 | §4.5；**已实施（`5938001`）** |
| DAG 正确性（环检测、Kahn 分层、依赖优先级、父任务聚合） | 补了"环会让队列永久 queued"这一致命缺口，并把聚合规则写死 | §5.5.1 |
| 取消语义（进程组杀灭、审批中/排队中可取消、竞态、下游传播、worktree 清理） | 把"取消"从改状态变成真杀进程，并定义竞态与部分产出 | §5.9.7 |
| 步级状态机 + `needs_input` 问题卡 | 状态变更即落库，等待用户输入不计失败、回答后开新 attempt | §5.9.8 |
| 流程级测试的可执行定义 | 把 flow 从描述变成有序可执行步骤，禁止人工/LLM 混入自动通过链 | §6.5.1 |
| `published` 软阻断 | 无通过记录时默认不发布，允许显式豁免并落库 | §6.5.2 |
| 任务总 wall clock 60 分钟 + 队列重排/aging | 防单任务无限重试与长任务饥饿 | §5.9.4、§11.2 |
| 路径规范化（realpath + NFC + 大小写 + 分隔符） | 统一 G1/G6/scope_files/fileAssociations/change_sets/node_links，消除"同名不同串"误判 | §5.4.1 |
| 迁移状态机与半迁移恢复 | 逐阶段 started/completed/failed、心跳、孤儿 `_backup` 检测与续跑边界 | §8.14 |
| 规模与保留策略 | 分页阈值、软上限、产物/建议/路由的保留期，避免叠加层被历史拖垮 | §11.3 |
| 假 E3/假 E2 修复 | 把"worktree 只含基线 commit 却记 E3"和"拿主工作区 dirty 当执行内容绑定"两类假证据堵死；E2 绑定 worktree 实际执行内容，零执行不写 | §6.2.1 |
| `change_sets` 进 L1 | 解决 §4.6 与 §8.12 的矛盾：既然 `filesTouched` 只认它，L1 必须建 | §4.6、§8.12 |
| allow-list 配置键测试 | 防止测试命令悄悄读取凭据/改变行为而不被发现 | §6.8.1 |

### 12.3 驳回清单与理由

| 对方主张 | 驳回理由 |
|---|---|
| LLM planner 直接产出 TaskDAG 并执行 | 与已定的"结构推导 + 人工确认 + 可修订计划"冲突；无人工确认的自动 DAG 会把模型猜测当成分解事实 |
| 节点状态由任务完成事件自动推进 | 与状态双轨冲突；"任务完成"不等于"节点完成"，正是"漂亮但说谎"的来源 |
| test-case `targets` 用 `graphId + nodeId` | node id 在克隆、重导、重建后都会变；必须坚持 `entity_key` + `node_links` |
| 新增 `test-flow` 节点类型 | 与现有 `test-suite` 语义重叠，且会再次触发 `nodes.type` CHECK 重建；用 suite 表达 flow |
| MVP 不做 worktree | 与 TestExecutor 隔离执行原则冲突；只在 agent 编排阶段采纳共享工作区 + 写闸 |
| review gate 直接计入"已验证" | LLM 验收 + 人工确认不能等价于"测试通过 + 代码 hash"；按 §6.7 降级映射到 E2/E4 |
| 以"已拆除 Yjs"为前提裁剪 P6 / 改 RequestQueue | **Yjs 已实施单向只读（`cc749ce`）**：写回已断开、WS 写消息 1008 拒绝、doc 变更不落库；SQLite 权威列不变（§2.2.1）。完全移除不在本期。P6 验收改为"默认启动下写消息被拒、doc 变更不落库"，SQLite 镜像验证并行。外部拆除方案本文不背书也不反驳。RequestQueue 由 `WorkItemService` 队列取代（§12.7） |
| Tier 2 降级执行写步骤 | 无写前审批回调就无法满足"不绕过审批网关"；Tier 2 只能只读或排队等人工会话，`degraded` 只用于手动会话（§5.9.5） |
| 运行记录只放 artifacts、不进图 | 我们本就没有把 run 做成图节点（`test_runs`/`test_results` 是表），方向一致，无需改 |

### 12.4 对已定八条口径的冲突检查

| 已定口径 | 外部文档是否触及 | 结论 |
|---|---|---|
| 查重阈值与判定顺序 | 未触及 | 保持 |
| 拒绝明细 90 天 + 聚合永久 | 未触及 | 保持 |
| E4 统一 30 天过期 | 未触及 | 保持 |
| 分支/副本"记住放行" | 未触及 | 保持 |
| 图删除后重建判据 | 未触及 | 保持 |
| L1 不开放删除节点 | 未定义删除语义 | 保持 |
| E3 / E4 的"可复现 / 不可复现"语义 | **触及**（review gate、published gate 把 LLM 验收/人工确认计入进度） | **不采纳其混同**，按 §6.7 降级映射；原口径不变 |
| `signed_by` 取值 | 未触及 | 保持 |

**结论：本次交叉验证未改写任何一条已定口径，不需要重新审批。**

### 12.5 仍需用户拍板

> 五条裁决（U1、F3、`plan_deviations` 归因、`work_items.status`、Tier1/`published`/流程级测试）已落入正文。R7 覆盖项（F1–F3 修复授权、发布进度仅内部展示、dev→online 提案 UI 留 L3）已拍板，从待定移除；E4 过期不延后也已定。Yjs 单向只读已由 `cc749ce` 在代码层实施。

1. **D1 计划确认强度**：简单单步内联 mini-C1 vs 全量 C1 对话框。
2. **D4 流程折叠**：suite/case + `test_specs.kind='flow'`；折叠层级与默认展开方式。
3. **F3 超时默认值来源**：是否引入配置键 `agent.timeouts.turnMs`（**产品选择，当前未实现**；现状是代码常量 `DEFAULT_AGENT_TIMEOUTS.turnMs`，单一来源已满足）。
4. **两层 partial 截断是否统一**：地图侧常量 `PARTIAL_FIELD_MAX_BYTES = 16KB` / `PARTIAL_TOTAL_MAX_BYTES = 64KB`（`work-run-service.ts:66-67`）vs 子代理侧常量 `MAX_OUTPUT_ENTRY_SIZE = 10_000` 单条（`base.ts:40`）。**当前两套值不一致且均非配置项**；要不要统一、统一到哪个值，待用户裁决，本文不擅自统一。

### 12.6 第二轮独立审查：六项必须改的改法

| # | 问题 | 选定改法 | 落点 |
|---|---|---|---|
| 1 | 假 E3 / 假 E2：worktree 从基线 commit 创建，主工作区未提交改动不在 worktree，测试却记 E3；失败分支又拿主工作区脏哈希当 E2 内容绑定 | **fail-closed**：L1 的 worktree 固定 detach 在 `base_commit`，不应用工作区 diff；E3 五条判据写死（执行后 worktree 仍干净 + 全过 + work_run），否则真实执行过只写 E2，`current_hash` = 执行内容指纹（tree + worktree 内实际改动），零执行不写。禁止"先记 E3 再降级" | §6.2、§6.2.1；`ref_json.worktreeCommit` / `worktreeTree` / `executedContentHash` / `worktreeDirtyFiles` |
| 2 | L1 的 `change_sets` 矛盾（§4.6 只认它，§8.12 不建） | 二选一后选择 **`change_sets` 进 L1**；活动流保留文件展示，不降级为"不展示文件" | §4.6、§8.12；L1 表数 11→13 |
| 3 | 取消只改状态，没杀进程；排队/审批中不可取消；下游错记 `blocked` | 补真杀**进程组**（TERM→10s→KILL）、`awaiting_approval` 可撤销、取消/完成竞态用条件更新、下游 `cancelled(reason='upstream_cancelled')`、partial 先落库、取消即清 worktree；给出迁移表 | §5.9.7；`work_runs.cancel_requested_at` / `cancel_reason` |
| 4 | DAG 无环检测，环会让队列永久 `queued`；依赖顺序与父任务聚合未定义 | 计划确认时环检测拒绝；Kahn 分层；`显式 depends_on > 隐式引用 > 数组顺序`；父任务"全部叶子终态 ∧ ≥1 failed → failed" | §5.5.1 |
| 5 | Tier 2 降级执行写步骤与"不绕过审批网关"冲突（无写前审批回调） | **编排写路径仅 Tier 1**；Tier 2 只读或排队等人工会话；`degraded` 只用于手动会话；MVP 仅 Tier 1（已定） | §5.9.5、§10、§11.2 |
| 6 | allow 命令扩展无"消费哪些配置键"的测试 | 新增纪律：每条 allow 命令必须附配置键消费测试，未附不得合入 | §6.8.1、§10 |

### 12.7 第二轮审查：八项建议落点

| 建议 | 落点 |
|---|---|
| 步级状态机（`planning` / `review` / `paused(infra)` / `needs_input` + `waiting_approval` / `succeeded` / `timed_out`），状态变更即落库 | §5.9.8；`work_steps.status` |
| 流程级测试的可执行定义 | §6.5.1 |
| `published` 加"测试通过"软阻断 | §6.5.2 |
| `needs_input` 问题卡与下一 attempt | §5.9.8；`work_steps.input_request_json` |
| 任务总 wall clock 60 分钟与队列重排 | §5.9.4、§11.2 |
| 路径规范化（realpath + 大小写折叠 + NFC + 分隔符），统一 G1/G6/`scope_files`/`fileAssociations`/`change_sets`/`node_links` | §5.4.1；`change_sets.dirty_tree_hash`（文件面证据） |
| 迁移状态机（逐阶段 started/completed/failed、半迁移拒绝启动、孤儿 `_backup` 检测与续跑） | §8.14；`map_migration_reports.stage` / `heartbeat_at` |
| 规模与保留策略（每节点上限、分页阈值、retention） | §11.3 |

### 12.8 记录不改（六项）

| 项 | 结论 | 说明 |
|---|---|---|
| Yjs | 依赖/表/schema **不删不改**；单向只读 | **已实施（`cc749ce` + `987c226`）**：写回模块删除、WS 写消息 1008 拒绝、doc 变更只落 `yjs_snapshots`；**1236 默认不监听已实施（`987c226`）**（`yjs-realtime.ts` 按 `BIZGRAPH_YJS_WS` 判定，`ipc-handlers.ts:348` 无 options，§2.2.1）。完全移除不在本期；P6 验收＝"默认启动下 `1236` 不监听、doc 变更不落库"，SQLite 镜像并行 |
| RequestQueue 删除 | 记录不改；由 `WorkItemService` 队列取代 | 删除动作随 **L3** 落地（P2 = L2，不得写成随 P2 删除），不在本文改源码 |
| 进化三层与 `review_queue` | L3+ 非本期 | 不写入 L1/L2 范围 |
| `ContextBundle` 与尾块协议 | 不在本文定义 | 交叉引用 `agent-architecture.md`（§0.1） |
| planner 主路径 | 保持现有路径 | 但明确：模型做候选选择时输出仍需 schema 校验 + 修复 1 轮（§5.3） |
| Windows 路径 | 明确平台范围 | 本期只验证 POSIX；Windows 规则不承诺（A9、§5.4.1） |

### 12.9 待回传外部方案的异议清单

> 以下只记录我方异议与依据，不把外部文档提交进仓库；等对方确认后再改其记录。

| # | 外部记录 | 我方异议 | 依据 |
|---|---|---|---|
| Q3 | "执行期机制全采纳" | 应为 **"串行执行机制全采纳"** | 本文 L1/L2 明确不做流程级 DAG 并行、不做并行写同一节点、不做多 Agent 并行编排（§1.8）；并行/fanout 属 L3 |
| Q6 | 章节引用错误 | 流程级测试的可执行定义在 **§6.5.1**，不是 suite 本身 | §6.5.1 定义 `test_specs.kind='flow'` 的执行口径；`test-suite` 只是资产容器 |
| Q11 | 载体是 suite | 应为 **`test_specs.kind='flow'`** | 流程级测试要绑定多节点与步骤序列，suite 本身不承载 flow 语义 |
| 表数 | 仍写"21 张表" | 我们已是 **22 张**；L1 最小集 **13 张** | §8.12 与 §7.2；D2 新增 `work_steps` 后总数 22 |
| P6 / 伪节点 | 仍标"不可用" | **Yjs 写消息拒绝：已实施（`cc749ce`）**；**1236 默认不监听：已实施（`987c226`）**；**伪节点取消：已实施（`5938001`）**，写入侧不再生成 `thread:<id>`（§4.5 D8） | §4.5、§2.2.1、§8.11；完全拆除才属 L3（§2.8） |
| R5 汇总 | "24 可用 / 8 待商议 / 2 不可用" | 应为 **24 可用 / 5 已裁决落地（D2/D3/D5/D6/D8）、2 待拍板（D1、D4）/ 0 不可用（2 项已处置）** | §12.5；D1/D4 仍待拍板 |
| `NODE_STATUS_CHANGE` | "无消费者" | 精确为"**有转发链（preload 与 sessionStore 均 re-emit），无 `node:statusChange` 订阅者**" | `src/preload/index.ts:315`、`src/renderer/store/sessionStore.ts:190`、`src/renderer/store/eventBus.ts:34`；2026-11-07 复核 |

### 12.10 Zcode v1.2.1（302 行，本地快照）逐节评估：明确不采纳

| 主张 | 不采纳理由 |
|---|---|
| Tier 2 以 `workspace-write` 执行写步骤 | 推翻"编排写路径仅 Tier 1"，等于给无写前审批的后端开后门（§5.9.5） |
| "drop 迁移单提交 revert 即可" | 代码可回退，已删除的行/列数据回不来；必须先备份并演练恢复（§2.8） |
| 纯百分比上下文预算 | 无总预算与 tokenizer 口径，是伪精度；按 §5.9.8.1 的固定增量 + 裁剪顺序 |
| embedding ≥0.85 与"路径转 glob" | 无数据模型、无算法、无验证方式；不落表也不落规则 |
| 整表术语对照 | 含错误映射（把 `task_steps` → `work_runs`，应为 `work_steps`）与陈旧主张；只按 §5.9.11 / §4.2 的字段对齐，不做整表搬运 |
| `needs_input` 未入值域 | 已定 13 个 `work_items.status`，不重开；`needs_input` 早在 D2 建齐 |
| 伪节点本期保留 | D8 裁决要求取消，**已实施（`5938001`）**；不回收该主张 |
| 其 L1/L2 表切分 | 与我们 L1 13 表冲突；`change_sets` / `work_steps` 必须在 L1 |
| `StageOverride.replace('extract')` | `pipeline.ts` 是字段映射而非方法调用，照写编译失败 |
| "turn 事件流监控点" | 没说是谁跑、多久一次、如何防并发重复杀；按 F3 的单一 deadline 执行者 |

### 12.11 Zcode v1.2.1（302 行）的事实性提醒

- **引用口径**：`Zcode v1.2`（被审附件，**364 行**）与本地 `Zcode v1.2.1`（勘误版，**302 行**）是两个不同版本；`1809` / `2051` / `3209` 分别是对本文 R5 / R6 / v1.2 写作时的**不同时点**行数，不混用。本文当前 **3451 行**（2026-11-07 `wc -l` 复核；随改动继续变化）。凡与本文冲突处，以本文当前版本为准。
- 其关于 Yjs WS 缓解、输出上限的具体数字**不采用**；Yjs 事实只以 §2.2.1 的 `cc749ce` 复核结论为准，测试范围只以 §2.8 的 **9 个测试文件 / 119 个 `it(`**（2026-11-07 复核）为准。
- 该版本把 "E4 在有真实测试时由 E3 替代" 写进方案，与我们"可复现 / 不可复现分离、不互相替代"冲突，不采纳（§3 / §6.7）。

### 12.12 Zcode v1.2.1 同步项（已落正文）

> 引用版本：**Zcode v1.2.1，302 行（本地快照）**。以下均已按三态词标注。

| 事项 | 状态 | 落点 |
|---|---|---|
| D2/D3/D5/D6/D8 在对方侧已落定：`work_steps` 独立表、伪节点取消（D8）、`work_items.status` 13 值含 `needs_input` | **全部已实施**：D8（`5938001`）；D2/D5a（`work_steps` 表）/D6（subject 扩展）/D3（推导冷启动权重）随 **v28/v31/v32 批次落地**（Zcode L1/L2，见其蓝图 §9 总账）；D1/D4 仍待我方拍板 | §4.1.1、§4.5、§4.7、§12.5 |
| U1：过期 E4 → `stale` | **已实施**（v29 派生引擎,Zcode L1 S6a 批次） | §3.5、§3.7.3 |
| Yjs 单向只读（写回删除、WS 写消息 1008、1236 默认不监听） | **已实施**（`cc749ce` + `987c226`） | §2.2.1、§8.11 |
| F3-A：`failed` + `failure_type='timeout'`，不碰 `cancelTurn` | **已实施**（`e921977`） | §8.15 |
| D1 计划确认强度、D4 流程折叠 | **仅建议**（待用户裁决） | §12.5 |
| F3 默认值来源、审批期 deadline 暂停机制 | **默认值=代码常量**（`DEFAULT_AGENT_TIMEOUTS.turnMs`，无配置键；是否引入配置键待定）；**审批期=候选 A 冻结重算，已实施**（`7e6e63f`） | §8.15、§12.5 |

### 12.13 勘误清单（供 Zcode 按 R9 逐条修正）

> 引用口径：被审附件 **Zcode v1.2，364 行**（行号逐条核自该附件）；对方现行勘误版 **Zcode v1.2.1，302 行（本地快照）**。A 表只收**事实错误**；C 表收"不采纳 / 不可执行"，不混排。B 表只记行号偏移。

**A. 事实错误 8 条**

| # | 对方位置（v1.2，364 行） | 原句 | 我方证据 | 判定 |
|---|---|---|---|---|
| A1 | L280（另 L56、L125） | "WS server（1236）…前置缓解已上" | 复核时（2026-11-07）`BIZGRAPH_YJS_WS` 全库无命中；`yjs-realtime.ts:70` 为 `disableWebSocket ?? false`；`:107` 未禁用即启动；`ipc-handlers.ts:348` `new YjsRealtime(db)` 无 options（现已在 `987c226` 实施默认不监听） | 事实错误：该缓解从未实施；`cc749ce` 已以单向只读取代，`987c226` 补上默认关闭 |
| A2 | L107 | "截断上限 1MB，与现有输出上限一致" | `BaseAdapter.MAX_OUTPUT_ENTRY_SIZE=10_000`（`base.ts:40`，单条 10KB）；1MB 属 `recipe-runner.ts:189,196` 的 shell stdout/stderr | 事实错误：现有 subagent 截断不是 1MB |
| A3 | L285 | "`realtime/snapshot/`（约 1070 行）" | `git ls-files 'src/main/realtime/snapshot/**' \| grep -v __tests__ \| xargs wc -l` → **1208 行**（5 个非测试文件：`snapshot-persistence.ts` 93、`snapshot-store.ts` 209、`ws-server.ts` 263、`yjs-document.ts` 414、`yjs-realtime.ts` 229） | 事实错误：少报 138 行 |
| A4 | L29 | "通读 1809 行" | 1809 是 `a60355a` 之前时点；本文当前 **3451 行**（2026-11-07 `wc -l`） | 事实错误：R5 结论建立在过期快照上，须按现文本复审 |
| A5 | L288 | "约 86 个 Yjs 专测" | `rg -c "\bit\("`：**9 文件 / 119 个 `it(` 声明**（`src/main/realtime` 8 文件 = 112 + `services/__tests__/conflict-reporter.test.ts` 7）；`git grep -c "it("` 子串法 8 个 realtime 文件为 116（含 4 行非声明匹配） | 事实错误：86 无对应口径 |
| A6 | L360 | "`needs_input` 未入 status 值域（delta，待确认）" | 本文 §7.2 / §5.9.8：`work_items.status` **13 值**已含 `needs_input`（D2 一次建齐） | 事实错误：已入值域 |
| A7 | L348 | 术语映射 "tasks / task_steps → work_items / work_runs" | D2：步专属字段落 **`work_steps`**；`work_runs` 是执行记录 | 事实错误：错误映射 |
| A8 | L134–L135 | L1 只列 `work_items` / `work_runs` / `node_session_links` / `routing_decisions` 4 表；`change_sets` 放 L2（S5b） | 本文 §8.12：L1 **13 张**，含 `work_steps`、`change_sets`（`5b26715` 裁决） | 事实错误：L1 切分冲突 |

**B. 仅行号偏移的 4 条（结论不变）**

| # | 对方位置（v1.2.1 行） | 原句 | 我方事实 | 判定 |
|---|---|---|---|---|
| B1 | L30 | "通读 1809 行"作为现况 | 1809 是 `a60355a` 之前时点；本文当前 **3451 行**（2026-11-07 `wc -l`） | 仅快照过期（同 A4；A4 按事实错误判定，B1 只记行号面） |
| B2 | L279 | "基于 1809/2051 行时点快照" | `1809` / `2051` / `3209` 是不同时点，不混用 | 仅行号偏移 |
| B3 | L5、L21 | "当前 3209 行" | 3209 是 v1.2 写作时点；本文当前 **3451 行** | 仅行号偏移 |
| B4 | L279 | 章节号引用（§12.2 / §12.3 等） | 章节内容未变，行号随增删移动 | 仅行号偏移；引用应以章节标题定位 |

**C. 属"不采纳 / 不可执行"，非事实错误（仅供其内部修订参考）**

| # | 对方位置（v1.2，364 行） | 原句 | 我方结论 | 性质 |
|---|---|---|---|---|
| C1 | L119 | "调 runtime 现有 `cancelTurn` → `finalizeTurnStatus` … `status='failed'`" | `runtime.ts:766-771`：`cancelTurn` 内部已做终态 CAS 写 `cancelled`/`aborted`，二次 CAS 返回 false，超时永远落不了 `failed`；已改 F3-A 专用超时路径 | 执行方案缺陷（我方已纠正），非对方事实写错 |
| C2 | L245 | "数据源 … 全部现成，聚合查询新造" | `agent_logs` 无 `work_item_id`（`database.ts:484`）；`subagent_invocations` 无任务连接（`database.ts:592`）；必须经 `node_session_links` 归因 | 表面具体但不可执行 |
| C3 | L229 | "E4 仅有真实测试时由 E3 替代" | 与本文 §3.5 / §6.7"可复现（E3）与不可复现（E4）分离、不互相替代"冲突 | 口径冲突，不采纳 |
| C4 | L291 | "单提交 revert 即可" | revert 只回代码，不回已 DROP 的行/列数据；须备份 + 演练恢复 | 错误承诺，不采纳 |

## 13. 覆盖审计（2026-11-07）

> 审计基线：本文件 B1 补齐前的 2045 行版本；本轮新增/改写的 §2.2.2、§2.3.1、§2.8、§3.7、§4.7、§5.7、§5.9.x、§6.5.x、§6.8.x、§8.14.1、§8.15 按补齐后形态一并列出。逐节复核后按"可施工 / 有框架缺细节 / 只有结论 / 空挂"四类判定。判定标准从严格：**只有能回答"每个字段类型、约束、谁写、何时写、写失败怎么办、怎么验收"才算可施工**。B1/B2 补丁已把大部分"有框架缺细节"推进到可施工；本表同时标注缺口归属。

**汇总**：共 102 行；可施工 13 节；有框架缺细节 66 节；只有结论 23 节；空挂 0 节。B1 相关缺口已落到 §2.2.2、§2.3.1、§3.7、§4.7、§8.14.1、§8.15；B2 已落到 §5.7、§5.9.x、§6.5.x、§6.8.x；五条裁决已定案，相关行不再标待定。

| 章节 | 现有内容形态 | 缺什么 | 属于哪一批 |
|---|---|---|---|
| §0.1 文档分工 | 只有结论 | 无施工内容；只需保持与 `agent-architecture.md` 的引用一致 | — |
| §0.2 链接 vs 完成度 | 只有结论 | 无；原则已可直接约束实现 | — |
| §0.3 默认假设 | 只有结论 | A1/A2/A9 尚未逐条转成验收用例；A3/A4 未落测试超时边界 | B1 / B2 |
| §1.1 三图 | 有框架缺细节 | `graphs.type` / `NodeType` 值域约束、跨图 edge 拒绝的 DDL 与写入校验 | B1（复用现状），S4 在 B2 |
| §1.2 `entity_key` | 有框架缺细节 | UUID 生成点、克隆/拆分/合并的写入时机、回填事务与失败回滚 | B1 |
| §1.3 `node_links` | 有框架缺细节 | 写入流程、方向矩阵、唯一/幂等、孤儿巡检与拆分/合并传播 | B1 |
| §1.4 状态双轨 | 有框架缺细节 | 证据写入校验、派生输入/哈希、重算触发与失败处理 | B1 |
| §1.5 任务对象 | 有框架缺细节 | 表间写入者、状态迁移、事务边界、取消/完成竞态 | B1 |
| §1.6 拆解机制 | 只有结论 | 候选算法、模型输出 schema、确认接口、gate 失败分支 | B2 |
| §1.7 TestExecutor | 只有结论 | 执行接口、审批 subject、worktree 生命周期、失败分支 | B2 |
| §1.8 本期范围 | 只有结论 | 无；范围声明本身不需施工 | — |
| §2.1 唯一性维度 | 有框架缺细节 | 迁移步骤、回填顺序、唯一索引失败处理、回滚边界 | B1 |
| §2.2 生成/保留/回填 | 有框架缺细节 | 多图配对、占位节点、冲突行、二次运行幂等 | B1 |
| §2.2.1 Yjs 写回事实 | 只有结论 | 无施工内容；**已实施（`cc749ce`）**，验收口径已改为"写消息被拒、doc 变更不落库" | — |
| §2.2 旧库回填算法 | 有框架缺细节 | 项目事务、并发写冲突、ambiguous 报告、失败续跑 | B1 |
| §2.2.2 S1 施工细则 | 可施工 | 无；导入路径仍需代码，但字段/事务/回滚/验收已齐 | B1 |
| §2.3 `node_links` 设计 | 有框架缺细节 | 写入服务、方向矩阵、重复/自链接、孤儿/失效判定 | B1 |
| §2.3.1 S2 施工细则 | 可施工 | 无；拆分/合并传播与回填判据已齐 | B1 |
| §2.4 生命周期 | 有框架缺细节 | 归档/删除的状态机、图删除拒绝条件、巡检频率与报告 | B1 / B2 |
| §2.5 链接不等于完成度 | 只有结论 | 无 | — |
| §2.6 重复导入 | 有框架缺细节 | 抽样算法、读失败、TOCTOU、事务与拒绝落库细节 | B1 |
| §2.6 已定规则 | 只有结论 | 无；拒绝不合并是已定口径 | B1 |
| §2.6 指纹组成 | 有框架缺细节 | N=12 抽样索引、二进制/超大文件边界、缺失信号处理 | B1 |
| §2.6 判定顺序 | 有框架缺细节 | 并发重查、错误分支、`matched_signals_json` 必填项 | B1 |
| §2.6 执行位置/原子性 | 有框架缺细节 | `BEGIN IMMEDIATE`、同事务建图、冲突回滚 | B1 |
| §2.6 数据结构 | 只有结论 | DDL 指向 §7.2；无独立施工内容 | B1 |
| §2.6 与 S1 关系 | 只有结论 | 无；硬前置已明确 | B1 |
| §2.7 提案机制 | 只有结论 | 提案 UI、采纳/驳回状态、撤销语义 | B3 |
| §2.8 Yjs 拆除清单 | 有框架缺细节 | runbook 与逐类处置已补；仍待拆除决策与旧快照数据方案，本期不施工 | B3 |
| §3.1 双轨边界 | 有框架缺细节 | 自动写 `nodes.status` 的两条路径如何关闭、验收断言 | B1 |
| §3.2 证据等级 | 有框架缺细节 | 等级字段组合校验、写入校验、禁止先写后降级 | B1 |
| §3.3 派生优先级 | 有框架缺细节 | 输入集合、tie-break、`inputs_hash`；过期 E4 → `stale` 已裁决 | B1 |
| §3.4 建议机制 | 有框架缺细节 | 建议转证据的事务、去重、接受人/时间字段 | B1 |
| §3.5 非 git E4 | 有框架缺细节 | 写入校验、过期/覆盖变化任务、续签字段语义；过期派生已裁决为 `stale` | B1 |
| §3.5 硬约束/字段/撤销/关系/非 git | 只有结论 | 规则本身完整；缺执行检查与任务调度落点 | B1 |
| §3.6 项目进度 | 只有结论 | 权重配置、只读查询、缓存与 `computed_at` | B2 |
| §3.7 S6a 施工细则 | 可施工 | 无；U1 定案、字段/校验/重算/验收已齐 | B1 |
| §4.1 `work_items`/revision | 有框架缺细节 | revision 事务、`is_current` 唯一、修订与 running 冲突 | B1 |
| §4.1.1 状态值域 | 有框架缺细节 | 迁入/迁出表、条件更新、父任务失败聚合 | B1 |
| §4.1.2 `work_steps` | 有框架缺细节 | 字段默认值、步级唯一、attempt/invocation 写入方 | B1 |
| §4.2 `work_runs` | 有框架缺细节 | run_seq 分配、幂等键、终态竞态、partial 结构 | B1 |
| §4.3 `node_session_links` | 有框架缺细节 | NULL 唯一、挂载/结束时机、多会话时间线 | B1 |
| §4.4 `change_sets`/`routing_decisions` | 有框架缺细节 | 采集算法、dirty hash、失败留"未采集"、路由失败不写半条 | B1 |
| §4.5 与 `agent_*` 关系 | 有框架缺细节 | D8 落地后的 turn 路径、长期放宽项、无伪节点验收 | B1 |
| §4.6 活动流 | 有框架缺细节 | `change_sets` 字段/采集、未采集展示、多 thread 聚合 | B1 |
| §4.7 S5a 施工细则 | 可施工 | 无；写入权、13 个任务状态、12 个步状态、幂等与验收已齐 | B1 |
| §5.1 总览 | 只有结论 | 无 | — |
| §5.2 候选推导 | 有框架缺细节 | 候选存储、算法伪代码、权重配置、边界失败 | B2 |
| §5.3 模型只选择 | 有框架缺细节 | 输出 schema、越界剔除、修复 1 轮的验收 | B2 |
| §5.4 准入 gate | 有框架缺细节 | G1–G6 实现、失败分支、gate 结果落库 | B2 |
| §5.4.1 路径规范化 | 有框架缺细节 | POSIX 边界、`realpath` 失败、NFC/大小写折叠实现 | B2 |
| §5.5 可修订计划 | 有框架缺细节 | revision 状态、DAG 环检测、父子聚合的实现 | B2 |
| §5.5.1 DAG 正确性 | 有框架缺细节 | Kahn 伪代码、依赖优先级冲突、终态聚合验收 | B2 |
| §5.6 确认点 | 有框架缺细节 | C1–C4 接口、计划快照、确认/退回状态 | B2 |
| §5.7 偏差度量 | 可施工 | 归因口径、单一聚合窗口、字段/视图与采集时点已齐 | B2 |
| §5.8 退化兜底 | 有框架缺细节 | D1–D7 触发判据、执行落点、验收 | B2 |
| §5.9 执行编排 | 可施工 | 调度 tick、接口输入输出、错误码与失败分支已齐（§5.9.9） | B2 |
| §5.9.1–5.9.8 子节 | 可施工 | 单步/多步、失败分类、忙重排、deadline、Tier 票、取消竞态、步状态迁移已齐 | B2 |
| §5.9.8.1 黑板/Phase B/fanout | 有框架缺细节 | 上下文最小化、检索预算与水位线已补；黑板数据结构与 Phase B 接口仍属 B3 | B3 |
| §6.1 边界与复用 | 只有结论 | 无；复用声明本身不需施工 | B2 |
| §6.2 执行流程 | 有框架缺细节 | 步骤接口、worktree 创建/清理、命令超时、失败分支 | B2 |
| §6.2.1 E3 判据 | 可施工 | 无；五条判据与 dirty 降级已可执行 | B2 |
| §6.3 审批 subject | 有框架缺细节 | `agent_approvals` 重建/迁移、subject 取值、回调幂等 | B2 |
| §6.4 安全约束 | 有框架缺细节 | `.git` 写拒绝、cwd 固定、输出脱敏的执行检查 | B2 |
| §6.5 测试资产与回写 | 有框架缺细节 | 资产创建/更新、结果回写事务、失败重试 | B2 |
| §6.5.1 流程级测试 | 可施工 | flow 生成、拓扑序、失败判定与 `test_report` 已齐（§6.5.1.1） | B2 |
| §6.5.2 `published` 软阻断 | 可施工 | 判定、徽标、豁免与回滚已齐（§6.5.2.1） | B2 |
| §6.6 Bug 闭环 | 有框架缺细节 | bug 节点创建、定向重测、链接回写 | B2 |
| §6.7 手工用例/E4 | 有框架缺细节 | 手工执行记录、E4 签收入口、覆盖范围 | B2 |
| §6.8 测试命令网关 | 可施工 | 计划创建/审批/执行接口、错误码与失败分支已齐（§6.8.2） | B2 |
| §6.8.1 allow-list 纪律 | 只有结论 | "配置键消费测试"的 harness、覆盖清单、CI 门禁 | B2 |
| §7.1 既有表变更 | 有框架缺细节 | 列迁移、回填、索引、旧库兼容、回滚 | B1 |
| §7.2 新增表（B1 13 张） | 有框架缺细节 | 写入者/时机/失败分支/验收；DDL 已齐但缺行为契约 | B1 |
| §7.2 新增表（B2 表） | 有框架缺细节 | 同上；`test_*` / `plan_*` / `boundary_*` 生命周期未落 | B2 |
| §7.3 值域汇总 | 有框架缺细节 | 类型层同步、CHECK 重建、迁移顺序 | B1 / B2 |
| §8.1 迁移总览 | 只有结论 | 无；顺序声明本身不需施工 | — |
| §8.1.1 交付节奏 | 有框架缺细节 | 每阶段验收门、回滚演练、发布检查单 | B1 / B2 |
| §8.2 S0 备份预检 | 可施工 | 无；备份/预检步骤可执行 | B1 |
| §8.3 S1 | 有框架缺细节 | 施工细则引用 §2.2.2；发布前需逐条验收 | B1 |
| §8.4 S2 | 有框架缺细节 | 施工细则引用 §2.3.1；回填与只读开关 | B1 |
| §8.5 S3 归档 | 有框架缺细节 | 归档状态机、删除路径改造、巡检任务 | B2 |
| §8.6 S4 CHECK 扩展 | 有框架缺细节 | 重建顺序、备份/恢复、不可逆回滚演练 | B2 |
| §8.7 S5 任务对象 | 有框架缺细节 | 建表顺序、回滚、状态值验收 | B1 |
| §8.8 S6 证据派生 | 有框架缺细节 | 建表顺序、CHECK 验收、派生重建 | B1 |
| §8.9 S7 推导/计划 | 有框架缺细节 | 候选/草稿表生命周期、确认流 | B2 |
| §8.10 S8 TestExecutor | 有框架缺细节 | 测试表生命周期、网关、worktree 清理 | B2 |
| §8.11 验证清单 | 有框架缺细节 | P1–P9 的执行脚本/断言；P6 的 Yjs 与 SQLite 并行验证 | B1 / B2 |
| §8.12 阶段×表矩阵 | 有框架缺细节 | L1 13 张表的边界、B2 表插入顺序、表数口径复核 | B1 / B2 |
| §8.13 v24 修复记录 | 只有结论 | 无；已完成记录 | — |
| §8.14 迁移状态机 | 有框架缺细节 | 阶段目录、心跳/owner_pid、孤儿 `_backup` 判定、续跑边界 | B1 |
| §8.14.1 B1 迁移细则 | 可施工 | 无；状态映射、预检、回滚、故障注入已齐 | B1 |
| §8.15 F1–F3 | 有框架缺细节 | **已实施**（2026-11-07，main：F1 `231c724`、F2 `2425f0c`、F3-A `e921977`、审批冻结 `7e6e63f`，均经 `git merge-base --is-ancestor` 核实；P-F1/P-F2 随 `71518ed` 整合）。剩余失真已按代码对齐：超时默认值是常量、无配置键；partial 两层常量不一致（§12.5 待定） | B1 |
| §9.1 主进程服务 | 只有结论 | 服务接口签名、依赖注入、错误类型 | B1 / B2 |
| §9.2 IPC 通道 | 有框架缺细节 | 入参/出参 schema、错误码、幂等键 | B1 / B2 |
| §9.3 事件通道 | 有框架缺细节 | payload schema、版本、去重 | B2 |
| §9.4 渲染层 | 有框架缺细节 | 组件职责、状态来源、空态/错态 | B2 |
| §9.5 既有缺口 | 有框架缺细节 | 两条 `nodes.status` 写入路径的修复与验收 | B1 |
| §10 安全模型 | 有框架缺细节 | 编排/测试/审批的执行检查与 fail-closed | B2 |
| §11.1 三个风险 | 只有结论 | 无 | — |
| §11.2 开放问题 | 只有结论 | 无；默认假设已给 | — |
| §11.3 规模与保留 | 有框架缺细节 | 每节点/证据/link 上限、分页阈值、retention 任务 | B1 / B2 |
| §12.1–12.11 对照/审查记录 | 只有结论 | 无；记录性质 | — |

**审计结论**

- **空挂 0**：没有"标题在、内容缺"的章节；`ContextBundle` / 尾块协议有明确外部指向，不算空挂。
- **B1 可施工边界（裁决后）**：S1、S2、S5a、S6a、迁移状态机、F1–F3 行为契约已细化；U1 与 F3 选型已定案（过期 E4 → `stale`；F3-A），F1–F3 已实施（2026-11-07，见 §8.15）。
- **B1 一次性修正（已接受）**：`work_items.status` 补 `failed`（13 值），否则 §5.5.1 的父任务失败聚合无法落库；表总数不变（22），L1 仍 13 张。
- **B2 可施工边界**：§5.9 及子节、§5.9.9–5.9.11、§5.7、§6.5.1/§6.5.2、§6.8 已细化到接口级输入输出与失败分支；黑板/Phase B/fanout 仍属 B3。
- **Zcode v1.2 处理**：采纳 9 项落 §2.8 / §4.2 / §5.9.5 / §5.9.8 / §5.9.8.1 / §5.9.11 / §8.15 / §9.3；不采纳 10 项与事实性错误见 §12.10 / §12.11；两项待裁决见 §12.5 第 6、7 项。
- **B1 不动的口径**：查重 N=12 / 0.6 / 0.8、90 天、E4 30 天、记住放行、重建判据、L1 不删节点、E3/E4 可复现语义、`signed_by`、Tier2 只读、单向 Yjs 均未改写。

---

## 14. G1–G6 准入 gate 规格（引擎已实施；D1–D14 已全部裁决）

> **状态（按 §0 三态口径，逐项区分，不合并表述）：**
> - **已实施（`b6f3735`）**：G1–G6 评估引擎 `src/main/map/gate-engine.ts`；生产装配在 `work-execution-runtime.ts` 以 `GateRecheck` 注入，受 `BIZGRAPH_MAP_EXECUTION` 开关控制（默认关闭，关闭时写通道仍显式拒绝）。引擎单元测试 56 例、执行触发测试 12 例，已随 `b6f3735` 落地。
> - **已批准已实施（`e4398e7`，D1/D7）**：D1 acceptance 冻结为 `{id,type,expected,text?}`，系统边界强制结构化；**存量 `[{id,text}]` 不自动迁移**，人工重新确认计划前任务保持 `blocked`（显式代价）。D7 G4 预估行数采用「Σ scope 文件行数」的**过渡代理指标，不是变更行数**：已存在文件计实际行数，新建文件计 0，目录/读取失败 fail-closed；阈值 env `BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES` / `_LINES`（默认 20/800）。该代理只用于准入规模守卫，不得当作"预计变更行数"的验收事实；真实改动行数属执行后 evidence 对比。
> - **已全部裁决（2026-11-07，整批采纳推荐值表）**：D2–D6、D8–D14 逐条裁决见 §14.8。其中 D3/D4/D5/D6/D8/D9/D10/D11/D13/D14 与现有引擎保守默认一致（零代码改动，`b6f3735` 即实现）；**D2 已于 2026-11-08 实施**（`acceptance-executor.ts` + `agent-step-runner` 接线，最小闭环：`command` 退出码 / `file_check` 存在性，可选 `stdout_contains`、`content_contains`、`timeout_ms`；判定不出含 manual 待确认一律 `verify_fail`）；**D12 裁决为本期不做**。
> - **仅建议（本节未实施）**：依赖未来能力出现的扩展条款——跨图写入面出现时的 G3 链接矩阵、异步评估器的时限预算、评估器版本精确归因的 schema 变更。对应能力出现前不实施。
>
> 本节正文仍是规格定义来源；实际行为以 `gate-engine.ts` 与 `work-execution-runtime.ts` 为准，完整实施记录见 §M5.7 / §M5.8。本节不改 §M5 或其他小节。

### 14.1 适用范围与调用时机

- 判定对象是**单个 `work_item` 的单个 revision**（`id + revision`），不是节点、不是 run、不是整个计划。
- 同一评估器必须在以下时点复用，禁止各入口自行解释条件（§4.7.3）：
  1. `awaiting_confirm → queued`：确认入队前强制评估（§4.7.2）。
  2. 调度 tick 第 2 步：对 `queued` 项重跑评估，不信任确认时的旧结果（§5.9「调度 tick」第 2 步）。
  3. `blocked → queued`：解除阻塞前重跑（§4.7.2；现有 `unblock` 只校验非 `incomplete`，不等于重跑）。
  4. `resumeWorkItem` 的恢复路径：蓝图 §5.9.9 明确 `GATE_INCOMPLETE`（恢复前重跑 gate）。
- 评估器**只读**：不写 `work_items` / `work_steps` / `work_runs` / `node_evidence`。结果落库与状态迁移由调度器/`WorkItemService` 完成（§4.7.1 写入权）。
- 评估器不创建 run、不增加 `attempt`、不占用写闸；未通过时"不进队列"（§5.4）。

### 14.2 通用输入契约

评估输入必须是一次调用内**同源、同一时点**的只读快照；禁止评估过程中分多次读库再拼接（避免 scope 读旧值、running 集合读新值）。形状草案（类型声明，不含实现）：

```text
GateRecheckInput {
  item: {
    id, revision, lineageId, isCurrent,
    projectPath, graphId, anchorNodeId, anchorEntityKey,
    scopeFilesJson, acceptanceJson, dependsOnJson,
    status, gateStatus, origin
  }
  project: { projectPathRealpath | null, pathPlatform: 'posix' | 'non_posix' }
  graph: {
    graphId,
    anchorNode: { id, graphType, lifecycleState } | null,
    referencedNodes: Array<{ id, graphType, entityKey, lifecycleState }>,
    nodeLinks: Array<{ id, linkType, fromEntityKey, toEntityKey, fromGraphType, toGraphType, status }>
  }
  dependencies: Array<{ id, lineageId, revision, isCurrent, status, supersedesId }>
  runningItems: Array<{ id, lineageId, projectPath, scopeFilesJson }>
  policy: { g4MaxFiles, g4MaxLines, evaluatorVersion, pathPlatform }
  waiver: { waivedBy, waivedAt, waiveReason } | null   // 人工豁免意图，不是评估结论
}
```

| 输入 | 来源 | 用途 | 依据 |
|---|---|---|---|
| `scope_files` | `work_items.scope_files`（JSON 数组） | G1 非空与根内校验；G4 计数；G6 交集 | §5.4、§5.4.1、§7.2 |
| `acceptance_json` | `work_items.acceptance_json` | G2 结构化可判定项 | §5.4 G2 |
| `depends_on_json` | `work_items.depends_on_json` | G5 依赖闭包 | §5.4 G5、§5.5.1 |
| `anchor_node_id` / `graph_id` | `work_items`；`nodes.graph_type` | G3 目标节点在 dev 图 | §5.4 G3、§7.2 |
| 图节点与链接 | `nodes`、`node_links`、同图 `edges` | G3 跨图写判定 | §1.2、§2.3、§5.4 G3 |
| 运行中任务集合 | `work_items WHERE status='running' AND is_current=1` | G6 写冲突预检 | §5.4 G6 |
| 项目根 | `work_items.project_path`（realpath） | G1/G6 路径规范化边界 | §5.4.1 |
| 规模阈值 | 配置（D7 已实施：env 阈值 + Σ scope 行数代理） | G4 | §5.4 G4 |
| 证据 | `node_evidence` / `execution_state` | **不参与 G1–G6 判定** | §5.4；见 §14.3 末条 |

- `scope_files`、`acceptance_json`、`depends_on_json` 都是 TEXT 存 JSON。解析失败一律 fail-closed，不得当作空数组"看起来通过"。
- 路径比较必须走 §5.4.1 的统一规范化管线；任一表存了未规范化路径，都在使用点重新规范化，不做字符串直接相等（§5.4.1）。
- 非 POSIX 根（Windows 路径）按 §5.4.1 A9 直接 fail-closed，不做猜测性兼容。

### 14.3 结果、落库与三态纪律

`gate_status` 只允许三值（`work_items.gate_status` CHECK，§7.2）：`pass` / `incomplete` / `waived`。`gate_missing_json` 是**字符串数组**（现有 `setGateResult(id, result, { missing: string[] })` 即此形状），只写缺失项代码，不写自由文本对象。

| 结论 | 落库 | 后续动作 | 约束 |
|---|---|---|---|
| `pass` | `gate_status='pass'`，`gate_missing_json=NULL` | 允许继续依赖校验/tick 后续步 | **不得**用 `[]` 表示通过（§4.7.3） |
| `incomplete` | `gate_status='incomplete'`，`gate_missing_json=JSON(missing[])` | 不 claim、不建 run；tick 内 `queued → blocked` 并写缺失项（§4.7.2） | `missing` 至少 1 条；无缺失项时写 `gate_missing_unclassified` |
| `waived` | `gate_status='waived'` 且 `gate_waived_by / gate_waived_at / gate_waive_reason` 三者齐全 | 视同通过（§4.7.2） | 缺任一字段 → 回落 `incomplete`（§4.7.3，现有 `setGateResult` 已是该行为） |

- 只有 **G2 的 `manual` 类型**允许豁免；G1/G3/G4 明确不允许（§5.4）。G5/G6 已裁决**不可豁免**（D9，§14.8）。
- 评估器不写库；调度器一次写入 `gate_status + gate_missing_json`（以及 waived 三字段），写入失败按 tick 失败处理，不能保留旧 `pass` 放行。
- **证据不参与准入**：G1–G6 是执行前条件，`node_evidence` / `execution_state` 是执行后事实（§3、§5.4）。用 stale/缺失证据阻断执行属于另一条策略；若产品需要，应新增 gate 或独立策略，不得塞进 G1–G6（D13 已裁决：不参与，§14.8）。

### 14.4 逐条 gate 规格

每条给出：判定、输入、`pass` 条件、`incomplete` 代码（命名已冻结，见 D11）、可豁免性与不确定时行为。依据均指向 §5.4 与相关章节。

#### G1 · scope 非空且都在项目根内

- **判定**：`scope_files` 解析为数组、去重后至少 1 项；每一项按 §5.4.1 规范化后，必须落在 `project_path` 的 realpath 之下；越界、`..`、外部绝对路径、指向根外的符号链接一律失败（§5.4、§5.4.1）。
- **输入**：`work_items.scope_files`、`work_items.project_path`。
- **pass**：全部条目通过规范化与根内校验，且无空串。
- **incomplete 代码（建议）**：`scope_files_empty`、`scope_files_invalid_json`、`project_path_missing`、`scope_file_empty:<index>`、`scope_file_escape:<index>`、`scope_file_unresolvable:<index>`。
- **可豁免**：否（§5.4 明确 G1 不允许豁免）。
- **不确定即失败**：`project_path` 为空（schema 允许 NULL）、realpath/权限/父目录解析失败、非 POSIX 根 → `incomplete`。理由：无法证明"在根内"就不能放行（§5.4.1 第 5 条）。

#### G2 · acceptance 至少 1 条结构化可判定项

- **判定**：`acceptance_json` 解析为数组，且至少 1 条满足：`type ∈ ('command','manual','file_check')`，并带非空 `expected`（§5.4 G2）。
- **输入**：`work_items.acceptance_json`。
- **pass**：存在上述结构化条目；其余条目可以是非结构化补充，但不得让判定变成"有文字就行"。
- **incomplete 代码（建议）**：`acceptance_json_empty`、`acceptance_json_invalid`、`acceptance_item_not_structured:<index>`、`acceptance_type_unknown:<index>`、`acceptance_expected_missing:<index>`。
- **可豁免**：仅 `manual` 类型可人工豁免，且必须三字段齐全（§5.4、§4.7.3）；manual 豁免为**整条任务粒度**，不得覆盖 command/file_check 失败（D3 已裁决，§14.8）。
- **不确定即失败**：类型不认识、`expected` 为空/无法解释、数组解析失败 → `incomplete`。
- **历史差距（D1 已解决，`e4398e7`）**：现有写入与执行路径曾把 `acceptance_json` 当作 `[{ id, text }]` 使用——IPC 入参是 `Array<Record<string, unknown>>`（`src/main/ipc/map.ts`），步骤提示词按字符串数组拼接（`src/main/map/agent-step-runner.ts`）。已裁决（D1）：系统边界强制结构化，存量不自动迁移（保持 `blocked` 待人工重新确认）。

#### G3 · 目标节点在 dev 图、无跨图写

- **判定**：`anchor_node_id` 可解析到 `nodes` 中的真实行；该节点 `graph_type='dev'`；本任务不包含跨图写（§5.4 G3）。
- **输入**：`work_items.anchor_node_id`、`work_items.graph_id`、`nodes(id, graph_id, graph_type, lifecycle_state)`、`node_links`（及同图 `edges`）。
- **pass**：锚点存在、其 `graph_type='dev'`、`graph_id` 一致；且按 D5 裁决口径未命中跨图写（本期仅锚点判定，见 §14.8）。
- **incomplete 代码（建议）**：`anchor_node_missing`、`anchor_node_graph_mismatch`、`anchor_node_not_dev:<graph_type>`、`cross_graph_write:<link_id|entity_key>`（最后这个本期不产出，D5）。
- **可豁免**：否（§5.4）。
- **不确定即失败**：锚点为空、解析到多行/零行、节点生命周期不可用、链接解析失败 → `incomplete`。
- **口径已裁决（D5）**：采纳收敛口径 c)——本期仅看锚点（存在 + dev + `graph_id` 一致）；a/b 候选与 `node_links` 链接矩阵不入本期准入，理由与未来约束见 §14.8。

#### G4 · 规模上限

- **判定**：`scope_files` 去重后的文件数 ≤ 配置上限（默认 20）；预估变更行数 ≤ 配置上限（默认 800）（§5.4 G4）。
- **输入**：G1 规范化后的文件集合；预估行数；阈值配置。
- **pass**：两项都在阈值内。
- **incomplete 代码（建议）**：`scope_file_count_exceeded:<n>/<max>`、`estimated_lines_exceeded:<n>/<max>`、`line_estimate_unavailable`、`gate_policy_missing`。
- **可豁免**：否（§5.4）。
- **不确定即失败**：拿不到预估行数时不能 pass（D7 已实施：目录/读取失败 → `line_estimate_unavailable`）；阈值非法回退默认并告警，不得回落到"无上限"。
- **现状（D7 已实施，`e4398e7`）**：`work_items` / `work_steps` / `plan_drafts` 仍无"预估行数"字段；生产来源是 `work-execution-runtime` 的 Σ scope 文件行数**过渡代理指标，不是变更行数**——已存在文件按实际行数，新建文件计 0（规模由 G4 文件数上限约束），目录/读取失败 fail-closed。阈值由 env 配置（默认 20/800，非法回退默认）。该代理只用于准入规模守卫，不能当作"预计变更行数"的验收事实。

#### G5 · 依赖闭包无未完成前置

- **判定**：沿 `depends_on_json` 做传递闭包；闭包内所有上游的**当前 revision**都处于终态成功（`status='done'`）；闭包内无环（§5.4 G5、§5.5.1 环检测）。
- **输入**：`work_items.depends_on_json`、闭包内 `work_items(id, lineage_id, revision, is_current, status, supersedes_id)`。
- **pass**：闭包完整可解析、无环、所有上游 `done`。
- **incomplete 代码（建议）**：`dep_missing:<id>`、`dep_not_done:<id>:<status>`、`dep_cycle:<id>`、`dep_revision_stale:<id>`、`dep_cross_project:<id>`。
- **可豁免**：不可（D9 已裁决，§14.8）。
- **"或显式标 blocked 并给出依赖 id"的含义**：已裁决为**失败分支**（D8）——依赖未完成时不放行，把依赖 id 写入 `gate_missing_json` 并转 `blocked`（§4.7.2 `queued → blocked`），"标了 blocked"不视为满足。
- **不确定即失败**：依赖 id 不存在、指向非当前 revision、存在环、上游为 `failed/cancelled/superseded/blocked` 等非 `done` 终态 → `incomplete`。
- **已裁决（D8）**：只看 `depends_on_json` 显式声明，隐式依赖（共享 `scope_files` / `verifies` / 同锚点）不入 G5 闭包，应由计划确认阶段落成显式声明；上游 `superseded` 按非当前 revision 判 `dep_revision_stale`，不自动代替。

#### G6 · 与 running 任务 scope 无交集

- **判定**：本任务规范化后的 `scope_files` 与所有 `status='running' AND is_current=1` 任务的 `scope_files` 逐条求交集；为空才通过（§5.4 G6）。只比较同一 `project_path` 下的任务，跨项目不比较（D10 已裁决）。
- **输入**：本任务 `scope_files`；running 集合的 `id / lineage_id / project_path / scope_files`。
- **pass**：无任何规范化后路径相同。
- **incomplete 代码（建议）**：`scope_conflict:<work_item_id>:<path>`、`scope_invalid:<index>`。
- **可豁免**：不可（D9 已裁决，§14.8）。
- **不确定即失败**：任一 running 行 scope 解析失败、或本任务路径无法规范化 → `incomplete`（不能"跳过坏行"当作无冲突）。
- **必须说明的边界**：G6 是**准入快照**，不是写锁；真正的互斥仍由 tick 第 5 步的写闸保证（§5.9「调度 tick」第 5 步）。G6 通过不代表运行期不会冲突，运行期冲突由调度与 ScopeGuard 处理（§6）。
- **已裁决（D10）**：不排除同 lineage 父/子任务（本期单 turn 串行 + 写闸在先，父子同时 `running` 的窗口极小；未来放开并行编排必须重裁）；`queued` 不纳入冲突面；跨项目不比较。

### 14.5 fail-closed 通则（适用于全部 gate）

按以下顺序，任何一条成立即 `incomplete`，不允许"跳过该项继续评估后判 pass"：

1. 输入缺字段/JSON 解析失败/类型不认识/枚举越界。
2. 只读快照构建失败（含查询异常、权限错误、超时）。
3. 规范化管线拒绝（非 POSIX 根、realpath 失败、越界）。
4. 评估器未注入、抛异常、超出时限、或返回结构不合规。
5. 结果自相矛盾（如 `pass` 却带 `missing` 非空、`waived` 缺三字段）。

生产默认实现即第 4 条的静态版本：不做任何判定，固定返回 `incomplete + ['gate_engine_unavailable']`。这条默认值本身就是"未实施"的显式表达，不得被解释为暂时放行。

### 14.6 `GateRecheck` 对接形状

- 调用点：调度 tick 第 2 步（§5.9）。调用前由调度器在**同一只读事务/同一快照**内装载 §14.2 输入；调用内不再自行跨表多次读库。
- 输出契约（类型声明，不含实现）：

```text
GateRecheckResult {
  gateStatus: 'pass' | 'incomplete' | 'waived'
  missing: string[]              // pass 时必须为空；incomplete 时至少 1 条
  waiver: { waivedBy, waivedAt, waiveReason } | null   // 仅 waived 时非空，且三字段齐全
  evaluatorVersion: string       // 归因用；配置/规则变更必须变版本
  evaluatedAt: number
}
```

- 调度器对结果的处置：

| 结果 | tick 动作 | 库写入 |
|---|---|---|
| `pass` | 继续第 3 步（依赖校验） | `gate_status='pass'`，`gate_missing_json=NULL` |
| `waived` | 视同通过继续 | `waived` + 三字段 |
| `incomplete` | 不 claim、不建 run；`queued → blocked` | `gate_status='incomplete'` + `gate_missing_json=missing` |
| 抛异常/超时/未知返回 | 与生产默认实现同路径 | 同上，missing 至少含 `gate_engine_unavailable` |

- 评估器返回 `waived` 时，调度器仍须校验三字段与"仅 G2 manual 可豁免"；不合法则改判 `incomplete`（沿用 `setGateResult` 现有守卫）。
- 幂等性要求：同一 `item.id + revision + evaluatorVersion + 快照` 应得到相同结论；评估本身不产生 run、不递增 attempt。
- 可观测性：拒绝原因只进 `gate_missing_json` 代码与结构化日志/事件；不把自由文本塞进 `gate_missing_json`，避免下游按字符串数组解析崩坏。

### 14.7 与现有代码/状态机的衔接点（仅指认，不改文件）

- `WorkItemService.setGateResult`：已实现三态与 waived 三字段守卫，可作为落库唯一入口（`src/main/map/work-item-service.ts`）。
- `WorkItemService.markBlocked`：已实现 `incomplete + missing[]` 与 `queued → blocked`，tick 失败分支可复用。
- `WorkScheduler`：tick 第 2 步目前只复核已落库值，且第 116 行对非 `pass/waived` 抛 `GATE_NOT_PASSED`；这是"引擎未实现"的临时形态，`GateRecheck` 接入后应替换为"先评估、再按结果转移"。
- `unblock`：目前只保证"不是 incomplete"，不保证"刚刚重跑过"；规格要求 blocked → queued 必须触发一次真实评估（§4.7.2）。
- `work_items.gate_missing_json` 已是字符串数组，保持形状兼容，避免为了 gate 规格改表。

### 14.8 裁决记录（D1–D14 已全部裁决，2026-11-07）

> 裁决来源：D1–D14 推荐值表于 2026-11-07 获用户**整批采纳**（「按此方案推进」）。状态词按 §0 三态口径：裁决与现有引擎行为一致且代码已存在 → **已批准已实施**；裁决定义契约但执行侧组件尚未存在 → **已批准未实施**；裁决为「不做」→ 终态裁决。

| 编号 | 裁决 | 状态 | 关联 |
|---|---|---|---|
| D1 | acceptance 冻结为 `{id,type,expected,text?}`；`createDraft` / `revise` 在系统边界强制结构化（缺 type/expected 或未知 type 拒绝，不静默降级）；**存量不自动迁移**，人工重新确认计划前保持 `blocked` | 已批准已实施（`e4398e7`） | §5.4 G2、`work-item-service` |
| D2 | `expected` 判定语义：`command` = 退出码 0（可选用 `stdout_contains` 匹配标准输出、`timeout_ms` 限制超时）；`file_check` = 相对 `project_path` 的路径存在性（可选用 `content_contains` 匹配文件内容）；`manual` = `expected` 为人工判定描述（非空字符串），由人确认。**确定性验收执行器已实施（2026-11-08）**：`acceptance-executor.ts` 只读评估，`agent-step-runner` 在 turn `completed` 后、terminate 之后调用；**非 manual 硬失败或执行器异常 → `verify_fail`（fail-closed）；仅 manual 待确认 → 步/item `needs_input`、run `completed`，待确认条目写入 `input_request_json`**。`BIZGRAPH_MAP_EXECUTION` 仍默认关闭。人工确认入口见 §M5.11；内容哈希匹配仍属后续 | 已批准已实施（`acceptance-executor.ts`，2026-11-08） | §5.4 G2、`agent-step-runner` |
| D3 | G2 豁免为**整条任务粒度**：仅当全部缺失码来自 G2 且失败条目全为 `manual` 时三字段豁免成立；manual 豁免不得覆盖 command/file_check 失败 | 已批准已实施（`b6f3735`） | §5.4、§4.7.3 |
| D4 | `project_path` 为空 → 直接 fail-closed（`project_path_missing`），不从图/项目根兜底 | 已批准已实施（`b6f3735`） | §5.4.1 |
| D5 | 「跨图写」采纳收敛口径：本期准入只判锚点存在 + `graph_type='dev'` + `graph_id` 一致；`node_links` 链接矩阵不入本期准入——写入面仅 `scope_files` 且已被 G1 限定在单一项目根内，跨图写在现有字段上不可表达。**若未来出现跨图写入面（如允许改 test 图资产），必须新增 gate 或扩展 G3 并重新裁决，不得静默放宽** | 已批准已实施（`b6f3735`） | §1.2、§2.3、§5.4 G3 |
| D6 | 准入一律要求 dev 锚点；test 图锚点任务不设准入特例（fail-closed `anchor_node_not_dev`）；test 只读派生留待未来能力出现时再议 | 已批准已实施（`b6f3735`） | §5.4 G3 |
| D7 | G4 预估行数 = Σ scope 文件行数的**过渡代理指标，不是变更行数**：已存在文件按实际行数、新建文件计 0、目录/读取失败 fail-closed；阈值 env `BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES` / `_LINES`（默认 20/800，非法回退） | 已批准已实施（`e4398e7`） | §5.4 G4、§7.2 |
| D8 | G5 只看 `depends_on_json` 显式声明，隐式依赖不入闭包（由计划确认阶段落成显式）；上游 `superseded` 按非当前 revision 判 `dep_revision_stale`（不自动代替）；`cancelled/failed/blocked` 等非 `done` → `dep_not_done`；「显式标 blocked 并给出依赖 id」= 失败分支（不放行、写缺失码、转 `blocked`） | 已批准已实施（`b6f3735`） | §5.4 G5、§5.5.1 |
| D9 | G5/G6 **不允许**人工豁免（本期）；失败只能修数据（依赖完成 / scope 调整）后重跑评估 | 已批准已实施（`b6f3735`） | §5.4 |
| D10 | G6 只比较同 `project_path` 且 `status='running' AND is_current=1` 的任务；不排除同 lineage 父/子（单 turn 串行 + 写闸在先，窗口极小；**放开并行编排必须重裁**）；`queued` 不纳入冲突面；跨项目不比较 | 已批准已实施（`b6f3735`） | §5.4 G6、§5.9 |
| D11 | `gate_missing_json` 冻结为当前引擎产出的稳定码集，形状保持字符串数组；**新增码只追加、不得改名**；UI 对未知码按「未知原因」兜底展示 | 已批准已实施（`b6f3735`，契约冻结） | §4.7.3、`setGateResult` |
| D12 | 评估器版本 / G4 阈值快照**本期不落库**；归因靠引擎所在 git commit + 现有事件日志。未来需要精确归因再走 schema 变更流程（蓝图 `observed_rule_version` 思路保留为候选） | **2026-11-08 修订为已实施**：改为每次评估落逐道诊断（复用 `map_migration_reports`，无 schema 变更，见 M5.14） | §5.7 |
| D13 | 证据 stale/缺失**不参与**准入（维持 §3 / §5.4 分层）；产品如需该策略，新增独立 gate 或策略，不塞进 G1–G6 | 已批准已实施（负向口径，`b6f3735`） | §3、§5.4 |
| D14 | `GateRecheck` 本期**不设时限预算**：引擎全同步（better-sqlite3 同步 API），无异步超时面；评估器抛异常由 tick 按 `gate_engine_unavailable` fail-closed 收口（已实现）。**未来引入异步评估器必须带预算 + 超时 fail-closed** | 已批准已实施（含未来约束，`b6f3735`） | §5.9 |

### 14.9 建议的验收断言（实施时使用）

以下只描述断言，不写实现：

1. 每条 gate 至少一组正例与一组反例；反例断言 `gate_status='incomplete'` 且 `gate_missing_json` 含对应代码，并且**没有创建 run、`attempt` 未变**。
2. G1/G6 各补一组符号链接与 NFC/大小写样本（§5.4.1 第 1–4 条），断言使用点重新规范化后比较。
3. G2 补 `manual` 豁免：三字段齐全 → `waived`；缺任一 → `incomplete`；G1/G3/G4 即使人工豁免也仍 `incomplete`。
4. G3 补锚点缺失、锚点非 dev、跨图链接三种反例。
5. G5 补依赖缺失、依赖非 `done`、环三种反例；`superseded` 判 `dep_revision_stale`（D8 已裁决）；隐式依赖不入闭包（D8，无需样本）。
6. G6 补同路径冲突与"路径写法不同但规范化后相同"两种冲突样本，断言只作为准入快照、不写写闸状态。
7. 注入生产默认 `GateRecheck`：所有任务均为 `incomplete + ['gate_engine_unavailable']`，tick 不 claim、不建 run。
8. 注入抛异常/超时的评估器：结果与第 7 条一致（fail-closed）。
9. 评估前后对 `work_items / work_steps / work_runs / node_evidence` 做快照对比，断言评估器自身零写入。
10. 同一输入重复评估两次，断言 `gateStatus` 与 `missing` 完全一致。

### 14.10 依据索引

- §5.4（G1–G6 条件表、豁免限制、不进队列）
- §5.4.1（路径规范化：realpath / NFC / 分隔符 / 大小写折叠 / 根内校验 / A9）
- §4.7.2（`awaiting_confirm → queued`、`queued → blocked`、`blocked → queued` 的 gate 守卫）
- §4.7.3（gate 三态、`gate_missing_json`、waived 三字段、`blocked → queued` 必须重跑）
- §5.5.1（环检测、依赖优先级、父任务聚合）
- §5.9「调度 tick」第 2、5 步（重跑 gate、写闸）
- §5.9.9（`enqueue` / `resumeWorkItem` 的 `GATE_INCOMPLETE` 与 `claimNext` 的 `GATE_REVOKED`）
- §7.2 `work_items` / `work_steps` / `work_runs` 字段（`scope_files`、`acceptance_json`、`depends_on_json`、`anchor_node_id`、`gate_*`、`status`）
- §1.2 / §2.3（`entity_key` 与 `node_links`；跨图只走链接、不建跨图 edge）
- §3、§3.7（证据等级与写入权；用于说明证据为何不作为准入输入）
- 现有代码：`src/main/map/work-item-service.ts`（`setGateResult` / `markBlocked` / `unblock`）、`src/main/map/work-scheduler.ts`（tick gate 复核现状）、`src/main/ipc/map.ts`、`src/main/map/agent-step-runner.ts`（acceptance 现有用法）

## §M5 执行触发段实施记录

> 本小节只记录 L2「执行触发」段的实施事实与已知偏离；其他章节的规格含义未改动。
> 状态词严格区分「已实施 / 已批准未实施 / 仅建议」。

### M5.1 状态总览

- **已实施**：主进程单实例异步 tick（§5.9.9 六步骨架）、`GateRecheck` 可插拔端口、G1–G6 准入 gate 评估引擎（§14 草案的实现子集 + §14.8 各待决项的 fail-closed 默认，见 M5.7）、孤儿回收（`running → queued`，不计 `attempt`）、`workitem:step:run`（只入队）与 `workitem:run:cancel`（条件更新 + 执行器真结束会话）。
- **已批准未实施**：§14.8 其余待决项（D2、D4–D6、D8、D10–D14）。
- **仅建议（本段未实施）**：Tier 1 自动路由探测（当前只接受 pinned adapter）、跨进程项目写闸（当前只有进程内单 turn 守卫）、renderer 执行入口 UI（归另一条线）。

**重要事实（M5.8 后更新）**：D1/D7 已裁决并实施——acceptance 结构化条目 + scope 指向已存在文件的任务，G1–G6 可全绿并真实进入执行；存量自由文本 acceptance 任务仍被 G2 挡在 `blocked`（D1 不自动迁移的显式代价），直到人工重新确认计划。

### M5.2 tick 六步映射

1. **取候选**：`work_items.status IN ('queued','running')`，`queued` 优先，`created_at ASC`；`work_items` 无 `priority` 列，故未实现蓝图中的 `priority DESC`（已知偏离）。
2. **重跑 gate**：每轮调用 `GateRecheck.recheck(item)`（生产 = G1–G6 引擎），不读取/不信任 `work_items.gate_status`；不通过时 `queued → blocked` 并写 `gate_missing_json`，running item 仅落 gate 失效（不改状态机）。评估器抛异常按 §14.6 与不可用同路径收口（`gate_engine_unavailable`）。重跑通过但库中仍是 `incomplete` 时，把重跑结论落为 `pass`；结论为「人工豁免视同通过」（仅 G2 manual 条目 + 三字段齐全）时保留库内 `waived` 三字段，不改写为 `pass`。
3. **依赖校验**：先 `blockUnstartedDependents`，再用 `peekNextReadyStep`（只读）选第一个就绪步；无就绪步且全部终态时触发 item 收敛。
4. **路由**：只接受 pinned adapter（`BIZGRAPH_MAP_EXECUTION_ADAPTER` 或写入时传入），并做 kernel/审批/驱动三项探测；不满足时保持 `queued`、发 `routing_failed` 事件、不建 run。
5. **写闸**：进程内 `inflightRunId` 守卫，同一时刻只允许一个 turn；busy 时本轮跳过，不写 run、不加 attempt。跨进程写闸属「仅建议」。
6. **claim → 执行**：`startStep`（幂等复用 queued run）→ `AgentStepRunner.run` → 终态 → `blockUnstartedDependents` + `convergeIfTerminal`。执行器异常且 run 未落终态时按 `infra` 兜底收口，确保 tick 内不留 `running` 孤儿。

每轮 tick 开始前执行孤儿回收：`work_runs.status='running' AND work_steps.status='pending'` → `running → queued`（条件更新，`attempt` 不变）。

### M5.3 写通道与开关

- 开关：`BIZGRAPH_MAP_EXECUTION`（显式 truthy 才开启，默认关闭）。关闭时 `workitem:step:run` / `workitem:run:cancel` 仍然存在，但 `WorkExecutionError('EXECUTION_DISABLED')` 明确拒绝，不静默降级。
- `workitem:step:run`：只做 `scheduler.enqueueStep`（建/复用 `queued` run），**不在 IPC handler 内联跑 turn**。
- `workitem:run:cancel`：`work_runs.cancel` 条件更新；若该 run 正在本进程执行，先 `terminateSession` 结束会话（真取消），再由 tick 按终态收敛；完成与取消竞态时失败方保留既有事实。下游未开始的依赖步落 `cancelled`（非 blocked），item 按 §5.5.1 收敛。
- 只读白名单：两个写通道均不在 `MAP_READ_ONLY_CHANNELS` 中；`map-read-ipc.test.ts` 同时断言「白名单不含写通道」与「写通道不在白名单」两个方向。

### M5.4 硬约束落实情况

| 约束 | 落实 |
| --- | --- |
| 只走 kernel-only 发送 | `AgentManagerTurnRunner` 仅调用 `sendCommandKernelOnly`；执行服务不持有 legacy 发送入口 |
| 审批经网关、不可用即 fail-closed | 开跑前探测 `kernel`/`runtime`/`driver`，任一不满足拒绝；`degraded`（UNSAFE 免审）视为不可编排 |
| 写通道默认关闭 | `BIZGRAPH_MAP_EXECUTION` 未开启时明确拒绝 |
| 写通道与只读白名单互斥 | 双向断言（见 M5.3） |
| 单进程串行、不加 schema 版本 | 无新迁移；沿用 v34；tick 为单实例串行 |

### M5.5 验证

- 新增 `src/main/__tests__/work-execution.test.ts`：12 个用例，覆盖 gate 重跑、默认 fail-closed、引擎抛异常收口、豁免视同通过且保留三字段、正常链路、孤儿回收、五类写通道拒绝、只入队、in-flight/queued 取消收敛、kernel-only 结构断言。
- 新增 `src/main/__tests__/gate-engine.test.ts`：53 个用例（§14.9 实现子集，见 M5.7）。
- `map-read-ipc.test.ts` 扩展写通道清单。
- 全量：`310` 个测试文件、`3815` 通过、`3` 跳过、`0` 失败（连续两轮全绿；首轮有一例与本段改动无关的偶发失败，未再复现）。`tsc --noEmit` 干净。
- 已知环境事实：本机 `node_modules/better-sqlite3` 默认按 Electron ABI 构建；跑 vitest 需临时按 Node 20 重建绑定，验证后已恢复为 Electron 绑定（sha256 校验一致）。

### M5.6 遗留风险

1. 存量自由文本 acceptance 任务不可执行（D1 不自动迁移的显式代价）：G2 判 `acceptance_item_not_structured`，需人工重新确认计划结构化后入队。scope 指向目录的任务被 G4 判 `line_estimate_unavailable`（fail-closed）。
2. 路由未实现 Tier 1 探测；pinned adapter 缺失时 run 不会被 claim。
3. 跨进程项目写闸未实现，只有进程内单 turn 守卫。
4. renderer 执行入口与运行态展示未接入（面板归另一条线）。

### M5.7 G1–G6 gate 引擎实施记录（2026-11-07）

**已实施**（`src/main/map/gate-engine.ts` + `src/main/map/gate-recheck.ts` 端口扩展；生产装配在 `work-execution-runtime.ts`）：

- 判定范围：G1（scope 非空且经 §5.4.1 realpath/NFC/大小折叠管线校验在项目根内）、G2（≥1 条 `{type ∈ command|manual|file_check, expected 非空}` 结构化条目）、G3 可判定子集（锚点存在 + `graph_type='dev'` + `graph_id` 一致）、G4（去重后文件数与预估行数上限，默认 20/800）、G5（`depends_on_json` 传递闭包全 `done` + 当前 revision + 无环）、G6（与 `running AND is_current` 任务 scope 规范化后无交集）。
- 豁免（§14.6/§14.9-3）：仅当全部缺失码来自 G2 且失败条目均为 `manual` 类型、三字段（`gate_waived_by/at/reason`）齐全时判 `waived` 视同通过；G1/G3/G4 不可豁免（§5.4），G5/G6 不可豁免（D9 已裁决）；manual 豁免不覆盖 command/file_check 失败（D3 已裁决：任务级粒度）。tick 对 waived 结论保留库内三字段，不改写为 `pass`。
- fail-closed（§14.5）：JSON 解析失败/查询异常/非 POSIX 根/阈值非法/预估来源缺失一律 `incomplete` + 具体缺失码；评估器抛异常由 tick 按 `gate_engine_unavailable` 同路径收口。
- 只读与幂等：recheck 全程同步读（better-sqlite3 单线程，一次调用等价同一时点快照），不写四张表（测试做前后快照对比）；同输入两次评估结果一致。
- 测试：`gate-engine.test.ts` 全量用例（含 `94125bd` 新增的 G6+豁免反向断言）+ `work-execution.test.ts` 12 用例，覆盖 §14.9 断言 1–10 的实现子集（含 symlink 逃逸、NFC、darwin 大小写折叠、`./` 前缀规范化等价、零写入、幂等、生产默认注入、抛异常注入）。

**采纳说明**：引擎最初来自另一条线留下的未跟踪实现；本次经逐条对照 §14 复核后采纳，并修正/补齐三处——G2 的 pass 语义（有结构化条目即通过，坏补充条目不再判 incomplete）、G4 按去重后文件数计数（§5.4）、豁免判定与 tick 的异常/waived 处理。

**与 §14.6 建议形状的已知偏离**：`GateRecheckResult` 沿用 M5 已落地的 `{ ok, missing, waived? }`，未采用草案建议的 `gateStatus/evaluatorVersion/evaluatedAt` 完整形状；D12 已裁决本期不落库（评估器归因靠引擎所在提交 hash）。→ **2026-11-08 修订**：D12 改为落可查诊断（见 M5.14），`GateRecheckResult` 追加可选 `diagnostics`（逐道 + 评估器版本 + 阈值快照），准入字段不变。

**已裁决并实施的行为**：D5/D6（G3 跨图写）已裁决为收敛口径——本期只判锚点存在 + `graph_type='dev'` + `graph_id` 一致，跨图写矩阵不建模（§14.8）；D1/D7 见 M5.8；D3/D9 见 M5.9。

### M5.8 D1/D7 裁决实施记录（2026-11-07，已批准已实施）

**D1（acceptance 结构化格式与迁移）**：
- 格式冻结为 `{ id, type: 'command'|'manual'|'file_check', expected 非空, text? }`；判定只看 `type + expected`，`text` 是人读补充（`work-item-service.ts` 导出 `StructuredAcceptanceEntry`/`normalizeAcceptanceInput`/`normalizeAcceptanceJson`）。
- 写入路径同批收紧：`createDraft` 与 `revise` 在系统边界强制结构化，缺 `type`/`expected`、未知 type、非数组/非法 JSON 一律 `WorkItemGuardError` 拒绝，不静默降级；IPC `workitem:create`/`workitem:revise` 传入的数组经同一校验（服务边界覆盖）。
- 存量 `[{id,text}]` **不自动迁移**：仍判 G2 incomplete（`acceptance_item_not_structured`），由人工重新确认计划时结构化（复用 `awaiting_confirm → queued` gate 守卫）。显式代价：存量任务重新确认前保持 `blocked`。
- 执行面：`agent-step-runner` 的步骤提示词与会话 `acceptance` 按结构化条目渲染为 `- [type] expected（text）`；无法识别的形状防御性跳过，不猜语义。

**D7（G4 预估行数来源）**：
- 算法定为确定性代理：`estimateLines = Σ scope 文件行数`——已存在文件按实际行数（mtime+size 缓存），将新建的文件计 0（新建规模由 G4 文件数上限约束）；scope 指向目录或读取失败 → null → 引擎 `line_estimate_unavailable`（fail-closed）。
- 配置：`BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES` / `BIZGRAPH_MAP_EXECUTION_G4_MAX_LINES`，默认 20/800；非法 env 值回退默认并告警。
- 落点：仅生产装配处（`work-execution-runtime.ts` 导出 `readG4Config`/`buildEstimateLines`）；引擎不改。写明定位：这是**准入代理指标**，真实改动行数由执行后 evidence 对比（超限属执行后审计，不归准入）。

**裁决后的可达性事实**：结构化 acceptance + scope 指向已存在文件的任务，G1–G6 可全绿并通过 tick claim 进入 kernel-only 执行；存量自由文本任务与 scope 指向目录的任务仍按上表 fail-closed。

**测试**：`work-item-service.test.ts` +4（结构化落库/旧格式拒绝/缺 expected/revise 校验）、`work-execution-runtime.test.ts` 新增（env 阈值、Σ 行数、目录 fail-closed、缓存）、`agent-step-runner.test.ts` 断言结构化渲染。

### M5.9 D3/D9 裁决实施记录（2026-11-07，已批准已实施）

**D3（G2 豁免粒度）**：裁决为**任务级粒度**——豁免即现有三字段（`gate_waived_by/at/reason`），作用于整条任务，不引入逐条目豁免（逐条目需新增豁免字段，与「不加 schema 版本」硬约束冲突，明确排除）。生效条件维持「全部缺失码来自 G2、且每个失败条目 type 均为 manual」；**混合 manual+command 时豁免不生效**——command 条目缺 `expected` 属于该补的判定标准，正确路径是人工 `revise` 补全（补全后 G2 自然通过）或改标 manual，豁免只留给「只能人判」的任务形态。

**D9（G5/G6 可豁免性）**：裁决为**永久不可豁免**，三字段豁免对这两道 gate 永不生效，也不为其增加豁免审计字段（不存在合法豁免路径）。理由：G5 放行即允许乱序执行，与 §1.6「未过准入不得入队」及串行语义冲突（正常路径：等上游 done / cancel 上游 / revise 改 `depends_on`）；G6 放行等于在准入时放过已知写冲突，真互斥在 tick 第 5 步写闸，放行只是把冲突推迟到运行期（正常路径：先 `workitem:run:cancel` running 任务，自带 run 级审计）。

**行为变化**：无——两项裁决均确认引擎现状行为，本次仅更新状态词与断言：`gate-engine.ts` 文件头措辞从「D9 裁决前/D3 保守读法」改为「已裁决」；`gate-engine.test.ts` 测试名对齐并**新增 G6+豁免 → incomplete 断言**（此前只有 G5+豁免，G6 无豁免反向断言）。

**边界**：§14.8 表中 D3/D9 行的状态词已在 2026-11-08 单轨收口时更新（文件所有权合并，见文末「单轨分工与文件所有权」）。

### M5.10 D2 裁决实施记录（2026-11-08，已批准已实施）

**范围（最小闭环）**：`src/main/map/acceptance-executor.ts` 只读评估结构化 acceptance。

- `command`：成功判退出码 0；可选 `stdout_contains`（标准输出包含）与 `timeout_ms`（默认 120s，上限 600s）；超时、非 0 退出、启动失败均不通过。
- `file_check`：`expected` 必须是相对路径且经 `isPathInside` 校验落在 `project_path` 内；存在且为普通文件才通过；可选 `content_contains`（UTF-8 内容包含）。
- `manual`：不自动通过，只产出 `acceptance_manual_pending:<i>`；**仅 manual 待确认（其余条目全部通过）时，步落 `needs_input`，run 仍 `completed`，不判负**。待确认条目 id/expected/text 写入 `work_steps.input_request_json`（`kind='acceptance_manual_confirm'`），item 同事务迁到 `needs_input`。
- 非法/空 JSON、存量 `[{id,text}]`、未知 type、`expected` 缺失、manual 缺 id、`project_path` 缺失/不可解析/非目录，一律 `ok=false` 并带具体缺失码。

**接线**：`AgentStepRunner.run` 在 turn `completed` 且 session terminate 之后调用 `verifyAcceptance`：存在非 manual 硬失败 → `run/step failed(verify_fail)`（异常 reason `ACCEPTANCE_VERIFIER_ERROR`）；仅 manual 待确认 → step/item `needs_input`、run `completed`；全部通过 → `succeeded`。`turnStatus` 始终记 `completed`。`WorkExecutionService` 透传，`work-execution-runtime` 装配 `evaluateAcceptance`。`BIZGRAPH_MAP_EXECUTION` 仍默认关闭。

**测试**：`acceptance-executor.test.ts` 20 例（退出码/stdout/超时/启动失败/路径存在与内容/绝对路径与逃逸/目录/不可读/非法 JSON/存量形状/manual 待确认与缺 id/已确认视为通过/混合）；`agent-step-runner.test.ts` 19 例（含通过、硬失败、manual 等待、等待不掩盖硬失败、执行器异常、非 completed 不触发）。相关主测试文件 112 例全绿（含 §M5.11 的 5 例），`tsc --noEmit` 0 error。

**边界**：内容哈希匹配、异步评估时限预算（D14 未来约束）不在本期；`manual` 的人工确认入口已由 §M5.11 补齐。

### M5.11 manual 验收人工确认入口（2026-11-08，已实施）

**写通道**：`workitem:acceptance:confirm`（`ipc/map.ts` → preload 白名单 → `IpcApi` → 面板按钮）。入参 `stepId` 或 `workItemId`（至少一个）+ `entryIds[]`，支持部分确认。

**确认事实存储**：v35 起写入独立表 `acceptance_confirmations`（每条目一行，`batch_id` 分组；字段见 §M5.12）。`9852b77` 曾复用 `agent_approvals`（`tool_name='acceptance_manual_confirm'`）的做法**已废止**——`agent_approvals` 只承载工具调用审批，不得出现从未调用过工具的放行记录。

**重算与收口**：`AcceptanceConfirmationService.confirm` 读 `input_request_json` 校验条目归属，把历史 + 本次确认的 manual id 传给 `evaluateAcceptance` 视为通过：

- 存在非 manual 硬失败 → item `needs_input` → `queued`，step `failed(verify_fail)`，再收敛 item；
- 仍有未确认 manual → 仅更新 `input_request_json`，step/item 保持 `needs_input`；
- 全部通过 → step `succeeded`，item 收敛（全部步终态则 done）。

**显式偏差**（§4.7.4）：manual 确认不新开 attempt、不重跑 agent——原 turn 已完成，人工只补验收事实；“补充信息后重跑”的原 needs_input→pending 路径仍保留，二者不混用。并发确认由 `input_request_json` 版本比对守卫（`STEP_STATE_CHANGED`），重复确认只允许一次。

**面板**：`NodeMapPanel` 在 `needs_input` 步下渲染待确认条目与“确认”按钮（`workitem:acceptance:confirm`），这是面板的唯一写操作；其余仍只读。

**测试**：`acceptance-confirmation.test.ts` 5 例（确认通过、部分确认继续等待、确认后硬失败、仅 itemId 定位、未知条目/重复确认）。

### M5.12 验收确认事实独立建表（v35，2026-11-08，已实施）

**动机**：`9852b77` 把人工验收确认写成 `agent_approvals` 行（`tool_name='acceptance_manual_confirm'`、直接 `status='allowed'`），绕过了 `ApprovalGateway`。后果是“哪些工具调用被放行”的审计里出现从未调用过工具的记录，语义被混。

**语义边界**：`agent_approvals` 只承载**一次工具调用的审批**（`subject_type='agent_turn'|'test_plan'`，`tool_name` 必须对应真实工具）。人工验收确认不是工具审批，不得写入该表。

**新表** `acceptance_confirmations`（schema v35）：

| 列 | 含义 |
|---|---|
| `id` | 事实行 id |
| `batch_id` | 一次确认调用分组（`acb_*`；历史迁移为 `legacy:<approvalId>`） |
| `work_item_id` / `step_id` | 所属任务与等待步 |
| `entry_id` | 被确认的验收条目 id（每行一个） |
| `decided_by` / `decided_at` | 谁在什么时候确认 |
| `decision_note` | 可选备注 |
| `source` | `user`（新写入）或 `legacy_agent_approval`（迁移来源） |
| `legacy_approval_id` | 迁移前 `agent_approvals.id`（可追溯，迁移不静默删） |
| `created_at` | 写入时间 |

唯一索引 `ux_acceptance_confirmations_entry(work_item_id, step_id, entry_id)` 保证同一步同一入口只确认一次；部分确认重试仍由 `STEP_NOT_WAITING` 挡住。

**迁移（v34→v35）**：新建表；`runIncrementalMigrations` 扫描 `agent_approvals.tool_name='acceptance_manual_confirm'` 的行，按 `args_json.entryIds` 逐条搬入新表后删除旧行。解析不了（缺 `step_id`/`subject_id`/`entryIds`）的历史行**保留并告警**，不静默丢失。实库核查（2026-11-08）：历史行 **0 条**。

**读取路径**：`listConfirmedEntryIds(stepId)` 改为查 `acceptance_confirmations.entry_id`；重复确认、批次确认、半批确认行为不变。

**测试**：迁移用例覆盖新表建成、旧行迁入且 `legacy_approval_id` 可追溯、信息不全行保留、非验收审批行原样保留、无 `_backup` 残留、`version=35`；确认用例断言 `agent_approvals` 不再出现验收行。

### M5.13 全局审批入口（方案一，2026-11-08，已实施）

**动机**：`ApprovalRequestDialog` 只挂在 `AgentChatPanel` 的「`currentThread` 存在」分支。编排 runtime 的 kernel turn 由主进程发起，不在 renderer 建线程，审批请求虽已广播到 renderer（`pending=1`），却没有任何组件挂载，最终 120s 交互超时 fail-closed 落 `denied`。真机演练据此断在「工具调用审批真的弹了」这一环。

**形态**：应用级 `ApprovalInbox`（固定于窗口右上、任何页面可见，可折叠，显示条数徽标）。展开后逐条展示：工具名、风险等级、命令/参数原文、来源三元组（任务 `workItemId` / 步骤 `stepId` / 会话 `sessionId`）、剩余秒数，并提供 allow(once) / deny。

**单一事实源**：新增渲染端 `approvalStore`，由 `attachApprovalListener()`（`App` 启动时挂一次）负责 `hydrate`（`agent:getPendingApprovals`）+ `onApprovalRequest` 增量 + `onApprovalResolved` 移除。聊天内弹窗改为投影同一 store，不再自持队列；聊天场景行为（倒计时、陈旧审批 `APPROVAL_STALE` 横幅、会话授权按钮、脱敏提示）保持不变。

**不重复网关语义**：120s 交互超时、deadline 冻结、归属校验（`sessionId/turnId`）、`argsHash` 防 TOCTOU 全部仍在主进程 `ApprovalGateway`；队列里的倒计时只是展示，决议仍走 `agent:resolveApproval`。

**来源字段**：`ApprovalRequestPayload` 新增可选 `workItemId`（由 `agent_approvals.step_id` 反查 `work_steps.work_item_id`，只读、查不到即不展示），仅用于展示，不参与判定。

**测试**：`ApprovalInbox.test.tsx` 3 例（无 pending 不渲染、编排 turn 审批可见工具名/命令/来源、允许后队列即时减少且归属字段回传）；`ApprovalRequestDialog.test.tsx` 8 例保持全绿。

### M5.14 gate 逐道诊断（D12 修订，2026-11-08，已实施）

**动机**：tick 第 2 步每次都会重跑 G1–G6，但库里只留最终 `gate_status` + 聚合 `gate_missing_json`。排查者无法回答「gates 第 3 道为什么没过」——尤其 G2 豁免通过时（整体 ok 但 G2 实际失败）现场完全丢失。

**职责边界**：`gate-engine.ts` 保持**只读纯引擎**（仍不写任何表，零写入测试不变），只把逐道结果作为返回值附加：`GateRecheckResult.diagnostics = { evaluatorVersion, thresholds, gates[] }`，`gates` 恒为 G1..G6 六项，每项 `{ gate, ok, missing[] }`。落库由 tick 调用方完成。

**载体（无 schema 变更）**：复用既有报告表 `map_migration_reports`（§8.14.1 本身即「所有阶段记录复用本表」）：
- `kind='integrity_check'`（G1–G6 是准入完整性判定，取语义最近的既有枚举值）；
- `stage='gate_eval:<workItemId>'`：按任务分组，保留最近 20 次评估；启动预检只关心 `failed/running/partial`，本模块只写 `status='ok'` 且为单条插入，不产生 running 行，因此不影响迁移与 preflight；
- `stats_json`：`verdict`（pass / waived / incomplete）、`missing_count`、`evaluator_version`（`gate-engine@1`，语义变化须同步更新）、`thresholds`（G4 实际取值）、`engine_error`；
- `details_json`：`gate_status_before`、逐道 `gates`、聚合 `missing`、`waived`。

**纯诊断**：不写 `work_items/work_steps/work_runs/node_evidence`，不进入用户可见状态；写失败仅 `logger.warn`，绝不阻断 tick（`recordGateEvaluation` 内部兜底，表缺失即跳过）。

**排查查法**：

```sql
SELECT started_at, stats_json, details_json
FROM map_migration_reports
WHERE kind = 'integrity_check' AND stage = 'gate_eval:<workItemId>'
ORDER BY started_at DESC, id DESC
LIMIT 1;
```

`details_json.gates` 里找 `gate='G3'` 的 `ok/missing` 即可定位；`stats_json.evaluator_version` + `thresholds` 用于复算归因。

**测试**：`gate-engine.test.ts` 新增 3 例（六道齐全 + 失败道定位、阈值快照随参数、豁免时保留 G2 失败现场）；`work-execution.test.ts` 新增 2 例（blocked 时六道写入且用户可见状态不受影响、引擎异常留行并标注 `engine_error`）。两文件 73 例全绿。

## 单轨分工与文件所有权（2026-11-08）

> 用户裁决：只保留**蓝图/编排线**单轨继续；其余三条线冻结。状态词按 §0 三态口径。

### 冻结线

| 线 | 状态 | 依据与收尾 |
|---|---|---|
| L2 审查修复 | **已实施，冻结** | P0 3/3（`2ce268b`）；P1 8/8 有对应修复提交（`88ab019`/`6e472de`/`c7a04a9`/`f65935d`/`9493fde`/`d8ace71`/`b53b82c`/`13321fc`）；P2 8 项中 4 项可核对（`1fd91fe`/`ed22fd8`/`f2f2882`/`dcf5af2`），其余 4 项需取回原始审查清单、按复现决定，本轮不改代码 |
| 启动与退出诊断 | **已实施，冻结** | `9b220ab`/`6e472de`/`4eb95b5`/`c7a04a9`/`13321fc`/`d8ace71`；无已知挂账 |
| L2 执行触发 | **已实施，冻结** | `7d9ef7e`（tick/写通道）、`b6f3735`（G1–G6）、`e4398e7`（D1/D7）、`94125bd`（D3/D9）；D2 原为已批准未实施，2026-11-08 由本单轨实施（`acceptance-executor.ts`） |

### 文件所有权（自 2026-11-08 起统一）

`src/main/map/gate-engine.ts`、`gate-recheck.ts`、`work-execution-service.ts`、`work-execution-runtime.ts`、`work-scheduler.ts`、`agent-step-runner.ts`、`execution-flags.ts`、`src/main/ipc/map.ts` 及对应测试，归蓝图/编排线。冻结线不再修改这些文件；发现并行改动时先停下报告。

### 三态总账

- **已实施**：S1–S8、L1、M1–M5、G1–G6、D1/D2/D3/D4/D5/D6/D7/D8/D9/D10/D11/D13/D14。
- **已批准未实施**：无。
- **仅建议**：未来跨图写入面出现时的 G3 扩展、异步评估器的时限预算与版本精确归因（D12 已裁决本期不做）。
