# 结构编辑优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 BizGraph 画布上的"改结构"成为最顺手的动作——拖拽即可重挂父节点、子树跟随移动、大图可折叠、类型规则全局统一。

**Architecture:** `nodes.parent_id` 是父子关系的唯一真相源。渲染层与布局层按 `parent_id` 派生虚拟层级边（`deriveHierarchyEdges`），不读存储的边——这样即使某条写入路径漏建边，画布也不会少画连线。存储层保留 `edge_type='hierarchical'` 的边作为 `parent_id` 的索引副本，仅供主进程查询；所有结构写操作收敛到单一入口 `graph:reparent`，在同一事务内更新 `parent_id`、`sort_index` 与 `hierarchical` 边。

**Tech Stack:** Electron / TypeScript（strict）/ better-sqlite3 / React 18 / @xyflow/react 12.12.0 / Zustand / Vitest

**Spec:** `docs/superpowers/specs/2026-10-27-structure-editing-design.md` —— 实施者必须先读这份设计文档，本计划从中推导；两者冲突时以 spec 为准。

---

## Global Constraints

- **语言**：界面文案走 `@shared/i18n` 资源层（`src/shared/i18n/resources/domains/*.ts`）。zh 是 key 的真值来源，en 必须覆盖每一个 zh key。新增文案**必须**同时加 zh 和 en。
- **`EdgeType` 是封闭联合类型**：`src/shared/types/graph.ts:52`。任何新增边类型必须同时改：联合类型、`EDGE_TYPE_VALUES`（同文件 :375）、`src/renderer/canvas/edge-utils.ts` 的 `edgeTypeConfig`（`Record<EdgeType, …>` 穷尽记录）、`src/shared/i18n/index.ts` 的 `HandBuiltEdgeType`（`Exclude<EdgeType, 'wiki-link'>`）相关记录。TS 编译期会抓到遗漏，但 `assertEdgeType` 在运行时会**抛 TypeError 导致整张图打不开**——这是本项目历史踩过的坑（`graph-repository.ts:137` 的 `assertEdgeType` 在 `graph:get` 路径上）。
- **CHECK 约束变更必须用真实 better-sqlite3 验证 INSERT**。项目历史教训：edges 表 CHECK 漏 `'wiki-link'` 导致 fresh install 下 wiki-link 落边静默失效（IPC 层 try/catch 吞错掩盖）。禁止用内存 fake repo 代替。
- **Node 状态转换必须走 `NodeRepository.update()`**（其内部强制 `validateNodeTypeTransition`）。禁止在主进程裸写 `UPDATE nodes SET status = ...`。
- **IPC 错误必须继承 `BizGraphError` 并覆写 `toJSON()`**，否则 `createTypedHandle` 会把自定义字段丢掉。自定义错误类还必须 `Object.setPrototypeOf(this, XxxError.prototype)`（照 `src/main/errors.ts` 里 `IpcError` / `AdapterError` 的写法）。
- **不改 `parent_id` 外键**：本批不做（spec §4.1.2 已论证会打断 `cloneGraphNodes` 与 `yjs-manager.ts` 的两段式写入）。防环靠应用层校验。
- **不实现撤销/重做**：用户明确推迟。结构写操作已收敛到 `graph:reparent` 单一入口，未来在此前挂命令栈即可。
- **`parent_id` 是唯一真相源**：渲染与布局都从它派生，不读存储的 `hierarchical` 边。
- **渲染层的引用稳定性（无限重渲染循环）**：任何进入 `useMemo` 依赖数组的值必须**引用稳定**。`GraphCanvas.tsx` 的 `flowNodes`（:516）与 `flowEdges`（:599）各自配一个 `useEffect(() => setRfNodes(flowNodes))`（:595-597）/ `useEffect(() => setRfEdges(flowEdges))`（:659-661），而 `setRfNodes` / `setRfEdges` 是 React `useState` 的 setter——**新数组引用即状态更新即重渲染**。若依赖数组里放的是每帧新建的数组（写在 `useMemo` 外面算出来的过滤/合并结果），会形成「重渲染 → 新数组 → effect 再触发 → 再重渲染」的无限循环，React 抛 *Maximum update depth exceeded*，画布白屏。凡是要进依赖数组的派生数组，必须自己包一层 `useMemo`；原始值（string / boolean / null）可以直接进依赖数组——它们引用稳定。
- **禁止 `--no-verify`** 跳过 git hooks。提交信息用中文，遵循现有风格：`feat(canvas): ...` / `fix(canvas): ...` / `refactor(db): ...`。

## Review Focus

以下五个场景 spec 暗示了、但没有任务直接覆盖，是最可能咬到人的地方。按重要性排序，每个都由对应任务的测试钉住：

1. **存量图升级后打不开** — 老库里已有 `default` 边，迁移后出现 `hierarchical` 行。若 `EdgeType` 联合类型或 `assertEdgeType` 没同步，`graph:get` 直接抛 TypeError，用户的图**完全无法打开**。期望：迁移后打开含 AI 生成节点的旧图正常，连线正常，无重复线。→ Task 1 + Task 2 Step 6
2. **连线重复画（双线）** — 存储的 `hierarchical` 边与派生边同时渲染。期望：AI 生成的节点连线只有一条；手动加的子节点**有**一条（这是本次修复的核心验收点）。→ Task 3 + Task 4
3. **拖拽重挂后连线不更新** — `parent_id` 改了但 `hierarchical` 边没在同一事务里改，或渲染层没切到派生边。期望：松手瞬间新连线出现、旧连线消失，无需手动整理布局。→ Task 6 + Task 10
4. **删父节点产生孤儿** — `node-repository.ts:191` 的 `delete()` 只删自身，子节点的 `parent_id` 指向已不存在的节点；后续 `graph:reparent` 的后代遍历会**死循环**。期望：子节点被置为根节点。→ Task 11
5. **大图折叠后布局出现空档** — 被折叠的节点必须作为叶子参与 dagre 计算，不能留空。期望：折叠后运行树形布局，节点紧凑排布。→ Task 12

---

## 文件结构

**新建**

| 路径 | 职责 |
|---|---|
| `src/renderer/canvas/layouts/hierarchy.ts` | `deriveHierarchyEdges` 纯函数——按 `parent_id` 派生层级边，过滤存储的 `hierarchical` 边。渲染层与布局层共用 |
| `src/renderer/canvas/layouts/__tests__/hierarchy.test.ts` | 上者的单元测试 |
| `src/main/repositories/hierarchy-migration.ts` | 增量迁移的四个步骤（清孤儿 / 回填 sort_index / default→hierarchical / 补齐缺失边）。独立成文件便于单测 |
| `src/main/repositories/__tests__/hierarchy-migration.test.ts` | 迁移的集成测试（真实 better-sqlite3） |
| `src/main/shared/hierarchy-utils.ts` | `isDescendant` 纯函数——防环判定。`parentOf` 是回调，数据库查询与内存映射共用 |
| `src/main/services/hierarchy-service.ts` | `graph:reparent` 的业务逻辑：校验（存在/自环/环/类型/同图）+ 事务写入 + 子树位置重排 |
| `src/main/services/__tests__/hierarchy-service.test.ts` | `graph:reparent` 的集成测试 |
| `src/main/ipc/node-type.ts` | `nodeType:listConfigs` IPC handler |
| `src/renderer/canvas/hooks/useNodeTypeConfigs.ts` | 渲染端拉取并缓存类型规则 |
| `src/renderer/canvas/hooks/useReparentDrag.ts` | 拖拽重挂的候选检测与落点校验 |
| `src/renderer/canvas/hooks/useCollapse.ts` | 折叠状态与可见节点计算 |

**修改**

| 路径 | 改动 |
|---|---|
| `src/shared/types/graph.ts` | `EdgeType` 增 `'hierarchical'`；`EDGE_TYPE_VALUES` 同步；`GraphNode` 增 `sortIndex?` / `collapsed?`；新增 `ReparentResult` |
| `src/renderer/canvas/edge-utils.ts` | `edgeTypeConfig` 增 `hierarchical` 样式项 |
| `src/shared/i18n/index.ts` | `HandBuiltEdgeType` 排除 `'hierarchical'`（内部类型，不进用户可选下拉） |
| `src/main/database.ts` | `edges` CHECK 增 `'hierarchical'`；`nodes` 加 `sort_index` / `collapsed` 列；`CURRENT_SCHEMA_VERSION` 16→17；接入迁移调用 |
| `src/main/errors.ts` | 新增 4 个 `HIERARCHY_*` 错误码 + `HierarchyError` 类 |
| `src/main/repositories/node-repository.ts` | `rowToNode` 映射新列；`update()` 支持写新列；`delete()` 处理子节点；删 `updateParentId` |
| `src/main/repositories/graph-repository.ts` | `cloneGraphNodes` 补新列 + `hierarchical` 边重映射；`rowToNode` 映射新列 |
| `src/main/shared/node-type-registry.ts` | 补全 `feature` / `bug` 的 `allowedChildTypes` |
| `src/main/ipc/graph.ts` | 注册 `graph:reparent`；`validateNodeUpdate` 拒绝 `parentId` |
| `src/main/ipc-handlers.ts` | 调用 `registerNodeTypeIpcHandlers(typedHandle)` |
| `src/shared/types/ipc.ts` | `IpcApi` 增两个通道签名 |
| `src/preload/index.ts` | `exposedChannels` 增两个通道 |
| `src/renderer/store/graphStore.ts` | 增 `reparentNode` action |
| `src/renderer/canvas/GraphCanvas.tsx` | 渲染层改用派生边；拖拽重挂交互；折叠过滤；布局模式持久化 |
| `src/renderer/canvas/layouts/tree-layout.ts` | `sortChildrenByEdgeOrder` 改用 `sort_index` |
| `src/renderer/canvas/BizNode.tsx` | 落点高亮样式 + 折叠指示器 + 徽标 |
| `src/renderer/canvas/NodeContextMenu.tsx` | 删除 `getChildTypeOptions`，改用统一规则 |
| `src/renderer/canvas/hooks/useNodeOperations.ts` | `handleAddChild` / `handleGenerateChildren` 补建 `hierarchical` 边 |
| `src/main/project-analyzer.ts` | 层级边改写 `edgeType:'hierarchical'` |
| `src/main/services/graph-service.ts` | 同上；AI 写入路径补建层级边 + 防环校验 |
| `src/shared/i18n/resources/domains/canvas.ts` | 新增折叠/拖拽相关文案（zh + en） |

---

## Task 1: `hierarchical` 边类型贯通全类型面

**Files:**
- Modify: `src/shared/types/graph.ts:52`（`EdgeType` 联合类型）、`:375`（`EDGE_TYPE_VALUES`）
- Modify: `src/renderer/canvas/edge-utils.ts`（`edgeTypeConfig`）
- Modify: `src/shared/i18n/index.ts:141`（`HandBuiltEdgeType`）、`:211`（`edgeTypeLabel`）
- Modify: `src/shared/i18n/resources/domains/node.ts`（新增 `edge.hierarchical.label`，zh + en）
- Create: `src/shared/__tests__/edge-type-hierarchical.test.ts`
- Test: `src/renderer/canvas/__tests__/edge-utils.test.ts`（已存在，扩展）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `EdgeType` 联合类型含 `'hierarchical'`；`EDGE_TYPE_VALUES` 含 `'hierarchical'`
  - `edgeTypeConfig.hierarchical` 存在，`color: '#94a3b8'`（与 default 同色——层级线是背景结构，不该抢语义边的视觉权重）
  - `HandBuiltEdgeType` 排除 `'hierarchical'`，因此 `edgeTypeOptions()`（用户可选边类型下拉）不返回它

- [ ] **Step 1: Write the failing test**

新建 `src/shared/__tests__/edge-type-hierarchical.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { EDGE_TYPE_VALUES } from '../types/graph'
import { assertEdgeType, isEdgeType } from '../type-guards'
import { edgeTypeLabel } from '../i18n'

describe('hierarchical edge type', () => {
  it('is a legal EdgeType value', () => {
    expect(EDGE_TYPE_VALUES).toContain('hierarchical')
    expect(isEdgeType('hierarchical')).toBe(true)
  })

  it('assertEdgeType accepts hierarchical without throwing', () => {
    expect(() => assertEdgeType('hierarchical')).not.toThrow()
    expect(assertEdgeType('hierarchical')).toBe('hierarchical')
  })

  it('has a translated label instead of the raw type string', () => {
    expect(edgeTypeLabel('hierarchical')).toBeTruthy()
    expect(edgeTypeLabel('hierarchical')).not.toBe('hierarchical')
  })
})
```

在 `src/renderer/canvas/__tests__/edge-utils.test.ts` 追加：

```ts
it('supports hierarchical edge type in config', () => {
  expect(edgeTypeConfig.hierarchical).toBeDefined()
  expect(edgeTypeConfig.hierarchical.color).toMatch(/^#/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/__tests__/edge-type-hierarchical.test.ts src/renderer/canvas/__tests__/edge-utils.test.ts`
Expected: FAIL — `'hierarchical'` 不在 `EDGE_TYPE_VALUES` 中，`edgeTypeConfig.hierarchical` 为 undefined，TS 编译报错

- [ ] **Step 3: Extend the shared type surface**

`src/shared/types/graph.ts:52`：
```ts
export type EdgeType = 'default' | 'success' | 'failure' | 'condition' | 'business-flow' | 'semantic' | 'dependency' | 'co-change' | 'wiki-link' | 'hierarchical'
```

`src/shared/types/graph.ts:375`：
```ts
export const EDGE_TYPE_VALUES = ['default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change', 'wiki-link', 'hierarchical'] as const
```

`src/renderer/canvas/edge-utils.ts` 的 `edgeTypeConfig` 增一项：
```ts
  hierarchical: { color: '#94a3b8' },
```

