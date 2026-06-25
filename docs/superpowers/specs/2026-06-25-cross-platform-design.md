# 跨平台全架构支持设计

**日期**: 2026-06-25
**状态**: Approved

## 目标

BizGraph 桌面端全平台全架构覆盖：macOS (arm64/x64)、Windows (x64/arm64)、Linux (x64/arm64)，并新增 MSIX 安装格式。

## 策略：混合方案

两线并行、互不阻塞：
1. **短线**：构建配置 + CI 矩阵补齐，立即见效
2. **长线**：平台抽象层渐进抽取 + 数据库替换，长期改善

---

## 一、目标平台矩阵

| 平台 | 架构 | 安装格式 | 当前状态 | 目标 |
|------|------|---------|---------|------|
| macOS | arm64 | DMG | ✅ 已有构建 | + CI 测试 |
| macOS | x64 | DMG | ✅ 已有构建 | + CI 测试 |
| Windows | x64 | NSIS + MSIX | ✅ NSIS 已有 | + MSIX |
| Windows | arm64 | NSIS + MSIX | ❌ 未支持 | 新增 |
| Linux | x64 | AppImage | ✅ 已有构建 | + CI 测试 |
| Linux | arm64 | AppImage | ❌ 未支持 | 新增 |

---

## 二、构建配置改造

### 2.1 package.json build 字段变更

```json
"mac": {
  "category": "public.app-category.developer-tools",
  "target": [{ "target": "dmg", "arch": ["arm64", "x64"] }]
},
"win": {
  "target": [
    { "target": "nsis", "arch": ["x64", "arm64"] },
    { "target": "msix", "arch": ["x64", "arm64"] }
  ]
},
"msix": {
  "identityName": "com.bizgraph.app",
  "publisher": "CN=BizGraph",
  "publisherDisplayName": "BizGraph",
  "languages": ["zh-CN", "en-US"],
  "store": false
},
"linux": {
  "target": [{ "target": "AppImage", "arch": ["x64", "arm64"] }],
  "category": "Development"
}
```

### 2.2 构建脚本扩展

```json
"build:win":      "electron-builder --win"
"build:win:msix": "electron-builder --win msix"
"build:mac":      "electron-builder --mac"
"build:linux":    "electron-builder --linux"
"build:all":      "electron-builder --mac --win --linux"
```

### 2.3 MSIX 说明

- `store: false`：先做侧载分发，后续上架 Microsoft Store 时改为 true 并补充签名
- MSIX 可在一个包内包含多架构二进制（bundle），但 electron-builder 当前按架构分别打包，暂不合并

---

## 三、CI 矩阵改造

### 3.1 构建矩阵（6 节点）

```yaml
strategy:
  matrix:
    include:
      - os: macos-14
        arch: arm64
      - os: macos-13
        arch: x64
      - os: windows-latest
        arch: x64
      - os: windows-11-arm
        arch: arm64
      - os: ubuntu-latest
        arch: x64
      - os: ubuntu-24.04-arm
        arch: arm64
```

### 3.2 Job 结构

| Job | 节点 | 内容 |
|-----|------|------|
| lint | ubuntu-latest × 1 | ESLint + Type check |
| build | 6 节点矩阵 | 编译 + 打包 + 上传产物 |
| e2e | 3 节点（仅 x64） | ubuntu / windows / macos |

ARM64 节点仅做构建验证（编译通过 + 产物上传），不跑 E2E（Playwright 在 ARM64 CI 不稳定）。

### 3.3 Runner 说明

- `macos-14`：M1 runner，构建 arm64
- `macos-13`：Intel runner，构建 x64
- `windows-11-arm`：GitHub ARM64 runner
- `ubuntu-24.04-arm`：GitHub ARM64 runner

---

## 四、数据库替换：@libsql/client → better-sqlite3

### 4.1 替换理由

| 对比项 | @libsql/client | better-sqlite3 |
|--------|---------------|----------------|
| win32-arm64 | ❌ 无原生包 | ✅ 有 prebuild |
| darwin-arm64 | ✅ | ✅ |
| linux-arm64 | ✅ | ✅ |
| Electron prebuild | 需 napi-rs | prebuild-install 自动 |
| API 风格 | async | sync |
| 事务 API | `db.transaction('write')` | `db.transaction(() => {})` |
| 批量操作 | `db.batch(stmts, 'write')` | 事务内多次 `prepare().run()` |
| libsql 特有功能 | 嵌入式副本、Turso 同步 | 无（项目未使用） |

