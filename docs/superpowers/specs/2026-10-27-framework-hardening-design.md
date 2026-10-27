# BizGraph 框架硬伤修复设计

> 创建：2026-10-27
> 范围：六子系统（模型 / Prompt / Schema / 通道 / Session / Memory）调研后确认的框架级缺陷
> 状态：设计已确认，待实施

## 背景

对 `src/main/adapters`、`src/main/memory`、`src/main/agent`、`src/main/database.ts`、`src/shared/types` 做了全量调研（三个并行 Explore agent + 人工逐条复核），确认六处**框架级缺陷**。它们不是功能缺失，而是「已经建好的能力没有接上」或「实现与自己的设计意图相矛盾」，修复不需要引入新框架。

配套实施计划：[`docs/superpowers/plans/2026-10-27-framework-hardening.md`](../plans/2026-10-27-framework-hardening.md)

### 缺陷清单（均已复核到 `file:line`）

| ID | 缺陷 | 证据 |
|----|------|------|
| F1 | 整段组装后的 Prompt（含用户请求原文）经 `memoryContext` 进入 **system 通道**；用户请求同时出现在 system 与 user turn，两次 | `agent-manager.ts:633` → `base.ts:937` → `claude-code.ts:213`；`base.ts:1056` |
| F2 | scope 压缩分级按**英文**标题分类，生产者实际输出**中文**标题 → 每段落进 `other`，Level 1/2/3 全是 no-op，只剩硬截断 | `prompt-orchestrator.ts:131-134` vs `scope-prompt-builder.ts:50-114` |
| F3 | 项目记忆与会话历史记忆被算出来**直接丢弃**（下划线前缀变量） | `context-assembler.ts:76` |
| F4 | context 层（35% 预算）因 `outputs` 从不传入而**常年空转**；`code-intelligence/prompt-assembler.ts` 整个类零消费者 | `context-assembler.ts:124-135`、`prompt-orchestrator.ts:245` |
| F5 | claude-code **从不发射 `sessionEnded`** → 恢复 / 回退 / Phase B 记忆管线对该适配器整体不可达；`session-recovery.ts` 的 claude-code 策略是死代码，其注释描述的契约无人实现 | `claude-code.ts` 中 `sessionEnded` 出现 0 次（codex 2 次、mcp 3 次）；`session-recovery.ts:52-69` |
| F6 | `migrate()` 用 `currentVersion < CURRENT_SCHEMA_VERSION` 门禁重建 → 改了 `createSql` 但没 bump 版本时，checksum 虽失配但重建被跳过，**schema 改动静默失效** | `database.ts:659` |
| F7 | `MessageStatus` 类型含 `'queued' \| 'sending' \| 'permanently_failed'`，DB CHECK 只允许 5 个值 → 写入抛裸 SQLite 错，降级成 `IPC_HANDLER_ERROR` | `agent.ts:147` vs `database.ts:379` |
| F8 | `safeJsonParse` 的 validator 参数**零调用点使用** → 所有 JSON 列盲转，脏数据直接进类型化对象 | `db-utils.ts:37` 及 7 处调用点 |
| F9 | waterline 超预算时**反向抢占** context 的预算，而 waterline 不可压缩、大小不变 → 净效果是 context 被压得更狠、水位线一点没瘦 | `prompt-orchestrator.ts:288-298` |

> **一处更正**：调研初稿把 F5 描述为「原生 resume 是坏的」。复核后更正为：claude-code 的恢复路径**根本不会被触发**（不发射 `sessionEnded`）。真正起作用的续接机制是 SDK session + adapter 私有 clone 上的 `resumeSessionId`，仅在同一进程、同一 session 对象存活时有效。修复方向随之调整。

## 目标

1. 让 BizGraph 注入给 Agent CLI 的内容符合 CLAUDE.md「Boundaries with Agent CLI」：用户请求走 user turn，system 通道只承载跨轮稳定的上下文，KV-cache 前缀不被每轮内容污染。
2. 消除「建好但没接上」的能力断层：项目记忆、会话历史记忆、代码上下文、编译上下文真正进入 prompt。
3. 让 schema 迁移与状态枚举在数据层与类型层保持一致，杜绝静默失效与写入即崩。
4. 给 JSON 列加运行时校验，脏数据退化为默认值而不是崩溃或盲转。

