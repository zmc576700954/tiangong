# 只读默认与范围记忆 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"没指定可改哪些文件"的会话默认**物理上写不了文件**，并把用户显式给过的文件范围记住，下次自动带上。

**Architecture:** 只读保证做在**适配器层**（禁用写工具），**不做**在 ScopeGuard 层——ScopeGuard 的 watcher 监听整棵项目树，分不清"Agent 写的"和"用户写的"，用它的空白名单沙箱会导致用户自己的新文件被回滚删除（`src/main/agent/send-and-wait.ts:44-56` 已明确记录这个坑）。范围记忆落在新增的 `project_settings` 表（schema v18），按 `project_path` 存相对路径。

**Tech Stack:** Electron + TypeScript（strict）+ better-sqlite3（schema v18）+ Claude Code SDK（`tools` 白名单）+ Codex SDK（`sandboxMode`）+ Vitest

**Spec:** `docs/superpowers/specs/2026-10-31-ux-defaults-design.md`（§二 裂缝 E、§三 决定 D1/D2/D3、§四 E1–E7）

**依赖：** 本计划**独立可交付**，不依赖 `docs/superpowers/plans/2026-10-31-ux-settings-ui.md`（那个计划里 Task 6 已让新建图绑定 `project_path`，本计划 Task 5 自己会兜住这个前提）。

---

## Global Constraints

以下约束对**每个任务**都生效：

- **TypeScript strict，全局禁止 `any`**（`npm run lint` 带 `--max-warnings 0`）。
- **只读靠适配器层，不靠 ScopeGuard。** `readOnly: true` 的会话**不建 ScopeGuard 沙箱**——`session-lifecycle-manager.ts:302` 的 `config.allowedFiles.length > 0 || config.verifyOnly` 条件在只读场景下会命中 `verifyOnly` 分支，而那条路在真实项目目录上会误伤用户文件。
- **不改 Agent CLI 自身行为**，只改调用参数。
- **不改适配器协议**（CLAUDE.md《与 Agent CLI 的边界》："多 Agent CLI 的协议不归一"）。逐适配器各加各的只读开关，**不建统一抽象层**。
- **只读推导只有一处实现**：`resolveReadonly()` 放在 `src/shared/readonly.ts`，主进程与 renderer 共用——不要各写一套。
- **A2A 链路不受影响**：`src/main/a2a/wiring.ts:118,132` 已显式传 `verifyOnly: true`，那是**隔离临时目录**场景，与本设计的"真实项目目录只读"不是一回事。**不要**把两者合并，也**不要**让 A2A 会话走本设计的只读推导路径。
- **范围存相对项目根的相对路径**（与 `scope-guard.ts` 的 `path.relative(workingDir, srcPath)` 一致），避免项目搬家后绝对路径失效。
- **节点状态变更必须走 `NodeRepository.update()`**；**不要**在别处直接 `UPDATE nodes SET status = ...`。
- **不改 `graph_type` 语义**（`2026-10-27` spec §4.4.1）。
- **IPC 错误必须继承 `BizGraphError` 并 override `toJSON()`**，以便 `createTypedHandle`（`src/main/ipc/utils.ts`）把结构化字段透传给 renderer。
- **命令**：`npx vitest run <path>` / `npx tsc --noEmit` / `npm run lint` / `npm run test`。
- **提交信息**：`<type>(<scope>): <中文描述>`。

---

## Review Focus

1. **用户显式清空了文件范围** —— 必须落回只读，**并且**清掉项目级那份默认，否则用户下次开会话又"莫名其妙能写了"。合理行为：当前会话只读 + 项目级默认被清空 + 有提示。
   → **Task 6**
2. **用户在一个不支持只读的适配器（cline / qwen-code 等）上开会话** —— 按决定 D3，**直接拒绝发送**并说清原因。合理行为：不发送、不静默降级、不自动换适配器。
   → **Task 4**
