# 结构编辑优化设计（画布结构操作）

> 创建日期：2026-10-27
> 状态：待评审
> 范围：画布上的**结构编辑**——父子关系、子树移动、子树折叠、类型约束、布局持久化
> 不在范围：撤销/重做（项目稳定后再议）、语义关系边（business-flow 等）的编辑体验

---

## 一、意图与为什么

BizGraph 的画布目前能新建节点、拖拽移动、连线、搜索、两种自动布局。但**"改结构"这件事本身是残缺的**：

用户真正想做的事是"把 X 从 A 下面挪到 B 下面"。今天这件事做不到——`parentId` 在创建时定死，改结构只能删了重建，而重建会丢掉节点上累积的一切（描述、验收标准、上下文引用、Agent 会话绑定、bug 关联）。

这是画布类工具的核心动作。Excalidraw、tldraw、Obsidian Canvas、Figma 都有直接的操作路径；XMind 的 `Alt+方向键` 专门用来移动话题。

本设计要达成的：**改结构是画布上最顺手的动作**，且改完立刻在视觉上正确。

### 成功标准

- 拖动节点到另一个节点上松手，即完成重挂父节点；整棵子树跟随移动
- 重挂后画布上立刻显示新的父子连线，无需手动"整理布局"
- 大图可以通过折叠子树收敛到当前关注的分支
- 类型层级规则在菜单、拖拽、落库三处完全一致，不再有两套
- 关掉应用重开，折叠状态和布局选择仍在

### 非目标（明确不做）

- **撤销/重做**——用户明确决定推迟到项目稳定后。本设计不预留半成品机制，但**不阻碍**后续接入：所有结构写操作都收敛到主进程单一入口（见 §五），未来加撤销时只需在该入口前挂一层命令栈
- **语义关系边的编辑体验**（business-flow 的条件/备注表单等）——不在本次范围
- **框选批量操作**（批量删除/批量改状态/对齐分布）——不在本次范围
- **节点内联改名**——不在本次范围

---

## 二、现状：地基的三处裂缝

动手前必须先修地基。以下三条是本次所有工作的前提。

### 裂缝 1：父子关系有两套真相源，且手动创建的节点"隐形"

图里同时存在：

| 载体 | 写入方 | 读取方 |
|---|---|---|
| `nodes.parent_id` | AI 生成、项目扫描、**手动建子节点** | `prompt-builder.ts` 向上追溯上下文、`agent-context-builder.ts` |
| `edges` 表 | AI 生成、项目扫描、**手动连线** | dagre 布局（`tree-layout.ts`）、画布渲染（`GraphCanvas.tsx` flowEdges） |

问题出在"手动建子节点"这条路径：`src/renderer/canvas/hooks/useNodeOperations.ts:31` 的 `handleAddChild` 只写 `parentId`，**不建边**（已核实：该文件无 `createEdge` 调用）。

而画布**只渲染 `edges` 表**（`GraphCanvas.tsx:603` 的 `flowEdges` 遍历 `graphEdges`，无虚拟边合成）。所以：

> **手动右键加出来的子节点，在画布上没有任何父子连线。**

这不是数据不一致，是**用户可见的功能缺失**。AI 生成和项目扫描的节点有边所以有连线，手动加的没有。这个差异此前无人注意，因为层级关系平时主要靠 AI 生成，少数手动添加的节点就像"贴"在画布上的孤岛。

同一根源还导致第二个后果：dagre 布局（`useAutoLayout.ts:21` 喂 `getEdges()`）看不见 `parentId`，所以**手动加的子节点在自动布局时是游离的**，不会被排到父节点下面。

### 裂缝 2：类型层级规则有两套，且真正的那套从未被调用

`src/main/shared/node-type-registry.ts` 里 `NodeTypeRegistry.validateParentChild(parentType, childType)` 是一套完整的父子类型校验。但：

- **全项目零调用**（`grep -rn "validateParentChild"` 只命中该文件自身与其单测）
- 且它与渲染端的菜单规则**不一致**：

| 父类型 | registry（`node-type-registry.ts:20-39`） | renderer 菜单（`NodeContextMenu.tsx:38-55`） |
|---|---|---|
| project | 只能挂 `module` | 给 `module` + `wiki-page` |
| module | 只能挂 `process` + `wiki-page` | 给 `process` + `feature` + `wiki-page` |
| process | 只能挂 `feature` + `bug` + `wiki-page` | 同上 |
| feature | `allowedChildTypes` **未定义 = 允许任意** | 只给 `bug` |
| bug | 未定义 = 允许任意 | 给**空**（不能有子节点） |

同时 registry 的 `module` 缺 `allowedChildTypes` 中的 `feature`，而 `feature`/`bug` 缺 `allowedChildTypes` 定义——**registry 自身也不完整**。

结果：类型层级是这套产品的核心语义（`project → module → process → feature/bug`），却没有任何一处代码真正强制它。

### 裂缝 3：结构数据缺少完整性约束