BizGraph 仅使用 libsql 的 SQLite 子集，未使用嵌入式副本或 Turso 云同步，迁移成本低。

### 4.2 API 映射表

| libsql | better-sqlite3 | 说明 |
|--------|---------------|------|
| `createClient({ url: 'file:path' })` | `new Database(path)` | 连接 |
| `client.execute(sql)` | `db.prepare(sql).run()` / `.get()` / `.all()` | 单条执行 |
| `client.execute({ sql, args })` | `db.prepare(sql).run(...args)` | 参数化执行 |
| `client.batch(stmts, 'write')` | 事务内循环 `prepare().run()` | 批量执行 |
| `client.transaction('write')` | `db.transaction(() => {})` | 显式事务 |
| `tx.execute()` / `tx.commit()` / `tx.rollback()` | 事务函数内直接操作，自动 commit/rollback | 事务操作 |
| `result.rows` | `.all()` 返回数组 | 查询结果 |
| `result.rows[0]` | `.get()` 返回对象 | 单行查询 |
| `result.rowsAffected` | `info.changes` | 影响行数 |
| `result.lastInsertRowid` | `info.lastInsertRowid` | 最后插入 ID |
| `type Row` | 普通对象 `Record<string, unknown>` | 行类型 |
| `type ResultSet` | `RunResult` / `Stmt` 返回值 | 结果类型 |
| `client.close()` | `db.close()` | 关闭连接 |
| `:memory:` URL | `:memory:` 路径 | 内存数据库 |

### 4.3 异步转同步策略

libsql 的 `.execute()` / `.batch()` / `.transaction()` 都是 async，better-sqlite3 全部是 sync。

**改造原则**：
- 所有 `await db.execute()` → `db.prepare().run/get/all()`
- 所有 `await db.batch()` → `db.transaction(() => { ... })`
- Repository 方法从 `async` 变为 sync（去掉 async/await）
- 上层调用者从 `await repo.method()` → `repo.method()`
- IPC handler 中可直接同步返回数据库结果，无需 async

**注意**：这是最大的改动面。上层所有 await 调用点都需要同步去除 await。需逐层追溯确保无遗漏。

### 4.4 受影响文件清单（31 个文件）

#### 核心层（2 文件）
1. `src/main/database.ts` — 初始化、迁移、PRAGMA、getClient
2. `src/main/index.ts` — initDatabase / closeDatabase 调用

#### Repository 层（8 文件）
3. `src/main/repositories/node-repository.ts` — batch(), execute()
4. `src/main/repositories/edge-repository.ts` — execute()
5. `src/main/repositories/graph-repository.ts` — batch(), execute()
6. `src/main/repositories/chat-repository.ts` — batch(), execute(), type Row, rowsAffected
7. `src/main/repositories/bug-repository.ts` — execute()
8. `src/main/repositories/snapshot-repository.ts` — execute()
9. `src/main/repositories/agent-log-repository.ts` — execute()
10. `src/main/repositories/compact-history-repository.ts` — execute(), type Row
11. `src/main/repositories/subagent-invocation-repository.ts` — execute(), type Row

#### Service 层（2 文件）
12. `src/main/services/graph-service.ts` — transaction('write'), commit/rollback
13. `src/main/services/chat-service.ts` — type Client

#### Memory 层（4 文件）
14. `src/main/memory/memory-store.ts` — batch(), execute(), lastInsertRowid, rowsAffected, FTS5
15. `src/main/memory/hybrid-search.ts` — execute()
16. `src/main/memory/waterline-sync.ts` — batch()
17. `src/main/memory/pipeline.ts` — batch()

#### IPC 层（2 文件）
18. `src/main/ipc/graph.ts` — type Client
19. `src/main/ipc-handlers.ts` — getClient()

#### Agent 层（1 文件）
20. `src/main/agent/agent-manager.ts` — type ResultSet, execute()

#### Code Intelligence（1 文件）
21. `src/main/code-intelligence/symbol-index.ts` — SAVEPOINT, execute(), type Client

