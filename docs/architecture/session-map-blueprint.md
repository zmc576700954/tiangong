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

本文不重复解释审批网关、驱动能力矩阵、会话恢复；需要时直接引用既有章节。

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

- `work_items`（可嵌套、带 revision）+ `work_runs` + `node_session_links`。
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
- 单 Agent 路由（按能力矩阵选一个 adapter）
- 节点会话时间线
- 顺序多步执行
- 节点级测试执行与结果回写

不做：

- 流程级 DAG 并行
- 并行写同一节点
- 自动 merge
- 全自动 planner（无人工确认的计划不执行）
- 多 Agent 并行编排

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
| 图快照恢复 / Yjs 重建 | 不得重算键；键只由 SQLite 权威列提供 |

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

### 2.3 `node_links` 设计要点

| 设计选择 | 理由 |
|---|---|
| 存 `entity_key` 而不是 node id | node id 在克隆/删除/重建后会变；键不会 |
| 不建到 `nodes` 的外键 | 外键会让"节点归档/图删除"直接抹掉关系历史；损坏应表现为 `status='orphan'` 而不是静默消失 |
| `node_id` 冗余保留 | 常用查询走 id 快路径；解析失败再回落到键 |
| `link_type` 固定枚举 | 防止自由文本导致语义漂移 |
| `UNIQUE(from_entity_key, to_entity_key, link_type)` | 同一语义的关系只允许一条 |

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

#### 数据结构

三张表的 DDL 见 **§7.2**（`project_fingerprints` / `import_rejections` / `import_allowances`），此处不重复，避免两处定义漂移。

- 拒绝/放行明细留存 **90 天**（可配置），由启动期清理任务删除；聚合计数写 `map_migration_reports.kind='import_dedup'`，**永久保留**。
- `import_allowances`（用户主动记住的分支/副本规则）不随 90 天清理，保留至撤销。
- `project_fingerprints` 随项目删除而删除；图被删但项目仍在时保留（继续拦截重复导入）。

#### 与 S1 的关系

- 查重表与导入流程属于 **S1**，与 `entity_key` 同批上线（`entity_key` 在 S1 只是加列，真正防漂移的是查重）。
- 缺这一步的后果：重导生成新图 → 节点换新 `entity_key` → 打开新节点时间线为空 → 用户判断"会话丢了"（数据仍在旧图）。
- 不做合并入口：入口拒绝后不会产生需要合并的第二套 lineage，因此 `lineage_links` 表取消、`graphs.project_lineage_id` 取消（§7 已移除）。

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
| 时间过期 | `expires_at` 到期（**统一 30 天，可配置**；不按项目风险/类型区分，留作后续可选扩展，不进 L1） | 视为过期，状态降为 `implemented` |
| 人工撤销 | 用户显式撤销，必填 `revoke_reason` | 状态降为 `implemented` |
| 无法计算内容哈希 | 文件不可读 / 超过阈值（默认 200 个文件） | `freshness='unknown'`，UI 显示"无法校验，请人工复核"；**不自动撤销** |

- **不允许"完全不检测"**：至少要有"覆盖文件内容哈希"或"时间过期"之一。两者都不可用时，E4 只能保留 30 天并要求人工续签。
- 内容哈希按文件独立记录（不是整树 Merkle），能精确回答"哪个文件变了"，也避免一次全量扫描。
- 撤销/过期不删除证据行：保留 `revoked_at` / `freshness` 作为历史；派生状态只采信未撤销、未过期的 E4。

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

### 4.2 `work_runs`

- 一次执行尝试一行；`executor_kind` 区分 agent / test / human。
- `status` 与 `agent_runs.status` 不共用：`work_runs` 是任务视角，`agent_runs` 是执行器视角。
- `work_item_revision` 固化"这次执行用的是哪一版计划"，用于偏差度量与证据归属。

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
| `agent_approvals` | 是 | 扩展 subject（测试计划级审批），见 §6.3 |
| `chat_threads` / `chat_messages` | 是 | 时间线读取来源 |

已知限制：`agent_turns.node_id NOT NULL`，无节点会话使用伪节点 `thread:<id>`。本期不改该表结构，`node_session_links` 用 `node_entity_key` 可空来表达"项目级会话"。

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

### 5.5 可修订计划

状态机：