- `nodes.parent_id` **无外键约束**（`database.ts:267` 是裸 `parent_id TEXT`）
- 删父节点**不级联子节点**（`node-repository.ts:188` 只 `DELETE FROM nodes`，靠 `edges` 表的 `ON DELETE CASCADE` 顺带删边）
- → 手动加的子节点（只有 `parent_id`、没有边）在父节点被删后会变成**孤儿**：指向已不存在的 `parent_id`
- **无兄弟顺序字段**：兄弟谁在前完全靠 `edges` 数组的出现顺序隐式决定（`tree-layout.ts:161` 的 `sortChildrenByEdgeOrder` 消费 `edges` 的迭代顺序）。这意味着重挂父节点后，兄弟顺序不可控、不可预期

---

## 三、方案总览

### 核心决策：真相源统一到 `parent_id`

采用「`parent_id` 为唯一真相源」路线：

```
parent_id（唯一真相源）
    │
    ├──→ 渲染层：按 parent_id 派生虚拟层级边 → 画布显示父子连线
    ├──→ 布局层：按 parent_id 派生虚拟层级边 → 喂给 dagre
    ├──→ 上下文层：直接读 parent_id（现状不变，prompt-builder 已经在做）
    └──→ 存储层：hierarchical 类型的边仅作索引/兼容，不再是真相
```

配套三件事：

1. **新增 `edge_type='hierarchical'`**，显式区分层级边与语义关系边
2. **存量迁移**：`default` 边中若 `target.parent_id === source`，判定为层级边 → 迁移为 `hierarchical`。判据可靠（父子关系唯一），不靠猜
3. **新增 `nodes.sort_index`**，兄弟顺序显式化

### 为什么不是「边为唯一真相源」

`parent_id` 已被下游多处依赖：`prompt-builder.ts:96-106` 向上追溯祖先链、`agent-context-builder.ts:18` 追溯父节点、`WikiIndexService`、克隆图逻辑（`graph-repository.ts:211`）。改成"查边"要动这些地方，而它们查 `parent_id` 是**语义正确**的（Wiki 层级、上下文追溯要的就是"祖先链"，不是"图上的连线"）。

反过来，把 `parent_id` 降级为派生缓存，则意味着每次查层级都要先扫边建索引——更慢、更绕、且把一个 O(1) 字段查询变成 O(E)。

### 为什么需要 `hierarchical` 这个 edge_type

不引入它，派生出的虚拟层级边会和存量 `default` 边**重复画线**。而 `default` 是个筐——`project-analyzer.ts:70` 的层级边和 `:302` 的跨模块依赖边都是 `default`。

有了 `hierarchical`：
- 渲染时：`hierarchical` 边由 `parent_id` 派生生成（**不读存储的边**），存量 `hierarchical` 边在 DB 里保留但不参与渲染
- 迁移后，语义关系边（`business-flow`/`semantic`/`dependency`/`wiki-link` 等）继续正常渲染
- `default` 边（迁移后剩下的非层级 `default`）继续正常渲染

### 落库入口收敛

所有结构写操作收敛到主进程**单一入口** `graph:reparent`：

```
graph:reparent(nodeId, newParentId)
  ├─ 校验：节点存在 / 目标存在 / 非自环 / 非环（目标不是自己的后代）
  ├─ 校验：类型层级（nodeTypeRegistry.validateParentChild）
  ├─ 校验：同图（不能把 online 图节点挂到 dev 图节点下）
  ├─ 事务：UPDATE nodes SET parent_id = ?, sort_index = ?
  ├─ 事务：更新/创建/清理 hierarchical 边（保持与 parent_id 一致）
  └─ 事务：子树的 sort_index 重排 + 位置持久化
```

这带来两个直接收益：
- 渲染层和布局层都从 `parent_id` 派生，**不存在两处不同步的窗口**
- 未来加撤销时，只需在 `graph:reparent` 前挂一层命令栈，不必重构

---

## 四、具体设计

### 4.1 数据模型变更

**`nodes` 表**

| 变更 | 说明 |
|---|---|
| `+ sort_index INTEGER` | 兄弟顺序。同一父节点下按此升序排列。迁移时按现有 `edges` 数组顺序回填 |
| `+ collapsed INTEGER DEFAULT 0` | 子树折叠状态。0=展开，1=折叠。跨会话保留 |
| `parent_id` 加外键 | `REFERENCES nodes(id) ON DELETE CASCADE` — **但有前置条件，见 §4.1.1，本期推迟** |

**`edges` 表**

| 变更 | 说明 |
|---|---|
| `edge_type` CHECK 增 `'hierarchical'` | 层级边的显式类型 |

⚠️ **CHECK 约束变更必须验证真实新库 INSERT**。项目历史教训（见 memory `llm-wiki-stepwise-plan`）：edges 表 CHECK 约束漏值导致 fresh install 下 wiki-link 落边**静默失效**（IPC 层 try/catch 吞错掩盖了约束违例）。本次改 CHECK 必须用真实 better-sqlite3 跑 INSERT 验证，不能只靠内存 fake repo。

`CURRENT_SCHEMA_VERSION` 从 16 → 17。

### 4.1.1 ⚠️ 阻塞项：`hierarchical` 必须是完整的共享类型，不是 DB 内部标记

**这是本设计最容易翻车的地方。**

`EdgeType` 定义在 `src/shared/types/graph.ts:52`，是一个**封闭联合类型**。`src/shared/type-guards.ts:40` 的 `assertEdgeType` 对未知值直接 `throw new TypeError`。而：