#### 测试文件（8 文件）
22. `src/main/__tests__/database-migration.test.ts` — createClient, execute, close
23. `src/main/__tests__/chat-repository.test.ts` — mock Client/Row/ResultSet
24. `src/main/__tests__/bug-repository.test.ts` — mock Client/Row/ResultSet
25. `src/main/__tests__/edge-repository.test.ts` — mock Client/Row/ResultSet
26. `src/main/__tests__/compact-history-repository.test.ts` — mock Client/Row/ResultSet
27. `src/main/__tests__/subagent-invocation-repository.test.ts` — mock Client/Row/ResultSet
28. `src/main/memory/__tests__/memory-store.test.ts` — createClient, :memory:
29. `src/main/code-intelligence/__tests__/symbol-index.test.ts` — createClient, execute, close

#### 配置文件（2 文件）
30. `vite.config.ts` — external 列表
31. `package.json` — 依赖

### 4.5 改造顺序（6 步）

**Step 1 — 依赖替换**
- package.json：移除 `@libsql/client`，添加 `better-sqlite3` + `@types/better-sqlite3`
- vite.config.ts：external 列表替换
- 安装依赖，验证 prebuild 下载

**Step 2 — database.ts 核心改造**
- 替换 `createClient` → `new Database`
- 重写 `initDatabase()`：PRAGMA 语句改为同步调用
- 重写 `migrate()`：所有 execute 改为 prepare().run()
- 重写 `closeDatabase()`：同步关闭
- `getClient()` 返回类型改为 `Database`
- 保留 WAL 模式、SAVEPOINT、FTS5（全部兼容）

**Step 3 — Repository 层改造（8 文件）**
- 每个 Repository 构造函数接收 `Database` 替代 `Client`
- `execute()` → `prepare().run/get/all()`
- `batch()` → `db.transaction(() => { ... })`
- 去除所有 async/await
- 替换 `Row` 类型为行对象
- 替换 `ResultSet.rowsAffected` → `RunResult.changes`
- 替换 `ResultSet.lastInsertRowid` → `RunResult.lastInsertRowid`

**Step 4 — Service + Memory + IPC + Agent + SymbolIndex 层改造（8 文件）**
- graph-service.ts：重写 transaction('write') 为 `db.transaction(() => {})`，消除 commit/rollback
- chat-service.ts：替换 Client 类型
- memory-store.ts：重写 batch/execute，保留 FTS5
- hybrid-search.ts / waterline-sync.ts / pipeline.ts：同步化
- ipc/graph.ts / ipc-handlers.ts：替换 Client 类型
- agent-manager.ts：替换 ResultSet 类型，同步化
- symbol-index.ts：SAVEPOINT 保留（兼容），同步化

**Step 5 — 测试文件改造（8 文件）**
- database-migration.test.ts / memory-store.test.ts / symbol-index.test.ts：替换 createClient，同步化
- 5 个 mock 测试：重写 mock 为 better-sqlite3 风格（prepare/run/get/all）

**Step 6 — 上层 await 清理**
- 追溯所有 Repository/Service 调用者，去除多余的 await
- IPC handler 中可直接同步返回数据库结果
- 运行全量测试验证

### 4.6 关键兼容性确认

| 功能 | better-sqlite3 支持 | 说明 |
|------|-------------------|------|
| WAL 模式 | ✅ | PRAGMA journal_mode=WAL |
| 外键约束 | ✅ | PRAGMA foreign_keys=ON |
| FTS5 | ✅ | 编译时默认包含 |
| SAVEPOINT | ✅ | 标准 SQLite 语法 |
| :memory: | ✅ | `new Database(':memory:')` |
| PRAGMA | ✅ | 完整支持 |
| INSERT OR REPLACE | ✅ | 标准 SQLite 语法 |

---

## 五、平台抽象层

### 5.1 PlatformProvider 接口

```typescript
// src/main/platform/platform-provider.ts

export interface PlatformProvider {
  readonly platform: 'darwin' | 'win32' | 'linux'
  readonly arch: 'x64' | 'arm64'
  readonly isMac: boolean
  readonly isWindows: boolean
  readonly isLinux: boolean
  readonly isArm64: boolean
  readonly isWsl: boolean

  // 路径操作
  normalizePath(p: string): string
  pathsEqual(a: string, b: string): boolean
  isSystemPath(p: string): boolean
  isWithinParent(child: string, parent: string): boolean

  // 进程管理
  killProcess(proc: ChildProcess): void
  getShellConfig(): Partial<SpawnOptions>

  // CLI 工具
  whichCommand(cmd: string): string | null

  // 文件监听
  getWatcherOptions(): Partial<WatcherOptions>
}
```

