# BizGraph 代码审查报告

## 审查范围

本次审查覆盖任务 #8（配置系统与 MCP 兼容架构）及任务 #9（TypeScript 编译修复）涉及的所有文件。

---

## 一、总体评价

### 架构层面

项目采用 Electron + React + TypeScript 技术栈，整体分层清晰：
- `src/main/` — 主进程（数据库、IPC、Agent 适配器、扫描器）
- `src/renderer/` — 渲染进程（UI、状态管理、画布）
- `src/shared/` — 共享类型与常量
- `src/preload/` — 安全桥梁

新增的配置系统与 MCP  fallback 架构设计合理，实现了"CLI 优先、API fallback"的降级策略，符合用户要求的 cc-switch 参考模式。

### 通过状态

- `tsc --noEmit`：**零报错通过**
- 运行时结构完整性：**良好**
- 安全边界：**基本合规**

---

## 二、按文件详细审查

### 1. `src/main/settings.ts` — 配置管理器

**状态：** 可接受，有优化空间

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Warning** | `detectCliTool` 版本解析存在换行符切割问题 | 第162行 `result.trim().split('\n')[0]` 在 Windows 上可能因 `\r\n` 导致异常，建议统一使用 `trim()` 后再处理 |
| **Warning** | `installCliTool` 使用 `npm install -g` | 全局安装可能因权限失败，未提供 `sudo` 或替代方案；且未检测 `npm` 本身是否可用 |
| **Info** | `mergeSettings` 未处理新增 CLI 工具 | 若未来默认工具列表增加，已保存配置中缺失的新工具不会自动补全 |
| **Info** | 缺少配置校验逻辑 | `writeSettings` 未校验数据完整性，理论上可写入非法结构 |

**建议：**
- 为 `detectCliTool` 添加 `npm` 和 `node` 前置检测
- 考虑使用 `child_process.spawn` 替代 `execSync` 安装 CLI，避免阻塞主进程
- 添加 JSON Schema 或简单校验函数保护 `writeSettings`

---

### 2. `src/main/mcp/client.ts` — MCP 客户端

**状态：** 设计良好，边界处理需加强

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Critical** | `connect()` 中 `setTimeout` 延迟初始化不可靠 | 第71行硬编码 500ms 等待进程就绪，在某些系统上可能不足；应改为监听进程 stdout 的 `initialized` 响应或实现真正的握手超时 |
| **Warning** | `handleData` 未处理 JSON 分片 | 若进程一次输出不完整的 JSON 行，当前实现会将残留数据留在 `buffer` 中，这是正确的；但若输出包含多字节字符（如 UTF-8 emoji）跨 Buffer 边界，可能导致乱码 |
| **Warning** | `call()` 缺少超时机制 | 若 MCP 服务器无响应，`pending` 中的 Promise 将永远挂起，导致内存泄漏 |
| **Warning** | `disconnect()` 中 `this.proc?.on('exit', ...)` 可能注册多个监听器 | 若多次调用 `disconnect`，会累积事件监听器 |
| **Info** | 未处理 `notifications/message` 以外的服务端通知 | MCP 协议中服务器可能发送多种通知类型 |

**建议：**
- 为 `call()` 添加请求超时（如 30 秒），超时后自动 reject 并从 `pending` 中移除
- `connect()` 改为基于响应的握手，而非固定延迟
- `disconnect()` 前先移除旧的事件监听器

---

### 3. `src/main/adapters/mcp-adapter.ts` — MCP 适配器

**状态：** 功能完整，安全与异常处理需改进

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Critical** | API Key 以明文存储在 JSON 文件中 | `settings.json` 中的 `apiKeys[].key` 是明文，存在安全风险；建议至少做简单的 XOR 或 base64 混淆，或评估使用系统 keychain |
| **Critical** | `fetch` 调用未处理网络超时 | Anthropic/OpenAI/DeepSeek 的 API 调用均无 `AbortSignal` 超时控制，在网络异常时会长期挂起 |
| **Warning** | `startSession` 中的假进程对象 | 第69行 `proc = { stdin: null, ... } as unknown as AgentSession['process']` 类型欺骗，若其他代码依赖 `proc.stdin.write` 会运行时崩溃 |
| **Warning** | `doSendCommand` 未使用 MCP tools | 虽然收集了工具列表，但 LLM 响应后未实际调用 `callTool` 执行工具；当前实现仅为"聊天式 fallback"，非真正的 MCP Agent |
| **Warning** | 模型名称硬编码 | `claude-3-5-sonnet-20241022`、`gpt-4o`、`deepseek-chat` 均为硬编码，未从 `defaultModel` 配置读取 |
| **Info** | `callAnthropic` 系统消息处理 | 将 system 消息从 messages 数组中过滤出来是正确的 Anthropic 做法，但若传入的 messages 全为 system 消息，会发送空数组 |