- `edge-repository.ts:31`（`listByGraph`）调用 `assertEdgeType`
- `graph-repository.ts:137`（`graph:get`）调用 `assertEdgeType`

→ **迁移一旦插入 `hierarchical` 行，`graph:get` 就抛异常，该图直接打不开。**

所以 `hierarchical` **必须**作为一等公民贯通全类型面：

| 位置 | 改动 |
|---|---|
| `src/shared/types/graph.ts:52` | `EdgeType` 联合类型增 `'hierarchical'` |
| `src/shared/type-guards.ts` | `EDGE_TYPE_VALUES` 增 `'hierarchical'` |
| `src/renderer/canvas/edge-utils.ts:5` | `edgeTypeConfig: Record<EdgeType, …>` 是**穷尽记录**，必须补 `hierarchical` 的样式项 |
| `src/shared/i18n/index.ts:201,211` | `edgeTypeOptions` / `edgeTypeLabel` 是穷尽记录，必须补 |

**但 `hierarchical` 不该出现在用户可选的边类型下拉里**（`EdgeEditor` / `CanvasOverlay` 的类型菜单）——它是系统内部的层级边，不是用户能主动创建的语义关系。

因此设计为：**类型面上它是合法的 `EdgeType`（保证读写不炸），但从「用户可创建的边类型」清单里排除。** 具体做法：`edgeTypeOptions` 保持用户可见清单不含 `hierarchical`，另设一个 `INTERNAL_EDGE_TYPES` 集合标记哪些是内部类型，供渲染层过滤与 UI 排除共用。

### 4.1.2 ⚠️ 阻塞项：`parent_id` 外键本期推迟，不随批次 1 上线

`db.pragma('foreign_keys = ON')` 在 `database.ts:45` 是**运行时默认开启**的。加 FK 会立刻打断两条现有写入路径：

| 路径 | 位置 | 问题 |
|---|---|---|
| `cloneGraphNodes`（`graph:derive`） | `graph-repository.ts:249` | Pass 1 插入的是**源图的 `parent_id`**（`row['parent_id']`），Pass 2 才重映射。FK 开启时该 INSERT 直接 `FOREIGN KEY constraint failed`，dev 图派生功能不可用 |
| `insertRemoteNode`（Yjs 远端） | `yjs-manager.ts:255` | 同样的两段式形状，同样会违反 FK |

要加 FK，必须先把这两条路径改成「先插 `parent_id = NULL`，再回填」的两段式——这是**独立的重构工作**，不该塞进批次 1。

**决定：`parent_id` 外键推迟到批次 2 之后**，作为独立任务。批次 1/2 用**应用层防环校验**（`graph:reparent` 里的后代检查）保证数据正确性，这已经能覆盖全部用户可触发的路径。

**替代防护**：删除父节点时，在 `node-repository.ts:188` 的 `delete()` 里显式处理子节点——把子节点的 `parent_id` 置 NULL（或一并删除，取决于产品决策）。这同时修掉裂缝 3 描述的「删父留孤儿」问题。

### 4.1.3 ⚠️ 阻塞项：schema 变更在存量库上如何生效

`rebuildTableIfNeeded`（`database.ts:267`）的重建触发条件有两个：
1. `requiredColumns` 中任一列在旧表缺失
2. `extractChecks` 提取的 CHECK 子句列表与 `createSql` 不一致

**`extractChecks` 只匹配 `check(`**（`database.ts:297`）——`REFERENCES` 子句对它不可见。且 `nodes` 的 `requiredColumns`（`database.ts:406`）当前列的是 `id/type/status/title/graph_id/graph_type/position_x/position_y/created_at/updated_at/wiki_content/wiki_meta`，**不含** `sort_index` / `collapsed`。

所以：
- `sort_index` / `collapsed` 若只靠 `addColumnSafe`（`ALTER TABLE ADD COLUMN`），**存量库能加上**——`addColumnSafe` 是 `ALTER TABLE` 路径，不依赖重建。
- `edges` 的 CHECK 变更（增 `hierarchical`）**会**触发重建，因为 `extractChecks` 能看到 CHECK 列表变化。但重建走 `restoreFromBackup`（`database.ts:98`），只拷贝新旧列交集——`edges` 表本身列没变，数据完整。
- `nodes` 表**不因本次变更重建**（CHECK 没变、requiredColumns 没变）→ 走 `addColumnSafe` 增量路径，**这正是我们想要的**，避免重建 nodes 触发 `DROP TABLE` 连带 CASCADE 清空依赖表的风险。

⚠️ **但 `foreign_key_check` 的影响要留意**：`database.ts:678` 在迁移提交前跑 `db.pragma('foreign_key_check')`，有违规则抛 `DatabaseError` **中断启动**。由于本期不加 `parent_id` FK，这条不受影响。但孤儿 `parent_id`（指向已删节点）不是 FK 违例（无 FK 就不检查），所以**必须在增量迁移里主动清理孤儿**，否则 `graph:reparent` 的后代遍历会走进死循环。

→ **孤儿清理是增量迁移的强制步骤，且必须在批次 1 完成**，不能推给批次 2。