`src/shared/i18n/index.ts:141`：
```ts
type HandBuiltEdgeType = Exclude<EdgeType, 'wiki-link' | 'hierarchical'>
```

（这样 `EDGE_TYPE_KEYS` / `EDGE_TYPE_DESC_KEYS` / `EDGE_TYPE_COLORS` 三张 `Record<HandBuiltEdgeType, …>` 不需要为 hierarchical 补条目，`edgeTypeOptions()` 自然不返回它——层级边不进用户可选的边类型下拉。）

`edgeTypeLabel()`（`src/shared/i18n/index.ts:211`）**必须**为 `hierarchical` 显式加一条分支。它的兜底是 `return key ? tIn(locale, key) : type`——不加工这条分支，画布上的连线标签会直接显示英文 `"hierarchical"`。照 `wiki-link` 的既有写法处理：

```ts
  if (type === 'hierarchical') return tIn(locale, 'edge.hierarchical.label')
```

并在 `src/shared/i18n/resources/domains/node.ts` 补 key（zh 是真值来源，en 必须覆盖；`edge.wikiLink.label` 就在这个文件里）：

```ts
  'edge.hierarchical.label': '层级',        // zh
  'edge.hierarchical.label': 'Hierarchy',    // en
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/__tests__/edge-type-hierarchical.test.ts src/renderer/canvas/__tests__/edge-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: 零错误。若报 `edgeTypeConfig` 缺 hierarchical，说明上一步漏了；`EDGE_TYPE_KEYS` 报缺 hierarchical，说明 `HandBuiltEdgeType` 的 `Exclude` 没生效

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/graph.ts src/renderer/canvas/edge-utils.ts src/shared/i18n/index.ts src/shared/i18n/resources/domains/node.ts src/shared/__tests__/edge-type-hierarchical.test.ts src/renderer/canvas/__tests__/edge-utils.test.ts
git commit -m "feat(canvas): hierarchical 边类型贯通共享类型面"
```

---

## Task 2: schema 变更与增量迁移

**Files:**
- Modify: `src/main/database.ts`（`edges` CHECK、`nodes` 列定义、`CURRENT_SCHEMA_VERSION`、迁移调用）
- Create: `src/main/repositories/hierarchy-migration.ts`
- Test: `src/main/repositories/__tests__/hierarchy-migration.test.ts`
- Modify: `src/main/__tests__/database-migration.test.ts`（Step 6 的真实库 CHECK 用例）

**Interfaces:**
- Consumes: Task 1 的 `EdgeType` 含 `'hierarchical'`
- Produces:
  - `runHierarchyMigration(db: BetterSqlite3.Database): void` in `src/main/repositories/hierarchy-migration.ts`——幂等，导出供 `database.ts` 调用与单测
  - `nodes.sort_index`（INTEGER，可空）、`nodes.collapsed`（INTEGER NOT NULL DEFAULT 0）
  - `edges.edge_type` CHECK 含 `'hierarchical'`
  - `CURRENT_SCHEMA_VERSION` = 17

**迁移步骤顺序不可调换**（spec §4.2）：

1. 加列 `sort_index`、`collapsed`
2. 清孤儿：`parent_id` 指向不存在节点 → 置 NULL
3. 回填 `sort_index`：按同父节点下子节点在 `edges` 数组中的出现顺序递增赋值；无 `parent_id` 的节点保持 NULL
4. `default` → `hierarchical`：`UPDATE edges SET edge_type='hierarchical' WHERE edge_type='default' AND EXISTS(SELECT 1 FROM nodes t WHERE t.id = edges.target AND t.parent_id = edges.source)`
5. 补齐缺失的 `hierarchical` 边：对每个有 `parent_id` 的节点，若无对应 `hierarchical` 边则插入一条

**已核实的 schema 机制**（实施者不必重新推导，但改动时不要违背）：
- `edges` 的 CHECK 变更**会**触发 `rebuildTableIfNeeded`（`database.ts:267`）：它走 `DROP TABLE edges` → `exec(createSql)` → `restoreFromBackup`。新表带新 CHECK，**约束会生效**。`edges` 列清单没变，`restoreFromBackup` 只拷新旧列交集 → 数据完整。
- `nodes` 表**不会**重建：加 `sort_index` / `collapsed` 是普通列，不改变 `extractChecks`（`database.ts:297`）提取到的 CHECK 列表；`nodes` 的 `requiredColumns`（`database.ts:406`）保持不变 → 走 `addColumnSafe` 的 ALTER TABLE 路径。
- ⚠️ **不要把 `sort_index` / `collapsed` 加进 `nodes` 的 `requiredColumns`**——加了会强制重建 nodes 表，走 `DROP TABLE` 路径，风险远大于收益。
- 迁移期间 `foreign_keys` 被关闭（`database.ts:775-825`），edges 重建时其 `REFERENCES nodes(id)` 不会报错；迁移提交前有 `foreign_key_check` 兜底。

- [ ] **Step 1: Write the failing test**

新建 `src/main/repositories/__tests__/hierarchy-migration.test.ts`。用真实 better-sqlite3，建一个最小 schema：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runHierarchyMigration } from '../hierarchy-migration'

describe('runHierarchyMigration', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
        title TEXT NOT NULL, graph_id TEXT NOT NULL, graph_type TEXT NOT NULL,
        parent_id TEXT, sort_index INTEGER, collapsed INTEGER NOT NULL DEFAULT 0,
        position_x REAL NOT NULL, position_y REAL NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
        edge_type TEXT, graph_id TEXT NOT NULL
      );
      INSERT INTO nodes VALUES
        ('p1','project','confirmed','项目','g1','online',NULL,NULL,0,0,0,'t','t'),
        ('m1','module','draft','模块','g1','online','p1',NULL,0,0,0,'t','t'),
        ('c1','process','draft','流程','g1','online','m1',NULL,0,0,0,'t','t'),
        ('orphan','feature','draft','孤儿','g1','online','gone',NULL,0,0,0,'t','t');
      INSERT INTO edges VALUES
        ('e1','p1','m1','default','g1'),
        ('e2','m1','c1','default','g1'),
        ('e3','p1','c1','business-flow','g1');
    `)
  })

  afterEach(() => { db.close() })

  it('clears orphan parent_id', () => {
    runHierarchyMigration(db)
    const row = db.prepare("SELECT parent_id FROM nodes WHERE id='orphan'").get() as { parent_id: string | null }
    expect(row.parent_id).toBeNull()
  })

  it('migrates parent-child default edges to hierarchical', () => {
    runHierarchyMigration(db)
    const rows = db.prepare("SELECT id, edge_type FROM edges ORDER BY id").all() as { id: string; edge_type: string }[]
    expect(rows.find(r => r.id === 'e1')!.edge_type).toBe('hierarchical')
    expect(rows.find(r => r.id === 'e2')!.edge_type).toBe('hierarchical')
    expect(rows.find(r => r.id === 'e3')!.edge_type).toBe('business-flow')
  })

  it('backfills sort_index in sibling order', () => {
    runHierarchyMigration(db)
    const row = db.prepare("SELECT sort_index FROM nodes WHERE id='m1'").get() as { sort_index: number | null }
    expect(row.sort_index).toBe(0)
  })

  it('adds missing hierarchical edge for parented node', () => {
    db.prepare("INSERT INTO nodes VALUES ('m2','module','draft','模块2','g1','online','p1',NULL,0,0,0,'t','t')").run()
    runHierarchyMigration(db)
    const row = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='hierarchical' AND source='p1' AND target='m2'").get() as { n: number }
    expect(row.n).toBe(1)
  })

  it('is idempotent', () => {
    runHierarchyMigration(db)
    const before = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    runHierarchyMigration(db)
    const after = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    expect(after.n).toBe(before.n)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/repositories/__tests__/hierarchy-migration.test.ts`
Expected: FAIL — 模块 `../hierarchy-migration` 不存在

- [ ] **Step 3: Implement `runHierarchyMigration`**

新建 `src/main/repositories/hierarchy-migration.ts`。签名：

```ts
export function runHierarchyMigration(db: BetterSqlite3.Database): void
```

实现要点：
- 用 `db.transaction()` 包住全部四步，保证原子性
- **本函数只管数据迁移，不碰 DDL**——加列由 `database.ts` 的 `runIncrementalMigrations` 用现成的 `addColumnSafe` 完成（见 Step 5）。理由：`addColumnSafe`（`database.ts:852`）已经实现了标识符校验 + 类型白名单 + "duplicate column" 吞错；在本文件里另写一份 `ALTER TABLE` + try/catch 就是把同一段逻辑抄第二遍。列的增删属于 schema 层的职责，数据迁移函数不该重复实现。
- 四步的**先后顺序不可换**：清孤儿必须先于回填 `sort_index`（否则会给已失效的父子关系排序号）；回填 `sort_index` 必须先于 `default → hierarchical` 改写（改写后父子关系才完整）。
- 清孤儿：`UPDATE nodes SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM nodes)`
- 回填 `sort_index`：先查每个父节点下按 `edges` 出现顺序排好的子节点列表，再逐个 `UPDATE nodes SET sort_index = ? WHERE id = ?`；无 `edges` 顺序可依据的节点按 `created_at` 兜底
- 迁移 `edge_type`：按上面步骤 4 的 SQL
- 补齐缺失边：对每个有 `parent_id` 的节点，`SELECT 1 FROM edges WHERE source=? AND target=? AND edge_type='hierarchical'` 不存在则 INSERT。生成的边 ID 用 `generateId('edge')`（`src/main/shared/env.ts`）

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/repositories/__tests__/hierarchy-migration.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: Wire the schema change into `database.ts`**

`src/main/database.ts`：
- `edges` 表 `createSql`（:416）的 CHECK 增 `'hierarchical'`：
  ```sql
  edge_type TEXT CHECK(edge_type IN ('default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change', 'wiki-link', 'hierarchical')),
  ```
- `nodes` 表 `createSql`（:389）加两列，紧跟 `parent_id TEXT,` 之后：
  ```sql
  sort_index INTEGER,
  collapsed INTEGER NOT NULL DEFAULT 0,
  ```
- `CURRENT_SCHEMA_VERSION`（:354）从 16 改为 17
- 在 `runIncrementalMigrations`（`database.ts:851`）里用**现成的** `addColumnSafe` 加两列——与其它所有列的加法完全同构（`database.ts:873-882` 就是这些调用的所在地）：
  ```ts
  addColumnSafe('nodes', 'sort_index', 'INTEGER')
  addColumnSafe('nodes', 'collapsed', 'INTEGER', '0')
  ```
  ⚠️ `collapsed` 的 DEFAULT 写成字符串 `'0'`，`addColumnSafe` 会用 `validateDefaultValue` 校验后拼进 SQL——照 `addColumnSafe('graphs', 'writeback_disabled', 'INTEGER', '0')` 的既有写法。
- 在 `runIncrementalMigrations` 末尾调用 `runHierarchyMigration(db)`（加列必须排在它前面——迁移要回填 `sort_index`）

⚠️ `nodes` 的 `requiredColumns`（:406）**不要**加 `sort_index` / `collapsed`——加了会触发 `rebuildTableIfNeeded` 重建 nodes 表，走 `DROP TABLE` 路径。新增列走 `addColumnSafe` 的 ALTER TABLE 路径即可。

- [ ] **Step 6: Verify CHECK constraint and new columns on a real fresh DB**

这个用例**加在 `src/main/__tests__/database-migration.test.ts`**（不要放进新的 `hierarchy-migration.test.ts`）——那个文件已经 mock 了 `electron` 并调用 `initDatabase()`，照抄它的模式（`vi.mock('electron', () => ({ app: { getPath: ... } }))` + `beforeAll(initDatabase)`）。主进程测试跑在 vitest 的 `node` 环境，`electron` 的 `app` 不存在，`initDatabase()` 会直接抛错——没有 mock 就跑不起来。

```ts
// 追加到 src/main/__tests__/database-migration.test.ts 的 describe 里
it('accepts hierarchical edge_type and has the new node columns', () => {
  const db = getClient()
  // 必须先建两个真实节点：edges.source/target 有 REFERENCES nodes(id) 外键，
  // 且 foreign_keys 常态是 ON（database.ts:45），插入不存在的 id 会先报外键违规，
  // 根本走不到 CHECK 那一层
  const now = new Date().toISOString()
  const insertNode = db.prepare(
    'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  )
  insertNode.run('n_x1', 'module', 'draft', 'X1', 'g_x', 'online', 0, 0, now, now)
  insertNode.run('n_x2', 'feature', 'draft', 'X2', 'g_x', 'online', 0, 0, now, now)

  db.prepare("INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES ('x1','n_x1','n_x2','hierarchical','g_x')").run()
  const row = db.prepare("SELECT edge_type FROM edges WHERE id='x1'").get() as { edge_type: string }
  expect(row.edge_type).toBe('hierarchical')

  const cols = (db.pragma('table_info(nodes)') as { name: string }[]).map(c => c.name)
  expect(cols).toContain('sort_index')
  expect(cols).toContain('collapsed')
})
```

