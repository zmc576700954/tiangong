# 框架硬伤修复 — 批次 1（F1–F9）

> 创建：2026-10-27
> 范围：六子系统（模型 / Prompt / Schema / 通道 / Session / Memory）调研确认的 9 个框架级缺陷
> 设计：`docs/superpowers/specs/2026-10-27-framework-hardening-design.md`
> 计划：`docs/superpowers/plans/2026-10-27-framework-hardening.md`
> 分支：`claude/framework-hardening`（base `6d03f9d`）

## 为什么是「硬伤」

这 9 条不是功能缺失，而是**已经建好的能力没有接上**，或**实现与自己的设计意图相矛盾**。共同特征：代码看起来在干这件事，实际在干另一件事——比缺功能更难发现，也更贵。

| ID | 缺陷 | 根因 | 修复任务 |
|----|------|------|---------|
| F1 | 用户请求原文经 `memoryContext` 进入 **system 通道**，同时又在 user turn 出现两次 | `agent-manager.ts:633` → `base.ts:937` → `claude-code.ts:213` | Task 2 / 3 |
| F2 | scope 压缩分级按**英文**标题分类，生产者输出**中文**标题 → 每段落进 `other`，Level 1/2/3 全是 no-op | `prompt-orchestrator.ts:131` vs `scope-prompt-builder.ts:50-114` | Task 1 |
| F3 | 项目记忆与会话历史记忆算出来后**直接丢弃** | `context-assembler.ts:76` | Task 4 |
| F4 | context 层因 `outputs` 从不传入而常年空转；第二份 scope 构造实现零消费者 | `context-assembler.ts:124-135` | Task 1 / 2 / 4 |
| F5 | claude-code **从不发射 `sessionEnded`** → 恢复 / 回退 / Phase B 记忆管线对该适配器整体不可达 | `claude-code.ts` 中 `sessionEnded` 出现 0 次 | Task 5 |
| F6 | `migrate()` 用版本号门禁重建 → 改了 `createSql` 但没 bump 版本时，schema 改动静默失效 | `database.ts:659` | Task 6 |
| F7 | `MessageStatus` 含 3 个值 DB CHECK 不允许 → 写入抛裸 SQLite 错，降级成 `IPC_HANDLER_ERROR` | `agent.ts:147` vs `database.ts:379` | Task 7 |
| F8 | `safeJsonParse` 的 validator **零调用点使用** → 所有 JSON 列盲转，脏数据直接进类型化对象 | `db-utils.ts:37` 及 7 处调用点 | Task 8 |
| F9 | waterline 超预算时**反向抢占** context 预算，而 waterline 不可压缩 → context 被压得更狠、水位线一点没瘦 | `prompt-orchestrator.ts:288-298` | Task 2 |

---

## 修复前 → 修复后

### F1 / D1 — Prompt 拆成「稳定前缀 / 每轮上下文 / 用户请求」三段

**修复前**：`PromptOrchestrator` 产出单一 `text`，被当作 system prompt 整段下发。用户请求原文既在 system 通道里（拼在 `memoryContext` 前缀后），又在 user turn 里 —— **LLM 看到两次**。同时 `codeContext` 被塞进 scope 段，scope 每轮变化，**可复用的 KV-cache 前缀被污染**。

**修复后**：引入 `PromptContext { stable, turn }`：

| 内容 | 归属 |
|------|------|
| 系统指令 / 会话摘要 / scope 约束 / 项目记忆 | `stable`（跨轮不变） |
| 代码上下文 / 编译上下文 / 水位线 / 会话历史记忆 | `turn`（每轮变化） |
| **用户请求** | **两段都不注入** —— 由适配器已有的 `buildCommandPrompt` 单独承载 |

- SDK 适配器：`systemPrompt = stable`，user turn = `[turn, commandPrompt].join('\n\n')`
- CLI 一次性适配器：单串 prompt，顺序固定 `stable → toolPrompt → turn → command`

`buildScopePrompt` 删掉 `codeContext` 形参（它让 scope 每轮变化），`codeContext` 改由编排器放入 turn 段。