3. **只读会话的主适配器启动失败，回退到 `mcp`** —— `fallback-router.ts:150` 给链上每个候选者传同一份 config，`mcp` 会挂载带 `filesystem` server 的全部工具，**能写**。合理行为：只读会话的回退链只保留只读适配器；没有就明确失败。
   → **Task 4**
4. **用户在只读会话里真的需要改文件** —— 必须有一条明确的"放开范围"路径，而不是让用户去改配置。合理行为：会话面板里能增删范围文件，改完自动转成可写会话。
   → **Task 6**
5. **项目目录被移动或改名** —— 范围存的是相对路径，`project_path` 变了则项目级默认应失效而不是指到错误位置。合理行为：查不到项目级默认时回落到全局默认 + 只读。
   → **Task 5 / Task 6**

---

## File Structure

**新建：**

| 路径 | 职责 |
|---|---|
| `src/main/repositories/project-settings-repository.ts` | `project_settings` 表的读写（按 `project_path` 存 JSON blob） |
| `src/shared/readonly-support.ts` | 哪些适配器支持只读、怎么判定（单一真相源，主进程与 renderer 共用） |
| `src/main/__tests__/project-settings-repository.test.ts` | 上述 repository 的测试 |
| `src/shared/__tests__/readonly-support.test.ts` | 上述模块的测试 |

**修改：**

| 路径 | 改动性质 |
|---|---|
| `src/shared/types/agent.ts` | `AgentSessionConfig` 加 `readOnly?: boolean`；`BizGraphSettings` 加 `projectDefaults` 相关类型 |
| `src/shared/types/ipc.ts` | 新增 `project:getDefaults` / `project:setDefaults` 通道 |
| `src/main/database.ts` | `TABLE_SCHEMAS` 加 `project_settings`；`CURRENT_SCHEMA_VERSION` 17 → 18 |
| `src/main/agent/agent-manager.ts` | 只读推导规则；只读会话的回退链裁剪；拒绝发送的错误 |
| `src/main/agent/session-lifecycle-manager.ts` | 只读会话**不建** ScopeGuard 沙箱 |
| `src/main/adapters/claude-code.ts` | 只读工具白名单 + `permissionMode: 'default'` |
| `src/main/adapters/codex.ts` | 只读 `sandboxMode` |
| `src/main/adapters/mcp-adapter.ts` | 只读时 `mcpTools = []` |
| `src/main/ipc/project.ts` | 新增两个 project defaults 通道 |
| `src/renderer/store/sessionStore.ts` | 读项目级默认、合并范围、推导 `readOnly` |
| `src/renderer/components/agent/AgentChatPanel.tsx` | `handleSend` 带上 `readOnly`；范围编辑入口 |
| `src/renderer/components/agent/ChatInput.tsx` | 范围引用区升级为显式范围编辑器 |

---

## Task 1: `readOnly` 会话标志 + 只读推导规则

**Files:**
- Modify: `src/shared/types/agent.ts:18-71`（`AgentSessionConfig`）
- Modify: `src/main/agent/agent-manager.ts:417-539`（`_startSessionInternal`）
- Test: `src/main/__tests__/agent-manager.test.ts`（已存在）

**Interfaces:**
- Consumes: 无。
- Produces:
  - `AgentSessionConfig.readOnly?: boolean` —— 语义见下。
  - `src/shared/readonly-support.ts` 新增导出：
    ```ts
    export type ReadonlySupportLevel = 'enforced' | 'unsupported'
    export function getReadonlySupport(adapterName: string): ReadonlySupportLevel
    export function listReadonlyCapableAdapters(adapterNames: string[]): string[]
    ```
    - `enforced`：该适配器**保证**只读（claude-code / codex / mcp 只读档 / mindmap-internal）。
    - `unsupported`：其余 7 个真 CLI + 未知名字。

- [ ] **Step 1: 写失败的测试**