## 非目标

- **不改** Agent CLI 内部的 system prompt / user request / tool schema / provider routing（CLAUDE.md 边界，硬约束）。
- **不引入** Agent CLI 的认证、权限检查或沙箱机制。
- **不做** 模型注册表、Zod 校验层、事件总线等能力补齐（属后续批次）。
- **不接** `HybridSearchEngine` 到 agent prompt 路径（属批次 2：记忆检索接线）。
- **不改** 任何持久化数据的业务语义（除 F7 的 CHECK 扩容，属放宽而非改写）。

---

## 决策

### D1 — Prompt 拆成「稳定前缀 / 每轮上下文 / 用户请求」三段

**问题**：当前 `PromptOrchestrator` 产出单一 `text`，被当作 system prompt 整段下发；用户的请求原文因此出现在 system 通道，且同时出现在 user turn。

**决策**：引入显式的两段式注入上下文，把用户请求完全排除在 system 通道之外。

```ts
// src/shared/types/agent.ts
export interface PromptContext {
  /** 稳定前缀：系统指令 + 会话摘要 + scope 约束 + 项目记忆。跨轮不变。 */
  stable: string
  /** 每轮上下文：代码上下文 + 编译上下文 + 水位线 + 会话历史记忆。每轮变化。 */
  turn: string
}
```

分层归属：

| 内容 | 归属 | 理由 |
|------|------|------|
| 系统指令 `buildSystemInstruction` | stable | 固定 |
| 会话摘要 `sessionConfig.contextSummary` | stable | 会话内不变 |
| scope 约束（白/黑名单、不变量、上下游契约、附加上下文） | stable | 节点级不变 |
| 项目记忆 `.bizgraph/memory.json` | stable | 项目级不变 |
| 代码上下文 `codeContext` | turn | 随查询变化（当前被塞进 scope，导致 scope 每轮变） |
| 编译上下文 `ContextCompiler` 输出 | turn | 随会话产物变化 |
| 会话历史记忆（MemoryStore 最近 + 跨适配器） | turn | 每轮检索结果 |
| 水位线 | turn | 每轮随 token 用量变化 |
| 用户请求 `command.description` | **不注入** | 由适配器已有的 `buildCommandPrompt` 单独承载 |

**关键改动**：`buildScopePrompt(config, resolvedContexts, codeContext)` 去掉 `codeContext` 形参——它让 scope 每轮变化，是 KV-cache 前缀不稳定的直接原因。`codeContext` 改由编排器放入 turn 段。

**适配器消费**：
- SDK 适配器（claude-code / codex / mcp-adapter）：`systemPrompt = promptContext.stable`，user turn = `[turn, commandPrompt].join('\n\n')`。
- CLI 一次性适配器：单串 prompt，顺序固定为 `stable → toolPrompt → turn → command`，用户请求仍然只出现一次。

**预算**：沿用现有五层百分比（system 10% / scope 25% / context 35% / waterline 5% / user 25%）。项目记忆并入 scope 层（受 25% 约束），代码上下文 + 编译上下文 + 会话历史记忆并入 context 层（受 35% 约束）。总分不变。

### D2 — scope 段标题单一来源

`scope-prompt-builder.ts` 导出 `SCOPE_SECTION_HEADINGS` 常量对象，生产者与压缩分类器共用同一份字面量，从结构上杜绝再次漂移。

参与分级的四类与现有压缩阶梯语义保持不变：

| 分类 | 标题常量 | 阶梯行为 |
|------|---------|---------|
| `invariant` | `## 业务不变量` | Level 1 移除 |
| `upstream` | `## 上游契约` | Level 2 移除 |
| `downstream` | `## 下游契约` | Level 2 移除 |
| `allowed-files` | `## 允许修改的文件（白名单）` | Level 3 压成 basename |