⚠️ 这个用例必须在**真实 better-sqlite3** 上跑——CHECK 约束漏值的历史教训（spec §4.1），禁止用内存 fake repo 代替。

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/main/repositories/__tests__/hierarchy-migration.test.ts src/main/__tests__/database-migration.test.ts src/main/__tests__/database.test.ts`
Expected: PASS —— 包括真实新库 INSERT hierarchical 成功

- [ ] **Step 8: Commit**

```bash
git add src/main/database.ts src/main/repositories/hierarchy-migration.ts src/main/repositories/__tests__/hierarchy-migration.test.ts src/main/__tests__/database-migration.test.ts
git commit -m "feat(db): 节点兄弟顺序与折叠状态列，层级边类型化，存量迁移"
```

---

## Task 3: `deriveHierarchyEdges` 纯函数

**Files:**
- Create: `src/renderer/canvas/layouts/hierarchy.ts`
- Test: `src/renderer/canvas/layouts/__tests__/hierarchy.test.ts`

**Interfaces:**
- Consumes: `GraphNode` / `GraphEdge`（`@shared/types`）
- Produces:
  ```ts
  // src/renderer/canvas/layouts/hierarchy.ts
  export interface DerivedHierarchyResult {
    /** 按 parent_id 派生的层级边；id 形如 `derived-<source>-<target>` */
    hierarchyEdges: GraphEdge[]
    /** 原样保留的语义边（已剔除存储的 hierarchical 边与重复的 default 层级边） */
    semanticEdges: GraphEdge[]
  }
  export function deriveHierarchyEdges(
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): DerivedHierarchyResult
  ```
  返回值分成两半，渲染层与布局层把两半合并后使用。返回的是**完整 `GraphEdge` 对象**（不是精简形状），这样 `flowEdges` 的 useMemo 除了换输入数组之外不需要改。

- [ ] **Step 1: Write the failing test**

新建 `src/renderer/canvas/layouts/__tests__/hierarchy.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { deriveHierarchyEdges } from '../hierarchy'
import type { GraphNode, GraphEdge } from '@shared/types'

const mkNode = (id: string, parentId?: string): GraphNode => ({
  id, type: 'feature', status: 'draft', title: id,
  graphId: 'g1', graphType: 'online', parentId,
  position: { x: 0, y: 0 }, createdAt: 't', updatedAt: 't',
})

const mkEdge = (id: string, source: string, target: string, edgeType: any): GraphEdge => ({
  id, source, target, edgeType, graphId: 'g1',
})