### 4.2 迁移流程

迁移在 `runIncrementalMigrations` 中执行，顺序：

1. **加列**：`nodes.sort_index`（INTEGER）、`nodes.collapsed`（INTEGER DEFAULT 0）——走 `addColumnSafe` 的 `ALTER TABLE` 路径，**不触发 nodes 表重建**
2. **清孤儿**：`UPDATE nodes SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM nodes)` ——必须先于任何依赖 `parent_id` 遍历的逻辑（否则 `graph:reparent` 的后代遍历会死循环）
3. **回填 sort_index**：按每个父节点的子节点在 `edges` 数组中的出现顺序赋值；无 parent_id 的节点（根节点）保持 NULL
4. **迁移 edge_type**：`UPDATE edges SET edge_type='hierarchical' WHERE edge_type='default' AND EXISTS(SELECT 1 FROM nodes t WHERE t.id = edges.target AND t.parent_id = edges.source)`
5. **补齐缺失的 hierarchical 边**：对每个有 `parent_id` 的节点，若不存在对应的 `hierarchical` 边 → 插入一条（这会把"手动加的隐形子节点"补上边）

第 5 步是关键——它同时修复了裂缝 1 造成的存量数据问题。

### 4.2.1 迁移后：谁写层级边

迁移只改存量。**新写入路径必须同步改，否则新旧数据形态不一致**：

| 写入方 | 位置 | 现状 | 改法 |
|---|---|---|---|
| 项目扫描 | `project-analyzer.ts:70/105/132` | 写 `edgeType:'default'` 的层级边 + `parentTempId` | 层级边改写 `edgeType:'hierarchical'` |
| AI 生成 | `graph-service.ts:505` 第三轮 | 同上 | 同上 |
| AI 生成（parent_id） | `graph-service.ts:493-495` | 裸 SQL 写 `parent_id` | 保持（这是真相源写入），但需在写完后确保 `hierarchical` 边存在 |
| **手动加子节点** | `useNodeOperations.ts:31` | **只写 `parent_id`，不建边** | **新建节点后补建 `hierarchical` 边**（修裂缝 1 的存量根因） |

**关键决策：仍然写 `hierarchical` 边，而不是彻底不写层级边。**

理由：`hierarchical` 边是 `parent_id` 的**索引副本**，不是第二个真相源。保留它的价值：
- 主进程侧按边查询的场景（`graph:get` 一次性取全图、克隆图、Louvain 构图）不必每次重建父子索引
- 未来若要放弃 `parent_id`（改回边为真相源），存量数据已就位

**一致性由 `graph:reparent` 保证**：该 IPC 在同一事务内更新 `parent_id` 与对应的 `hierarchical` 边，两者在主进程层面不可能不同步。

**`deriveHierarchyEdges` 渲染时仍按 `parent_id` 派生**，而不是读存储的 `hierarchical` 边——这样即使某个写入路径漏了边（正如今天 `handleAddChild` 那样），画布也不会少画连线。存储的 `hierarchical` 边只服务于主进程查询，**不参与渲染**。

**克隆路径必须同步**：`graph-repository.ts:211` 的 `cloneGraphNodes` 用 `SELECT *` 读源图、显式列名写入目标图。新增的 `sort_index` / `collapsed` 列**不会**被 `SELECT *` 自动带进 INSERT（INSERT 列名是硬编码的），必须显式加进 INSERT 列表并回填。否则 `graph:derive`（online → dev）产出的 dev 图会丢失兄弟顺序和折叠状态。

**克隆的 `hierarchical` 边**：克隆会重映射 `parent_id`（Pass 2 用 `idMap`），`hierarchical` 边的 source/target 必须跟着**同一张 `idMap`** 重映射，否则克隆出的 dev 图里层级边会指向错误的节点。

**dev 图的折叠状态**：折叠是「我暂时不关心这个模块」，属于**开发者视角**。dev 图从 online 图派生时，`collapsed` 应重置为 0（展开）而非继承——开发者打开 dev 图要看到完整结构。但 `sort_index`（兄弟顺序）应当继承，因为那是结构信息不是视角偏好。

**dev 图是快照，不会自动跟随 online 图的结构变更**。online 图里重挂父节点后，dev 图的层级保持派生时刻的状态。这是现有的产品语义（`deriveGraph` 是一次性克隆），本期**不引入自动同步**——跨图同步是独立特性。用户需要更新 dev 图时，走现有的重新派生流程。

### 4.2.1 与既有边消费者的兼容

`deriveHierarchyEdges` 只作用于**画布渲染**和**布局**。以下主进程消费者直接读 `edges` 表，不受影响，但需要确认它们对 `hierarchical` 类型的边没有错误假设：