```
draft ──► awaiting_confirm ──► confirmed ──► (生成 work_items, 进队列)
   ▲              │
   └──── revise ◄─┘
confirmed ──► revised(revision+1) ──► awaiting_confirm ...
任意状态 ──► superseded（被新 revision 取代，只读）
任意状态 ──► rejected
```

规则：

- `revision` 单调递增；`lineage_id` 不变；`supersedes_id` 指向上一行。
- 只有 `is_current=1` 的行参与执行、统计、UI 默认展示。
- 执行中修订：新 revision 继承未完成项；已完成项默认不重跑，除非显式 `rework`（此时新增 run，旧 run 证据保留并标 `superseded_by_revision`）。
- 旧 revision 的 evidence 不迁移，`plan_deviations` 仍按旧 revision 统计，避免"改计划后看起来偏差变小"。

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
| `derivation_version` | 生成计划时的规则版本 | **归因维度** |
| `rule_version` | 记录时的规则版本 | 校准对齐 |

用途（三条，不超过这三条）：

1. **阈值校准**（离线）：按 `derivation_version` 聚合，若 `actual/planned` 文件数连续 3 批 > 1.5，则下调 `file_cohesion` 阈值或提高拆分粒度；若 `replan_count` 中位数 > 2，则提高候选数上限并强化 C1 展示。
2. **退化检测**：`scope_violation` 或 `rework_count` 高频的锚点类型（如 wiki-page、跨模块流程）标记为"结构不可推导"，下次直接进退化路径。
3. **确认强度自适应**：`replan_count` 高的项目在 C1 增加"必须逐条勾选验收条件"，低风险项目可折叠次要信息 —— 但**不允许跳过确认**。

校准是离线分析 + 人工改配置，不做在线自动学习、不自动修改历史计划。

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
2. 计算 plan_hash = sha256(规范化命令清单 + cwd + 基线)
3. 走 ApprovalGateway 提交 subject_type='test_plan' 的一次性审批
4. 批准后由主进程受控 git 能力创建 worktree（不通过 Bash 工具）
5. 逐条执行 test_plan_items：
     - evaluateBashPolicy 判定
     - evaluateGitDirWriteGuard 判定（命中即 deny）
     - cwd 固定为 worktree；超时 kill
6. 结果写 test_results；聚合写 test_runs
7. 通过的测试证据写 node_evidence（**E3**，带 `code_version` = 基线 commit）
8. 清理 worktree（保留失败现场 N 天，可配置）
```

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
- 单条命令执行**不重复弹审批**；但 `policy_decision='deny'` 的命令即使计划已批准也不执行（计划审批只把 `ask` 提升为 `allow`，不能豁免 `deny`）。
- 影响面：任何读取 `agent_approvals` 的查询需处理 `run_id/turn_id` 为空；重启重推逻辑需按 `subject_type` 分流，`test_plan` 未批准则计划作废（`expired`），不自动重放。
- 迁移方式见 §8 S8（该表需要重建，`NOT NULL` 无法用 `ALTER` 放宽）。

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
- 失败的测试产生 E3 的反向事实（`status='failed'`），派生状态为 `failed`，但**不自动把 `nodes.status` 打回**。

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

### 7.2 新增表

#### `node_links`

```sql
CREATE TABLE node_links (
  id              TEXT PRIMARY KEY,
  project_path    TEXT,
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
  UNIQUE(from_entity_key, to_entity_key, link_type)
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
  revoked_at       TEXT,
  revoked_by       TEXT,
  revoke_reason    TEXT
);

CREATE INDEX idx_node_evidence_node    ON node_evidence(graph_id, node_entity_key);
CREATE INDEX idx_node_evidence_level   ON node_evidence(evidence_level, freshness);
CREATE INDEX idx_node_evidence_run     ON node_evidence(work_run_id);
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
  is_reproducible    INTEGER NOT NULL DEFAULT 0,  -- 分组统计：verified/E3=1；signed_off/E4=0
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
    'done','cancelled','superseded')),
  gate_status          TEXT NOT NULL DEFAULT 'incomplete'
                       CHECK(gate_status IN ('incomplete','pass','waived')),
  gate_missing_json    TEXT,
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

#### `work_runs`