### F2 / D2 — scope 段标题单一来源

**修复前**：`compressScopeByPriority` 按 `'## Invariant Rules'` 等**英文**标题分类，生产者 `scope-prompt-builder.ts` 实际输出 `'## 业务不变量'` 等**中文**标题。所有段落落进 `other`，**Level 1/2/3 全是 no-op**，只剩硬截断 —— 压缩阶梯形同虚设。

**修复后**：`scope-prompt-builder.ts` 导出 `SCOPE_SECTION_HEADINGS` 常量表，生产者与分类器共用同一份字面量，从结构上杜绝再次漂移。分类恢复生效：

| 分类 | 标题常量 | 阶梯行为 |
|------|---------|---------|
| `invariant` | `## 业务不变量` | Level 1 移除 |
| `upstream` | `## 上游契约` | Level 2 移除 |
| `downstream` | `## 下游契约` | Level 2 移除 |
| `allowed-files` | `## 允许修改的文件（白名单）` | Level 3 压成 basename |
| `other` | 验收标准 / **黑名单** / 待修复 Bug / 附加上下文 | 全程保留，仅受硬截断 |

黑名单是安全约束，任何预算压力下都不得被丢弃。

同时删除 `src/main/code-intelligence/prompt-assembler.ts`（151 行）——`PromptAssembler` 类零生产消费者，却复制了第二份 scope 构造，段标题还与 `scope-prompt-builder.ts` 不一致（`## 允许修改的文件` vs `## 允许修改的文件（白名单）`）。留着它就是留一个随时会被误用的第二实现。

### F3 / F4 — 记忆与代码上下文真正进入 prompt

**修复前**：`context-assembler.ts:76` 把项目记忆与会话历史记忆算出来，赋给**下划线前缀**变量（下划线 = 约定即丢弃）。context 层因 `outputs` 从不传入而常年空转。

**修复后**：项目记忆并入 `stable`（项目级不变），会话历史记忆并入 `turn`（每轮检索）。context 层不再是空转。

### F9 / D3 — waterline 超预算截断自身

**修复前**：水位线超预算时**反向抢占 context 层的预算**（`prompt-orchestrator.ts:288-298`），而水位线是不可压缩层、大小不变 —— 净效果是 context 被压得更狠、水位线一点没瘦。

**修复后**：超预算时截断水位线**自身文本**，按 token 二分截断保证结果确实 ≤ 预算，不再动别人的预算。

### F5 / D4 — claude-code 补齐会话终止与恢复契约

三处改动：

1. **发射终止事件**：SDK 错误分支（非 AbortError）除发 `error` 输出外，追加 `sessionEnded(sessionId, 'error', null)`。AbortError 是用户主动取消，不发终止事件。
2. **恢复策略拿到 CLI 级会话 id**：`AgentAdapter` 新增可选 `getResumeSessionId?(sessionId): string | undefined`；`BaseAdapter` 实现为读 `session.config.resumeSessionId`（claude-code 在 SDK init 消息里写入 conversation id）。策略侧语义修正：**拿到 `resumeSessionId` 才走原生恢复，拿不到返回 `null`**（不具备原生恢复条件，走替换路径）—— 此前是「假装恢复」，等于丢上下文。
3. **原生恢复重发上一条命令**：native 分支此前只恢复映射、**不重发命令**，用户指令实际丢失。改为同样调用 `resumeLastCommand(sessionId, state.lastCommand)`。

> 一处更正：调研初稿把 F5 描述为「原生 resume 是坏的」。复核后更正为「恢复路径根本不会被触发」。真正起作用的续接机制是 SDK session + adapter 私有 clone 上的 `resumeSessionId`，仅在同一进程、同一 session 对象存活时有效。

### F6 / D5 — schema 迁移慢路径无条件重建 + 列类型比对

**修复前**：`migrate()` 用 `currentVersion < CURRENT_SCHEMA_VERSION` 门禁重建 —— 改了 `createSql` 但忘了 bump 版本时，checksum 虽失配，但重建循环被跳过，**schema 改动静默失效**。