| 消费者 | 位置 | 行为 |
|---|---|---|
| Wiki 社区发现（Louvain） | `src/main/wiki/graph-compute-service.ts:35` | 已显式 `filter(e => e.edgeType === 'wiki-link')` — **不受影响** |
| Wiki lint | `src/main/wiki/graph-lint-service.ts:54` | 同样只取 `wiki-link` — **不受影响** |
| Wiki 链接落边 | `src/main/services/wiki-link-service.ts` | 只操作 `wiki-link` 边 — **不受影响** |
| 写回回滚 | `src/main/services/writeback-service.ts:346-351` | 只删 `wiki-link` / `semantic` 边 — **不受影响** |
| dev 图克隆 | `src/main/repositories/graph-repository.ts:225` | `SELECT *` 克隆全部边 — `hierarchical` 边会一并克隆，**但必须与 `parent_id` 用同一张 `idMap` 重映射** |
| 上下文追溯 | `src/main/mindmap-agent/synthesis/prompt-builder.ts` | 读 `parent_id` — 不受影响 |
| 渲染层 | `src/renderer/store/graphStore.ts:25` | 已 `filter(e => e.edgeType !== 'wiki-link')` — 需新增对 `hierarchical` 的过滤（存储的层级边不参与渲染，渲染用派生边） |

**渲染层的过滤位置很重要**：`graphStore.ts:25` 的过滤发生在 store 层（边进入 store 时就被滤掉），而 `deriveHierarchyEdges` 需要看到原始边集来判断"哪些 `default` 边其实是层级边"。两者顺序不能颠倒——**过滤必须在派生之后进行**，且派生的输入要包含原始 `default` 边（用于识别并排除迁移残留）。

**关键约束**：`hierarchical` 边与 `parent_id` 必须始终一致。克隆路径是最容易产生不一致的地方——`cloneGraphNodes` 有两轮（先插节点后重映射 `parent_id`），`hierarchical` 边的 source/target 必须跟着同一张 `idMap` 重映射。

### 4.3 派生层级边（渲染 + 布局共用）

新增纯函数模块 `src/renderer/canvas/layouts/hierarchy.ts`：

```ts
/**
 * 按 parent_id 派生层级边。
 * parent_id 是唯一真相源，存储的 hierarchical 边不参与渲染（避免重复画线）。
 */
export function deriveHierarchyEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphEdge[]
```

行为：
- 对每个有 `parent_id` 的节点，产出 `{ source: parentId, target: node.id, edgeType: 'hierarchical' }`
- **过滤掉**存储边中 `edgeType === 'hierarchical'` 的那些（它们已被派生边取代）
- 其余语义边（`business-flow`/`semantic`/`dependency`/`wiki-link`/迁移后剩余的 `default`）原样保留

渲染层（`GraphCanvas.tsx`）与布局层（`useAutoLayout.ts`）都用这个函数的输出替代原始 `graphEdges`。

### 4.4 拖拽重挂父节点

参照 mindgraph（React Flow + TS，行为最接近本项目）的做法：

**交互流程**

1. 拖动节点 A 时，检测指针下方是否存在可作为新父节点的节点 B
2. 命中判定：指针位置落在 B 的边界内（用 `screenToFlowPosition` 转 flow 坐标后做矩形命中，**不用** `getBoundingClientRect` 的屏幕坐标直接比）
3. **合法性预检**（实时，决定高亮与否）：
   - B 不是 A 自己
   - B 不是 A 的后代（否则成环）
   - `validateParentChild(B.type, A.type)` 通过
   - B 与 A 同图
   - **B 不是 A 的当前父节点** —— 命中时按「**没有候选**」处理（不是「非法」）。
     理由：主进程对「换父到当前父节点」是**无操作**（原样返回库里的坐标，一个字节都不写）。
     若把它当成合法落点，渲染端会先抑制自由位置持久化、再调 `graph:reparent` →
     主进程回一个「没动过」的坐标 → 节点弹回拖拽前的位置，同时弹一个「已移动到 B」的
     成功提示。用户并没有做错任何事，却被告知成功了。
     按「没有候选」处理 = 退化成普通移动（A 跟随指针、位置照常持久化），且**不给红框** ——
     这不是一个错误，只是一个没有意义的操作。
4. 命中合法时：B 显示**绿色高亮边框**，A 与 B 之间显示**幽灵连线**
5. 命中非法或未命中：拖拽行为退化为普通移动（A 跟随指针，位置持久化）
6. 松手在合法 B 上：调用 `graph:reparent(A, B)`

**防环**

`graph:reparent` 主进程侧必须做后代检查：从新父节点出发沿 `parent_id` 上溯，若能到达 A，则拒绝。这是**唯一权威**的防环点（渲染端也做一份预检只是为了即时反馈，最终裁决在主进程）。

**类型提示**

命中非法时给出明确原因（而非静默拒绝）：
- 类型不允许 → tooltip「功能点不能挂在流程下」
- 会成环 → tooltip「不能挂到自己的子节点下」

**子树跟随**

重挂后，A 的整棵子树要跟着 A 移动到 B 下面。

实现方式：重挂成功后**只重排受影响的部分**——把 A 及其后代作为一个整体，平移到 B 的子树区域末端；不跑全图 dagre（全图重排会让用户失去已调好的布局）。

具体计算：以 B 现有子节点的包围盒为基准，把 A 子树放到 B 下方，并给 A 及其所有后代设置相同的 `sort_index` 偏移。

### 4.4.1 「同图」的定义：比 `graph_id`，不是 `graph_type`

`nodes` 表有两个相关字段：`graph_id`（归属哪张图）和 `graph_type`（节点语义类别）。二者**不等价**：

