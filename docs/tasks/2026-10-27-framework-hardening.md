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
| 系统指令 / scope 约束 / 项目记忆 | `stable`（跨轮不变，可被 KV-cache 复用） |
| 会话摘要 / 附加上下文 / 代码上下文 / 编译上下文 / 水位线 / 会话历史记忆 | `turn`（每轮变化） |
| **用户请求** | **两段都不注入** —— 由适配器已有的 `buildCommandPrompt` 单独承载 |

- SDK 适配器：`systemPrompt = stable`，user turn = `[turn, commandPrompt].join('\n\n')`
- CLI 一次性适配器：单串 prompt，顺序固定 `stable → toolPrompt → turn → command`

`buildScopePrompt` 删掉 `codeContext` 形参（它让 scope 每轮变化），`codeContext` 改由编排器放入 turn 段。

> **收尾修正**（见文末「评审修复」）：会话摘要与附加上下文原本也归 `stable`——压缩会重写摘要、换附件会改附加上下文，两者都会让稳定前缀失效。已移入 `turn`。

### F2 / D2 — scope 段标题单一来源

**修复前**：`compressScopeByPriority` 按 `'## Invariant Rules'` 等**英文**标题分类，生产者 `scope-prompt-builder.ts` 实际输出 `'## 业务不变量'` 等**中文**标题。所有段落落进 `other`，**Level 1/2/3 全是 no-op**，只剩硬截断 —— 压缩阶梯形同虚设。

**修复后**：`scope-prompt-builder.ts` 导出 `SCOPE_SECTION_HEADINGS` 常量表，生产者与分类器共用同一份字面量，从结构上杜绝再次漂移。分类恢复生效：

| 分类 | 标题常量 | 阶梯行为 |
|------|---------|---------|
| `invariant` | `## 业务不变量` | Level 1 移除 |
| `upstream` | `## 上游契约` | Level 2 移除 |
| `downstream` | `## 下游契约` | Level 2 移除 |
| `allowed-files` | `## 允许修改的文件（白名单）` | Level 3 压成 basename |
| `other` | 验收标准 / **黑名单** / 待修复 Bug | 全程保留，仅受硬截断 |

黑名单是安全约束，任何预算压力下都不得被丢弃。

> **收尾修正**：附加上下文（用户本轮附件）原属 scope 段，会随换附件改变 scope 文本 → 让稳定前缀失效。已拆出为 `buildAdditionalContextsPrompt`，进 `turn` 段。scope 段现在只含会话内不变的约束。

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

> **收尾修正**（见文末「评审修复」）：第 1 条原先只在 **catch 分支**成立 —— SDK 的失败主要通过 `type:'result'` 消息报告（`subtype: 'error_*'` 或 `subtype:'success'` 且 `is_error:true`），不抛异常。原实现把 `is_error:true` 的成功结果当正常完成上报、且错误 subtype 不发 `sessionEnded`，恢复链路仍然不可达。已改为 result 分支同时看 `subtype` 与 `is_error`。

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

**修复后**：新增守卫（`src/shared/type-guards.ts`），脏数据退化为默认值：

| 列 | 期望形状 | 非法值退化 |
|----|---------|-----------|
| `chat_messages.context_refs` | `ContextRef[]` | `[]` |
| `chat_messages.tool_calls` | `ToolCallBlock[]` | `[]` |
| `chat_messages.error` | `MessageError` | `undefined` |
| `agent_logs.command` | `AgentCommand` | `{ type:'implement', description:'', targetNodeId:'' }` |
| `agent_logs.outputs` | `AgentOutput[]` | `[]` |
| `nodes.rules` | `BusinessRule[]` | `undefined` |
| `nodes.context_refs` | `ContextRef[]` | `undefined` |
| `nodes.metadata` | `NodeMetadata` | `undefined` |
| `nodes.content` | `NodeContent` | `undefined` |
| `nodes.wiki_meta` | 对象 | `undefined` |
| `edges.content` | `EdgeContent` | `undefined` |

`agent_logs` 的必填列（`id` / `session_id` / …）与 `result` 枚举仍然抛错 —— 那是数据缺失，不是形状脏。

> **收尾修正**（见文末「评审修复」）：数组列原先只验「是数组」不验元素形状（`isUnknownArray`），脏数据 `[null]` 能通过守卫而渲染层 `.map` 直接崩；`safeJsonParse` 的 validator 形参也一度从类型谓词放宽为 `(val: unknown) => boolean`，丢掉了编译期的「列类型 ↔ 守卫」耦合。两者均已修正：守卫逐元素校验，validator 恢复谓词签名。

---

## 评审修复（末尾整体评审）