在 `src/main/__tests__/agent-manager.test.ts` 追加（import 用 `import { resolveReadonly } from '@shared/readonly'`）：

```ts
it('allowedFiles 为空且未显式指定 readOnly 时，推导为只读', () => {
  expect(resolveReadonly({ allowedFiles: [], readOnly: undefined })).toBe(true)
})

it('allowedFiles 非空时推导为可写', () => {
  expect(resolveReadonly({ allowedFiles: ['/tmp/a.ts'], readOnly: undefined })).toBe(false)
})

it('显式 readOnly: false 覆盖推导', () => {
  expect(resolveReadonly({ allowedFiles: [], readOnly: false })).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/__tests__/agent-manager.test.ts`
Expected: FAIL —— `resolveReadonly` 不存在。

- [ ] **Step 3: 实现推导纯函数**

新建 `src/shared/readonly.ts`：

```ts
export function resolveReadonly(config: {
  allowedFiles: string[]
  readOnly?: boolean
}): boolean {
  if (config.readOnly !== undefined) return config.readOnly
  return config.allowedFiles.length === 0
}
```

（`src/shared/readonly-support.ts` 是另一件事——适配器能力表，见 Task 2。两个文件职责不同，别合并。`readonly.ts` 放在 shared 层是因为 renderer 侧要**用同一份推导规则**，不能各写一套。）

- [ ] **Step 4: `AgentSessionConfig` 加字段**

`src/shared/types/agent.ts` 的 `AgentSessionConfig` 末尾加：

```ts
  /**
   * 只读会话：Agent 物理上写不了文件。
   * 由 resolveReadonly() 推导（未显式指定时 = allowedFiles 为空）。
   * 注意：只读由**适配器层**保证（禁写工具），**不建 ScopeGuard 沙箱**——
   * 空白名单沙箱的 watcher 会把用户自己的改动判为越界并回滚删除。
   */
  readOnly?: boolean
```

- [ ] **Step 5: 在 `_startSessionInternal` 里统一施加推导**

`src/main/agent/agent-manager.ts` 的 `_startSessionInternal`（`:417` 起）：在构造最终 config 之前，把 `readOnly` 写进 config（用 `resolveReadonly`），并把该值随 config 传给适配器。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/main/__tests__/agent-manager.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
npx tsc --noEmit
git add src/shared/types/agent.ts src/shared/readonly.ts src/main/agent/agent-manager.ts src/main/__tests__/agent-manager.test.ts
git commit -m "feat(agent): 新增 readOnly 会话标志，空范围默认推导为只读"
```

---

## Task 2: claude-code 只读实现

**Files:**
- Create: `src/shared/readonly-support.ts`
- Modify: `src/main/adapters/claude-code.ts:209-236`
- Test: `src/main/__tests__/claude-code.test.ts`（已存在）、新建 `src/shared/__tests__/readonly-support.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentSessionConfig.readOnly`。
- Produces: `src/shared/readonly-support.ts`：

  ```ts
  export type ReadonlySupportLevel = 'enforced' | 'unsupported'
  export function getReadonlySupport(adapterName: string): ReadonlySupportLevel
  export function listReadonlyCapableAdapters(adapterNames: string[]): string[]
  export const READONLY_TOOLS_WHITELIST: readonly string[]
  ```

  - `getReadonlySupport('claude-code' | 'codex' | 'mcp' | 'mindmap-internal')` → `'enforced'`；其余 → `'unsupported'`。
  - `READONLY_TOOLS_WHITELIST` = Claude Code 的只读工具集（`Read` / `Grep` / `Glob` / `LS` / `TodoWrite` 等；**具体名单以 Claude Code CLI 的实际工具名为准**，实现时先查 `sdk.d.ts` 或 CLI `--help` 确认，不要臆造）。

- [ ] **Step 1: 写失败的测试**

新建 `src/shared/__tests__/readonly-support.test.ts`：

```ts
it('claude-code / codex / mcp / mindmap-internal 支持只读，其余不支持', () => {
  expect(getReadonlySupport('claude-code')).toBe('enforced')
  expect(getReadonlySupport('codex')).toBe('enforced')
  expect(getReadonlySupport('mcp')).toBe('enforced')
  expect(getReadonlySupport('mindmap-internal')).toBe('enforced')
  expect(getReadonlySupport('cline')).toBe('unsupported')
  expect(getReadonlySupport('qwen-code')).toBe('unsupported')
})