describe('deriveHierarchyEdges', () => {
  it('derives one hierarchy edge per parented node', () => {
    const { hierarchyEdges } = deriveHierarchyEdges([mkNode('p'), mkNode('c', 'p')], [])
    expect(hierarchyEdges).toHaveLength(1)
    expect(hierarchyEdges[0]).toMatchObject({ source: 'p', target: 'c', edgeType: 'hierarchical' })
    expect(hierarchyEdges[0].id).toBe('derived-p-c')
  })

  it('excludes stored hierarchical edges from semantic edges', () => {
    const { semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('c', 'p')],
      [mkEdge('e1', 'p', 'c', 'hierarchical')],
    )
    expect(semanticEdges.find(e => e.id === 'e1')).toBeUndefined()
  })

  it('keeps semantic edges that are not parent-child pairs', () => {
    const { semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('a'), mkNode('b')],
      [mkEdge('e1', 'a', 'b', 'business-flow')],
    )
    expect(semanticEdges.map(e => e.id)).toEqual(['e1'])
  })

  it('keeps default edges that are not parent-child pairs', () => {
    const { semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('a'), mkNode('b')],
      [mkEdge('e1', 'a', 'b', 'default')],
    )
    expect(semanticEdges.map(e => e.id)).toEqual(['e1'])
  })

  it('drops default edges that duplicate a parent-child pair', () => {
    const { semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('c', 'p')],
      [mkEdge('e1', 'p', 'c', 'default')],
    )
    expect(semanticEdges.map(e => e.id)).toEqual([])
  })

  it('produces no edge for a node whose parent is missing', () => {
    const { hierarchyEdges } = deriveHierarchyEdges([mkNode('orphan', 'gone')], [])
    expect(hierarchyEdges).toEqual([])
  })

  it('produces no edge for a root node', () => {
    const { hierarchyEdges } = deriveHierarchyEdges([mkNode('root')], [])
    expect(hierarchyEdges).toEqual([])
  })

  it('produces exactly one edge for a parented node that also has a stored edge', () => {
    const { hierarchyEdges, semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('c', 'p')],
      [mkEdge('e1', 'p', 'c', 'default')],
    )
    const all = [...hierarchyEdges, ...semanticEdges]
    expect(all.filter(e => e.source === 'p' && e.target === 'c')).toHaveLength(1)
  })

  it('produces exactly one edge for a parented node with no stored edge', () => {
    const { hierarchyEdges, semanticEdges } = deriveHierarchyEdges([mkNode('p'), mkNode('c', 'p')], [])
    const all = [...hierarchyEdges, ...semanticEdges]
    expect(all.filter(e => e.source === 'p' && e.target === 'c')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/canvas/layouts/__tests__/hierarchy.test.ts`
Expected: FAIL — 模块 `../hierarchy` 不存在

- [ ] **Step 3: Implement `deriveHierarchyEdges`**

新建 `src/renderer/canvas/layouts/hierarchy.ts`。算法：

```ts
export function deriveHierarchyEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
): DerivedHierarchyResult {
  const nodeIds = new Set(nodes.map(n => n.id))
  const hierarchyEdges: GraphEdge[] = []
  for (const node of nodes) {
    if (!node.parentId) continue
    if (!nodeIds.has(node.parentId)) continue   // 孤儿不产生边
    hierarchyEdges.push({
      id: `derived-${node.parentId}-${node.id}`,
      source: node.parentId,
      target: node.id,
      graphId: node.graphId,
      edgeType: 'hierarchical',
    })
  }
  const parentChildPairs = new Set(hierarchyEdges.map(e => `${e.source} ${e.target}`))
  const semanticEdges = edges.filter((e) => {
    if (e.edgeType === 'hierarchical') return false                      // 存储的层级边不参与渲染
    if (e.edgeType === 'default' && parentChildPairs.has(`${e.source} ${e.target}`)) return false  // 迁移残留
    return true
  })
  return { hierarchyEdges, semanticEdges }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/canvas/layouts/__tests__/hierarchy.test.ts`
Expected: PASS（9 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/layouts/hierarchy.ts src/renderer/canvas/layouts/__tests__/hierarchy.test.ts
git commit -m "feat(canvas): 按 parent_id 派生层级边的纯函数"
```

---

## Task 4: 渲染层切换到派生边

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx`（`flowEdges` useMemo，:599）
- Test: `src/renderer/canvas/layouts/__tests__/hierarchy.test.ts`（已存在，Task 3 已含验收用例）

**Interfaces:**
- Consumes: Task 3 的 `deriveHierarchyEdges(nodes, edges) → { hierarchyEdges, semanticEdges }`
- Produces: 画布上的父子连线由 `parent_id` 派生

**布局层自动获益**（无需改 `useAutoLayout.ts`）：`useAutoLayout.applyLayout` 用的是 React Flow 的 `getEdges()`，而 `GraphCanvas` 通过 `useEffect(() => setRfEdges(flowEdges))` 把合并后的边集写回 React Flow。因此 `flowEdges` 一旦切到派生边，dagre 布局喂进去的就是派生边——手动加的子节点会自动排到父节点下方。**不要**在 `useAutoLayout.ts` 里再单独派生一次，会造成两套派生。

- [ ] **Step 1: Switch the renderer to derived edges**

`src/renderer/canvas/GraphCanvas.tsx` 的 `flowEdges` useMemo（:599-657）：输入数组从 `graphEdges` 换成合并集。改法是把 `graphEdges.map(...)` 改为遍历合并后的数组：

```ts
// ⚠️ mergedEdges 必须自己包一层 useMemo —— 它会作为 flowEdges 的依赖数组成员。
// 写成 useMemo 外面的一次性计算 = 每帧新数组引用 → flowEdges 每帧重算
// → useEffect(() => setRfEdges(flowEdges)) 每帧触发 → setRfEdges 是 useState setter
// → 无限重渲染循环（React: Maximum update depth exceeded），画布白屏。
const mergedEdges = useMemo(() => {
  const { hierarchyEdges, semanticEdges } = deriveHierarchyEdges(graphNodes, graphEdges)
  return [...hierarchyEdges, ...semanticEdges]
}, [graphNodes, graphEdges])

const flowEdges = useMemo(() => {
  // ...原有 cache/key 逻辑完全不变，只是把 graphEdges.map 换成 mergedEdges.map
}, [mergedEdges, selectedEdgeId, degradation.simplifyEdges, degradation.hideEdgeLabels])
```

要点：
- `mergedEdges` 必须**自己包一层 `useMemo`**（依赖 `[graphNodes, graphEdges]`），再作为 `flowEdges` 的依赖。见 Global Constraints 的「渲染层的引用稳定性」——写成 useMemo 外面的一次性计算会造成无限重渲染循环
- 派生边的 `id` 是 `derived-<source>-<target>`，与存储边 ID 空间隔离，`edgeCacheRef` 的 key 不会冲突
- `flowEdges` 内部对 `edgeTypeConfig[edgeType]` 的查表、marker、动画逻辑都不需要改——`edgeTypeConfig.hierarchical` 已在 Task 1 补齐

- [ ] **Step 2: Verify the store still hands raw edges to the renderer**

`src/renderer/store/graphStore.ts:25` 的 `excludeWikiLinkEdges` 只过滤 `wiki-link`，**保持原样**。原因：`deriveHierarchyEdges` 需要看到原始 `default` 边才能识别并剔除「迁移残留的层级边」；存储的 `hierarchical` 边由 `deriveHierarchyEdges` 自己剔除。store 层不要提前过滤 `hierarchical`。

- [ ] **Step 3: Verify with type-check and existing tests**

Run: `npx tsc --noEmit && npx vitest run src/renderer/canvas/layouts/__tests__/ src/renderer/canvas/__tests__/`
Expected: 零错误，现有测试全绿

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/GraphCanvas.tsx
git commit -m "feat(canvas): 渲染层改用派生的层级边"
```

---

## Task 5: 类型规则单一权威

**Files:**
- Modify: `src/main/shared/node-type-registry.ts`（补全 `allowedChildTypes`）
- Create: `src/main/ipc/node-type.ts`
- Modify: `src/main/ipc-handlers.ts`（注册新 handler 文件）
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/canvas/NodeContextMenu.tsx`（删 `getChildTypeOptions`）
- Modify: `src/renderer/canvas/GraphCanvas.tsx`（传 prop）
- Create: `src/renderer/canvas/hooks/useNodeTypeConfigs.ts`
- Test: `src/main/shared/__tests__/node-type-registry.test.ts`（已存在，扩展）

**Interfaces:**
- Consumes: 无
- Produces:
  - IPC `nodeType:listConfigs: () => Promise<NodeTypeConfig[]>`——返回主进程 registry 的全部类型配置
  - `nodeTypeRegistry.validateParentChild(parentType, childType)` 补全后成为唯一权威
  - 渲染端通过 `useNodeTypeConfigs()` hook 获取规则

**registry 补全后的权威规则表**（spec §4.6，实施时按此表逐字对齐）：

| 类型 | allowedChildTypes | allowedParentTypes | 现状 |
|---|---|---|---|
| project | `['module']` | — | 已符合 |
| module | `['process', 'wiki-page']` | `['project']` | 已符合 |
| process | `['feature', 'bug', 'wiki-page']` | `['module']` | 已符合 |
| feature | `['bug']` | `['process']` | **缺 allowedChildTypes** |
| bug | `[]` | `['process', 'feature']` | **缺 allowedChildTypes**；且 `allowedParentTypes` 要补 `'feature'` |
| wiki-page | `['wiki-page']` | `['project', 'module', 'process', 'wiki-page']` | 已符合 |

`feature` / `bug` 缺 `allowedChildTypes` 意味着 `validateParentChild` 里的 `if (parent.allowedChildTypes && ...)` 短路放行——**任何类型都能挂到 feature/bug 下**。补 `bug` 为 `[]` 后，`[]` 是 truthy，`![].includes(childType)` → 拒绝全部子节点。✓

⚠️ `validateParentChild`（`node-type-registry.ts:53`）是**双向**校验：父的 `allowedChildTypes` 与子的 `allowedParentTypes` 都要放行才算通过。所以只把 `feature.allowedChildTypes` 设成 `['bug']` 是不够的——`bug.allowedParentTypes` 原本只有 `['process']`，`validateParentChild('feature','bug')` 仍会因 `child.allowedParentTypes` 不含 `'feature'` 返回 false。**`bug.allowedParentTypes` 必须同步改成 `['process', 'feature']`**，否则下面「feature can have bug children」那条用例在改完 registry 后依然会失败。

- [ ] **Step 1: Write the failing test**

在 `src/main/shared/__tests__/node-type-registry.test.ts` 追加：

```ts
it('module cannot have feature children', () => {
  expect(nodeTypeRegistry.validateParentChild('module', 'feature')).toBe(false)
})

it('feature can have bug children', () => {
  expect(nodeTypeRegistry.validateParentChild('feature', 'bug')).toBe(true)
})

it('bug cannot have any children', () => {
  expect(nodeTypeRegistry.validateParentChild('bug', 'feature')).toBe(false)
  expect(nodeTypeRegistry.validateParentChild('bug', 'process')).toBe(false)
})

it('feature cannot be a child of module', () => {
  expect(nodeTypeRegistry.validateParentChild('feature', 'module')).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/shared/__tests__/node-type-registry.test.ts`
Expected: FAIL —— `feature` 的 `allowedChildTypes` 未定义（允许任意），`bug` 同理

- [ ] **Step 3: Complete the registry**

`src/main/shared/node-type-registry.ts` 的 `builtin` 数组（:19-41），改两行：

```ts
{ type: 'feature', label: '功能点', defaultStatus: 'placeholder', allowedParentTypes: ['process'], allowedChildTypes: ['bug'] },
{ type: 'bug', label: 'BUG点', defaultStatus: 'draft', allowedParentTypes: ['process', 'feature'], allowedChildTypes: [] },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/shared/__tests__/node-type-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Expose the registry over IPC**

新建 `src/main/ipc/node-type.ts`：

```ts
import type { TypedHandle } from './utils'
import { nodeTypeRegistry } from '../shared/node-type-registry'

export function registerNodeTypeIpcHandlers(typedHandle: TypedHandle): void {
  typedHandle('nodeType:listConfigs', async () =>
    // behavior 字段含函数（NodeTypeBehavior），不可结构化克隆 —— 必须剥掉
    nodeTypeRegistry.listConfigs().map(({ behavior: _behavior, ...rest }) => rest),
  )
}
```

`src/shared/types/ipc.ts` 的 `IpcApi` 增：
```ts
  'nodeType:listConfigs': () => Promise<NodeTypeConfig[]>
```
（`NodeTypeConfig` 需要加入该文件顶部 `@shared/types/graph` 的 import 列表。）

`src/preload/index.ts` 的 `exposedChannels` 数组增 `'nodeType:listConfigs',`。

`src/main/ipc-handlers.ts`：
- 顶部 `import { registerNodeTypeIpcHandlers } from './ipc/node-type'`
- 在 `registerSubagentHandlers(...)`（:481）附近调用 `registerNodeTypeIpcHandlers(typedHandle)`（`typedHandle` 是 `ipc-handlers.ts:284` 创建的单一实例，被所有 handler 组共用）

- [ ] **Step 6: Replace the renderer's hardcoded rules**

`src/renderer/canvas/NodeContextMenu.tsx`：
- 删除 `getChildTypeOptions` 函数（:38-55）
- 改为接收 `allowedChildTypes: string[]` prop

`src/renderer/canvas/GraphCanvas.tsx` 传入该 prop。

新建渲染端 hook `src/renderer/canvas/hooks/useNodeTypeConfigs.ts`：

```ts
export interface NodeTypeConfigsState {
  /** 类型名 → 配置。IPC 未返回前是空表 */
  configs: Record<string, NodeTypeConfig>
  /** 规则表是否已就绪。成功与失败都算就绪——失败时 `configs` 是空表 */
  loaded: boolean
}

export function useNodeTypeConfigs(): NodeTypeConfigsState {
  const [state, setState] = useState<NodeTypeConfigsState>({ configs: {}, loaded: false })
  useEffect(() => {
    let cancelled = false
    void window.electronAPI['nodeType:listConfigs']().then((list) => {
      if (!cancelled) setState({ configs: Object.fromEntries(list.map(c => [c.type, c])), loaded: true })
    }).catch(() => {
      // 取不到规则表 → 空表。空表语义是「所有类型都拒绝」：宁可不给可选项，
      // 也不放行未知规则。这与主进程 validateParentChild 对未知类型返回 false 的语义一致。
      if (!cancelled) setState({ configs: {}, loaded: true })
    })
    return () => { cancelled = true }
  }, [])
  return state
}
```

⚠️ `loaded` 不是可选字段——Task 10 的拖拽重挂靠它区分「规则还没到」与「规则判定为不合法」。少了它，规则表未就绪的短暂窗口里所有落点都会被误判成红色。

`NodeTypeConfig` 已经在 `@shared/types` 里（`src/shared/types/graph.ts:513`），`behavior?: unknown` 是渲染安全的——渲染端 hook 与 `src/shared/types/ipc.ts` 都从 `@shared/types` import，不用碰 `src/main/shared/node-type-registry`。

`src/renderer/canvas/GraphCanvas.tsx` 传入该 prop 的算法（`nodeContextMenu` 是 GraphCanvas 里已有的 state，见 :262）：

```ts
const { configs } = useNodeTypeConfigs()
const contextTargetNode = nodeContextMenu
  ? graphNodes.find((n) => n.id === nodeContextMenu.nodeId)
  : undefined
const allowedChildTypes = contextTargetNode?.type
  ? (configs[contextTargetNode.type]?.allowedChildTypes ?? [])
  : []
```

然后 `<NodeContextMenu … allowedChildTypes={allowedChildTypes} />`。`NodeContextMenu` 内部用这个 prop 取代 `getChildTypeOptions(node.type)` 的返回值。

- [ ] **Step 7: Type-check and test**

Run: `npx tsc --noEmit && npx vitest run src/main/shared/__tests__/node-type-registry.test.ts`
Expected: 零错误，测试全绿

- [ ] **Step 8: Commit**

```bash
git add src/main/shared/node-type-registry.ts src/main/ipc/node-type.ts src/main/ipc-handlers.ts src/shared/types/ipc.ts src/preload/index.ts src/renderer/canvas/NodeContextMenu.tsx src/renderer/canvas/GraphCanvas.tsx src/renderer/canvas/hooks/useNodeTypeConfigs.ts src/main/shared/__tests__/node-type-registry.test.ts
git commit -m "refactor(canvas): 类型层级规则统一到 nodeTypeRegistry 并经 IPC 暴露"
```

---

## Task 6: `graph:reparent` 服务与校验

**Files:**
- Create: `src/main/shared/hierarchy-utils.ts`
- Create: `src/main/services/hierarchy-service.ts`
- Create: `src/main/services/__tests__/hierarchy-service.test.ts`
- Modify: `src/main/errors.ts`（新错误码 + `HierarchyError`）
- Modify: `src/main/ipc/graph.ts`（注册 IPC）
- Modify: `src/shared/types/graph.ts`（`ReparentResult`）
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: Task 5 的 `nodeTypeRegistry.validateParentChild(parentType, childType)`
- Produces:
  ```ts
  // src/main/services/hierarchy-service.ts
  export interface ReparentResult {
    nodeId: string
    oldParentId: string | null
    newParentId: string
    /** 被移动的节点及其全部后代的最新位置 */
    movedPositions: Array<{ id: string; x: number; y: number }>
  }

  export class HierarchyService {
    constructor(private readonly db: BetterSqlite3.Database) {}
    reparent(nodeId: string, newParentId: string): ReparentResult
  }
  ```
  校验失败抛 `HierarchyError`（继承 `BizGraphError`，覆写 `toJSON()`），`code` 取自新增的 `ErrorCode.HIERARCHY_*`。

  `ReparentResult` 定义在 `src/shared/types/graph.ts`（renderer 也要用），**不要**定义在 `@main`。

  ```ts
  // src/main/shared/hierarchy-utils.ts
  /**
   * ancestorId 是否为 childId 的后代（含自身）。
   * parentOf 由调用方提供——可以是数据库查询，也可以是内存映射。
   * 沿 parentId 上溯，带 visited 集合防死循环（存量孤儿数据可能成环）。
   */
  export function isDescendant(
    ancestorId: string,
    childId: string,
    parentOf: (id: string) => string | null | undefined,
  ): boolean
  ```
  纯函数、不碰数据库。Task 6 与 Task 8 共用它——防环逻辑只写一份，Task 8 的 AI 写入路径把 `parentOf` 换成内存映射即可复用。

- [ ] **Step 1: Write the failing test**

新建 `src/main/services/__tests__/hierarchy-service.test.ts`。用真实 better-sqlite3 建最小 schema（nodes + edges 两表），fixture：

```
nodes:
p1 (project, parent NULL)
m1 (module,  parent p1)
m2 (module,  parent p1)
c1 (process, parent m1)
f1 (feature, parent c1)

edges（4 条初始层级边，与 parent_id 一致）:
(p1,m1) (m1,c1) (c1,f1) (p1,m2)
```

⚠️ **fixture 的 INSERT 必须写全列名**，不能写 `INSERT INTO nodes VALUES (...)`：`nodes` 表在 Task 2 之后是 **13 列**（`id, type, status, title, graph_id, graph_type, parent_id, sort_index, collapsed, position_x, position_y, created_at, updated_at`），省略列名的写法一加列就报「table nodes has 13 columns but 11 values were supplied」。测试里 CREATE TABLE 的列清单也要跟这 13 列一致。edges 表至少要有 `id, source, target, edge_type, graph_id` 五列。

⚠️ **fixture 里的兄弟节点要写显式 `sort_index`**（同一父节点下 0,1,2,…）：不写的话全是 NULL，reparent 的 `COALESCE(MAX(sort_index), -1) + 1` 取到 0，测到的就变成「从零开始」而不是「重排」，用例会失去区分度。

测试用例：

```ts
describe('HierarchyService.reparent', () => {
  it('moves a node to a new parent', () => {
    const svc = new HierarchyService(db)
    const res = svc.reparent('m2', 'm1')
    expect(res.newParentId).toBe('m1')
    const row = db.prepare("SELECT parent_id FROM nodes WHERE id='m2'").get() as { parent_id: string }
    expect(row.parent_id).toBe('m1')
  })

  it('updates the hierarchical edge in the same transaction', () => {
    const svc = new HierarchyService(db)
    svc.reparent('m2', 'm1')
    const rows = db.prepare("SELECT source, target FROM edges WHERE edge_type='hierarchical'").all() as { source: string; target: string }[]
    expect(rows).toContainEqual({ source: 'm1', target: 'm2' })
    expect(rows).not.toContainEqual({ source: 'p1', target: 'm2' })
  })

  it('rejects reparenting a node under its own descendant', () => {
    const svc = new HierarchyService(db)
    expect(() => svc.reparent('m1', 'f1')).toThrow()
    try { svc.reparent('m1', 'f1') } catch (e) {
      expect((e as any).code).toBe(ErrorCode.HIERARCHY_CYCLE)
    }
  })

  it('rejects reparenting a node under itself', () => {
    const svc = new HierarchyService(db)
    try { svc.reparent('m1', 'm1'); expect.unreachable() } catch (e) {
      expect((e as any).code).toBe(ErrorCode.HIERARCHY_SELF_PARENT)
    }
  })

  it('rejects a type-invalid reparent', () => {
    const svc = new HierarchyService(db)
    try { svc.reparent('f1', 'm1'); expect.unreachable() } catch (e) {
      expect((e as any).code).toBe(ErrorCode.HIERARCHY_TYPE_INVALID)
    }
  })

  it('rejects a cross-graph reparent', () => {
    const svc = new HierarchyService(db)
    db.prepare(
      "INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run('x1', 'feature', 'draft', '跨图', 'g2', 'dev', null, 0, 0, 't', 't')
    try { svc.reparent('x1', 'c1'); expect.unreachable() } catch (e) {
      expect((e as any).code).toBe(ErrorCode.HIERARCHY_CROSS_GRAPH)
    }
  })

  it('moves the whole subtree when reparenting', () => {
    const svc = new HierarchyService(db)
    const res = svc.reparent('c1', 'm2')
    const ids = res.movedPositions.map(p => p.id).sort()
    expect(ids).toEqual(['c1', 'f1'])
  })

  it('renumbers sibling sort_index', () => {
    const svc = new HierarchyService(db)
    svc.reparent('m2', 'm1')
    const row = db.prepare("SELECT sort_index FROM nodes WHERE id='m2'").get() as { sort_index: number }
    expect(row.sort_index).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/__tests__/hierarchy-service.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: Add error codes and the error class**

`src/main/errors.ts` 的 `ErrorCode` 增：

```ts
  // 层级结构（父子关系）
  HIERARCHY_CYCLE: 'HIERARCHY_CYCLE',
  HIERARCHY_TYPE_INVALID: 'HIERARCHY_TYPE_INVALID',
  HIERARCHY_CROSS_GRAPH: 'HIERARCHY_CROSS_GRAPH',
  HIERARCHY_SELF_PARENT: 'HIERARCHY_SELF_PARENT',
```

并在 `IpcError` 类之后新增：

```ts
/** 层级结构操作失败（防环 / 类型 / 跨图 / 自环） */
export class HierarchyError extends BizGraphError {
  readonly details?: Record<string, unknown>

  constructor(message: string, code: ErrorCodeType, details?: Record<string, unknown>) {
    super(message, code)
    this.name = 'HierarchyError'
    this.details = details
    Object.setPrototypeOf(this, HierarchyError.prototype)
  }

  toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), details: this.details }
  }
}
```

（`Object.setPrototypeOf` 是必须的——照 `IpcError` / `AdapterError` 的写法，不修原型链会导致 `instanceof` 失效。）

- [ ] **Step 4: Implement `isDescendant` and `HierarchyService`**

先新建 `src/main/shared/hierarchy-utils.ts`（纯函数，无数据库依赖）：

```ts
export function isDescendant(
  ancestorId: string,
  childId: string,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  if (ancestorId === childId) return true
  const visited = new Set<string>()
  let cur: string | null | undefined = parentOf(childId)
  while (cur) {
    if (visited.has(cur)) return false
    visited.add(cur)
    if (cur === ancestorId) return true
    cur = parentOf(cur)
  }
  return false
}
```

再新建 `src/main/services/hierarchy-service.ts`。`reparent(nodeId, newParentId)` 的执行顺序：

1. 读节点与新父节点，都不存在则抛 `IpcError`
2. `nodeId === newParentId` → `HIERARCHY_SELF_PARENT`
3. `graph_id` 不同 → `HIERARCHY_CROSS_GRAPH`（**比 `graph_id`，不是 `graph_type`**——同一张图里可以同时有 `graph_type='online'` 和 `'dev'` 的节点，spec §4.4.1）
4. **防环**：调 `isDescendant(nodeId, newParentId, parentOf)`（`src/main/shared/hierarchy-utils.ts`），`parentOf` 是查 `nodes.parent_id` 的函数。返回 true → `HIERARCHY_CYCLE`。上溯自带 `visited` 集合，存量孤儿数据成环时不会死循环
5. **类型校验**：`nodeTypeRegistry.validateParentChild(newParent.type, node.type)` 为 false → `HIERARCHY_TYPE_INVALID`
6. 事务开始：
   - `UPDATE nodes SET parent_id = ? WHERE id = ?`
   - 新的 `sort_index` = 目标父节点现有子节点最大 `sort_index` + 1，取值写 `COALESCE(MAX(sort_index), -1) + 1`（`COALESCE` 不能省：兄弟全为 NULL 时 `MAX` 返回 NULL，`NULL + 1` 在 SQLite 里仍是 NULL → 被移动的子节点会落到布局的「undefined 排最后」兜底里，位置不确定）
   - 旧的 `hierarchical` 边（`source = oldParentId, target = nodeId`）→ `UPDATE edges SET source = ? WHERE id = ?`；若旧父为 NULL 或无对应边则 `DELETE` / `INSERT`
   - 若目标 `hierarchical` 边不存在则 INSERT，边 ID 用 `generateId('edge')`（`src/main/shared/env.ts:78`）
   - 原父节点的其余子节点 `sort_index` 重排为连续值
   - **子树跟随**：收集 `nodeId` 及其全部后代（沿 `parent_id` 下行），整体平移到新父节点的子树区域末端，计算新坐标并 `UPDATE nodes SET position_x = ?, position_y = ?`，同时返回 `movedPositions`
   - 事务提交

子树平移的具体算法由实施者决定，只要满足：整体保持相对位置、不与目标父节点的其他子节点重叠。推荐做法：以目标父节点现有子节点的包围盒为基准，把子树整体放到该包围盒下方。

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/services/__tests__/hierarchy-service.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 6: Register the IPC**

`src/main/ipc/graph.ts` 增 handler（`registerGraphHandlers` 内部，`node:update` 附近）：

```ts
typedHandle('graph:reparent', async (_, nodeId: string, newParentId: string) => {
  return new HierarchyService(db).reparent(nodeId, newParentId)
})
```

`src/shared/types/graph.ts` 增 `ReparentResult` 接口（同文件 `GraphEdge` 附近）。

`src/shared/types/ipc.ts` 的 `IpcApi` 增：
```ts
  'graph:reparent': (nodeId: string, newParentId: string) => Promise<ReparentResult>
```
（`ReparentResult` 需要加入该文件顶部 `@shared/types/graph` 的 import 列表。）

`src/preload/index.ts` 的 `exposedChannels` 数组增 `'graph:reparent',`。

- [ ] **Step 7: Commit**

```bash
git add src/main/shared/hierarchy-utils.ts src/main/services/hierarchy-service.ts src/main/services/__tests__/hierarchy-service.test.ts src/main/errors.ts src/main/ipc/graph.ts src/shared/types/graph.ts src/shared/types/ipc.ts src/preload/index.ts
git commit -m "feat(canvas): graph:reparent 单一入口，含防环与类型校验"
```

---

## Task 7: 关闭 `node:update` 的 parentId 旁路

**Files:**
- Modify: `src/main/ipc/graph.ts`（`validateNodeUpdate`，:131）
- Modify: `src/main/repositories/node-repository.ts`（清理 `updateParentId`，:210）
- Test: `src/main/ipc/__tests__/graph-node-update.test.ts`（新建）

**Interfaces:**
- Consumes: Task 6 的 `ErrorCode.HIERARCHY_*`
- Produces: `node:update` 拒绝携带 `parentId`；`nodeRepository.updateParentId` 移除

已核实：仓库内**无任何现有调用方**传 `parentId` 给 `node:update`（`useNodeOperations.ts` 的 `handleEnrichNode` 只传 metadata/acceptanceCriteria/rules、`handleStartDev` 只传 status、NodeEditor 只读）。`nodeRepository.updateParentId` 零调用方，可直接删。

⚠️ `node-repository.ts:163` 的 `if (data.parentId !== undefined) { updates.push('parent_id = ?') }` **要保留**——`graph:reparent` 走的是 `hierarchy-service.ts` 的裸 SQL，但 Yjs 远端更新路径（`bidirectional-sync.ts:67` → `nodeRepo.update`）仍经由 repository 层，删了会打断协作同步。

- [ ] **Step 1: Write the failing test**

`validateNodeUpdate` 目前是 `registerGraphHandlers` 里的**内部函数**（`src/main/ipc/graph.ts:131`，闭包在 `:41-460` 内）。**先把它提升到模块作用域并 `export`**——它和它依赖的 `validateNodeContent`（`:90`）、`MAX_TITLE_LEN` / `MAX_DESCRIPTION_LEN`（`:70-71`）都是纯函数，不依赖任何闭包变量，提升是安全的。

然后在 `src/main/ipc/__tests__/` 下新建 `graph-node-update.test.ts` 直接测它——主进程测试跑在 vitest 的 `node` 环境，没有 `window`，走 `window.electronAPI` 的写法跑不起来：

```ts
import { describe, it, expect } from 'vitest'
import { validateNodeUpdate } from '../graph'

describe('validateNodeUpdate', () => {
  it('rejects a payload that changes parentId', () => {
    expect(() => validateNodeUpdate('n1', { parentId: 'n2' })).toThrow(/parentId/)
  })

  it('still accepts a payload that changes collapsed', () => {
    expect(() => validateNodeUpdate('n1', { collapsed: true })).not.toThrow()
  })
})
```

第二条是护栏：`collapsed` / `sortIndex` 必须能经 `node:update` 落库（Task 12 的折叠持久化走这条路），不能被这条新规则误伤。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/ipc/__tests__/`
Expected: FAIL —— 当前 `node:update` 接受 `parentId`

- [ ] **Step 3: Block parentId in validateNodeUpdate**

`src/main/ipc/graph.ts` 的 `validateNodeUpdate`（:131，已在 Step 1 提升到模块作用域）里加：

```ts
    if (node.parentId !== undefined) {
      throw new IpcError(
        'parentId cannot be changed via node:update; use graph:reparent',
        ErrorCode.IPC_INVALID_ARGUMENT,
      )
    }
```

- [ ] **Step 4: Remove the unused repository method**

删除 `src/main/repositories/node-repository.ts:210` 的 `updateParentId` 方法（零调用方）。

- [ ] **Step 5: Verify no caller broke**

Run: `npx tsc --noEmit && npx vitest run src/main/ipc/__tests__/ src/renderer/store/__tests__/`
Expected: 零错误，测试全绿

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/graph.ts src/main/repositories/node-repository.ts src/main/ipc/__tests__/graph-node-update.test.ts
git commit -m "refactor(canvas): 关闭 node:update 的 parentId 旁路"
```

---

## Task 8: 补建层级边（手动 / AI / 扫描三条写入路径）

**Files:**
- Modify: `src/renderer/canvas/hooks/useNodeOperations.ts`（`handleAddChild`、`handleGenerateChildren`）
- Modify: `src/main/project-analyzer.ts`（层级边改写 `hierarchical`）
- Modify: `src/main/services/graph-service.ts`（AI 路径补建层级边 + 防环校验 + 分配 `sort_index`）
- Test: `src/renderer/canvas/hooks/__tests__/useNodeOperations.test.ts`（新建）
- Test: `src/main/services/__tests__/graph-service-sort-index.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `EdgeType` 含 `'hierarchical'`；Task 3 的 `deriveHierarchyEdges`（渲染侧保证即使漏建边也有连线）
- Produces: 三条写入路径产出的层级边类型统一为 `hierarchical`

**已核实的写入点**：
- `project-analyzer.ts:74 / :105 / :132` —— 三处 `edgeType: 'default'` **全部是层级边**（project→module、module→process、process→feature）。改为 `'hierarchical'`。同文件 `:384` 的 `'condition'` 是语义边，不动。
- `graph-service.ts:508` —— `edgeData.edgeType ?? 'default'`，是 AI 结果的边落库处。生产者改了类型，这里自动跟随，**不需要改**。同文件 `:541` / `:605` 的 `'default'` 是 `suggestEdges` 的代码 import 语义边，**不动**。
- `graph-service.ts:489-498` —— 第二轮写 `parent_id`，是真相源写入，保持。
- `useNodeOperations.ts:handleAddChild` —— 只写 `parentId` 不建边，**这是裂缝 1 的根因**。

- [ ] **Step 1: Write the failing test**

新建 `src/renderer/canvas/hooks/__tests__/useNodeOperations.test.ts`。

⚠️ **两个 mock 的形状不能照抄隔壁文件**：

1. `useNodeOperations` 用的是 **selector 形式**的 store——`useGraphStore((state) => state.nodes)`（`useNodeOperations.ts:14-16`）。隔壁 `useNodePositionPersistence.test.ts` mock 的是 `{ getState: vi.fn() }`（那是 `getState` 形式），照抄会直接报 `useGraphStore is not a function`。
2. `useReactFlow()` 在没有 `<ReactFlowProvider />` 时会抛 `Please make sure that you wrap the app in a <ReactFlowProvider />`——必须 mock 掉。

`useI18n` **不用 mock**——`I18nContext` 有可用的默认值（`src/renderer/i18n/context.ts:17`）。

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useNodeOperations } from '../useNodeOperations'

const { mockState } = vi.hoisted(() => ({
  mockState: {
    nodes: [] as unknown[],
    createNode: vi.fn(),
    createEdge: vi.fn(),
    updateNode: vi.fn(),
  },
}))

vi.mock('../../../store/graphStore', () => ({
  useGraphStore: (selector: (s: unknown) => unknown) => selector(mockState),
}))

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ screenToFlowPosition: (p: { x: number; y: number }) => p }),
}))