计划执行完毕后做了一次**全分支评审**（评审区间 `6d03f9d..c503f80`，按 HEAD `0c41ea6` 评）。结果：**1 条 Critical、5 条 Important、5 条 Minor、8 条明确搁置**。Critical / Important 全部进入同一轮修复（每条先写出会失败的用例，再改实现，再跑完整套）；Minor 全部 deferred。

其中 C-1 与 I-5 是**本分支自己引入的**（计划缺口，不是实现走偏），其余 4 条是既有实现的遗漏。

| 编号 | 问题 | 修法 |
|------|------|------|
| **C-1** | 直接走 `AgentManager.sendCommand` 的 6 条路径（子代理派发 / `agent:sendCommand` / 校验 / `graph-service` / `send-and-wait` / 替换会话恢复）上 scope 提示词**整体消失** —— 白名单 / 黑名单 / 业务不变量 / 验收标准 / 节点标题 / 项目记忆全部不投递 | 把「任何投递路径都必须携带 scope」上升为框架级不变量：`AgentManager.sendCommand` 无条件重新装配（已装配的调用点用 `options.contextAssembled` 标记跳过），另加适配器层 `buildScopePromptForSession` 从 `session.config` 自建 scope 的兜底。**黑名单唯一的执行手段就是提示词**（`forbiddenFiles` 全仓库只有 `scope-prompt-builder.ts` 消费它，`scope-guard.ts` 只是拷进 config 从不执行），提示词一丢这条安全约束就静默消失 |
| **I-1** | `stable` 段并非跨轮逐字节一致：会话摘要（压缩 / 恢复会重写）与附加上下文（换附件会变）被算进 stable —— 与 CLAUDE.md「不污染可复用 KV-cache prefix」冲突 | 两者移入 `turn` 段；附加上下文另拆 `buildAdditionalContextsPrompt` |
| **I-2** | `safeJsonParse` 的 validator 被放宽为 `(val: unknown) => boolean`，丢掉编译期的「列类型 ↔ 守卫」耦合 | 恢复谓词签名 `(val: unknown) => val is NonNullable<T>`，interface 一侧用窄守卫解决 |
| **I-3** | JSON 数组列只验容器不验元素，脏数据 `[null]` 能通过守卫而渲染层 `.map` 直接崩 | 补 9 个逐元素守卫，替换 `isUnknownArray`（只验容器的那个已删除） |
| **I-4** | claude-code 只在抛异常时发 `sessionEnded`；SDK 的 `type:'result'` 错误通道完全没覆盖 —— `subtype:'success'` 且 `is_error:true` 被当正常完成上报，错误 subtype 不发终止事件 | result 分支同时看 `subtype` 与 `is_error`，失败一律发 `error` 输出 **并** `sessionEnded('error')`；`errors` 数组按运行时形状取（原实现读 `.length` 会抛异常，把真实失败原因替换成 `Cannot read properties of undefined`） |
| **I-5** | `session.promptContext` 永不过期 → 同一会话第二轮会注入第一轮的 turn 段 | 与 C-1 同一机制修（每次投递都重新装配） |

---

## 落地记录

### 提交序列