**修复后**：

1. 慢路径（版本落后 **或** checksum 失配）一律尝试重建；`rebuildTableIfNeeded` 内部只在列集合、列类型或 CHECK 文本变化时才真正重建，无变化时只做两次 pragma 查询。
2. 比对从「列名 + CHECK 文本」扩展到「列名 + **列类型** + CHECK 文本」，让 `INTEGER → TEXT` 这类类型变更不再被漏掉。
3. `CURRENT_SCHEMA_VERSION` 仍需随 schema 变更 bump（约定不变），但漏 bump 不再吞掉变更。

### F7 / D6 — MessageStatus 与 DB CHECK 对齐

**修复前**：`MessageStatus` 类型含 `'queued' | 'sending' | 'permanently_failed'`，DB CHECK 只允许 5 个值。渲染层 `messageStore.ts:314` 在重试耗尽时把消息标成 `permanently_failed` 并回写 DB → **裸 SqliteError**，被 IPC 层降级成信息全无的 `IPC_HANDLER_ERROR`。

**修复后**：以类型定义为准，CHECK 扩容为 `('success','error','pending','streaming','aborted','queued','sending','permanently_failed')`。`CURRENT_SCHEMA_VERSION` 15 → 16。存量行的 status 值全部落在新集合内，重建无损。

### F8 / D7 — JSON 列运行时校验

**修复前**：`safeJsonParse` 的 validator 参数零调用点使用 —— 7 处 JSON 列全是盲转。两种后果：

- **崩溃**：脏数据把错误形状原样交给渲染层，渲染层对 `rules` / `contextRefs` 做 `.map` / `.forEach`，形状不对直接崩在画布上
- **整页打不开**：`agent_logs` 的两列更激进 —— 脏数据让整个列表查询抛 `DatabaseError`，**一条坏日志就能让整个节点的历史面板打不开**

**修复后**：新增守卫 `isRecord` / `isStringArray` / `isUnknownArray` / `isAgentCommand` / `isAgentOutput` / `isAgentOutputArray`（`src/shared/type-guards.ts`），脏数据退化为默认值：

| 列 | 期望形状 | 非法值退化 |
|----|---------|-----------|
| `chat_messages.context_refs` | `ContextRef[]` | `[]` |
| `chat_messages.tool_calls` | `ToolCallBlock[]` | `[]` |
| `chat_messages.error` | `MessageError` | `undefined` |
| `agent_logs.command` | `AgentCommand` | `{ type:'implement', description:'', targetNodeId:'' }` |
| `agent_logs.outputs` | `AgentOutput[]` | `[]` |
| `nodes.rules` / `context_refs` | 数组 | `undefined` |
| `nodes.metadata` / `content` / `wiki_meta` | 对象 | `undefined` |
| `edges.content` | 对象 | `undefined` |

`agent_logs` 的必填列（`id` / `session_id` / …）与 `result` 枚举仍然抛错 —— 那是数据缺失，不是形状脏。

---

## 落地记录

### 提交序列

```
c503f80 fix(db): JSON 列统一走 safeJsonParse 的运行时校验，脏数据退化为默认值
711cd60 fix(db): chat_messages.status CHECK 扩容以覆盖 MessageStatus 全集（schema v16）
b00a9e8 fix(db): 迁移慢路径无条件重建，比对列类型防 schema 变更静默失效
9036e0d fix(session): claude-code 补齐 sessionEnded 发射与原生恢复重发契约
bcd4d19 fix(memory): 项目记忆与会话历史记忆接入 prompt 分段
289b7af fix(prompt): 适配器按 stable/turn 分离投递，用户请求不再进入 system 通道
7859a15 feat(prompt): 装配结果拆为 stable/turn 两段，水位线超预算改为截断自身
d9475ea fix(prompt): scope 段标题收敛为单一常量源，修复压缩分级失效
5126a4d docs(plan): 框架硬伤修复设计文档与实施计划
```

### 规模