describe('useNodeOperations — 补建层级边', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.nodes = []
    mockState.createNode.mockResolvedValue({ id: 'child1' })
    mockState.createEdge.mockResolvedValue({ id: 'edge1' })
  })

  it('creates a hierarchical edge when adding a child', async () => {
    const { result } = renderHook(() => useNodeOperations('g1'))
    await result.current.handleAddChild('parent1', 'module')

    expect(mockState.createNode).toHaveBeenCalledTimes(1)
    expect(mockState.createNode.mock.calls[0][0]).toMatchObject({ parentId: 'parent1' })
    expect(mockState.createEdge).toHaveBeenCalledTimes(1)
    expect(mockState.createEdge.mock.calls[0][0]).toMatchObject({
      source: 'parent1',
      target: 'child1',
      edgeType: 'hierarchical',
    })
  })

  it('creates a hierarchical edge for each AI-generated child', async () => {
    mockState.nodes = [{ id: 'parent1', title: 'P', type: 'module', position: { x: 0, y: 0 } }]
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      'mindmap:generateModule': vi.fn().mockResolvedValue({
        children: [{ title: 'C1' }, { title: 'C2' }],
        childType: 'process',
      }),
    }
    const { result } = renderHook(() => useNodeOperations('g1', '/proj'))
    await result.current.handleGenerateChildren('parent1')

    expect(mockState.createNode).toHaveBeenCalledTimes(2)
    expect(mockState.createEdge).toHaveBeenCalledTimes(2)
    expect(mockState.createEdge.mock.calls[0][0]).toMatchObject({
      source: 'parent1',
      target: 'child1',
      edgeType: 'hierarchical',
    })
  })
})
```

再新建 `src/main/services/__tests__/graph-service-sort-index.test.ts` —— 覆盖**第三条写入路径**（`initFromProject` → `graph-service.createNodes`）。

⚠️ **这条路径必须用真实库**：它写的是 `nodes` 表的全部 21 个列，mock DB 断言不到「写进去的 `sort_index` 是几」。electron mock + `initDatabase()` 照抄 Task 11 Step 1 的写法（那里已有现成模式）。

`initFromProject` 走真实写入路径的两个前提：
- `ProjectScanner` 与 `ProjectAnalyzer` 都要 mock（相对本测试文件的路径：`'../../project-scanner'` / `'../../project-analyzer'`）——`ProjectAnalyzer.analyze()` 是**纯函数**（`project-analyzer.ts:43`），mock 掉它不影响被测的写入路径。
- **不要传 `agentManager`**：`initFromProject` 只有在 `agentManager` 存在时才走 L3 AI 增强（`graph-service.ts:191`），不传就跳过，模块列表直接用扫描结果 → 写入路径是确定性的。

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-graph-svc-sort-' + process.pid)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? TEST_USER_DATA : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

const mockScanResult = {
  projectName: 'Test Project',
  projectPath: '/project',
  framework: 'react',
  packageJson: null,
  modules: [
    {
      name: 'M1',
      description: 'module one',
      processes: [{ name: 'P1', description: 'process one', features: [] }],
    },
  ],
}

// 一个父节点 P1 + 三个兄弟 C1/C2/C3（数组顺序 = analyzer 的输出顺序）
const mockGraphResult = {
  projectName: 'Test Project',
  projectPath: '/project',
  framework: 'react',
  nodes: [
    { tempId: 'root', type: 'project', status: 'confirmed', title: 'Root', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], ownerRole: 'product' },
    { tempId: 'p1', type: 'module', status: 'draft', title: 'P1', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], parentTempId: 'root', ownerRole: 'product' },
    { tempId: 'c1', type: 'process', status: 'draft', title: 'C1', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], parentTempId: 'p1', ownerRole: 'product' },
    { tempId: 'c2', type: 'process', status: 'draft', title: 'C2', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], parentTempId: 'p1', ownerRole: 'product' },
    { tempId: 'c3', type: 'process', status: 'draft', title: 'C3', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], parentTempId: 'p1', ownerRole: 'product' },
  ],
  edges: [],
}

vi.mock('../../project-scanner', () => ({
  ProjectScanner: vi.fn().mockImplementation(function () {
    return { scan: vi.fn().mockResolvedValue(mockScanResult) }
  }),
}))

vi.mock('../../project-analyzer', () => ({
  ProjectAnalyzer: vi.fn().mockImplementation(function () {
    return { analyze: vi.fn().mockReturnValue(mockGraphResult) }
  }),
}))

import { initDatabase, closeDatabase, getClient } from '../../database'
import { GraphService } from '../graph-service'

describe('GraphService.createNodes — 兄弟顺序', () => {
  let db: ReturnType<typeof getClient>

  beforeAll(() => {
    initDatabase()
    db = getClient()
  })

  afterAll(() => {
    closeDatabase()
  })

  it('assigns consecutive sort_index to siblings written by the scan path', async () => {
    const service = new GraphService(db)
    const { onlineGraph } = await service.initFromProject({
      projectPath: '/project',
      projectName: 'Test Project',
    })

    const parent = db
      .prepare("SELECT id FROM nodes WHERE graph_id = ? AND title = 'P1'")
      .get(onlineGraph.id) as { id: string }
    const rows = db
      .prepare('SELECT title, sort_index FROM nodes WHERE parent_id = ? ORDER BY sort_index')
      .all(parent.id) as { title: string; sort_index: number }[]

    expect(rows.map((r) => r.title)).toEqual(['C1', 'C2', 'C3'])
    expect(rows.map((r) => r.sort_index)).toEqual([0, 1, 2])
  })
})
```