- `useNodeOperations.ts:36` 建子节点时写 `graphType: 'dev'`（feature/bug 节点），但 `graphId` 是**当前打开的图**（通常是 online 图）
- 也就是说：**同一张图里可以同时存在 `graph_type='online'` 和 `graph_type='dev'` 的节点**

所以「不能跨图重挂」的校验必须比 **`graph_id`**，而不是 `graph_type`。用 `graph_type` 会误伤「online 图里的 feature 节点挂到同图的 process 节点下」这种完全合法的操作。

**`graph:reparent` 不修改节点的 `graph_type`**——重挂只改父子关系，不改节点自身的语义分类。

### 4.4.2 Yjs 协作路径是第二个未受控的 `parent_id` 写入方

`src/main/realtime/` 下有两条路径会写 `parent_id`：

| 路径 | 位置 | 形状 |
|---|---|---|
| 远端节点插入 | `yjs-manager.ts:255` | 裸 SQL INSERT，带 `parentId` |
| 远端节点更新 | `bidirectional-sync.ts:67` → `nodeRepo.update(change.id, nodeData)` | 传**完整节点 payload** |

问题：`nodeRepo.update` 会写 `parent_id`（`node-repository.ts:160`），而远端 peer 可以任意指定 `parentId`——**绕过防环和类型校验**。更糟的是，本地 `graph:reparent` 的写入**不更新 Yjs 文档**（`ipc/graph.ts` 里没有 Yjs 镜像），所以远端 peer 后续的一次全量同步可能用陈旧的 `parentId` 覆盖本地刚做的重挂。

**本期决定**：
- 远端更新路径**必须复用同一套校验**——在 `nodeRepo.update` 的调用侧（或 repository 内）加校验，与 `graph:reparent` 共用同一段防环/类型逻辑
- 协作功能默认关闭（`ws-server.ts:234` 按需创建文档），所以这是**防御性加固**而非修 bug
- **不做** Yjs 双向镜像——那是独立特性，不在本期范围

### 4.4.3 AI 写入路径的类型校验

`project-analyzer.ts` 与 `graph-service.ts` 生成的父子类型组合**不受菜单规则约束**——它们直接写 `parentTempId` / `parent_id`。

统一 registry 后，UI 能表达的层级变严了（`module → feature` 不再合法），但 AI 路径可能造出 UI 无法复现的结构。

**决定：AI 写入路径不强制类型校验**。理由：
- AI 生成的层级是**批量**的，逐个校验可能让整次生成失败（一个不合规就全废）
- 现有生成结果已经在生产使用，追溯性限制收益低、风险高
- 本期目标是让**用户手动改结构**变得顺畅，不是收紧 AI 的产出

但要保证**数据不会因此崩**：AI 写出的 `parent_id` 只要不构成环，`graph:reparent` 的后代遍历就是安全的。所以 AI 路径需加**防环校验**（廉价：写入前检查新父节点不是自己的后代），但**不加类型校验**。

### 4.5 子树折叠/展开

**交互**：节点上出现折叠指示器（有子节点时才显示），点击切换。折叠时：
- 子树节点从画布隐藏
- 父节点显示子节点数量徽标（如 `⊕ 3`）
- 该节点在布局中作为一个叶子参与 dagre 计算

**存储**：新增 `nodes.collapsed INTEGER DEFAULT 0`（0/1）。用户明确要求**跨会话保留**。

理由：折叠是**业务语义**——"这个模块我暂时不关心"是用户对图的理解状态，不是纯 UI 偏好。存 localStorage 会导致换个窗口/重装就丢失，且无法参与协作同步。

**协作注意**：D10b 的 Yjs awareness 广播的是选区/光标，折叠状态走普通 `node:update` IPC 持久化即可，本期不做实时协同折叠。

**布局交互**：折叠后运行树形布局，被折叠节点作为叶子参与，展开后重新布局。

### 4.6 类型规则统一

**registry 补全**（`node-type-registry.ts`）：

| 类型 | allowedChildTypes | allowedParentTypes |
|---|---|---|
| project | `['module']` | — |
| module | `['process', 'wiki-page']` | `['project']` |
| process | `['feature', 'bug', 'wiki-page']` | `['module']` |
| feature | `['bug']` | `['process']` |
| bug | `[]` | `['process']` |
| wiki-page | `['wiki-page']` | `['project', 'module', 'process', 'wiki-page']` |

即：以 registry 的语义为准（module 不直接挂 feature，与 `project → module → process → feature` 的层级一致），补全 feature/bug 缺失的定义，让 `feature` 能挂 `bug`、`bug` 不能有子节点。

**暴露给渲染端**：新增 IPC `nodeType:listConfigs` 返回 `NodeTypeConfig[]`，渲染端启动时拉取并缓存。

**消费方统一**：
- `NodeContextMenu.tsx` 的 `getChildTypeOptions` **删除**，改用 IPC 拉到的 `allowedChildTypes`
- 拖拽校验用同一份 `allowedChildTypes` / `allowedParentTypes`
- `graph:reparent` 主进程用 `nodeTypeRegistry.validateParentChild`（终于被真正调用）