**建议：**
- 为 `fetch` 添加 `AbortController` 超时（建议 60 秒）
- 评估使用 `safe-storage` 或 `keytar` 加密存储 API key
- 若暂时不实现 tool calling，应在 UI 中明确标注 MCP 当前仅为"增强提示"模式
- 从 `settings.defaultModel` 读取模型名称，而非硬编码

---

### 4. `src/main/ipc-handlers.ts` — IPC 处理器

**状态：** 结构合理，有一处类型不一致

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Warning** | `startSession` 返回类型与 `IpcApi` 不一致 | IPC 类型定义中 `'agent:startSession'` 返回 `Promise<{ sessionId: string }>`，但实际实现返回 `{ sessionId: string; fallback?: boolean }`，渲染进程未处理 `fallback` 字段 |
| **Warning** | `sendCommand` / `terminateSession` 的轮询逻辑 | 遍历所有适配器尝试的方式在低效的同时可能误操作其他适配器的会话；建议通过 session ID 前缀（如 `claude-` / `mcp-`）直接定位适配器 |
| **Info** | `graph:create` 未使用 `project_path` 字段 | 数据库表有 `project_path` 列，但插入时未填充，与 `Graph` 类型中的 `projectPath` 不对应 |

**建议：**
- 统一 `agent:startSession` 的返回类型，或在渲染进程中处理 `fallback` 标志并给用户提示
- 为 session ID 添加适配器前缀映射，避免 O(n) 轮询

---

### 5. `src/shared/types.ts` — 共享类型

**状态：** 良好，有一处遗留问题

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Warning** | `GraphType = 'online' | 'dev'` 与数据库 CHECK 约束 | 需确保数据库 schema 的 CHECK 约束值（`type IN ('online', 'dev')`）与此类型严格一致；历史版本曾出现 `'production'` / `'development'` 不一致导致崩溃 |
| **Info** | `IpcApi` 中 `'settings:setApiKey'` 的 `baseUrl` 类型为 `string | null` | 虽然兼容，但 `null` 与 `undefined` 在业务逻辑中可能产生歧义 |

**建议：**
- 在数据库初始化时添加 schema 版本校验，防止未来 CHECK 约束与类型定义再次脱节
- 考虑引入 `zod` 或 `valibot` 进行运行时类型校验，替代手动类型断言

---

### 6. `src/preload/index.ts` — 预加载脚本

**状态：** 良好

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Info** | 缺少 `settings:write` 的调用场景 | SettingsPanel 中只有 read/refresh/install/setApiKey，未见 write 调用；如需支持 MCP server 开关编辑，需补充 |

---

### 7. `src/renderer/panels/SettingsPanel.tsx` — 设置面板

**状态：** 功能可用，交互待完善

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Warning** | `alert()` 阻塞渲染进程 | 第69行使用 `alert(result.message)` 会冻结整个 Electron 窗口，建议使用 toast 或内联状态提示 |
| **Warning** | API Key 输入框无显示/隐藏切换 | 密码框永久隐藏输入内容，用户无法确认输入是否正确 |
| **Warning** | MCP Server 列表只读 | 用户无法启用/禁用服务器或添加自定义服务器，与 `updateMcpServer` 后端能力不匹配 |
| **Info** | `saveApiKey` 后无成功反馈 | 保存 API key 后用户无法确认是否生效 |

**建议：**
- 使用轻量级 toast 组件（如 `sonner`）替代 `alert`
- 为密码框添加显示/隐藏切换按钮
- 扩展 MCP Server 列表为可编辑状态，利用已有的 `updateMcpServer` IPC

---

### 8. `src/renderer/store/graphStore.ts` / `agentStore.ts` — 状态管理

**状态：** 类型安全已修复，有设计建议

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Warning** | `graphStore.ts` 第15行 `sourceGraphId?: string` 参数与实际实现不一致 | `createGraph` 实现未接收此参数，但接口保留；若未来需要"从现有图克隆"功能需补全 |
| **Warning** | `loadGraph` 中串行加载 Bug | 第53-56行对每个节点串行调用 `bug:listByNode`，节点数量大时会产生 N+1 查询；建议增加 `bug:listByGraph` 批量接口 |
| **Info** | IPC 类型断言分散在各处 | `as Graph[]`、`as GraphNode` 等散布在 store 中，若 IPC 类型定义变更需全局修改；可考虑在 `window.electronAPI` 类型层面解决 |