⚠️ `initFromProject` 给 online 与 dev 两张图**各写一遍节点**，所以查询必须限定到一张图（上面用 `graph_id` 找父节点、再按 `parent_id` 取子节点）——否则 dev 图的同名节点会混进来。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/canvas/hooks/__tests__/useNodeOperations.test.ts src/main/services/__tests__/graph-service-sort-index.test.ts`
Expected: 两个都 FAIL —— 渲染层当前不建边；主进程扫描路径当前不写 `sort_index`（兄弟的 `sort_index` 全是 NULL）

- [ ] **Step 3: Make handleAddChild build the edge**

`src/renderer/canvas/hooks/useNodeOperations.ts` 的 `handleAddChild`：把 `await createNode({...})` 的返回值接住，然后建边：

```ts
const created = await createNode({ ... })
await createEdge({
  source: parentId,
  target: created.id,
  graphId,
  edgeType: 'hierarchical',
})
```

（`createNode` 返回 `Promise<GraphNode>`，见 `graphStore.ts:215` 的 `return serverItem`。`createEdge` 的入参是 `Omit<GraphEdge, 'id'>`。）

`handleGenerateChildren` 同理——每个 AI 生成的子节点都要建 `hierarchical` 边（在 `createNode` 之后紧跟着建，边用同一个 `created.id` 作 target）。

`createEdge` 从 store 取：`const createEdge = useGraphStore((state) => state.createEdge)`——与 `createNode` / `updateNode` 同样的 selector 形式（`useNodeOperations.ts:14-16` 那一组）。

- [ ] **Step 4: Switch the AI and scan write paths**

`src/main/project-analyzer.ts` 的 `:74` / `:105` / `:132` 三处 `edgeType: 'default'` 改为 `edgeType: 'hierarchical'`。

`src/main/services/graph-service.ts`：在第二轮写完 `parent_id`（:489-498）之后、第三轮建边（:500）之后，加一步「确保每个有 parent_id 的节点都有对应的 hierarchical 边」：

```ts
// 第四轮：确保每个有 parent_id 的节点都有 hierarchical 边
for (const nodeData of graphResult.nodes) {
  if (!nodeData.parentTempId) continue
  const sourceId = tempIdMap.get(nodeData.parentTempId)
  const targetId = tempIdMap.get(nodeData.tempId)
  if (!sourceId || !targetId) continue
  const exists = db.prepare(
    "SELECT 1 FROM edges WHERE source=? AND target=? AND edge_type='hierarchical'"
  ).get(sourceId, targetId)
  if (exists) continue
  insertEdgeStmt.run(generateId('edge'), sourceId, targetId, null, 'hierarchical', graphId, null, null, null)
}
```

这让 AI 生成路径不依赖 `graphResult.edges` 里是否带了层级边——`parent_id` 有就一定有层级边。

⚠️ 上面的代码是**示意**。`insertEdgeStmt` 的列顺序与占位符数量必须照 `graph-service.ts` 里那条语句的**实际定义**写——照抄示意里的参数顺序会把 `edge_type` 写进别的列。实施时先读那条语句的真实绑定顺序。

---

⚠️ **第二轮要一起写 `sort_index`（spec §4.8）——这条路径绕过了 `NodeRepository.create()`**

`graph-service.ts:428` 的 `createNodes` 是**裸 SQL 写入**：自己 `prepare` INSERT、自己 `UPDATE parent_id`，**不经过 `NodeRepository`**。所以 Task 11 给 `NodeRepository.create()` / `createBatch()` 补的「新建子节点取 `max(兄弟) + 1`」**覆盖不到这条路径**。不写的话，这条路径建出来的子节点 `sort_index` 全是 NULL，后果是**兄弟顺序错乱**：

- 画布布局把 `sortIndex` 为 `undefined` 的节点排在**最后**（Task 11 的兜底规则）。用户随后手动加一个子节点 C3（Task 11 给了它 `COALESCE(MAX(sort_index), -1) + 1`——而兄弟全是 NULL，`MAX` 返回 NULL，`COALESCE` 兜到 -1 → C3 拿到 **0**）→ 布局把 C3 排到**最前**，C1/C2（undefined）排到最后 → **后建的节点跑到了前面**。
- 下次启动的迁移（R-11 修法后只补 NULL）也救不回来：本路径的节点有层级边（第四轮补的）→ 落在 tier-0 → 按边 rowid 排出 `C1=0, C2=1`，而 C3 已经**占着 0** → 撞号，顺序仍然不确定。

实现要点：
- **第二轮**（`graph-service.ts:489-497` 写 `parent_id` 的那轮）里，同一父节点的多个子节点要拿**连续**的 `sort_index`（0, 1, 2…）——批内递增，不要每个子节点都去查一次库。
- 基准值 = 该父节点**已有**子节点的最大 `sort_index` + 1，写法 `COALESCE(MAX(sort_index), -1) + 1`（`COALESCE` 不能省：兄弟全为 NULL 时 `MAX` 返回 NULL，`NULL + 1` 在 SQLite 里仍是 NULL）。本方法建的是**全新图**（`initFromProject` 每次新建 online/dev 两张图），所以通常是 0 起步，但基准值仍要按公式取，不要写死 0。
- **兄弟顺序 = `graphResult.nodes` 里同父节点的「出现顺序」**（analyzer 的 dagre 布局顺序）。它同时也是第四轮补边的插入顺序——两者必须一致，否则迁移按边 rowid 排出的顺序会与 `sort_index` 打架（R-11 的教训：两套顺序源必须同源）。

- [ ] **Step 5: Add cycle checks to the AI write path**

`src/main/services/graph-service.ts` 的第二轮（写 `parent_id`）与 `project-analyzer.ts` 写 `parentTempId` 处：写入前检查新父节点不是自己的后代。AI 路径**不加类型校验**（spec §4.4.3：批量生成，逐个校验会让整次生成失败）。

防环检查**必须复用 Task 6 的 `isDescendant`**（`src/main/shared/hierarchy-utils.ts`），不要在这里另写一份上溯逻辑：
- `graph-service.ts`：`isDescendant(nodeId, parentId, (id) => 已落库节点的 parent_id)`
- `project-analyzer.ts`：`isDescendant(nodeId, parentTempId, (id) => 内存里 tempId → parentTempId 的映射)`——`parentOf` 做成回调正是为了让内存映射与数据库查询共用同一个函数

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/renderer/canvas/hooks/__tests__/ src/main/ipc/__tests__/mindmap.test.ts src/main/services/__tests__/graph-service-sort-index.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/canvas/hooks/useNodeOperations.ts src/renderer/canvas/hooks/__tests__/ src/main/project-analyzer.ts src/main/services/graph-service.ts src/main/services/__tests__/graph-service-sort-index.test.ts
git commit -m "fix(canvas): 手动加子节点补建层级边，AI 与扫描路径边类型化"
```

---

## Task 9: 克隆路径同步新列与层级边

**Files:**
- Modify: `src/main/repositories/graph-repository.ts`（`cloneGraphNodes`，:214）
- Test: `src/main/repositories/__tests__/graph-repository-clone.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `nodes.sort_index` / `nodes.collapsed` 列
- Produces: `graph:derive` 产出的 dev 图保留 `sort_index`、`collapsed` 重置为 0、`hierarchical` 边与 `parent_id` 一致

- [ ] **Step 1: Write the failing test**

⚠️ **新建 `src/main/repositories/__tests__/graph-repository-clone.test.ts`，不要往 `src/main/__tests__/graph-repository.test.ts` 里加**——后者是 **mock db** 的单元测试（`createMockDb()` 把 `prepare` 换成 `vi.fn()`），克隆路径是多语句读写，mock 测不出真实行为。必须用真实 better-sqlite3。electron mock 照抄 `src/main/__tests__/database-migration.test.ts`（那里已有现成模式）。

被测单元是 **`GraphRepository.cloneGraphNodes(sourceGraphId, targetGraphId, targetGraphType)`**（`graph-repository.ts:214`），不是 `GraphService.deriveGraph`——后者还包了建 dev 图等与本任务无关的步骤。

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-graph-clone-test-' + process.pid)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? TEST_USER_DATA : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../../database'
import { GraphRepository } from '../graph-repository'

describe('GraphRepository.cloneGraphNodes — 新列与层级边', () => {
  let db: ReturnType<typeof getClient>
  let repo: GraphRepository

  beforeAll(() => {
    initDatabase()
    db = getClient()
    repo = new GraphRepository(db)
    const now = new Date().toISOString()
    const insGraph = db.prepare(
      'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?,?,?,?,?,?)'
    )
    insGraph.run('g_on', 'Online', 'online', '/p', now, now)
    insGraph.run('g_dev', 'Dev', 'dev', '/p', now, now)

    const ins = db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, sort_index, collapsed, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    ins.run('p1', 'project', 'confirmed', 'P1', 'g_on', 'online', null, null, 0, 0, 0, now, now)
    ins.run('m1', 'module', 'draft', 'M1', 'g_on', 'online', 'p1', 0, 1, 0, 0, now, now)
    ins.run('m2', 'module', 'draft', 'M2', 'g_on', 'online', 'p1', 1, 0, 0, 0, now, now)

    const insEdge = db.prepare(
      'INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES (?,?,?,?,?)'
    )
    insEdge.run('e1', 'p1', 'm1', 'hierarchical', 'g_on')
    insEdge.run('e2', 'p1', 'm2', 'hierarchical', 'g_on')
  })

  afterAll(() => { closeDatabase() })

  it('clones sort_index but resets collapsed', () => {
    repo.cloneGraphNodes('g_on', 'g_dev', 'dev')
    const rows = db.prepare(
      "SELECT title, sort_index, collapsed FROM nodes WHERE graph_id='g_dev'"
    ).all() as { title: string; sort_index: number | null; collapsed: number }[]
    const m1 = rows.find((r) => r.title === 'M1')!
    const m2 = rows.find((r) => r.title === 'M2')!
    expect(m1.sort_index).toBe(0)
    expect(m2.sort_index).toBe(1)
    // 源图 M1 的 collapsed 是 1，克隆到 dev 图必须重置为 0（折叠是开发者视角）
    expect(m1.collapsed).toBe(0)
  })

  it('remaps hierarchical edges to the cloned node ids', () => {
    repo.cloneGraphNodes('g_on', 'g_dev', 'dev')
    const devNodes = db.prepare(
      "SELECT id, title, parent_id FROM nodes WHERE graph_id='g_dev'"
    ).all() as { id: string; title: string; parent_id: string | null }[]
    const titleById = new Map(devNodes.map((n) => [n.id, n.title]))
    const edges = db.prepare(
      "SELECT source, target FROM edges WHERE graph_id='g_dev' AND edge_type='hierarchical'"
    ).all() as { source: string; target: string }[]

    expect(edges).toHaveLength(2)
    for (const e of edges) {
      // 边的两端必须是 dev 图里的节点（id 被重映射过），且与 parent_id 自洽
      expect(titleById.get(e.source)).toBe('P1')
      const child = devNodes.find((n) => n.id === e.target)!
      expect(child.parent_id).toBe(e.source)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/repositories/__tests__/graph-repository-clone.test.ts`
Expected: FAIL —— 当前 INSERT 不含 `sort_index` 列，`collapsed` 也随源图复制

- [ ] **Step 3: Update cloneGraphNodes**

`src/main/repositories/graph-repository.ts` 的 `cloneGraphNodes`：
- `insertNodeStmt`（:220）的列清单加 `sort_index`（放在 `parent_id` 之后，与真实 `nodes` 表的列顺序一致），值取 `row['sort_index']`；**占位符数量同步 +1**（20 → 21），且 `insertNodeStmt.run(...)` 的实参要按同样的位置插入 `row['sort_index']`——列清单与实参顺序错位会把 `sort_index` 写进别的列
- `collapsed` **不加入 INSERT**（新表默认 0）——折叠是开发者视角，从 online 派生出来应是展开态（spec §4.2.1）
- 克隆边时（Pass 3，:273），若 `row['edge_type'] === 'hierarchical'`，其 source/target 必须用 `idMap` 重映射（与 `parent_id` 用同一张 map）。当前 Pass 3 用的就是 `idMap.get(rowStr(row, 'source'))`，因此**现有代码已经满足**——但要靠 Step 1 的第二个用例钉住，防止将来有人改坏

⚠️ `cloneGraphNodes` 的两轮结构（Pass 1 插节点时 `parent_id` 暂时是源图的值，Pass 2 才重映射）**保持不变**——本期不加 `parent_id` 外键，这个两段式仍然安全。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/repositories/__tests__/graph-repository-clone.test.ts src/main/__tests__/graph-repository.test.ts`
Expected: PASS（两个文件都绿——`src/main/__tests__/graph-repository.test.ts` 是 mock 版单元测试，本次不改动它，但它必须继续全绿）

- [ ] **Step 5: Commit**

```bash
git add src/main/repositories/graph-repository.ts src/main/repositories/__tests__/graph-repository-clone.test.ts
git commit -m "fix(canvas): 派生图同步兄弟顺序并重映射层级边"
```

---

## Task 10: 拖拽重挂交互

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx`
- Create: `src/renderer/canvas/hooks/useReparentDrag.ts`
- Create: `src/renderer/canvas/hooks/__tests__/useReparentDrag.test.ts`
- Modify: `src/renderer/canvas/BizNode.tsx`（落点高亮样式）
- Modify: `src/renderer/store/graphStore.ts`（`reparentNode` action）
- Modify: `src/shared/i18n/resources/domains/canvas.ts`（文案 zh + en）