**为什么走 IPC 而不是直接 import**：registry 在 `src/main/shared/`，是主进程专属（运行时逻辑 + Map 实例）。`src/shared/types.ts` 不能含运行时逻辑。走 IPC 与 `subagent:listTypes` 的既有模式一致。

### 4.7 布局选择持久化

现状 `GraphCanvas.tsx:754` 的 `layoutMode` 是 `useState`，刷新即丢。

存储位置：`localStorage`，key 按项目路径隔离（如 `bizgraph.layoutMode.<projectPath>`）。**不存 DB**——布局模式是纯显示偏好，不是业务语义（与折叠状态的处理不同，这是有意的区分）。

### 4.8 兄弟顺序（sort_index）

`sort_index` 的语义：同一 `parent_id` 下，子节点按 `sort_index` 升序。

- 根节点（`parent_id` 为 NULL）`sort_index` 为 NULL
- 新建子节点时取父节点现有子节点中最大的 `sort_index + 1`
- 重挂时插入到目标父节点的末尾（或指定位置）
- `tree-layout.ts` 的 `sortChildrenByEdgeOrder` 改为消费 `sort_index` 而非 `edges` 数组顺序

这样兄弟顺序才是**用户可控且可预期**的，而不是数组碰巧的顺序。

---

## 五、IPC 契约

| 通道 | 方向 | 说明 |
|---|---|---|
| `graph:reparent` | renderer → main | `(nodeId, newParentId)` → 重挂父节点。含类型/环/同图校验 + 子树位置重排 |
| `nodeType:listConfigs` | renderer → main | → `NodeTypeConfig[]`，渲染端缓存类型规则 |

新通道需同步登记三处（沿用既有模式）：
- `src/shared/types/ipc.ts` — `IpcApi` 接口
- `src/preload/index.ts` — `exposedChannels` 数组
- `src/main/ipc/graph.ts` — `typedHandle` 注册

**现有 `node:update` 允许改 `parentId`（`node-repository.ts:160`）——这条路径必须关闭或收敛**，否则会绕过 `graph:reparent` 的所有校验。方案：在 `validateNodeUpdate` 里拒绝 `parentId` 变更，引导走专用通道。

已核实该收敛**不破坏仓库内任何现有调用方**：`useNodeOperations.ts:86`（只传 metadata）、`:108`（只传 status）、`graphStore.ts:485`（只传 metadata）、`NodeEditor.tsx:515`（只读）都不传 `parentId`。且 `node-repository.ts:207` 的 `updateParentId` 方法**零调用方**，可一并清理。

⚠️ **但 Yjs 远端更新路径传的是完整节点 payload**（`bidirectional-sync.ts:67`），它经由 `nodeRepo.update` 而非 `node:update` IPC。收敛 IPC 层拦不住它——需要在 repository 层或该调用点单独处理（见 §4.4.2）。

---

## 六、错误处理

新增错误码（`src/main/errors.ts` 的 `ErrorCode` 常量）：

| 错误码 | 触发场景 |
|---|---|
| `HIERARCHY_CYCLE` | 目标节点是自己的后代 |
| `HIERARCHY_TYPE_INVALID` | 类型层级不允许 |
| `HIERARCHY_CROSS_GRAPH` | 跨图重挂（`graph_id` 不同） |
| `HIERARCHY_SELF_PARENT` | 节点挂到自己身上 |

这些是 `BizGraphError` 的子类，需覆写 `toJSON()` 暴露结构化字段（沿用 `IpcError` 的做法），以便 `createTypedHandle` 透传到渲染端。

渲染端捕获后 toast 提示，拖拽回弹到原位。

---

## 七、测试策略

| 层次 | 覆盖 |
|---|---|
| 类型面 | `EdgeType` 增 `hierarchical` 后，`assertEdgeType('hierarchical')` 不抛；`edgeTypeConfig` / i18n 穷尽记录补齐（TS 编译期检查） |
| 迁移 | 真实 better-sqlite3 跑迁移：孤儿清理、`sort_index` 回填、`default`→`hierarchical` 迁移、缺失 `hierarchical` 边补齐。**必须验证真实新库 INSERT**（CHECK 约束教训） |
| 迁移幂等性 | 迁移跑两次结果一致（`runIncrementalMigrations` 每次启动都跑） |
| `deriveHierarchyEdges` | 纯函数单测：派生正确、排除存储的 `hierarchical` 边、保留语义边（含 `default` 语义边）、根节点无 `parent_id`、孤儿子节点不产生边 |
| `graph:reparent` | 主进程集成测试：正常重挂、防环、类型拒绝、跨图拒绝（`graph_id` 不同但 `graph_type` 相同也算跨图）、自环拒绝、兄弟 `sort_index` 重排、子树位置跟随、`parent_id` 与 `hierarchical` 边在事务后一致 |
| 类型规则 | registry 补全后的 `validateParentChild` 全组合单测 |
| 删除父节点 | 子节点被置为根节点而非成为孤儿 |
| 克隆 | `graph:derive` 后 dev 图的 `sort_index` 保留、`collapsed` 重置、`hierarchical` 边与 `parent_id` 一致 |
| 渲染 | 手动创建的子节点在画布上有父子连线；AI 生成的节点连线不重复（不出现双线） |