其余段落（验收标准、黑名单、待修复 Bug、附加上下文）归入 `other`，全程保留，仅受硬截断影响——黑名单是安全约束，任何情况下不得因预算不足被丢弃。

**同时删除第二实现**：`src/main/code-intelligence/prompt-assembler.ts` 的 `PromptAssembler` 类零生产消费者（仅自身测试与 barrel 导出引用），而它的 `buildScopeSection` 复制了一份 scope 构造、段标题还与 `scope-prompt-builder.ts` 不一致（`## 允许修改的文件` vs `## 允许修改的文件（白名单）`）。留着它就是留一个随时会被误用的第二实现，与本决策的目标直接冲突。一并删除该文件、其测试与 barrel 中的两处导出；`ResolvedCodeContext` 保留（`ContextAssembler` 在用）。

### D3 — waterline 超预算截断自身，不借 context 的预算

水位线是不可压缩层，超出预算时截断自身文本，**不再**从 context 层扣预算给一个大小不会变的层。

### D4 — claude-code 补齐会话终止与恢复契约

三处改动：

1. **发射终止事件**：claude-code 的 SDK 错误分支（非 AbortError）除发 `error` 输出外，追加 `sessionEnded(sessionId, 'error', null)`，使恢复 / 回退 / Phase B 记忆管线的既有链路真正接上。AbortError 是用户主动取消，走既有 complete 路径，不发终止事件。
2. **恢复策略拿到 CLI 级会话 id**：`AgentAdapter` 增加可选方法 `getResumeSessionId?(sessionId): string | undefined`；`BaseAdapter` 实现为读取 `session.config.resumeSessionId`（claude-code 在 `claude-code.ts:265` 写入 SDK 的 conversation id）。`RecoveryContext` 增加 `resumeSessionId?: string`，由 `RecoveryOrchestrator` 从适配器取到后传入。
3. **原生恢复重发上一条命令**：`RecoveryOrchestrator.handleSessionExit` 的 native 分支当前只恢复映射、**不重发命令**，用户指令实际丢失。改为在 native 分支同样调用 `resumeLastCommand(sessionId, state.lastCommand)`——适配器带着 `resume: resumeSessionId` 再发一次，SDK 侧续接同一段对话。

策略侧语义修正：claude-code 策略在拿到 `resumeSessionId` 时返回 `ctx.sessionId`（保持原生恢复）；拿不到时返回 `null`（不具备原生恢复条件，走替换路径）。原注释描述的「调用方会传 resumeSessionId」契约由本决策真正实现。

### D5 — schema 迁移慢路径无条件重建 + 列类型比对

1. `migrate()` 的慢路径把 `rebuildTableIfNeeded` 的循环从「版本落后才跑」改为「慢路径一律跑」。`rebuildTableIfNeeded` 内部只在列集合或 CHECK 文本变化时才真正重建，无变化时只做两次 pragma 查询，代价可忽略。
2. `rebuildTableIfNeeded` 的比对从「列名 + CHECK 文本」扩展到「列名 + 列类型 + CHECK 文本」，让 `INTEGER → TEXT` 这类类型变更不再被漏掉。
3. `CURRENT_SCHEMA_VERSION` 仍然必须随 schema 变更 bump（约定不变），但漏 bump 不再导致变更被静默吞掉。

`restoreFromBackup` 的行为不变：它按新表 `createSql` 建表（约束完整），再按公共列回填数据，并保留既有的三处历史 enum 重映射。

### D6 — MessageStatus 与 DB CHECK 对齐

以**类型定义为准**（类型是规范，DB 是实现）：`chat_messages.status` 的 CHECK 扩容为 `('success','error','pending','streaming','aborted','queued','sending','permanently_failed')`。

存量数据的 status 值全部落在新集合内，重建无损。`CURRENT_SCHEMA_VERSION` 15 → 16。

### D7 — JSON 列运行时校验

`safeJsonParse` 的第三个参数 `validator` 目前零调用点使用。为高风险 JSON 列补上守卫：