**Interfaces:**
- Consumes: Task 5 的 `useNodeTypeConfigs()`；Task 6 的 `graph:reparent` IPC
- Produces:
  ```ts
  // src/renderer/canvas/hooks/useReparentDrag.ts
  export interface ReparentCandidate {
    nodeId: string
    valid: boolean
    reason?: 'cycle' | 'type' | 'cross-graph'
  }
  export function useReparentDrag(): {
    draggingNodeId: string | null
    candidate: ReparentCandidate | null
    onDragStart: (nodeId: string) => void
    onDrag: (pointer: { x: number; y: number }) => void
    onDragEnd: () => void
  }
  ```
  `onDrag` 的 `pointer` 是 **flow 坐标**（调用方用 `screenToFlowPosition` 换算）。

  `useReparentDrag` 内部调用 Task 5 的 `useNodeTypeConfigs()` 取类型规则，不接受外部传入——类型规则的唯一权威是主进程的 registry，渲染端只能通过 IPC 拿。

  ```ts
  // src/renderer/store/graphStore.ts
  reparentNode: (nodeId: string, newParentId: string) => Promise<void>
  ```
  动作内部：调 `graph:reparent` IPC → 用返回的 `movedPositions` 更新 store 里对应节点的 `parentId` 与 `position`。

- [ ] **Step 1: Write the failing test**

新建 `src/renderer/canvas/hooks/__tests__/useReparentDrag.test.ts`：

```ts
it('rejects a candidate that is a descendant of the dragged node', () => { /* 期望 reason === 'cycle' */ })
it('rejects a candidate whose type is not allowed as parent', () => { /* 期望 reason === 'type' */ })
it('rejects a candidate in another graph', () => { /* 期望 reason === 'cross-graph' */ })
it('accepts a valid candidate', () => { /* 期望 valid === true */ })
it('returns null candidate when pointer is on empty space', () => { /* 期望 candidate === null */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/canvas/hooks/__tests__/useReparentDrag.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: Implement the drag hook**

新建 `src/renderer/canvas/hooks/useReparentDrag.ts`。核心逻辑：

- `onDragStart(nodeId)`：记录拖动节点与其**后代集合**（沿 `parent_id` 下行）
- `onDrag(pointer)`：遍历当前图的节点，找到**包含 pointer 的矩形**的节点（用 flow 坐标的 `position` + 节点尺寸估算，与 `tree-layout.ts` 的 `estimateNodeWidth/Height` 一致），排除拖动节点自身与其后代。若无命中 → `candidate = null`。若命中 → 依次校验：
  0. **规则表未就绪 → 直接 `candidate = null`**：`useNodeTypeConfigs()` 返回的 `loaded === false`（IPC 还没回来）时不做任何判定——此时 `configs` 是空表，照常判定会把**所有**合法落点判成 `type` 不合法，给用户一个错误的红框。`loaded === true` 之后才走下面的 1–5。
  1. 命中的是拖动节点自身 → 跳过
  2. 命中的是后代 → `reason: 'cycle'`
  3. `graph_id` 不同 → `reason: 'cross-graph'`
  4. 类型不允许 → `reason: 'type'`。**渲染进程不能 import `nodeTypeRegistry`**（它在 `src/main/shared/`，是主进程专用），所以这里用 Task 5 的 `useNodeTypeConfigs()` 拿到的配置对象做同样的判断，语义必须与主进程 `validateParentChild` 一致：
     ```ts
     const parentCfg = configs[candidate.type]        // 候选将成为父节点
     const childCfg = configs[dragging.type]          // 拖动中的将成为子节点
     // ⚠️ 必须与主进程 validateParentChild 的语义逐条对齐：
     //   - 配置对象缺失（未知类型）→ 主进程 `if (!parent || !child) return false` → 这里也判 false
     //   - allowedChildTypes / allowedParentTypes 字段缺失 → 主进程短路放行 → 这里也放行
     const parentOk = !!parentCfg && (!parentCfg.allowedChildTypes || parentCfg.allowedChildTypes.includes(dragging.type))
     const childOk = !!childCfg && (!childCfg.allowedParentTypes || childCfg.allowedParentTypes.includes(candidate.type))
     // parentOk && childOk 为 false → reason: 'type'
     ```
     `allowedChildTypes` 字段本身为 `undefined` 表示「无限制」，与主进程 `validateParentChild` 的短路语义一致（`node-type-registry.ts:57-58`）；但**配置对象**缺失是另一回事，主进程判拒绝，这里也必须判拒绝——否则渲染端说「可以挂」，主进程 `graph:reparent` 拒掉，用户看到的是一次莫名其妙的报错。`useReparentDrag` **内部调用** `useNodeTypeConfigs()`，不通过参数传入。
  5. 否则 `valid: true`
- `onDragEnd()`：若 `candidate?.valid` 则调 `graphStore.reparentNode(draggingNodeId, candidate.nodeId)`；失败则 toast 提示并回弹

**坐标系注意**：`getBoundingClientRect()` 返回屏幕坐标，命中判定需要 flow 坐标——用 `screenToFlowPosition` 换算（`GraphCanvas.tsx:187` 已有 `useReactFlow()`）。

- [ ] **Step 4: Add the store action**

`src/renderer/store/graphStore.ts` 的 `GraphState` 接口加：

```ts
reparentNode: (nodeId: string, newParentId: string) => Promise<void>
```

实现：调 `window.electronAPI['graph:reparent'](nodeId, newParentId)`，成功后用返回的 `movedPositions` 更新 store：

```ts
reparentNode: async (nodeId, newParentId) => {
  const result = await window.electronAPI['graph:reparent'](nodeId, newParentId)
  const posMap = new Map(result.movedPositions.map(p => [p.id, p]))
  setNodes((nodes) => nodes.map((n) => {
    if (n.id === nodeId) return { ...n, parentId: result.newParentId }
    const p = posMap.get(n.id)
    return p ? { ...n, position: { x: p.x, y: p.y } } : n
  }))
}
```

- [ ] **Step 5: Wire it into GraphCanvas**

`src/renderer/canvas/GraphCanvas.tsx`：
- 现有的 `onNodeDragStart` / `onNodeDrag` / `onNodeDragStop`（:1144-1146）已是力导向布局的钩子，**需与拖拽重挂共存**：拖拽时既跑力导向 reheat，也跑重挂候选检测
- `onNodeDragStop` 时若候选有效，跳过原有的位置持久化逻辑（由 `reparentNode` 返回的 `movedPositions` 统一写位置）；否则走原有的位置持久化
- 候选命中时给目标节点加高亮样式（新增 `data.isReparentTarget` / `data.isReparentTargetValid` 属性传给 `BizNode`）

⚠️ **高亮状态怎么进 `flowNodes`**：不要「在 `flowNodes` 的 useMemo 外面 map 一遍节点再传进去」——那会每帧新建数组，`flowNodes` 的依赖数组随即每帧变化，`useEffect(() => setRfNodes(flowNodes))`（:595-597）每帧触发 → 无限重渲染循环。正确做法：把 `candidate?.nodeId`（`string | null`）与 `candidate?.valid`（`boolean | undefined`）当作**原始值**放进 `flowNodes` 的 useMemo **依赖数组**和它的缓存 key 里（key 是 `JSON.stringify([...])` 的成员列表，见 :535-551），在 useMemo 内部给命中的那个节点加 `data.isReparentTarget`。原始值引用稳定，放进依赖数组安全。

`src/renderer/canvas/BizNode.tsx`：新增高亮样式——合法候选用绿色边框，非法候选用红色边框。

- [ ] **Step 6: Add i18n strings**

`src/shared/i18n/resources/domains/canvas.ts` 增（zh 是真值来源，en 必须覆盖）：

```
'canvas.reparent.invalidType': '类型不允许此父子关系',
'canvas.reparent.cycle': '不能挂到自己的子节点下',
'canvas.reparent.crossGraph': '不能跨图移动节点',
'canvas.reparent.success': '已移动到 {parent}',
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/renderer/canvas/hooks/__tests__/useReparentDrag.test.ts && npx tsc --noEmit`
Expected: PASS，零类型错误

- [ ] **Step 8: Commit**

```bash
git add src/renderer/canvas/GraphCanvas.tsx src/renderer/canvas/hooks/useReparentDrag.ts src/renderer/canvas/hooks/__tests__/useReparentDrag.test.ts src/renderer/canvas/BizNode.tsx src/renderer/store/graphStore.ts src/shared/i18n/resources/domains/canvas.ts
git commit -m "feat(canvas): 拖拽重挂父节点，含落点高亮与类型提示"
```

---

## Task 11: 兄弟顺序与删父节点处理

**Files:**
- Modify: `src/main/repositories/node-repository.ts`（`delete()`、`update()`、`rowToNode`）
- Modify: `src/main/repositories/graph-repository.ts`（`get()` 里的内联节点映射，:109-131）
- Modify: `src/renderer/canvas/layouts/tree-layout.ts`（`sortChildrenByEdgeOrder`，:161）
- Modify: `src/shared/types/graph.ts`（`GraphNode` 增字段）
- Test: `src/main/repositories/__tests__/` 与 `src/renderer/canvas/layouts/__tests__/tree-layout.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `nodes.sort_index` / `nodes.collapsed`
- Produces: `GraphNode.sortIndex?: number` / `GraphNode.collapsed?: boolean` 在渲染端可读；删父节点时子节点被置为根

- [ ] **Step 1: Write the failing test**

新建 `src/main/repositories/__tests__/node-repository.test.ts`。

⚠️ **用真实库，不用手搓的最小 schema**：`NodeRepository.rowToNode`（`node-repository.ts:22`）读了 **23 个列**（`description` / `acceptance_criteria` / `rules` / `metadata` / `context_refs` / `wiki_content` / `wiki_meta` / `owner_role` / `content` / `community_*` …）。手写一个「够用」的 `nodes` 表，漏一列就是 `no such column` 报错、多一列就是与真实 schema 漂移。`initDatabase()` 给的是真表。electron mock 照抄 `src/main/__tests__/database-migration.test.ts`（那里已有现成模式）。

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-node-repo-test-' + process.pid)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? TEST_USER_DATA : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../../database'
import { NodeRepository } from '../node-repository'

describe('NodeRepository — 层级相关行为', () => {
  let db: ReturnType<typeof getClient>
  let nodeRepo: NodeRepository

  beforeAll(() => {
    initDatabase()
    db = getClient()
    nodeRepo = new NodeRepository(db)
    const now = new Date().toISOString()
    const ins = db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    ins.run('c1', 'process', 'draft', 'C1', 'g1', 'online', 'm1', 0, 0, now, now)
    ins.run('f1', 'feature', 'draft', 'F1', 'g1', 'online', 'c1', 0, 0, now, now)
  })

  afterAll(() => { closeDatabase() })

  it('orphans become root nodes when their parent is deleted', () => {
    nodeRepo.delete('c1')
    const row = db.prepare("SELECT parent_id FROM nodes WHERE id='f1'").get() as { parent_id: string | null }
    expect(row.parent_id).toBeNull()
  })

  it('round-trips the collapsed flag through update', () => {
    const updated = nodeRepo.update('f1', { collapsed: true })
    expect(updated.collapsed).toBe(true)
    const raw = db.prepare("SELECT collapsed FROM nodes WHERE id='f1'").get() as { collapsed: number }
    expect(raw.collapsed).toBe(1)
    const cleared = nodeRepo.update('f1', { collapsed: false })
    expect(cleared.collapsed).toBe(false)
  })

  it('assigns sort_index to a new child as max(siblings) + 1', () => {
    // spec §4.8：新建子节点时取父节点现有子节点中最大的 sort_index + 1
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run('p_sort', 'module', 'draft', 'P', 'g1', 'online', null, 0, 0, now, now)

    const mk = (title: string) => nodeRepo.create({
      type: 'feature', status: 'draft', title,
      graphId: 'g1', graphType: 'online', parentId: 'p_sort',
      position: { x: 0, y: 0 },
    })

    expect(mk('S1').sortIndex).toBe(0)
    expect(mk('S2').sortIndex).toBe(1)
    expect(mk('S3').sortIndex).toBe(2)
  })

  it('leaves sort_index unset for a root node', () => {
    const root = nodeRepo.create({
      type: 'project', status: 'confirmed', title: 'Root',
      graphId: 'g1', graphType: 'online',
      position: { x: 0, y: 0 },
    })
    expect(root.sortIndex).toBeUndefined()
  })
})
```

第二条钉的是 boolean→INTEGER 的转换：better-sqlite3 不接受 boolean 绑定，忘了转换就会抛 `TypeError` 而不是断言失败。

💡 `TEST_USER_DATA` 目录名带 `process.pid`——vitest 每个测试文件跑在独立 worker 进程里，各自有自己的 userData 目录，不会互相踩。

在 `src/renderer/canvas/layouts/__tests__/tree-layout.test.ts` 追加（同文件已有 `makeNode` / `makeEdge` 两个 helper，直接用）：

```ts
it('orders siblings by sort_index rather than edge order', () => {
  const withSort = (id: string, title: string, sortIndex: number): Node => ({
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: { type: 'feature', title, sortIndex },
  } as Node)

  const nodes = [
    makeNode('p1', 'project', 'Root'),
    withSort('a', 'A', 1),
    withSort('b', 'B', 0),
  ]
  // 边顺序与 sort_index 相反：a 在边里排前面，但它的 sort_index 是 1
  const edges = [
    makeEdge('e1', 'p1', 'a'),
    makeEdge('e2', 'p1', 'b'),
  ]
  const result = computeTreeLayout(nodes, edges)
  const posById = new Map(result.nodes.map((n) => [n.id, n.position]))
  // sort_index=0 的 b 应排在 sort_index=1 的 a 之前
  expect(posById.get('b')!.y).toBeLessThan(posById.get('a')!.y)
})
```

⚠️ **同文件里已有的 `'sorts children by edge order to avoid crossings'` 用例必须继续通过**——它造的节点全都没有 `sortIndex`（全是 undefined），靠的是「undefined 排最后、保持原相对顺序」这条兜底路径，才仍按边顺序排列。这条是本次语义切换的护栏：兜底路径实现错了，存量没有 `sort_index` 的节点顺序就会乱。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/repositories/__tests__/ src/renderer/canvas/layouts/__tests__/tree-layout.test.ts`
Expected: FAIL