沿用既有约定：测试与源码同目录 `__tests__/`；命令 `npx vitest run <path>`。

### 7.1 重点复核场景（人工验证）

单元测试覆盖不到的交互层问题：
- **存量图升级后能否正常打开**——迁移后打开一个含 AI 生成节点的旧图，不报错、连线正常、无重复线
- **手动加的子节点升级后是否补上连线**——这是裂缝 1 的直接验收点
- **拖拽重挂后连线是否即时更新**——松手瞬间新连线出现、旧连线消失，无需手动整理布局
- **大图折叠后布局是否收敛**——折叠后运行树形布局，被折叠节点作为叶子参与，不出现空档

---

## 八、参考项目

| 项目 | 借鉴点 |
|---|---|
| **mindgraph**（React Flow + TS） | 拖拽重挂父节点、整棵子树跟随移动、合法目标灰边提示、防环自动处理 |
| **KityMinder dragtree.js** | 拖拽时区分「合法父节点」与「兄弟插入位置」两类落点提示 |
| **XMind** | 层级语义的类型约束、`Alt+方向键` 移动话题的快捷键惯例 |
| **Logseq / Roam** | `Tab`=缩进成子节点、`Shift+Tab`=提升的层级编辑惯例（本期不实现快捷键，但语义参考） |
| **Excalidraw** | `ActionManager` 集中管理快捷键、菜单内联显示快捷键提示 |
| **zundo** | Zustand temporal 中间件（未来撤销重做的候选方案，本期不用） |

React Flow v12 内置能力核实结论（已核对 `node_modules/@xyflow/react@12.12.0` 类型定义）：
- **不内置撤销/重做**（官方为 Pro 付费示例）
- 已内置：框选（`selectionKeyCode` 默认 Shift）、多选（`multiSelectionKeyCode` 默认 Meta/Ctrl）、`getIntersectingNodes`、`screenToFlowPosition`、MiniMap、Controls
- **无 `zoomToCursor` 属性**——缩放跟随指针需自行用 `screenToFlowPosition` + `zoomTo` 实现

---

## 九、实施顺序

分三个可独立验证的批次：

**批次 1 — 地基**（无用户可见变化，但后续全部依赖它）
1. `EdgeType` / `EDGE_TYPE_VALUES` / `edgeTypeConfig` / i18n 补齐 `hierarchical`（**必须最先做**，否则后续任何写入 `hierarchical` 边的代码都会让图打不开）
2. schema 变更：`nodes.sort_index` / `nodes.collapsed`（`addColumnSafe` 增量路径）+ `edges` CHECK 增 `hierarchical`
3. 增量迁移：清孤儿 → 回填 `sort_index` → `default`→`hierarchical` 迁移 → 补齐缺失的 `hierarchical` 边
4. `deriveHierarchyEdges` 纯函数 + 单元测试
5. 渲染层与布局层切换到派生边
6. registry 补全 + `nodeType:listConfigs` IPC + 菜单改用统一规则
7. **修 `handleAddChild`**：手动加子节点时同时补建 `hierarchical` 边（修裂缝 1 的根因）
8. `cloneGraphNodes` 补齐新列 + `hierarchical` 边重映射

**批次 2 — 改结构**（核心价值）
9. `graph:reparent` IPC（含全部校验）+ 集成测试
10. 拖拽重挂交互（含落点高亮、幽灵连线、防环预检、类型提示）
11. 子树跟随移动 + 局部重排
12. 兄弟 `sort_index` 重排
13. 删父节点的子节点处理（`parent_id` 置 NULL）
14. Yjs / AI 写入路径补防环校验

**批次 3 — 大图可用性**
15. 子树折叠/展开（含徽标、布局参与、DB 持久化）
16. 布局选择持久化（localStorage）

**批次 4 — 后续（本期不做，记录在此）**
17. `parent_id` 外键：需先重构 `cloneGraphNodes` 与 `yjs-manager.ts` 为「先插 NULL 再回填」的两段式
18. 撤销/重做：结构写操作已收敛到 `graph:reparent` 单一入口，届时在此前挂命令栈
19. 跨图结构同步：online 图变更后 dev 图的层级同步

批次 1 完成后，"手动加的子节点有连线了"和"布局能正确排到父节点下"这两个用户可见的修复就已经生效——即使后续批次延期，收益也不为零。

---

## 十、留给实施者的决定

以下由实施者自行决定，不影响设计：

- 拖拽命中的具体阈值（指针落在目标框内即命中 vs 需要停留 N 毫秒）
- 幽灵连线的视觉样式（虚线、颜色、是否带箭头）
- 折叠徽标的文案与位置
- `sort_index` 回填时对无 `edges` 顺序可依据的节点如何定序（建议按 `created_at` 兜底）
- 迁移脚本是内联在 `runIncrementalMigrations` 还是独立模块

---

## 十一、明确留给用户的决定

- 折叠徽标显示子节点总数还是仅显示"已折叠"
- 重挂后的子树是放在目标父节点末尾，还是插入到指定兄弟位置（本期默认末尾）
- 删除父节点时，其子节点是**置为根节点**（保留）还是**一并删除**（级联）——本期设计为置为根节点（保守，不丢数据）