```sql
CREATE TABLE work_runs (
  id                   TEXT PRIMARY KEY,
  work_item_id         TEXT NOT NULL REFERENCES work_items(id),
  work_item_lineage_id TEXT NOT NULL,
  work_item_revision   INTEGER NOT NULL,
  run_seq              INTEGER NOT NULL,
  executor_kind        TEXT NOT NULL CHECK(executor_kind IN ('agent','test','human')),
  adapter_name         TEXT,
  route_decision_id    TEXT,
  status               TEXT NOT NULL CHECK(status IN (
    'queued','running','awaiting_approval','blocked',
    'completed','failed','cancelled','superseded')),
  session_id           TEXT,
  thread_id            TEXT,
  agent_run_id         TEXT,
  started_at           INTEGER,
  ended_at             INTEGER,
  result_summary       TEXT,
  failure_class        TEXT,
  created_at           INTEGER NOT NULL,
  UNIQUE(work_item_id, run_seq)
);

CREATE INDEX idx_work_runs_lineage ON work_runs(work_item_lineage_id, run_seq);
CREATE INDEX idx_work_runs_status  ON work_runs(status);
CREATE INDEX idx_work_runs_session ON work_runs(session_id);
```

#### `node_session_links`

```sql
CREATE TABLE node_session_links (
  id               TEXT PRIMARY KEY,
  project_path     TEXT,
  graph_id         TEXT NOT NULL,
  node_entity_key  TEXT,
  node_id          TEXT,
  work_item_id     TEXT,
  work_run_id      TEXT,
  thread_id        TEXT,
  session_id       TEXT,
  agent_run_id     TEXT,
  turn_id          TEXT,
  link_role        TEXT NOT NULL CHECK(link_role IN (
    'primary','supporting','review','test','investigation')),
  session_origin   TEXT NOT NULL CHECK(session_origin IN (
    'map_task','manual_panel','subagent','test')),
  started_at       INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE(thread_id, node_entity_key, link_role)
);

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
  files_json      TEXT NOT NULL,
  file_count      INTEGER NOT NULL DEFAULT 0,
  line_additions  INTEGER NOT NULL DEFAULT 0,
  line_deletions  INTEGER NOT NULL DEFAULT 0,
  captured_at     INTEGER NOT NULL
);

CREATE INDEX idx_change_sets_run     ON change_sets(work_run_id);
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

CREATE INDEX idx_routing_decisions_run ON routing_decisions(work_run_id);
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
  derivation_version    TEXT,
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
  rule_version          TEXT,
  computed_at           INTEGER NOT NULL
);

CREATE INDEX idx_plan_deviations_rule ON plan_deviations(derivation_version);
CREATE INDEX idx_plan_deviations_item ON plan_deviations(work_item_lineage_id);
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
  dirty            INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK(status IN (
    'pending','running','passed','failed','error','cancelled','stale')),
  total            INTEGER NOT NULL DEFAULT 0,
  passed           INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
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
  kind          TEXT NOT NULL CHECK(kind IN ('entity_key_backfill','link_backfill','integrity_check','import_dedup')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK(status IN ('running','ok','partial','failed')),
  stats_json    TEXT,
  details_json  TEXT
);
```

### 7.3 值域汇总（类型层需同步扩展）

| 类型 | 新增值 |
|---|---|
| `GraphType` | `test` |
| `NodeType` | `test-suite`、`test-case` |
| `EdgeType` | `verifies`、`covers` |
| `NodeStatus` | 不变（7 值） |
| 新增 `ExecutionState` | 9 值（见 §3.3，含 `signed_off`） |
| 新增 `EvidenceLevel` | `E0`–`E4` |

注意：`NODE_STATUS_TRANSITIONS` 是 `Record<NodeType, ...>`，新增 NodeType 必须补矩阵，否则类型检查失败；test 节点建议只允许 `draft → confirmed → published`（`developing/testing/review` 对测试资产无意义，作为默认假设）。

---

## 8. 迁移与实施顺序

> 当前 `CURRENT_SCHEMA_VERSION = 24`。**v24 是既有缺陷修复**（把增量列正式写进 `createSql`，见 §8.13），不属于蓝图增量。
> 下列 S1–S8 对应 v25–v32。
> **通用前置**：S0 备份完成且校验通过；迁移在启动期单事务内执行；`foreign_key_check` 必须为 0。

### 8.1 总览