**建议：**
- 添加 `bug:listByGraph` IPC 接口，避免 N+1 查询
- 考虑封装 IPC 调用层，统一处理类型转换和错误

---

### 9. `src/main/project-scanner.ts` — 项目扫描器

**状态：** 功能丰富，边界处理需加强

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Warning** | 正则提取路由/实体依赖 heuristics | 正则模式可能误匹配注释中的代码或字符串内容，导致假阳性 |
| **Warning** | 大型项目扫描可能内存溢出 | 未限制单次扫描的文件数量或大小，若项目包含 `node_modules` 或大量日志文件可能被误扫 |
| **Info** | 未缓存扫描结果 | 同一项目重复扫描会重新读取所有文件，建议添加 `scannedAt` 缓存或增量扫描 |

**建议：**
- 增加文件大小限制（如跳过 >1MB 的文件）
- 增加文件数量上限或进度回调
- 对 `node_modules`、`.git`、日志目录做更严格的排除

---

### 10. `src/renderer/canvas/GraphCanvas.tsx` — 画布组件

**状态：** 编译通过，运行时风险可控

**问题：**

| 级别 | 问题 | 说明 |
|------|------|------|
| **Warning** | `handleCreateNode` 中的坐标转换不准确 | 使用 `document.querySelector('.react-flow__viewport')` 获取的 rect 是视口坐标，与 React Flow 内部画布坐标系存在缩放/平移差异；应使用 `reactFlowInstance.screenToFlowPosition` |
| **Info** | `nodeTypes` 在每次渲染时重新创建 | 第134行 `const nodeTypes = { bizNode: BizNodeComponent }` 在组件内定义，应移至组件外部或 memoize |

---

## 三、安全审查

| 风险项 | 级别 | 说明 |
|--------|------|------|
| API Key 明文存储 | **High** | `settings.json` 中的 key 可被任何有文件系统访问权限的进程读取 |
| `npm install -g` 权限风险 | **Medium** | 全局安装可能因权限不足失败，且未验证 npm 包的来源完整性 |
| MCP Server 命令注入 | **Medium** | `McpServerConfig.command` / `args` 若从用户输入读取，存在命令注入风险；当前为硬编码配置，风险较低 |
| `graph:initFromProject` 路径遍历 | **Low** | 未对 `projectPath` 做路径规范化，但 `fs.readdir` 本身受操作系统权限保护 |

---

## 四、测试覆盖建议

当前项目未见单元测试文件（`tests/` 目录仅含 e2e）。建议优先补充以下测试：

1. **`settings.ts`** — 配置读写、merge 逻辑、CLI 检测 mock
2. **`mcp/client.ts`** — JSON-RPC 解析、超时处理、连接生命周期
3. **`project-scanner.ts`** — 各类框架的扫描 fixture 测试
4. **`project-analyzer.ts`** — 布局算法输入输出断言
5. **`ipc-handlers.ts`** — 数据库操作与 IPC 的集成测试

---

## 五、优先修复清单

### P0（阻塞性问题）
- [ ] 为 MCP `call()` 添加请求超时，防止 Promise 永久挂起
- [ ] 为 LLM API `fetch` 调用添加 `AbortController` 超时

### P1（重要改进）
- [ ] 替换 `alert()` 为无阻塞提示
- [ ] `loadGraph` N+1 查询优化（批量 Bug 加载）
- [ ] `GraphCanvas` 坐标转换使用 React Flow API
- [ ] 评估 API Key 加密存储方案

### P2（体验优化）
- [ ] SettingsPanel MCP Server 可编辑
- [ ] 密码框显示/隐藏切换
- [ ] `nodeTypes` 外提避免重复创建
- [ ] 项目扫描文件大小/数量限制

---

## 六、结论

本次提交的代码在架构设计上方向正确，MCP fallback 策略和 cc-switch 风格的统一配置系统都达到了预期目标。TypeScript 编译已完全修复。主要风险集中在**运行时超时处理**和**API Key 安全存储**两个方面，建议按优先清单逐步完善。

---

*审查人：Claude Code*
*日期：2026-05-25*
*审查范围：Task #8 + Task #9 全部变更*