```
53f3eeb fix(agent): claude-code 把 SDK result 错误通道当失败，恢复 sessionEnded
746d141 fix(db): JSON 列逐元素校验，safeJsonParse 恢复编译期列↔守卫耦合
44a8e35 fix(prompt): stable 段只留跨轮不变的内容（摘要与附加上下文移入 turn）
ae619a6 fix(prompt): 直接投递路径也带 scope 约束，turn 段跨轮不复用
0c41ea6 docs: 落地记录测试数更新为 2869
68382e5 test: 补齐 plan Review Focus 的两条缺口用例
ad9c4c8 docs: 框架硬伤修复批次 1 落地记录 + ROADMAP Phase D-0
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
| 提交 | 16（含设计文档） |
| 测试用例 | 2885 全绿 / 231 个测试文件 |

### 关键接口变更

| 接口 | 变更 | 用途 |
|------|------|------|
| `PromptContext` | 新增 `{ stable, turn }` | D1 两段式注入上下文 |
| `AgentAdapter.getResumeSessionId?()` | 新增可选方法 | D4 原生恢复前置条件 |
| `RecoveryContext.resumeSessionId?` | 新增可选字段 | D4 传递 CLI 会话 id |
| `BaseAdapter.getSessionConfig()` | 新增 | D1 读适配器**实时**配置（压缩摘要写在适配器自己的 clone 上，manager 快照拿不到） |
| `SCOPE_SECTION_HEADINGS` | 新增导出 | D2 段标题单一来源 |
| `compressScopeByPriority` | 新增导出 | D2 压缩分类可测 |
| `buildAdditionalContextsPrompt` | 新增导出 | D1 附加上下文从 scope 拆出，进 turn 段 |
| `isRecord` / `isStringArray` / `isAgentCommand` / `isAgentOutput` / `isAgentOutputArray` / `isMessageError` / `isContextRef(Array)` / `isToolCallBlock(Array)` / `isBusinessRule(Array)` / `isNodeMetadata` / `isNodeContent` / `isEdgeContent` | 新增导出 | D7 JSON 列守卫（数组列逐元素校验） |
| `safeJsonParse(raw, fallback, validator?)` | validator 为类型谓词 `(val: unknown) => val is NonNullable<T>` | D7 列类型 ↔ 守卫的耦合留在编译期 |
| `rebuildTableIfNeeded` | 改为导出 | D5 列类型比对可测 |
| `AgentAdapter.getSessionConfig?()` | 已有（`BaseAdapter` 实现） | 读适配器**实时**配置（压缩摘要写在适配器自己的 clone 上，manager 快照拿不到） |

> `safeJsonParse` 的 validator 形参：**曾经**从 `(val: unknown) => val is T` 放宽为 `(val: unknown) => boolean`（理由：`isRecord` 的谓词类型 `Record<string, unknown>` 与 `MessageError` 这类 interface 不满足谓词可赋值性）。评审指出放宽后「把单元素守卫传给数组列」这类错配不再编译报错 —— 而这正是本轮实现自己踩过的坑。已恢复谓词签名，interface 一侧改用专门的窄守卫（`isMessageError` / `isNodeMetadata` / `isNodeContent` / `isEdgeContent`）解决。

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
npm run test              # 2885 / 2885 通过（231 个测试文件）
npm run lint              # 零警告
```

**better-sqlite3 ABI**：本机 Node v20.20.2 是 `NODE_MODULE_VERSION` 115，Electron 33.4.11 是 **130** —— **ABI 不同**，同一个 `.node` 不能同时服务两边（实测：Node ABI 构建在 Electron 里直接报 `compiled against a different Node.js version`）。因此：

- 跑 Vitest 前 `npm rebuild better-sqlite3`（切到 Node ABI）
- 跑 Electron / `npm run dev` 前 `npx electron-builder install-app-deps`（切回 Electron ABI）

本轮收尾的终态是 **Electron ABI**（`npm run dev` 可用）；此状态下再跑 `npm run test` 需要先 `npm rebuild better-sqlite3`。

## 遗留

### 评审 deferred 的 Minor

| 项 | 说明 |
|----|------|
| Level 4 硬截断可能把黑名单切掉 | `compressScopeByPriority` 最后一级是无脑前缀切片，scope 段序为 验收标准 → 白名单 → 黑名单 —— 验收标准很长时切点落在黑名单之前。规格明写「黑名单任何情况下不得因预算不足被丢弃」。修法是把黑名单段排除在切片外、切片后拼回（会改变压缩阶梯的输出形状，需另起一轮） |
| `mcp-adapter.ts` 在 `startSession` 里自建 scope 只写 stdout 日志 | 日志里的 scope 文本与真正投递的 `stable` 不一致（缺 `contextSummary`、缺项目记忆、未经压缩），会误导用户 |
| `src/main/adapters/README.md:103,167` 仍在教新适配器用 `this.buildScopePrompt(config)` | 新契约下该模式产出的 scope 不会被投递；README 是新适配器的入口文档，应同步改成 `stable`/`turn` + `setPromptContext` 契约 |
| `edges.content` 仍是裸 `JSON.parse`（`edge-repository.ts:17-24`） | 未加守卫 |
| codex 与 spec D1 的适配器表不符 | `@openai/codex-sdk` 的 `ThreadOptions` 没有 system prompt 选项，codex 只能走单串 `buildFullPrompt` —— 是**规格问题**不是实现问题，应回填规格 |

### 其他

| 项 | 说明 |
|----|------|
| `snapshot-repository.ts` 的 `snapshots.data` 列 | 同为盲转，但不在 D7 表内，且快照是整库重建时写入的受控数据，本轮未动 |
| `compressScopePrompt`（`scope-prompt-builder.ts`）已成死代码 | 编排器改用 `compressScopeByPriority` 后无生产调用点，只被自己的测试引用。删除属纯清理，未混入本轮修复 —— 但它与现行函数的压缩语义不同（前者按段落数截，会先丢黑名单），宜与 Level 4 那条一并处理 |
| `HybridSearchEngine` 未接入 agent prompt 路径 | 设计文档的「批次 2」范围 |
| 真实 tokenizer 替代 4 字符启发式 | 设计文档的「批次 4」范围 |