| 项 | 数 |
|----|---|
| 提交 | 9（含设计文档） |
| 改动文件 | 49（其中源码 24 / 测试 25） |
| 代码增删 | +2433 / -631（含 1323 行计划与设计文档） |
| 测试用例 | 2867 全绿 / 231 个测试文件 |

### 关键接口变更

| 接口 | 变更 | 用途 |
|------|------|------|
| `PromptContext` | 新增 `{ stable, turn }` | D1 两段式注入上下文 |
| `AgentAdapter.getResumeSessionId?()` | 新增可选方法 | D4 原生恢复前置条件 |
| `RecoveryContext.resumeSessionId?` | 新增可选字段 | D4 传递 CLI 会话 id |
| `BaseAdapter.getSessionConfig()` | 新增 | D1 读适配器**实时**配置（压缩摘要写在适配器自己的 clone 上，manager 快照拿不到） |
| `SCOPE_SECTION_HEADINGS` | 新增导出 | D2 段标题单一来源 |
| `compressScopeByPriority` | 新增导出 | D2 压缩分类可测 |
| `isRecord` / `isStringArray` / `isUnknownArray` / `isAgentCommand` / `isAgentOutput` / `isAgentOutputArray` | 新增导出 | D7 JSON 列守卫 |
| `safeJsonParse(raw, fallback, validator?)` | validator 形参放宽为 `(val: unknown) => boolean` | D7 见下方说明 |
| `rebuildTableIfNeeded` | 改为导出 | D5 列类型比对可测 |

> `safeJsonParse` 的 validator 形参从 `(val: unknown) => val is T` 放宽为 `(val: unknown) => boolean`：`isRecord` 的谓词类型是 `Record<string, unknown>`，与 `MessageError` 这类 interface 不满足 TypeScript 的谓词可赋值性（interface 没有隐式索引签名），传不进去。放宽后调用点用显式泛型指定目标类型，返回类型仍是 `T`，语义不变。

### 与 CLAUDE.md「Boundaries with Agent CLI」的对齐

| 边界 | 本轮做法 |
|------|---------|
| 不修改 Agent CLI 的 system prompt / user request | 用户请求**移出** system 通道，由适配器既有 `buildCommandPrompt` 承载 —— 比「不修改」更严：system 通道从此只承载 BizGraph 自己组装的可缓存上下文 |
| 不污染可复用 KV-cache prefix | `codeContext` 移出 scope 段；`stable` 段跨轮逐字节一致（同一 CLI 会话连发两条命令有专门用例钉住） |
| A2A 透明转发不下发内部状态 | `transparentForward` 会话的 `stable` 与 `turn` **同时为空**（专门用例） |
| schema 变更必须 bump 版本 | `CURRENT_SCHEMA_VERSION` 15 → 16，同时补上漏 bump 时的兜底 |

---

## 验证

```bash
npx tsc --noEmit          # 零错误
npm run test              # 2867 / 2867 通过（231 个测试文件）
npm run lint              # 零警告
```

**better-sqlite3 ABI**：本机 Node v20.20.2 是 `NODE_MODULE_VERSION` 115，Electron 33.4.11 是 **130** —— **ABI 不同**，同一个 `.node` 不能同时服务两边（实测：Node ABI 构建在 Electron 里直接报 `compiled against a different Node.js version`）。因此：

- 跑 Vitest 前 `npm rebuild better-sqlite3`（切到 Node ABI）
- 跑 Electron / `npm run dev` 前 `npx electron-builder install-app-deps`（切回 Electron ABI）

本轮收尾的终态是 **Electron ABI**（`npm run dev` 可用）；此状态下再跑 `npm run test` 需要先 `npm rebuild better-sqlite3`。

## 遗留

| 项 | 说明 |
|----|------|
| `snapshot-repository.ts` 的 `snapshots.data` 列 | 同为盲转，但不在 D7 表内，且快照是整库重建时写入的受控数据，本轮未动 |
| `HybridSearchEngine` 未接入 agent prompt 路径 | 设计文档的「批次 2」范围 |
| 真实 tokenizer 替代 4 字符启发式 | 设计文档的「批次 4」范围 |