it('listReadonlyCapableAdapters 只保留支持只读的', () => {
  expect(listReadonlyCapableAdapters(['claude-code', 'cline', 'codex']))
    .toEqual(['claude-code', 'codex'])
})
```

在 `src/main/__tests__/claude-code.test.ts` 追加一条：只读会话构造出的 SDK options 里，`tools` 是一个**不含写工具**的白名单，且 `permissionMode === 'default'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/shared/__tests__/readonly-support.test.ts src/main/__tests__/claude-code.test.ts`
Expected: FAIL —— 模块不存在 / 只读未生效。

- [ ] **Step 3: 建 `readonly-support.ts`**

按上面的接口实现。名单与判定集中在这一个文件，主进程与 renderer 都要用。

- [ ] **Step 4: claude-code 只读实现**

`src/main/adapters/claude-code.ts:209-236`：
- `permissionMode`：只读会话用 `'default'`，其余保持 `'acceptEdits'`（`:229`）。
- `tools`：只读会话传 `READONLY_TOOLS_WHITELIST`；`transparent` 会话保持现有的 `tools: []`（`:214-216`）；其余保持 `undefined`（= 全允许）。

> SDK 语义：`tools` 传数组是**白名单**；`tools: []` = 禁用全部内置工具（`sdk.d.ts:1630-1638`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/shared/__tests__/readonly-support.test.ts src/main/__tests__/claude-code.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit
git add src/shared/readonly-support.ts src/main/adapters/claude-code.ts src/shared/__tests__/readonly-support.test.ts
git commit -m "feat(claude-code): 只读会话禁用写工具并回落到 default 权限模式"
```

---

## Task 3: codex 与 mcp 只读实现

**Files:**
- Modify: `src/main/adapters/codex.ts:98,103`、`src/main/adapters/mcp-adapter.ts:678`
- Test: `src/main/__tests__/codex.test.ts`（已存在）、`src/main/__tests__/adapter.test.ts`（已存在）

**Interfaces:**
- Consumes: Task 2 的 `getReadonlySupport`。
- Produces: 无新导出。

- [ ] **Step 1: 写失败的测试**

- `codex.test.ts`：只读会话传给 Codex SDK 的 `sandboxMode` 是只读档（SDK 的取值是 `"read-only" | "workspace-write" | "danger-full-access"`，见 `codex-sdk/dist/index.d.ts:236`）。
- `adapter.test.ts`：只读会话传给 MCP 适配器的工具集为空数组。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/__tests__/codex.test.ts src/main/__tests__/adapter.test.ts`
Expected: FAIL。

- [ ] **Step 3: codex 实现**

`src/main/adapters/codex.ts:98,103`：当前写死 `sandboxMode: 'workspace-write'`。改为只读会话传 `'read-only'`，其余不变。

- [ ] **Step 4: mcp 实现**

`src/main/adapters/mcp-adapter.ts:678`：`transparent` 分支已经有 `mcpTools = []` 的写法。只读会话复用同一路径（工具集置空），**但保留 MCP server 连接**（`mcp` 适配器是 API 兜底，工具全禁就等于纯对话，与只读语义一致）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/main/__tests__/codex.test.ts src/main/__tests__/adapter.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit
git add src/main/adapters/codex.ts src/main/adapters/mcp-adapter.ts
git commit -m "feat(adapter): codex 与 mcp 支持只读会话"
```