| 步骤 | 内容 | 版本 | 前置条件 | 可独立上线边界 | 回退方式 |
|---|---|---|---|---|---|
| S0 | 停写备份 + 预检 | — | 无 | 否（运维动作） | 用备份覆盖 DB |
| S1 | 身份：`entity_key` 列 + 回填 + 唯一索引；**导入期查重**（`project_fingerprints` / `import_rejections` / `import_allowances`）+ 拒绝与放行决策 | v25 | P1/P6/P8 通过 | 是（读写路径可后置，旧代码忽略列） | 停用读取；查重表可清空；列可保留无害 |
| S2 | `node_links` + 跨图回填（只读展示优先） | v26 | S1 完成 | 是（先只读展示） | 停用写入；表可保留空置 |
| S3 | `lifecycle_state`（nodes/graphs）+ 删除路径改造 + 巡检 | v27 | S2 完成 | 是（先写后读） | 停用归档路径，回退到硬删（接受孤儿） |
| S4 | CHECK 扩展（test 图/节点/边） | v28 | **S1 必须已上线**；P2/P3/P4 通过 | 是（test 图功能开关关闭时不可见） | **只能恢复 S0 备份**（旧二进制无法兼容新值域） |
| S5 | 任务对象表 | v29 | S2 完成（**不依赖 test 图**） | 是（任务卡叠加层开关） | 关闭开关；表保留 |
| S6 | 证据与派生状态表 | v30 | S5 完成（证据可挂任务） | 是（叠加层状态徽标） | 关闭开关；缓存表可整表重建 |
| S7 | 推导/计划/偏差表 | v31 | S5 完成 | 是（C1 计划确认流） | 关闭开关；草稿表只读保留 |
| S8 | 测试表 + 审批 subject 扩展 | v32 | S4 + S6 完成；P5 通过 | 是（TestExecutor 开关） | 关闭开关；测试表保留，审批回退到 `agent_turn` 语义（`run_id` 可空但不再使用） |

### 8.2 S0：备份与预检（不是代码变更）

1. 退出应用，确认无残留执行器进程。
2. `PRAGMA wal_checkpoint(TRUNCATE)` 后复制 `data/bizgraph.db` 到 `data/backups/bizgraph-v24-<ts>.db`（v24 为 §8.13 修复后的基线）。
3. 记录基准指标：`graphs`/`nodes`/`edges` 行数、`foreign_key_check` 结果、`graphs.writeback_disabled=1` 的项目数、`edges.updated_at` 非空行数。
4. 记录 `schema-checksum.json` 内容：**回退时该文件与新库不匹配会触发旧二进制重建**，因此回退必须配合恢复 DB，不能只回退二进制。

回退：停应用 → 用备份覆盖 `bizgraph.db` 及 `-wal`/`-shm` → 删除 `schema-checksum.json` → 启动旧版本。

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

顺序：`work_items` → `work_runs` → `node_session_links` → `change_sets` → `routing_decisions` → 索引。

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

前置：S4（test 图可用）+ S6（证据回写可用）+ P5 通过；`agent_approvals` 重建方案已评审。

顺序：

1. `test_specs` → `test_plans` → `test_plan_items` → `test_runs` → `test_results`
2. `agent_approvals` 重建（放宽 `run_id`/`turn_id`，加 `subject_type`/`subject_id`，把这两列加入 `requiredColumns` 以强制重建）
3. 回填 `subject_type='agent_turn'`，`subject_id=turn_id`
4. 索引 `idx_agent_approvals_subject`

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
| P6 | Yjs / 快照 / IPC / 渲染兼容 | Yjs 更新后查键；从两种快照恢复后查键；`graph:get` 返回 `entityKey`；旧快照可读 | 键不丢不重置；旧快照可读；未知 `graphType` 不崩 | Yjs 覆盖 → 保持 repo 显式列更新并加断言；快照重建 id → 快照 v2 恢复后按签名回填；渲染拒新值 → 放宽共享类型 + 未知类型降级展示 |
| P7 | 渲染底座是否需要推翻 | 叠加层原型在 1000 节点图上跑批量 IPC | 不改 React Flow 数据模型；帧率/内存劣化 < 20%；单次批量 IPC | 超出性能预算 → 叠加层改为按视口分页拉取；仍不足则改为独立只读视图（仍不推翻底座） |
| P8 | 导入查重判定正确（§2.6） | 构造 6 类样本：同路径 / 同目录名+高相似 / 不同目录名+高相似 / 不同目录名+中相似 / 抽样失败 / 不同项目 | 每个样本决策与 §2.6 Step 表一致；拒绝时 `graphs`/`nodes` 新增行数为 0；放行时指纹与建图同事务 | 误拒率高 → 调阈值或改为"总是展示证据 + 人工确认"；误放高 → 提高相似度阈值并强制人工确认；抽样失败率高 → 增加 N 或改用目录树结构指纹 |
| P9 | 非 git E4 不混同（§3.5） | 构造 E3（`verified`）+ E4（`signed_off`）混合数据，逐项检查地图徽标/列表/导出/看板 | 按"可复现 / 不可复现"分组；E4 标注"无代码 hash、不可复现"；无同列合并、无等价排序 | 数据层已隔离，先在导出/看板层强制分组；若仍做不到，暂时只允许 UI 展示、关闭该维度导出 |