### 5.2 3 批渐进抽取

**Batch 1 — 路径操作（5 处重复，最高优先）**

| 文件 | 当前代码 | 迁移到 |
|------|---------|--------|
| `src/main/ipc/utils.ts` | pathsEqual / isSystemPath | `provider.pathsEqual()` / `provider.isSystemPath()` |
| `src/main/ipc-handlers.ts` | pathsEqual (×3) | `provider.pathsEqual()` |
| `src/main/ipc/fs.ts` | isWithinParent | `provider.isWithinParent()` |
| `src/main/ipc/git.ts` | pathsEqual | `provider.pathsEqual()` |
| `src/main/scope-guard.ts` | pathsEqual / isWithinParent | `provider.pathsEqual()` / `provider.isWithinParent()` |

**Batch 2 — 进程管理（4 处，影响 Agent 执行）**

| 文件 | 当前代码 | 迁移到 |
|------|---------|--------|
| `src/main/adapters/base.ts` | killProcess (×2) + shell config | `provider.killProcess()` / `provider.getShellConfig()` |
| `src/main/adapters/mindmap-adapter.ts` | shell: true on Windows | `provider.getShellConfig()` |
| `src/main/settings.ts` | which vs where (×2) | `provider.whichCommand()` |

**Batch 3 — 剩余零散（3 处，低优先）**

| 文件 | 当前代码 | 迁移到 |
|------|---------|--------|
| `src/main/index.ts` | isMac 菜单构建 | `provider.isMac` |
| `src/main/scope-guard.ts` | WSL 检测 + watcher config | `provider.isWsl` / `provider.getWatcherOptions()` |
| `src/main/project-scanner/dir-scanner.ts` | isSystemPath | `provider.isSystemPath()` |

### 5.3 实现原则

- **单例 + 懒初始化**：`getPlatformProvider()` 首次调用时根据 `process.platform` 创建对应实例
- **不改变外部行为**：每批抽取后原有函数签名不变，内部委托给 Provider
- **可测试**：注入 mock Provider 可在任意平台测试所有平台分支逻辑

---

## 六、测试策略

### 6.1 三层覆盖

| 层级 | 范围 | 运行位置 |
|------|------|---------|
| 单元测试 | PlatformProvider mock、better-sqlite3 API 适配、Repository 逻辑 | 任意平台 (vitest) |
| E2E 测试 | 安装 → 启动 → 交互 → 退出 | CI x64 3 节点 |
| 构建验证 | 编译通过 + 产物上传 | CI 全 6 节点 |

### 6.2 新增测试文件

- `src/main/__tests__/platform-provider.test.ts` — PlatformProvider 全分支 mock 测试
- `src/main/__tests__/database-provider.test.ts` — better-sqlite3 连接、PRAGMA、迁移验证

### 6.3 现有测试改造

8 个测试文件全部从 libsql mock 迁移到 better-sqlite3 风格：
- 实例测试（3 个）：替换 `createClient` → `new Database`，同步化
- Mock 测试（5 个）：替换 mock 接口从 `execute/batch/close` → `prepare/run/get/all`

---

## 七、风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| better-sqlite3 同步 API 阻塞主进程 | Electron main process 本身是 Node.js，同步 I/O 是 SQLite 最佳实践（官方推荐） |
| 异步→同步改动面大 | 按层逐步改造（database → repository → service → ipc），每层独立验证 |
| FTS5 在 better-sqlite3 中行为差异 | better-sqlite3 编译时默认包含 FTS5，行为与 libsql 一致 |
| Windows ARM64 CI runner 可用性 | GitHub 2025 已提供 `windows-11-arm` runner；如不可用，降级为交叉编译 |
| MSIX 签名 | 初期 `store: false` 侧载，不涉及签名；上架时再处理 |
| better-sqlite3 prebuild 与 Electron 版本不匹配 | prebuild-install 自动匹配，CI 中验证 |
| graph-service.ts transaction 回滚语义差异 | libsql 手动 commit/rollback → better-sqlite3 事务函数抛异常自动 rollback，需确保业务异常被正确抛出 |
| `rebuildTableIfNeeded()` 中数据迁移丢失 | 该函数依赖 `execute()` + `SELECT` 动态构建 SQL，同步化后逻辑不变但需逐句验证 |