| 列 | 期望形状 | 非法值退化 |
|----|---------|-----------|
| `chat_messages.context_refs` | `ContextRef[]` | `[]` |
| `chat_messages.tool_calls` | `ToolCall[]` | `[]` |
| `agent_logs.command` | `AgentCommand` | `{ type:'implement', description:'', targetNodeId:'' }` |
| `agent_logs.outputs` | `AgentOutput[]` | `[]` |
| `graphs.rules` | 记录 | `undefined` |
| `graphs.metadata` | 记录 | `undefined` |
| `graphs.content` | 字符串 | `undefined` |
| `chat_messages.error` | `MessageError` | `undefined` |

守卫放在 `src/shared/type-guards.ts`（已有 `makeGuard` 模式可复用），新增 `isStringArray` / `isRecord` / `isAgentCommand` / `isAgentOutput` 等。

---

## 影响面与风险

| 决策 | 影响文件 | 风险 | 缓解 |
|------|---------|------|------|
| D1 | `prompt-orchestrator.ts`、`context-assembler.ts`、`agent-manager.ts`、`base.ts`、`claude-code.ts`、`codex.ts`、`mcp-adapter.ts`、`scope-prompt-builder.ts`、`shared/types/agent.ts` | **高** —— 改动 prompt 投递路径，影响所有 Agent 会话 | 逐层落地：先产出 segments（不改变投递），再切投递；每步都有单测钉住「用户请求只出现一次」「system 跨轮稳定」 |
| D2 | `scope-prompt-builder.ts`、`prompt-orchestrator.ts` | 低 | 常量单一来源，压缩分级有专门单测 |
| D3 | `prompt-orchestrator.ts` | 低 | 预算断言单测 |
| D4 | `claude-code.ts`、`base.ts`、`session-recovery.ts`、`recovery-orchestrator.ts`、`shared/types/agent.ts` | **中** —— 改变会话终止时机，可能影响既有恢复测试 | 新增契约测试；既有 `session-recovery.test.ts` / `recovery-orchestrator.test.ts` 全绿为门槛 |
| D5 | `database.ts` | **中** —— 迁移路径改动影响所有用户库 | 必须用真实 better-sqlite3 跑「老库 → 新库」迁移用例；内存 fake repo 会掩盖字段丢失（历史教训） |
| D6 | `database.ts` | 低 | 真实库重建用例 |
| D7 | `shared/type-guards.ts`、`chat-service.ts`、`agent-log-repository.ts`、`graph-repository.ts` | 低 | 每列一个脏数据退化用例 |

**全局约束**：
- 遵守 CLAUDE.md「Boundaries with Agent CLI」：不修改 Agent CLI 的 system prompt / user request / tool schema / provider routing；A2A 透明转发会话（`transparentForward`）**不下发任何 BizGraph 内部状态**——D1 的 stable/turn 拆分在透明转发下必须同样为空。
- 遵守 CLAUDE.md「不污染可复用 KV-cache prefix」：D1 的 stable 段必须跨轮逐字节一致。
- Node 状态变更必须走 `NodeRepository.update()`（`validateNodeTypeTransition` 内部强制）。
- 数据库 schema 变更必须 bump `CURRENT_SCHEMA_VERSION`。
- `better-sqlite3` 原生 ABI 冲突：跑 Vitest 前 `npm rebuild better-sqlite3`；跑 Electron 前 `npx electron-builder install-app-deps`。每个任务跑完测试后切回 Electron ABI。

## 后续批次（本设计不覆盖）

| 批次 | 内容 | 依赖 |
|------|------|------|
| 批次 2 | 把 `HybridSearchEngine` 接进 agent prompt 路径；记忆按相关性 + 预算注入；`commandType` 打通到 extractor | 本设计（先有 segments 结构，才谈得上按预算切分检索结果） |
| 批次 3 | Zod 校验层（`IpcApi` 同源）、集中事件总线、统一模型注册表与每模型参数 | 无 |
| 批次 4 | `autoCompactEnabled` 默认开启、真实 tokenizer 替代 4 字符启发式、`onUsage` 订阅接通、水位线按适配器真实 context window | 无 |