**结论**：在满足 P1–P9 的前提下，**可以按 A+ 走**。无任何一项要求推翻渲染底座或重建图数据模型。

### 8.12 阶段 × 表矩阵与 L1 最小集

先对齐规模事实：全量是 **21 张新建表**（原设计 18 张 + §2.6 查重相关 3 张：`project_fingerprints` / `import_rejections` / `import_allowances`），另有 **4 张既有表**被改列或重建（`nodes`、`graphs`、`edges`、`agent_approvals`）。

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
| 建 | `work_items`、`work_runs`、`node_session_links`、`routing_decisions` | 任务对象与路由记录（S5 的前半） |
| 建 | `node_evidence`、`node_execution_state` | 证据展示与派生状态（S6 的前半） |

**L1 共需 11 张新表 + 1 次改列**，对应迁移批次：S1 → S2 → S5a（`work_items`/`work_runs`/`node_session_links`/`routing_decisions`）→ S6a（`node_evidence`/`node_execution_state`）。

**L1 明确不建**（避免提前建空表）：

| 延后项 | 归属 | 延后理由 |
|---|---|---|
| `change_sets` | S5b | L1 时间线只展示会话与证据，不展示变更集 |
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
| `SessionTimelineService` | 按节点聚合会话/run/证据，供时间线查询 |
| `PlanDerivationService` | 候选边界推导（确定性算法）、`plan_drafts` 生成与越界剔除 |
| `RoutingService` | 单 Agent 选择与 `routing_decisions` 记录（不做并行） |
| `TestExecutor` | 计划审批提交、worktree 管理、逐条命令执行与结果回写 |
| `MapIntegrityService` | 孤儿链接、键缺失、派生状态漂移的巡检与报告 |

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

1. `event:NODE_STATUS_CHANGE` 无渲染端消费者 → `testing` 自动推进丢失。本期改为：该事件只更新派生状态提示，不再承担 `nodes.status` 写入。
2. `agent-manager` 会话启动自动广播 `developing` → 改为写 `work_runs`/派生状态。
3. `threadStore` 单 thread 映射 → 时间线查询。
4. `AgentChatPanel` 少传 `graphId` → 必须补。
5. `graphStore` 自动写 `developing` → 删除。

---

## 10. 与既有安全模型的一致性

| 约束 | 本设计如何满足 |
|---|---|
| 不绕过审批网关 | TestExecutor 的每条 ask 类命令都由计划级审批覆盖，审批事实写 `agent_approvals`；不新增旁路 API |
| 不绕过 Bash 策略 | 逐条调用 `evaluateBashPolicy`；`deny` 不可被计划审批豁免 |
| 不绕过 gitdir 写保护 | 逐条调用 `evaluateGitDirWriteGuard`，命中即 deny（fail-closed）；worktree 创建走主进程受控 git 能力，不经 Bash |
| 不复用 `RecipeRunner` shell | 明确不复用；TestExecutor 自带执行循环 |
| 不复用会话授权 | `session grants` 为内存态，测试执行不读取、不继承 |
| 不使用 `unattended` | 计划审批超时即作废（`expired`），不自动重放 |
| 审计可追溯 | 审批、路由、偏差、证据、迁移都有独立表与报告 |

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
| 偏差校准的周期 | 按批次（每 20 个 run）离线统计，人工改配置 |
| worktree 残留清理周期 | 失败现场保留 7 天，其余即时清理（可配置） |