---

## Task 4: 只读会话裁剪回退链 + 不支持只读时拒绝发送

**Files:**
- Modify: `src/main/agent/agent-manager.ts:417-539`、`src/main/agent/fallback-router.ts`（`buildChain` 与逐候选 `startSession` 处）
- Modify: `src/main/errors.ts`（新增一个错误码，用于"该适配器不支持只读"）
- Test: `src/main/__tests__/agent-manager.test.ts`（已存在）、**新建** `src/main/__tests__/fallback-router.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `getReadonlySupport` / `listReadonlyCapableAdapters`。
- Produces: `src/main/errors.ts` 新增错误码（沿用现有 `ErrorCode` 常量风格）：
  ```ts
  /** 只读会话选中的适配器不支持只读，且回退链上没有可用的只读适配器 */
  ADAPTER_READONLY_UNSUPPORTED
  ```
  配套一个 `AdapterError` 子类，override `toJSON()` 暴露 `{ adapterName, fallbackChain }`。

- [ ] **Step 1: 写失败的测试**

1. 只读会话 + 主适配器是 `cline`（不支持只读）→ `startSession` 抛错，错误里带 `adapterName: 'cline'`。
2. 只读会话 + 主适配器启动失败 + 回退链里有 `codex` → 实际启动的是 `codex`（不是 `mcp`）。
3. 只读会话 + 主适配器启动失败 + 回退链里**只有** `mcp`（不支持只读的路径）→ 抛 `ADAPTER_READONLY_UNSUPPORTED`，**不是**启动 `mcp`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/__tests__/agent-manager.test.ts src/main/__tests__/fallback-router.test.ts`
Expected: FAIL —— 现在只读会话会照样回退到 `mcp`。

- [ ] **Step 3: 实现回退链裁剪**

在 `AgentManager._startSessionInternal` 里构造回退链时（`agent-manager.ts:424-430` 的 `fallbackRouter.buildChain(primary, preferences.fallbackOrder, preferences.forceAdapter, ...)`）：

```
若 resolveReadonly(config) === true
  chain = listReadonlyCapableAdapters(chain)
```

裁剪后若 `chain` 为空 → 直接抛 `ADAPTER_READONLY_UNSUPPORTED`（带 `adapterName: primary` 与原始 chain）。

**注意**：`forceAdapter`（用户强制指定某个适配器）时**不裁剪**——用户显式指定就该照做，但此时该适配器若不支持只读，同样抛 `ADAPTER_READONLY_UNSUPPORTED`（决定 D3：不静默降级）。

- [ ] **Step 4: `fallback-router` 的兜底**