- [ ] **Step 3: Handle children on delete**

`src/main/repositories/node-repository.ts` 的 `delete(id)`：在删除前先 `UPDATE nodes SET parent_id = NULL WHERE parent_id = ?`（子节点变根节点），再删自身。

- [ ] **Step 4: Map and write the new columns**

`src/main/repositories/node-repository.ts`：
- `rowToNode` 映射 `sort_index` → `sortIndex`（number）、`collapsed` → `collapsed`（0/1 转 boolean）
- `update()` 增两个分支：`if (data.sortIndex !== undefined)` 与 `if (data.collapsed !== undefined)`
- **`create()` 与 `createBatch()` 在有 `parentId` 时分配 `sort_index`**（spec §4.8「新建子节点时取父节点现有子节点中最大的 `sort_index + 1`」）：
  - 取值 `COALESCE((SELECT MAX(sort_index) FROM nodes WHERE parent_id = ?), -1) + 1`——`COALESCE` 不能省：兄弟全为 NULL 时 `MAX` 返回 NULL，`NULL + 1` 在 SQLite 里仍是 NULL。
  - 无 `parentId`（根节点）→ `sort_index` 保持 NULL（spec §4.8：根节点没有兄弟可言）。
  - `createBatch()` 里**同一父节点**的多个节点要拿**连续**的号，不能拿同一个号——批内递增，不能每个都去查一次库。
  - 返回值要把 `sortIndex` 带回去（`create()` 现在是 `return { ...data, id, createdAt, updatedAt }`）。渲染层的 `graphStore.createNode`（`src/renderer/store/graphStore.ts:205-220`）是「乐观插入 → 用 server 返回的节点替换」，server 带上 `sortIndex`，前端就自动同步上了 ✓。

  ⚠️ **为什么这条是承重的（不是「顺手补一下」）**：Task 6 的 reparent 规定「新的 `sort_index` = 目标父节点现有子节点最大 `sort_index` + 1」，而 SQL 的 `MAX(sort_index)` **忽略 NULL**。若子节点里有本次会话新建的（`sort_index` 为 NULL），`MAX` 只看得到老节点；再叠加 Task 11 布局「`sortIndex` 为 undefined 排最后」的兜底 → 目标父节点有 A(`sort_index=0`) 与 B(NULL，本次会话新建) 时把 C 挂进去，C 拿到 `sort_index=1`，布局排成 **A(0) → C(1) → B(最后)**——**先于 C 存在的 B 被挤到 C 后面**，兄弟顺序颠倒。

⚠️ **better-sqlite3 不接受 boolean 绑定**（只接受 number / string / bigint / buffer / null）。`collapsed` 落库必须显式转成 `1` / `0`：

```ts
if (data.collapsed !== undefined) { updates.push('collapsed = ?'); args.push(data.collapsed ? 1 : 0) }
```

不转的话 `update(id, { collapsed: true })` 抛 `TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null`。`sortIndex` 是 number，直接绑定即可。

`src/main/repositories/graph-repository.ts` 的 `GraphRepository.get()` 里那段**内联的节点字段映射**（:109-131）同样映射 `sort_index` → `sortIndex`、`collapsed` → `collapsed`。注意该文件**没有** `rowToNode` 函数——映射是内联在 `get()` 的 `nodesRows.map(...)` 里的。

`src/shared/types/graph.ts` 的 `GraphNode` 增：
```ts
  /** 同父节点下的兄弟顺序（升序）；根节点为 undefined */
  sortIndex?: number
  /** 子树是否折叠 */
  collapsed?: boolean
```

- [ ] **Step 5: Make tree layout honor sort_index**

`src/renderer/canvas/layouts/tree-layout.ts` 的 `sortChildrenByEdgeOrder`（:161）：改为按子节点的 `sortIndex` 排序——React Flow `Node` 的 `data` 里带有 GraphNode 展开字段（`GraphCanvas.tsx:567` 的 `data: { ...node, ... }`），所以读 `node.data.sortIndex`。`sortIndex` 为 undefined 的排在最后，保持原有相对顺序作为兜底。函数名可改为 `sortChildrenBySortIndex`。

⚠️ `Node['data']` 在 @xyflow/react 里是 `Record<string, unknown>`，`node.data.sortIndex` 取出来是 `unknown`——比较前必须转 number（`Number(n.data.sortIndex)`），否则 `tsc` 报 `Operator '<' cannot be applied to types 'unknown'`。且转 number 前要判 `undefined`：`Number(undefined)` 是 `NaN`，`NaN` 参与比较恒为 false，会把兜底路径静默弄坏。

⚠️ 节点缓存 key（`GraphCanvas.tsx:530`）含 `node.updatedAt`，`sort_index` / `collapsed` 变更会更新 `updated_at` → 缓存自动失效。✓

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/main/repositories/__tests__/ src/renderer/canvas/layouts/__tests__/tree-layout.test.ts && npx tsc --noEmit`
Expected: PASS，零类型错误

- [ ] **Step 7: Commit**

```bash
git add src/main/repositories/node-repository.ts src/main/repositories/graph-repository.ts src/shared/types/graph.ts src/renderer/canvas/layouts/tree-layout.ts src/main/repositories/__tests__/ src/renderer/canvas/layouts/__tests__/tree-layout.test.ts
git commit -m "feat(canvas): 兄弟顺序显式化，删除父节点时子节点置根"
```

---

## Task 12: 子树折叠/展开

**Files:**
- Modify: `src/renderer/canvas/BizNode.tsx`（折叠指示器 + 徽标）
- Modify: `src/renderer/canvas/GraphCanvas.tsx`（折叠节点隐藏子树）
- Create: `src/renderer/canvas/hooks/useCollapse.ts`
- Create: `src/renderer/canvas/hooks/__tests__/useCollapse.test.ts`
- Modify: `src/shared/i18n/resources/domains/canvas.ts`

**Interfaces:**
- Consumes: Task 11 的 `GraphNode.collapsed`
- Produces:
  ```ts
  // src/renderer/canvas/hooks/useCollapse.ts
  export function useCollapse(): {
    collapsedIds: Set<string>
    isCollapsed: (nodeId: string) => boolean
    toggle: (nodeId: string) => Promise<void>
    visibleNodes: GraphNode[]
  }
  ```
  `visibleNodes` 过滤掉被折叠节点的整棵子树（折叠节点本身可见）。

**布局自动获益**：`useAutoLayout.applyLayout` 用 React Flow 的 `getNodes()`，而 `GraphCanvas` 通过 `setRfNodes(flowNodes)` 写回。只要 `flowNodes` 过滤掉隐藏后代，被折叠节点就自动作为叶子参与 dagre 计算——**不需要**在 `useAutoLayout.ts` 里单独处理。

- [ ] **Step 1: Write the failing test**

新建 `src/renderer/canvas/hooks/__tests__/useCollapse.test.ts`：

```ts
it('hides the whole subtree when a node is collapsed', () => { /* p1 → m1 → c1，折叠 m1 后 visibleNodes 不含 m1/c1 */ })
it('persists the collapsed flag through node update', () => { /* toggle 后期望调 updateNode(id, { collapsed: true }) */ })
it('expands when toggled again', () => { /* */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/canvas/hooks/__tests__/useCollapse.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: Implement the collapse hook**

新建 `src/renderer/canvas/hooks/useCollapse.ts`：
- 从 `graphStore` 读节点，算出每个节点的**后代集合**（沿 `parent_id` 下行）
- `collapsedIds` = 所有 `collapsed === true` 的节点 id
- `visibleNodes` = 排除所有被折叠节点的后代（折叠节点本身可见）
- `toggle(nodeId)` 调 `graphStore.updateNode(nodeId, { collapsed: !isCollapsed(nodeId) })`

⚠️ `collapsedIds` 与 `visibleNodes` 都必须用 `useMemo` 算（`visibleNodes` 依赖 `[nodes, collapsedIds]`），**不能**每次渲染重新算出一个新数组返回——`visibleNodes` 会进 `GraphCanvas` 的 `flowNodes` 依赖数组（Step 4），每帧新建数组会导致 `useEffect(() => setRfNodes(flowNodes))`（:595-597）每帧触发，`setRfNodes` 是 React `useState` setter → 无限重渲染循环，React 抛 *Maximum update depth exceeded*，画布白屏。

- [ ] **Step 4: Render the collapse control**

`src/renderer/canvas/BizNode.tsx`：
- 有子节点时显示折叠指示器（`ChevronDown` / `ChevronRight` 图标），点击 `toggle`
- 折叠时显示徽标：`⊕ {后代数量}`

`src/renderer/canvas/GraphCanvas.tsx`：`flowNodes` 的 useMemo 改为遍历 `visibleNodes` 而不是 `graphNodes`。

⚠️ `flowNodes` 的依赖数组（:592）要加上 `visibleNodes`；`nodeCacheRef` 的清理循环（:588-590）会自动移除不可见节点的缓存条目。✓
⚠️ `visibleNodes` 必须是 `useCollapse` 里 `useMemo` 出来的**稳定引用**（Step 3）——依赖数组里放每帧新建的数组会让 `useEffect(() => setRfNodes(flowNodes))`（:595-597）每帧触发 → 无限重渲染循环。见 Global Constraints 的「渲染层的引用稳定性」。

- [ ] **Step 5: Add i18n strings**

`src/shared/i18n/resources/domains/canvas.ts` 增（zh + en 都要）：
```
'canvas.collapse.toggle': '折叠/展开子树',
'canvas.collapse.childCount': '{count} 个子节点',
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/renderer/canvas/hooks/__tests__/useCollapse.test.ts && npx tsc --noEmit`
Expected: PASS，零类型错误

- [ ] **Step 7: Commit**

```bash
git add src/renderer/canvas/hooks/useCollapse.ts src/renderer/canvas/hooks/__tests__/useCollapse.test.ts src/renderer/canvas/BizNode.tsx src/renderer/canvas/GraphCanvas.tsx src/shared/i18n/resources/domains/canvas.ts
git commit -m "feat(canvas): 子树折叠展开，跨会话持久化"
```

---

## Task 13: 布局选择持久化 + 全量验证

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx`（`layoutMode` 持久化）
- Test: 无新增单测（改动极小），但需全量验证

**Interfaces:**
- Consumes: 无
- Produces: `localStorage` key `bizgraph.layoutMode.<projectPath>` 存 `'tree' | 'force'`

- [ ] **Step 1: Persist layout mode**

`src/renderer/canvas/GraphCanvas.tsx:754` 附近的 `const [layoutMode, setLayoutMode] = useState<'tree' | 'force'>('tree')` 改为从 localStorage 读初值，并在 `setLayoutMode` 时写回。key 规则：`bizgraph.layoutMode.${projectPath ?? 'default'}`。projectPath 为空时用 `'default'`。

- [ ] **Step 2: Run the full verification suite**

Run: `npm run lint && npx tsc --noEmit && npm run test`
Expected: 零 lint 警告、零类型错误、全部测试通过

- [ ] **Step 3: Manual verification（关键场景）**

Run: `npm run dev`，然后逐项确认：

1. **打开一个存量项目**（含 AI 生成的旧图）→ 不报错，连线正常，**无双线**
2. **右键手动加一个子节点** → 画布上**立刻出现父子连线**（本次核心修复）
3. **点击「整理布局」** → 手动加的子节点排到父节点**下方**，不再是游离的
4. **拖动节点到另一个节点上** → 目标节点高亮，松手后新连线出现、旧连线消失，无需手动整理布局
5. **拖动节点到自己的子节点上** → 红色高亮 + tooltip「不能挂到自己的子节点下」，松手无变化
6. **拖动 feature 到 module 上** → 红色高亮（类型不允许）
7. **折叠一个有子节点的模块** → 子树消失，显示 `⊕ N` 徽标；**重启应用后仍是折叠状态**
8. **删除一个父节点** → 其子节点变成根节点（不报错、不消失）
9. **切换到力导向布局 → 重启应用** → 仍是力导向
10. **派生 dev 图**（online → dev）→ dev 图的兄弟顺序与 online 一致；折叠状态是展开的

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/GraphCanvas.tsx
git commit -m "feat(canvas): 布局选择按项目持久化"
```

---

## 附录：本期不做的事（记录，避免后续误以为遗漏）

| 项 | 原因 |
|---|---|
| `nodes.parent_id` 外键 | 会打断 `cloneGraphNodes` 与 `yjs-manager.ts` 的两段式写入，需先重构（spec §4.1.2、批次 4） |
| 撤销/重做 | 用户明确推迟到项目稳定后。结构写操作已收敛到 `graph:reparent`，届时挂命令栈即可（批次 4） |
| 跨图结构同步 | online 图改结构后 dev 图不自动跟随。dev 图是一次性克隆，现有产品语义如此（批次 4） |
| Yjs 双向镜像 | 本地 `graph:reparent` 不写 Yjs 文档，远端 peer 的全量同步可能覆盖本地改动。本期只加防环校验，不做镜像（spec §4.4.2） |
| Yjs 远端写入的类型校验 | 远端 peer 可以任意指定 parentId；本期在 repository 侧补防环校验，类型校验留待协作功能真正启用时再加 |
| AI 写入路径的类型校验 | AI 批量生成，逐个校验可能让整次生成失败。本期只给 AI 路径加防环校验（spec §4.4.3） |
| 内联改名、快捷键体系 | 不在本次范围（spec §一非目标） |
| 框选批量操作 | 不在本次范围 |