`src/main/agent/fallback-router.ts:150` 的 `let config = initialConfig` 保持不变（裁剪已经在上游做完）。但**在候选循环里加一道保险**：若 `config.readOnly === true` 且当前候选 `getReadonlySupport(candidate) === 'unsupported'`，跳过该候选并记录 `fallbackHistory`（防止未来有别的调用方绕过裁剪）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/main/__tests__/agent-manager.test.ts src/main/__tests__/fallback-router.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit
git add src/main/agent/agent-manager.ts src/main/agent/fallback-router.ts src/main/errors.ts
git commit -m "feat(agent): 只读会话裁剪回退链，无只读适配器时明确拒绝"
```

---

## Task 5: `project_settings` 表 + schema v18

**Files:**
- Modify: `src/main/database.ts:355`（`CURRENT_SCHEMA_VERSION`）、`src/main/database.ts` 的 `TABLE_SCHEMAS` 数组
- Create: `src/main/repositories/project-settings-repository.ts`
- Create: `src/main/__tests__/project-settings-repository.test.ts`
- Test: `src/main/__tests__/database-migration.test.ts`（已存在）

**Interfaces:**
- Consumes: 无。
- Produces:
  - 表：
    ```sql
    CREATE TABLE project_settings (
      project_path  TEXT PRIMARY KEY,
      defaults_json TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
    ```
  - `src/main/repositories/project-settings-repository.ts`：
    ```ts
    // ProjectDefaults 类型定义在 src/shared/types/agent.ts（renderer 与 main 共用），
    // 本文件 import 它，不重复定义。
    export class ProjectSettingsRepository {
      constructor(db: BetterSqlite3.Database)
      get(projectPath: string): ProjectDefaults | undefined
      set(projectPath: string, defaults: ProjectDefaults): void
      clear(projectPath: string): void
    }
    ```
  - `src/shared/types/agent.ts` 新增：
    ```ts
    /** 项目级默认（覆盖全局默认）。allowedFiles 存相对项目根的相对路径。 */
    export interface ProjectDefaults {
      defaultAdapter?: string
      defaultModel?: string
      allowedFiles?: string[]
    }
    ```
  - **`project_path` 必须规范化**：统一分隔符为 `/`、去掉尾斜杠、macOS 上不解析大小写。提供一个导出的纯函数
    ```ts
    export function normalizeProjectPath(p: string): string
    ```
    并在 `get` / `set` 内部都过一遍。

- [ ] **Step 1: 写失败的测试**

新建 `src/main/__tests__/project-settings-repository.test.ts`：

```ts
it('set 后 get 能读回，allowedFiles 存相对路径', () => { ... })
it('get 不存在的项目返回 undefined', () => { ... })
it('clear 会删除该项目的设置', () => { ... })
it('normalizeProjectPath 抹平路径写法差异', () => {
  expect(normalizeProjectPath('/tmp/p/')).toBe('/tmp/p')
  expect(normalizeProjectPath('/tmp\\p')).toBe('/tmp/p')
})
```

在 `src/main/__tests__/database-migration.test.ts` 追加：迁移到 v18 后 `project_settings` 表存在，且旧库（v17）迁移过来时该表被创建、数据不丢。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/__tests__/project-settings-repository.test.ts src/main/__tests__/database-migration.test.ts`
Expected: FAIL —— repository 不存在 / 表不存在。

- [ ] **Step 3: 加表 + bump 版本**

`src/main/database.ts`：
- `CURRENT_SCHEMA_VERSION` 从 `17` 改成 `18`。
- 在 `TABLE_SCHEMAS` 数组末尾追加：
  ```ts
  {
    name: 'project_settings',
    createSql: `
      CREATE TABLE project_settings (
        project_path TEXT PRIMARY KEY,
        defaults_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    requiredColumns: ['project_path', 'defaults_json', 'updated_at'],
  },
  ```
  `rebuildTableIfNeeded` 会自动为新库建表、为老库补建——**不需要**在 `runIncrementalMigrations` 里另写建表语句。

- [ ] **Step 4: 实现 repository**

新建 `src/main/repositories/project-settings-repository.ts`，按上面的接口实现。`get` / `set` 里对 `project_path` 做 `normalizeProjectPath`；`defaults_json` 用 `JSON.stringify` / `JSON.parse` 存取，**解析失败时返回 `undefined` 而不是抛错**（脏数据不该让整个应用起不来）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/main/__tests__/project-settings-repository.test.ts src/main/__tests__/database-migration.test.ts src/main/__tests__/database.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit
git add src/main/database.ts src/main/repositories/project-settings-repository.ts src/main/__tests__/project-settings-repository.test.ts src/main/__tests__/database-migration.test.ts
git commit -m "feat(db): 新增 project_settings 表（schema v18）"
```

---

## Task 6: 项目级默认 IPC + 范围记忆 UI

**Files:**
- Modify: `src/shared/types/ipc.ts`（新增两个通道）、`src/main/ipc/project.ts`、`src/main/ipc-handlers.ts`（装配 repository）
- Modify: `src/renderer/store/sessionStore.ts`、`src/renderer/components/agent/AgentChatPanel.tsx:254-274`、`src/renderer/components/agent/ChatInput.tsx:159-167`
- Create: `src/renderer/components/agent/__tests__/ScopeEditor.test.tsx`
- Test: `src/renderer/store/__tests__/sessionStore.test.ts`（已存在）

**Interfaces:**
- Consumes: Task 5 的 `ProjectSettingsRepository` 与 `normalizeProjectPath`；Task 1 的 `resolveReadonly`（在 `src/shared/readonly.ts`，renderer 直接 import 同一份，**不重复实现推导规则**）。
- Produces:
  - IPC 通道：
    ```ts
    'project:getDefaults': (projectPath: string) => Promise<ProjectDefaults | null>
    'project:setDefaults': (projectPath: string, defaults: ProjectDefaults) => Promise<void>
    ```
  - `src/renderer/components/agent/ScopeEditor.tsx`（新建）：
    ```ts
    export function ScopeEditor(props: {
      effectiveFiles: string[]
      readonly: boolean
      adapterSupportsReadonly: boolean
      onAddFile: (relPath: string) => void
      onRemoveFile: (relPath: string) => void
      onClearAll: () => void
    }): JSX.Element
    ```
    渲染三态：**只读**（显示「本次只读，Agent 不能修改文件」+ 一个「放开范围」按钮）、**可写**（列出范围文件，每个可删 + 一个「清空全部」按钮）、**适配器不支持只读**（显示警告条，说明该适配器无法保证只读，范围为空时需二次确认）。

- [ ] **Step 1: 写失败的测试**

新建 `src/renderer/components/agent/__tests__/ScopeEditor.test.tsx`（`// @vitest-environment jsdom`）：

1. `readonly === true` → 渲染「只读」文案与「放开范围」按钮。
2. `readonly === false` → 列出 `effectiveFiles`，点某个文件的删除按钮 → 调用 `onRemoveFile`。
3. 点「清空全部」→ 调用 `onClearAll`（**并且**这一路径要连带清掉项目级默认——见 Step 5）。
4. `adapterSupportsReadonly === false` 且 `readonly === true` → 渲染警告条。

在 `src/renderer/store/__tests__/sessionStore.test.ts` 追加：

5. 项目级默认里 `allowedFiles` 非空 → 构造出的 session config 里 `allowedFiles` 含这些文件、`readOnly === false`。
6. 项目级默认为空 → `allowedFiles` 为空 → `readOnly === true`。
7. 用户显式清空范围 → 项目级默认被清掉（断言 `project:setDefaults` 被调用且 `allowedFiles` 为空数组）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/components/agent/__tests__/ScopeEditor.test.tsx src/renderer/store/__tests__/sessionStore.test.ts`
Expected: FAIL —— 模块与通道都不存在。

- [ ] **Step 3: 主进程 IPC**

- `src/shared/types/ipc.ts` 加上面两个通道的类型签名（`ProjectDefaults` 类型放 `src/shared/types/agent.ts`，让 renderer 与 main 共用）。
- `src/main/ipc/project.ts` 注册两个 `typedHandle`：从 `ProjectSettingsRepository` 读写；`projectPath` 先过 `normalizeProjectPath`；路径必须是**已注册的项目路径**（复用现有的路径白名单校验，`src/main/ipc-handlers.ts` 里已有同类逻辑）。
- `src/main/ipc-handlers.ts` 里实例化 `ProjectSettingsRepository` 并注入。

- [ ] **Step 4: renderer 读项目级默认并推导只读**

`src/renderer/store/sessionStore.ts`：
- 进入项目 / 切换当前图时，调 `project:getDefaults(currentGraph.projectPath)` 取项目级默认（**`projectPath` 为空时不调**——图没绑定项目就没有项目级默认）。
- `handleSend` 构造 session config 时：
  ```
  allowedFiles = union(项目级默认.allowedFiles ∪ 本次会话显式引用的文件)
  readOnly    = allowedFiles.length === 0
  ```
- 项目级默认里的 `defaultAdapter` / `defaultModel` 也要用上：选中适配器时优先取项目级覆盖，其次全局默认，最后用户本次手动选的。

- [ ] **Step 5: 范围编辑 UI**

- 新建 `src/renderer/components/agent/ScopeEditor.tsx`（接口见上）。
- `src/renderer/components/agent/ChatInput.tsx:159-167`：把 `@` 文件引用从"顺带产生 allowedFiles"升级为**显式范围入口**——保留 `@` 引用，但引用后的文件在 `ScopeEditor` 里可见、可删。
- `src/renderer/components/agent/AgentChatPanel.tsx:254-274` 的 `handleSend`：按 Step 4 的规则构造 config，并把 `readOnly` 一起传下去。
- **"清空全部"的动作**：清掉本次会话引用 **并且**调 `project:setDefaults(projectPath, { ...defaults, allowedFiles: [] })` 清掉项目级默认，让下一次会话回到只读。
- **"放开范围"的动作**：打开一个文件选择器（复用现有的文件树 / `@` 搜索），选中的文件写进项目级默认 → 下次自动带上。
- 文案走 `t()`，加在 `src/shared/i18n/resources/domains/agent.ts`（及 en）。

- [ ] **Step 6: 适配器不支持只读时的提示**

当用户选的适配器 `getReadonlySupport(name) === 'unsupported'` 且范围为空 → 渲染警告条 + **发送前二次确认**（决定 D3 说"直接拒绝发送"是针对**回退链**；用户**主动**选了不支持只读的适配器时，按 spec §四.E2 的原设计是"UI 显式标注 + 二次确认"。**这一处保持二次确认**，回退链那处保持拒绝——两处语义不同，实现时不要混淆）。

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run src/renderer/components/agent/__tests__/ScopeEditor.test.tsx src/renderer/store/__tests__/sessionStore.test.ts`
Expected: PASS。

- [ ] **Step 8: 类型检查 + 全量测试 + 提交**

```bash
npx tsc --noEmit
npm run lint
npm run test
git add src/shared/types/ipc.ts src/shared/types/agent.ts src/main/ipc/project.ts src/main/ipc-handlers.ts src/renderer/store/sessionStore.ts src/renderer/components/agent/AgentChatPanel.tsx src/renderer/components/agent/ChatInput.tsx src/renderer/components/agent/ScopeEditor.tsx src/renderer/components/agent/__tests__/ScopeEditor.test.tsx src/renderer/store/__tests__/sessionStore.test.ts
git commit -m "feat(agent): 范围记忆与项目级默认，只读状态在会话面板可见"
```

---

## 完成判据

```bash
npx tsc --noEmit
npm run lint
npm run test
```

外加一条**人工验证**（无法用单测覆盖）：

1. 新建项目 → Agent 面板显示「本次只读，Agent 不能修改文件」。
2. 只读会话里让 Agent 改一个文件 → **改不动**（适配器报工具不可用，或命令被拒）。
3. 点「放开范围」选一个文件 → 状态变成可写，范围列表里能看到那个文件。
4. **重启应用** → 范围仍在（验证 `project_settings` 持久化 + 读取）。
5. 用 `cline`（若已装）开会话且范围为空 → 出现「该适配器不支持只读」的警告与二次确认。
6. 只读会话里把主适配器故意弄挂 → 不会回退到能写的 `mcp`，而是明确报错。
7. 在项目目录里手动新建一个文件，同时跑一个只读会话 → **那个文件不会被 BizGraph 删除**（回归 §二.E 引用的那个坑）。

> 本计划**不含**：设置面板的「默认值」页签、状态菜单 per-type 过滤、静默失败 toast 归零。它们在 `docs/superpowers/plans/2026-10-31-ux-settings-ui.md`。
