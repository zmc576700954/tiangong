# Agent 体系设计评审（双文档 · 对抗性）

- 评审对象 A：[agent-system-design.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design.md)（1190 行，「可落地版」）
- 评审对象 B：[AGENT_ARCHITECTURE_DESIGN.md](file:///Users/zhumingchen/tiangong/AGENT_ARCHITECTURE_DESIGN.md)（587 行，用户提供版）
- 事实基础：[AI_AGENT_ARCHAEOLOGY.md](file:///Users/zhumingchen/tiangong/AI_AGENT_ARCHAEOLOGY.md)、项目源码、已安装 SDK 类型定义
- 评审性质：只读。本报告不修改任何业务源码。

标注约定：**[实读]** = 我打开了对应文件确认；**[实测]** = 我实际运行了命令/编译/SQL；**[推断]** = 基于已证实事实的推理，未运行验证。

---

## 0. 本次实际执行的验证

| # | 验证项 | 手段 | 结果 |
|---|---|---|---|
| 1 | 全仓类型检查 | `./node_modules/.bin/tsc --noEmit` | **exit 0，零报错**（tsconfig 明确 include `src/renderer/**/*.tsx` 且 `jsx: react-jsx`）**[实测]** |
| 2 | A 的 §3 类型草案 | 逐字抽取到独立文件 + `tsc --strict` | **0 error**，可编译 **[实测]** |
| 3 | B 的 §2/§3/§7 契约 | 逐字抽取到独立文件 + `tsc --strict` | **11 处 TS2304**，7 个标识符未定义 **[实测]** |
| 4 | A 的建表 SQL | `sqlite3 3.51` 临时库执行 | DDL 全部通过；partial unique index 生效 **[实测]** |
| 5 | 活动 turn 唯一索引语义 | 同 node 插 `running` 后再插 `queued` | **第二条 queued 被索引拒绝** **[实测]** |
| 6 | 已安装 SDK 版本 | `node -p` | codex-sdk `0.135.0`、claude-agent-sdk `0.3.286`（声明 `^0.3.160`）**[实测]** |
| 7 | Claude 审批 API | 读 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | `canUseTool` / `PreToolUse.permissionDecision` **确认存在** **[实测]** |
| 8 | Codex 中断与流式 | 读 `node_modules/@openai/codex-sdk/dist/index.d.ts` | `TurnOptions.signal`、`runStreamed()`、`ThreadItem` 完整联合 **确认存在** **[实测]** |

---

## 1. 总判断

**两份文档都不能按 M0 直接开工。**

- A 的工程纪律（证据标注、验证清单、诚实降级）明显更强，类型草案可编译，是本轮应作为**主文档**的一份。但它把最高风险项（事件归属、崩溃对账）放在验收里、把实现放在 M0 之后，验收不可达；且 per-session 锁 API 无法表达自己规定的语义。
- B 的抽象更接近「统一事件模型 + 事件溯源」，但接口不可编译、审批通道退化了安全性（丢 `argsHash`）、能力矩阵有三处被代码推翻。它适合作为**补充章节**，不适合作为实现依据。
- 两份文档共享同一个**未被承认的致命前提**：现有 `BaseAdapter` 是「每个 adapter 名字一个实例 + 用 `outputSessionStack` 栈顶归属输出」，而两份文档又都默认「同一执行器可并发 2」。这两件事叠加，事件归属必然错，恰好击穿两份文档各自的核心验收项。

必须先补的三件事（详见 §9）：**统一术语与表结构（一份实现口径）→ 把事件归属从「栈」改为「显式 session 上下文」→ 把 M0 的验收改成 M0 能交付的东西（启动对账 + 审批/执行窗口定义）**。

---

## 2. 阻塞级问题（会让方案失效）

### K1 事件归属在「单实例 + 栈顶归属 + 并发 2」下必然错（A 与 B 共有）

**问题**：两份文档都承诺「不同 session 事件的 `sessionId/turnId/stepId` 归属 100% 正确」（A §9 M0 验收、A §12 V4；B §7.2「数据隔离」隐含同类承诺），但现有归属机制不支撑。

**证据**：

- [base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L53-L55)：`outputSessionMap: WeakMap<AgentOutput,string>` + `outputSessionStack: string[]`，**每个 adapter 实例只有一份栈**。
- [base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L197-L204) 与 [base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L251-L296)：两条派发路径各自 `pushOutputSession` / `popOutputSession`。
- [base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L459-L461)：归属取 `outputSessionStack[stack.length-1]`，即**栈顶**。
- [ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L116-L131)：每个 adapter 名只 `new` 一次，全进程共享实例。
- A §6.2 又规定「每执行器并发上限 Claude/Codex 默认 2」。

**影响**：[推断，但机制已实读] 同 adapter 两个 session 并发时，A 的输出会在 B 的栈帧下被 emit，于是被记到 B 的 `sessionId`。这会让 A 的 V4、B 的「数据隔离」在真实并发下失败；而且失败方式是**静默串台**（事件不丢、id 错），比崩溃更难发现。A 把「禁止跨 session 复用 adapter 实例」写在了 V4 的**失败分支**里，属于事后补救，不是设计。

**修改建议**：三选一，且在 M0 就定死：

1. M0 起 `per-executor 并发 = 1`（最简单，代价可接受），先把并行留给 M1 的 worktree 隔离；
2. adapter 实例 per-session 化（`registry.create(name)` 不再返回单例）；
3. 归属改为显式上下文：normalizer 不再读栈，而由 driver 在 `runTurn` 内把 `sessionId/turnId` 直接传给 `emitOutputForSession`（[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L604-L609) 已有精准通道，但 [opencode.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts#L76) 等仍走全局 `emitOutput`）。

---

### K2 A 的 M0 验收依赖 M1 的交付物（A）

**问题**：M0 验收第 4 条要求「`kill -9` 后重启，未终结 turn 变为 `orphaned`；不出现 UI 显示运行中但实际无进程」；但 M0 交付物 1–5 里没有任何「启动对账 / 重启归置」组件，`RecoveryPlanner` 被排到 M1。

**证据**：A [§9 M0](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design.md#L995-L1011) 只有 migration+5 表、锁、三个 Normalizer、审批通道、`runNode` 最小实现；`agent_sessions.status` 的 `orphaned` 值虽在 §4.1 建表里，但没有任何代码负责在 boot 时把 `starting/active` 置 `orphaned`。全仓 `src/main` 中 `orphan` 关键字仅存在于本设计文档，源码无此概念 **[实读，grep 无命中]**。

**影响**：M0 验收不可机械判定、也不可通过；更实际的风险是「UI 悬空态」在 M0 之后仍然存在——而这正是本方案要卖给用户的核心卖点之一。

**修改建议**：M0 增加一个**最小启动对账**（不需要 RecoveryPlanner）：boot 时在同一事务内把 `agent_sessions.status IN ('starting','active')` → `orphaned`、`agent_turns.status IN ('running','waiting_approval','cancelling')` → `orphaned`、`agent_approvals.status='pending'` → `expired`，并向 renderer 推一次全量快照。或者把该验收条整条移到 M1，不要留在 M0。

---

### K3 B 的 Driver 契约不可编译，且审批回填的 API 形状与 SDK 语义不符（B）

**问题 1（不可编译）**：B §3.1/§7.1 引用了 7 个从未定义的标识符：`DriverStartInput`、`DriverHandle`、`DriverInput`、`ApprovalDecision`、`TerminationReason`、`TurnInput`、`TurnResult`。

**证据**：**[实测]** 逐字抄录 B 的 `BackendDriver`/`SessionExecutor` 声明后 `tsc --strict`，报 11 处 `TS2304 Cannot find name ...`（`DriverStartInput` / `DriverHandle` / `DriverInput` / `TerminationReason` / `ApprovalDecision` / `TurnInput` / `TurnResult`）。B 正文只在 §3.1「设计要求」里用散文提到 `DriverHandle.backendSessionId`，没有类型。

**问题 2（语义错）**：`decideApproval?(handle: DriverHandle, decision: ApprovalDecision): Promise<void>`：

- 签名里**没有 `approvalId`**，所以无法在「同一 turn 内多个并发审批」时定位到底是哪一项 —— 而 B 自己的 §12.4 明确承认「SDK 可能并行执行多个 `tool_use`，`decideApproval` 需要支持并发审批」。
- Claude 的 `canUseTool` 是**回调内返回**（`canUseTool?: CanUseTool`，[sdk.d.ts](file:///Users/zhumingchen/tiangong/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts#L1587)），不是「先返回、事后再 push 一个决定」。事后 push 只能靠 driver 自己持有一个 `Map<approvalId, resolver>`，这已经等价于 A 的 `ApprovalBridge.request()`，B 的契约只是把这个事实藏起来了。

**影响**：照 B 开工，Driver 层要么编译不过，要么在并发审批时产生「批了 A、放行 B」的错配。

**修改建议**：采 A §3.4 的 `ApprovalBridge.request(payload, signal): Promise<ApprovalDecision>` 形态（回调内 await），把 B 的 `decideApproval` 改为 `resolvePending(approvalId, decision)` 并补全被引用的所有类型。合并后的 Driver 契约应当能通过 `tsc --strict`，这是可落地的硬门槛。

---

### K4 B 的审批通道不绑定工具参数（B）

**问题**：B 的 `agent:approvalDecision` 入参只有 `{ approvalId, decision, remember? }`，`agent_approvals` 表也没有 `args_hash`。A 明确要求 `argsHash` 并在 main 侧做 5 条校验（A §3.4）。

**证据**：B [§5.1](file:///Users/zhumingchen/tiangong/AGENT_ARCHITECTURE_DESIGN.md#L300-L307)、[§6.1](file:///Users/zhumingchen/tiangong/AGENT_ARCHITECTURE_DESIGN.md#L371-L383) 建表无 `args_hash`；A [§3.4 校验顺序](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design.md#L502-L510)。

**影响**：B 在 §0.5 宣称「审批必须是 fail-closed 的跨进程 RPC」，但缺少参数指纹时，「用户批的是 A、执行器执行的是 B」这一类最典型的 TOCTOU 无法检测。这是安全承诺与实现的直接矛盾。

**修改建议**：采信 A。`agent_approvals` 必须含 `args_json` + `args_hash`；`ApprovalDecision` 必须回传 `argsHash`；main 侧校验顺序固定为 A §3.4 的 1–5 条，任何一条不满足即 `deny`。

---

### K5 锁 API 无法表达自己规定的「立即 SESSION_BUSY」，ALS 防重入口径也不闭合（A）

**问题 1**：A §3.6 的 `acquire(key, { turnId, timeoutMs?, priority? })` 搭配 §6.1「`timeoutMs` 默认 0（不超时）」，无法表达「已有 turn 在途时，第二次派发**立即**返回 `SESSION_BUSY`」。`timeoutMs: 0` 在文档里表示「不超时」，那请求就会永远挂起；若解释为「0 毫秒超时」，又与同句自相矛盾。

**问题 2**：`AsyncLocalStorage` 只在**同一 async 执行根**内传播。以下三条路径都是新的 async 根，进入内层时 store 为空：IPC handler（每次 invoke 独立根）、`setInterval`/`setTimeout` 驱动的恢复巡检、`SubagentManager` 的定时派发。

**证据**：A [§3.6](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design.md#L586-L599)、[§6.1](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design.md#L857-L864)。代码侧 `BaseAdapter.sendCommand` 确实无在途保护，只有 `idleReapingSessions` 半终止保护 **[实读：[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L184-L224)]**。

**影响**：若 ALS 存的是一个布尔 `inLock`，则「turn 在锁内派发子 session」时子 session 的锁会被**跳过**，同一 adapter 立刻并发（回到 K1）；若不跳过，则子 session 在父 turn 未结束时永远拿不到锁 → 死锁。两种情况都是实现时必须现场发明规则的地方。

**修改建议**：

- 增加 `tryAcquire(key, { turnId }): LockHandle | null`，明确「立即返回 null = SESSION_BUSY」，把 `timeoutMs` 从主路径移出；
- ALS 的 store 用 **`Set<sessionKey>`** 而不是布尔，入锁必须 `als.run(store ∪ {key}, ...)`；
- 规定「ALS 缺失 ≠ 已在锁内」，即拿不到 store 就必须 acquire，禁止静默跳过；
- 加一条单测：父 turn 内派发子 session（同 adapter）必须各持各锁且事件不串台。

---

### K6 活动 turn 的唯一索引与「排队 / 分支」两条设计直接冲突（A）**[实测]**

**问题**：A 同时规定三件互斥的事：

- §4.1 `ux_agent_turns_active_node ON agent_turns(node_id) WHERE status IN ('queued','running','waiting_approval','cancelling')`；
- §4.2「第二次插入失败 → `NODE_BUSY`，**不排队**」；
- §6.1「由 UI 提供「排队」选项时才入队（**最多 1 个等待项**）」，且队列表里 `queued` 属于非终态；
- §5.3 节点内分支「同一 node 的第二个 turn（`parentTurnId`）」在 M2 要并发。

**证据**：**[实测]** 在 `sqlite3 3.51` 临时库执行 A §4.1 的 DDL 后：先插一条 `running`，再插一条 `queued` → **UNIQUE constraint failed**。即 partial unique index 本身在 SQLite 上完全可表达（这一点评审提纲里的怀疑不成立），但它的**语义范围**把 `queued` 也纳入排他，于是「最多 1 个等待项」永远写不进去。

**影响**：M0 一旦实现排队 UI，插入必失败；M2 分支无法落库。

**修改建议**：活动唯一性只管「真正占用执行器」的状态：`WHERE status IN ('running','waiting_approval','cancelling')`。若要支持「同节点多等待项」，索引键改为 `(node_id, group_id)`；若要支持分支，改成 `(node_id, coalesce(group_id,'-'), coalesce(branch_label,'-'))` 并对 `branch_label` 加列。

---

### K7 「已批准但未执行」的崩溃窗口没有归属规则（A 与 B 共有）

**问题**：A §4.4 的恢复表逐行列了 `message.delta`、`turn.running`、`tool.running`、`file.changed(postHoc)`、`turn.completed`、`turn.failed`，但**没有** `approval.status='allowed'` 且对应 step 尚未执行这一格。B §6.2 的算法只写「replay 到最后一条持久化事件 + 标记 interrupted」，同样没有这一格。

**证据**：[A §4.4](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design.md#L792-L807)、[B §6.2](file:///Users/zhumingchen/tiangong/AGENT_ARCHITECTURE_DESIGN.md#L394-L415)。代码侧现状是写入后才有 `PostToolUse` 记录（[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L237-L268)），所以「已批未执行」和「执行了但 hook 未触发」在磁盘上**都表现为没有对应的 `file.changed`**。

**影响**：重启对账时，这两种情况无法区分。若判为「未执行」→ 重跑导致**重复写入**；若判为「已执行」→ **静默漏执行**。A §4.4 承诺「对账不一致 → `needs_attention`，绝不自动重跑」，但没有对账输入，这条规则无法执行。

**修改建议**：

1. 在 `agent_steps` 增加三阶段：`approved_at` → `executing_at` → `ended_at`；`executing_at` 必须在**调用工具之前**写（写前标记），这是唯一能在崩溃后区分「批了没执行」与「执行中」的字段；
2. 恢复规则明确成一张 2×2 表：`(approved_at 有, executing_at 无)` → 安全重跑；`(executing_at 有)` → 一律 `needs_attention`，用 `beforeHash/afterHash` 做磁盘比对后才允许重跑；
3. 若不想引入 `executing_at`，就必须承认「写后记录」后端（Claude 的 PostToolUse 路径、Codex、OpenCode）**不能承诺自动恢复**，只能 `abandon`/人工——A 现在的表没有这么说。

---

### K8 B 的外键级联会删掉审计事实，且恢复承诺自相矛盾（B）

**问题 1**：B 的 `agent_events` / `agent_approvals` / `agent_snapshots` 均 `REFERENCES agent_runs(id) ON DELETE CASCADE`。而 `database.ts` 已开启 `db.pragma('foreign_keys = ON')`。

**证据**：[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L46) `foreign_keys = ON`；B [§6.1](file:///Users/zhumingchen/tiangong/AGENT_ARCHITECTURE_DESIGN.md#L342-L391) 三处 `ON DELETE CASCADE`。**[实读 + 实测：pragma 已确认；SQLite CASCADE 语义为标准行为]**

**影响**：删除一个 run 会连带删除事件、审批、快照 —— 与 B §0.4「恢复必须建立在自有的 Event Store 上」、§6.1「append-only」直接冲突；合规审计（谁批了什么）无法保留。A 的表**完全不设外键**，反而更安全。

**问题 2**：B §0 结论 4 写「Event sourcing + 快照，才能支持「**恢复到任意步骤**」」，§6.2 又写「能恢复到「最后一条已持久化事件」；**不能**恢复后端进程内的未上报中间态。UI 不得宣称「精确恢复任意节点」」。同一份文档里对同一能力给了相反承诺。

**修改建议**：去掉 `ON DELETE CASCADE`（改 `ON DELETE RESTRICT` 或干脆不设 FK，与 A 一致），删除 run 走「归档表 + 软删」；§0 第 4 条改为「支持恢复到最近持久化边界 + 按 artifact 对账」，与 §6.2 对齐。

---

## 3. 重要级问题（会导致返工）

### I1 A/B 的迁移口径都不准确（两文档）

`database.ts` 不是「建表 + 列补齐」，而是**版本化迁移**：`CURRENT_SCHEMA_VERSION = 17`、迁移记录表 + **checksum 文件**、迁移事务内显式关闭再恢复 FK。

证据：[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L355)、[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L722-L746)、[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L768-L779)。**[实读]**

影响：只把 DDL 贴进 `createSql` 而**不 bump 版本**，已有用户库不会执行建表；checksum 不匹配还会触发重算/告警路径。两文档都没写这一步，是「开工第一天就会踩」的坑。

建议：把「M0 第 1 项」改写成可执行清单：`CURRENT_SCHEMA_VERSION 17 → 18`、新表加入 `TABLE_SCHEMAS`、索引加入 `INDEX_SQLS`、跑一次真实旧库副本做 V9 验证（含行数/内容 hash 不变）。

### I2 A 的适配器数量写错；B 的「不重写」与自己 §3.2D 冲突（A 与 B）

- **[实测]** `registry.ts` 共 **12** 条注册项（`claude-code / codex / opencode / cline / kilo-code / kimi-code / codebuddy / qoder / qwen-code / cursor / mcp / mindmap-internal`）。A 在 §2.3 两处写「13 个 CLI 适配器」「老的 10 个 CLI 适配器」——13 是错的；实际是 10 个外部 agent 适配器 + 1 个 MCP/API 兜底 + 1 个 `mindmap-internal` 内部一次性执行器。B 写「12 个」是对的。
- 但 B §3.2D 又提出用一个通用 `CLIDriver` 统一包 7 个 CLI。这实质是重写（各 CLI 的入参形态不同：`cline "prompt"` / `--json`、`cursor-agent`、`qwen` 等），与 B §13「不重写 12 个适配器，Driver 是包装层」自相矛盾。A 的 `LegacyAdapterExecutor`（逐个包住现有 adapter）才是「不重写」的正确实现。

建议：采 A 的 shim；`CLIDriver` 删除，或降级为「仅用于 M2 新增后端」的空实现。

### I3 `transparentForward` 在类型里不存在（A）

A §11 R11 要求「`TurnRequest` 增加 `transparentForward` 分支」，但 §3.2 的 `TurnRequest` 没有该字段；`NodeExecutionRequest` 也没有。实际字段在 `AgentSessionConfig.transparentForward`。

证据：[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L64)、A [§3.2](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design.md#L348-L368)、A [R11](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design.md#L1099)。B 的 `DriverInput` 同样未定义。**[实读]**

影响：A2A 透明转发一旦进入新编排层，最容易发生的回归就是「注入了 scope/memory」。而类型里没有这个开关，实现者很可能漏掉。

建议：`TurnRequest` 增加 `transparentForward?: boolean`，并在 `PolicyEngine.preTurn` 与 prompt 组装处短路（现有短路点见 [agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L695)）；V12 的单测要断言 prompt 内容不含 scope/记忆。

### I4 三套 id 的指向在 schema 里没定死（A）

A 的 `agent_turns.session_id` 到底指向 `agent_sessions.id` 还是 `runtime_session_id`？§3.3 注释说 `runtimeSessionId`「主进程内唯一；**不落库为主键**」，但 §4.1 又有 `runtime_session_id TEXT` 列和 `executor_handle TEXT`。同时 §6.1 锁键写「`agent_sessions.id`（新路径）；遗留路径用 BizGraph sessionId，两个 key 通过别名表映射」。

影响：恢复时从 turn 拿不到句柄，就永远只能 `rerun`；锁的两个 key 若映射缺失，遗留路径与新建路径可并行跑同一 adapter（回到 K1）。

建议：在表上写死注释与约束：`agent_turns.session_id → agent_sessions.id`（加 FK）；`agent_sessions.runtime_session_id` 是运行时 id；`executor_handle` 是 vendor id；`thread.session_id` 存 `agent_sessions.id`（与 A §4.5 一致）。补一张「id 对照表」进文档。

### I5 「seq 不断号」的验收在 Codex/OpenCode 上近似恒真，且与保留策略冲突（A）

A §3.1 明确 `seq` 是宿主分配（`EventOrdering` 注释），所以 Codex/OpenCode 的 seq 连续性是**宿主记账的必然结果**，不是对归一化保真度的检验。真正需要验的是「每个事件的 `origin/fidelity` 是否正确、是否可溯源到 vendor payload」。此外 §4.2 的保留策略「`message.delta` 超 30 天归档为 `message.completed`」会**物理删除中间 seq**，与「不允许 seq 断号」永久冲突。

建议：验收改为两条可判定的断言：① `turn.started` / `message.completed` / `turn.completed` 三条语义锚点存在且顺序正确；② 每个事件的 `(origin, fidelity)` 与录制的 vendor 夹具逐条一致。保留策略明确「归档后 seq 允许有洞，读取侧以 `(turn_id, seq)` 序号 + 归档表补齐」。

### I6 B 的 run 级 seq 与 A 的 turn 级 seq 需要合并，不能二选一（两文档）

A：`agent_events.turn_id NOT NULL` + `UNIQUE(turn_id, seq)`，无 `run_id` → **跨 turn 回放没有全序**。B：`UNIQUE(run_id, seq)`，但事件带 `turnId` 却按 run 排序 → 单个 turn 内的幂等/断号检查没有局部键。

建议：`agent_events(run_id, seq)` 全序 + `(turn_id, turn_seq)` 局部唯一。恢复按 run 的 seq 回放；单 turn 审计按 turn_seq 查。

### I7 B 的能力矩阵被代码推翻（B）

见 §6.1 的「被代码推翻」清单：`codex eventFidelity/cancel`、`opencode loopOwnership/approval`、`claude eventFidelity`。这三项会直接导致实施走错路（例如为 OpenCode 建一个拦不住写入的 `ToolRuntime`，或为 Codex 白白降级为「不可取消、无中间事件」）。

### I8 「审批期间窗口关闭」没有实现点（A 与 B）

A §7.3 写了策略「窗口关闭 / renderer 崩溃 → deny」，但没有指定谁在什么事件上执行。当前 `broadcastToWindows` 是**遍历全部窗口广播**（[ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L145-L148)），主进程没有监听 `webContents.destroyed` / `render-process-gone` 来批量 resolve 待审批。

影响：最坏情况下 60s × 每个高风险步骤 的等待，期间**锁与工作区租约一直被占用**；用户以为窗口关了任务就停了。

建议：`ApprovalStateMachine` 订阅窗口生命周期，窗口销毁即把所有该窗口的 `pending` 置 `deny(decided_by='system')` 并广播 `onApprovalResolved`；同时 `cancelTurn`。

### I9 Codex 的「审批」不可按 A/B 描述实现（A 与 B）

A §7.4 承诺「点拒绝 → 该工具调用不执行；turn 继续或按策略终止」，B §5.2 也写 `policy-only`「Kernel 不阻塞（也拦不住），只记录」。但 Codex 的 `approvalPolicy` 是**预设枚举**（`never|on-request|on-failure|untrusted`，[index.d.ts](file:///Users/zhumingchen/tiangong/node_modules/@openai/codex-sdk/dist/index.d.ts#L235)）而不是逐工具回调；在 SDK 无交互 surface 的情况下设 `on-request` 还可能**挂起**。

建议：Codex 的能力位改为「`approval: 'policy-only'` + `sandboxMode: 'read-only'|'workspace-write'` + `networkAccessEnabled`」，产品文案统一为「回合前策略 + 事后对账」；不要写「拒绝后 turn 继续」。

### I10 M0「不改 UI 信息架构」不成立（A）

A §9 标题写「M0（不改 UI 信息架构）」，但 M0 第 4 项要求审批卡片与降级文案。审批卡片必然要新组件/新 hook；且新 IPC 需要四处改动：`IpcApi` 类型、`exposedChannels`、事件白名单、main handler（[preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L17-L118) 是显式白名单）。

建议：M0 明确列为「允许新增一个只读审批卡片组件 + 4 处 IPC 白名单改动」，并把 renderer 改动量计入排期；否则实现时会临时破坏最小切片边界。

### I11 幂等键与 attempt 重跑冲突（A）

`UNIQUE(idempotency_key)` + `attempt INTEGER DEFAULT 1` + §4.4「重跑 turn（新 attempt）」。若 key 由 `runId+nodeId` 派生，第二次 attempt 必然撞唯一约束；文档没定义 key 组成。

建议：`idempotency_key = hash(runId, nodeId, attempt, command)`，并在文档里写明；或把唯一约束改为 `UNIQUE(idempotency_key, attempt)`。

### I12 两份文档都缺「事件 schema 版本」

`agent_events.kind` 是自由 TEXT（A §4.1 无 CHECK），`payload_json` 无版本列。vendor schema 一变（A 自己在 R7 承认 SDK 漂移），历史 payload 无法解析。

建议：加 `payload_version INTEGER`，normalizer 按版本反序列化；`kind` 至少加 CHECK 或引用共享的 `NormalizedEvent['kind']` 联合。

---

## 4. 建议级

| # | 建议 | 说明 |
|---|---|---|
| S1 | 统一 `EventFidelity` 四值，废弃 `derived/coarse` | A 的 `aggregate`/`synthesized`/`opaque` 三分比 B 的两分更能表达「内容真实但只有一个回合包」（Codex items）与「宿主推导」（ScopeGuard）的差别；B 的 `derived` 同时承担了这两种语义，下游必然误用 |
| S2 | 把 B 的 `eventFidelity` 改名 `streamGranularity: token\|message\|item\|turn\|session` | 它和 `fidelity` 是两个正交维度，同名会长期混淆；且 `item` 是 Codex 真实存在的一档 |
| S3 | 补索引：`agent_turns(status)`、`agent_approvals(run_id,status)`、`agent_events(type)` | 启动对账与待审批查询都是按 status 扫全表；`agent_events` 只有 `(turn_id,seq)` 与 `(kind,created_at)` |
| S4 | 单窗口今天成立，但审批事件要带 `threadId`/`windowId` | 现在 `broadcastToWindows` 广播到全部窗口；未来开第二个窗口会同时弹两张审批卡，任一张都能改状态 |
| S5 | `input_json` 存 prompt 与「日志不记 prompt 正文」要写明边界 | A §4.1 注释「含 prompt，供重跑」与 §8.3「不记录 prompt 正文」看起来矛盾，实际是 DB vs 日志两个 sink，需要一句话说明并给加密/本地化的要求 |
| S6 | R12 打包风险要落成具体配置 | `asarUnpack` 需要覆盖 `@anthropic-ai/claude-agent-sdk` 的 CLI 二进制与 `@openai/codex-sdk` 的 `codex` 可执行；加打包后 smoke test |
| S7 | 保留策略要落成作业，而不是一段话 | 30 天归档需要定时任务 + 归档表；否则 `agent_events` 以会话速率增长（B 无保留策略，完全没有） |
| S8 | 删掉 `AgentOutput` 里未被消费的 `tool_call` 语义 | 渲染层把它当「工具调用」用，但实际来源是文本启发式；新事件模型下会与新 `tool.requested` 冲突 |

---

## 5. 逐项回答评审要求

### 5.1 事实一致性（最优先）

**结论：A 的行号引用准确率很高，B 的抽象命名正确但事实断言有 4 处被代码推翻。**

A 抽查并确认（[实读]）：`agent.ts L93-117`（10 种 type、单一 `data`）、`agent.ts L239-286`（`AgentAdapter` 接口）、`base.ts L184-L224`（无在途锁）、`claude-code.ts L229`（`permissionMode: transparent ? 'default' : 'acceptEdits'`）、`L237-L268`（仅 PostToolUse，matcher `Edit|Write`）、`L272-L337`（只消费 `text` 与 `result`，`tool_use/tool_result/thinking` 丢弃）、`L340-L346`（abort）、`codex.ts L109`（阻塞 `thread.run()`）、`L129-L148`（只取 `agent_message`/`file_change`）、`L179-L183`（`doCloseQuery` 只清 Map）、`L34-L35`（thread Map）、`opencode.ts L49-L86`（`-q` + stdout 缓冲到 exit）、`agent-manager.ts L115-L117`（`MAX_SESSIONS`/`MAX_PROCESSES`）、`L562-L613`（`sendCommand`）、`L494-L519`（placeholder→developing）、`request-queue.ts L143-L150`（按 adapterName 分组；且全仓仅测试引用 **[实测 grep]**）、`database.ts L463-L476`（`agent_logs` 整段 outputs 一行）、`ipc.ts L109-L150`（无审批 channel）。

A 的两处偏差：`registry` 数量（13 → 12，见 I2）；`§13.8` 把「`AgentChatPanel` 可能编译不过」留作未确认（**[实测] 全仓 `tsc --noEmit` exit 0，此疑虑不成立**）。另外 A 的 §7.2/§11 R2 对 Codex「不支持中断」的判断被 SDK 类型推翻（见 §7.1 第 2 条）。

### 5.2 可编译性

- A 的 §3 类型草案：**[实测]** 独立文件 + `tsc --strict` = 0 error。语义层面仍有 4 处问题：`TurnTerminalEvent` 的 `kind` 与 `status` 可自相矛盾（`kind:'turn.completed'` + `status:'failed'` 可以通过编译）；`ToolCompletedEvent.kind='tool.failed'` 没有任何错误字段；`SessionLockRegistry` 表达不出「立即失败」（K5）；`TurnOutcome.usage` 必填但 M0 不建 `agent_usage` 表（类型要求与分期交付冲突）。这些是**语义不闭合**，不是编译失败。
- B 的 §2/§3/§7 契约：**[实测]** 11 处未定义标识符（K3）。
- SQLite 能力：**[实测]** A 的 partial unique index 在 SQLite 3.51 上完全可以表达（评审提纲里「可能表达不出来」的怀疑不成立）；真正的问题在**语义**（K6）。A 的 `CHECK` 只能约束枚举值，**无法**约束状态转移（K7）。B 的 `ON DELETE CASCADE` 在 `foreign_keys=ON` 下会真的级联删除（K8）。

### 5.3 状态机与恢复

- **不可达/矛盾状态**：A 的 `TurnStatus` 包含 `queued`，但 `ux_agent_turns_active_node` 把 `queued` 也算作排他（K6），于是「排队的 turn」这条路径整体不可达。A §3.2 说 `cancelling` 只能到 `cancelled|failed`，§6.3 又说取消超时「标记 `orphaned`」→ 自相矛盾。`waiting_approval` 超时后进入哪一状态（回到 `running` 还是 `failed`）没有定义。
- **死锁路径**：`waiting_approval` 持锁等用户；窗口关闭时无人 resolve（I8），只能等 60s 超时；若一个 turn 内有多个高风险步骤，等待线性累加，期间锁与工作区租约不释放。
- **崩溃窗口**：K7 的「已批未执行」无规则；另外「执行了但 PostToolUse 未触发」同样无规则。A §4.4 的「对账不一致 → `needs_attention`」在没有 `executing_at` 标记时无法判定。

### 5.4 锁与并发

per-session 串行本身在**单进程内存**里是可实现的（Electron main 只有一个进程），能防住同一 session 的重入。但四点必须修：K5（API 表达不了立即失败 + ALS 键控）、K1（锁住 session 不等于锁住 adapter 实例）、A §6.2「每工作区并发 1」没有任何实现契约 —— `WorkspaceLease` 只是个带 `leaseToken: string` 的数据结构（A §3.6），没有 acquire/release，也没有 `WorkspaceLockRegistry`，所以「同工作区串行」在 M0/M1 之间是悬空的。至于「`AsyncLocalStorage` 在多窗口下是否成立」：ALS 是进程级、按异步上下文隔离的，与窗口数量无关；真正的风险不是多窗口，而是**跨异步根不传播**（K5）。

### 5.5 审批真实性

- Claude 0.3.286 上**静态确认** `canUseTool` 与 `PreToolUse.permissionDecision`（`allow|deny|ask|defer`）都存在。A 的「理论上支持」是保守且正确的；B 的「签名未能确认」已经过时，可以删掉。
- A 的「不能同时使用 `acceptEdits` 与写前审批」只对 `canUseTool` 成立；**对 `PreToolUse` 不成立**——hook 在权限模式之前评估（调研 §3.2.2 的顺序），所以在 `acceptEdits` 下仍可用 hook 做 `deny`。A 把两种机制混为一谈，会让实现者以为必须整体切到 `default`。建议明确：`PreToolUse` 只做硬 deny（策略），`canUseTool` 只做人审（`permissionMode: 'default'`），二者不要同时装，避免双重弹窗。
- 降级路径的「欺骗性状态」风险仍在：A 的 `turn_policy` 与 B 的 `policy-only` 都允许「UI 有审批入口但实际拦不住」。两份文档都写了「必须说真话」，但都没有把「能力位 → UI 文案」写成一处唯一来源（A §7.2 的矩阵是散文表格，B §4.2 是另一套）。建议把 `ApprovalMode` 存进 `agent_sessions.capabilities_json`，渲染层只读它。
- Codex 的真实降级是 `sandboxMode` 预设，不是「审批」（I9）。

### 5.6 归一化契约

- `seq` 不断号：在 Codex（阻塞）与 OpenCode（one-shot）下**可满足，但近乎无意义**——seq 由宿主分配，只要不改写就不会断号。真正的风险是**多写者**（normalizer + approval + system）与**保留策略归档**（I5）。
- `fidelity`/`ordering` 的误用风险确实存在：`ordering: 'native'` 对宿主合成事件（`turn.started`/`turn.completed`）是假的；`fidelity` 是逐事件的，没有「本 turn 保真度下限」，UI 很容易把 `fidelity='exact'` 的 `message.completed` 当作「工具事件也完整」。建议在 `TurnStartedEvent` 上加 `fidelityFloor`，并在 `NormalizedEventBase` 里去掉 `ordering`（它可由 `origin + fidelity` 派生，三字段同时存在必然漂移）。

### 5.7 工作量与顺序

- A 的 M0 是「5 张表 + 锁 + 3 个 Normalizer + 审批通道 + `runNode`」，这不是最小切片，而是除调度与恢复之外的**全部横切面**。它把两个最高风险项放在了错误的位置：① 事件归属（K1）只作为 V4 的失败分支；② 崩溃对账（K2）的验收值在 M1。
- B 的 Phase 1「事件归一（不改行为）」顺序更稳，但它缺 A 的「先证伪 Claude 审批」这一前置 spike，导致 Phase 2 的「Claude 接入原生审批」没有 go/no-go 门。
- 返工点：若先按 B 的 `run` 单位建表，再接受 A 的 `turn` 原子，则 `agent_runs` 会退化成冗余状态机（两处写 status），迁移成本集中在最贵的地方。

### 5.8 遗漏

两文档共同遗漏或写得过轻：**DB 迁移版本号/checksum**（I1）、**preload 四处白名单改动**（I10）、**启动对账**（K2）、**工作区租约的实现契约**（5.4）、**事件 schema 版本**（I12）、**窗口销毁处置**（I8）、**多窗口审批路由**（S4）、**成本上限持久化**（A 的「日成本熔断」没有落库表，`agent_usage` 只有 turn 级）。打包只有 A 的 R12 一行，无具体 `asarUnpack` 项。B 完全没有保留策略与迁移章节。

---

## 6. 两份文档的合并评审

### 6.1 重复部分（可删一份）

| 主题 | A 位置 | B 位置 | 结论 |
|---|---|---|---|
| 分层 + 依赖规则 | §2.1、§2.2 | §1、§1.1 | 重复。A 的六层 + 5 条 lint 规则更可执行，B 的 `ToolRuntime/ContextEngine` 两节是补充 |
| 事件信封 + 事件类型 | §3.1 | §2.1–§2.3 | 重复且冲突（字段名与枚举值不同） |
| 能力矩阵 | §3.3 `ExecutorCapabilities` + §7.2 | §3.3 表 | 重复且冲突（两套枚举） |
| 审批状态机（fail-closed / 超时 deny / 幂等） | §3.4、§7.3、§7.4 | §5.2 | 重复。A 的校验顺序与 `argsHash` 更强 |
| 「不重写适配器」 | §2.3 | §13 | 重复。A 的实现路径（shim）更诚实 |
| 分期 | §9（M0/M1/M2） | §10（Phase1-4） | 重复。切分口径不同但颗粒相近 |

### 6.2 互补部分（各留一半）

| A 有、B 无 | B 有、A 无 |
|---|---|
| 可编译的类型草案（`Executor`/`TurnRequest`/`ApprovalBridge`） | `agent_runs` 作为「一次执行请求」的聚合行 |
| `argsHash` + main 侧 5 条校验 | `agent_snapshots` + 「快照 + replay」恢复基线 |
| `CancelOutcome.effective/mechanism`（诚实取消） | `loopOwnership` 轴（谁决定下一步） |
| 验证清单 V1–V12 + 夹具/故障注入资产 | `run.paused/resumed/interrupted` 的显式生命周期 |
| `fidelity` 四分（`synthesized` 单列） | 「恢复到最近持久化边界」的承诺边界（诚实） |
| 预算三级、`is_estimate`、日熔断 | 审批 `allow_session` 的会话内复用语义 |

### 6.3 直接冲突（逐条 + 采信）

| # | 冲突点 | A 口径 | B 口径 | 采信 | 理由 |
|---|---|---|---|---|---|
| C1 | 保真度枚举 | `exact\|aggregate\|synthesized\|opaque` | 信封 `exact\|derived\|coarse`；能力位 `token\|turn\|session` | **A 的史实枚举 + 把 B 的能力位改名 `streamGranularity`** | A 的 `synthesized` 能单独表达「宿主推导」，B 的 `derived` 把「结果反推」和「宿主合成」混为一谈；两个 `fidelity` 同名必混 |
| C2 | 基本单位 | `turn`（状态机原子） | `run`（状态机原子，内含 turn） | **`run` 保留为聚合行，`turn` 是唯一状态机原子** | 现存的锁、唯一索引、执行器 `send` 粒度都在 turn；把 run 当第二个状态机会产生双写 |
| C3 | 循环归属 | 无此轴，用 `toolEvents: blocking\|observational\|none` | `loopOwnership: backend\|host` | **两个正交轴都保留，但拆成三列**：`loopOwner`（谁决定下一步）/ `toolExecution`（谁执行工具）/ `interception`（能否写前拦） | B 的 `host` 同时暗示「宿主执行」和「宿主可拦」，实际不成立（OpenCode 宿主不执行文件写入）；A 的 `blocking` 不告诉你是谁在跑循环 |
| C4 | 审批能力枚举 | `ApprovalMode: step_blocking\|turn_policy\|none` | `approval: native\|hook\|policy-only` | **A** | `hook` 是实现机制不是能力；同一个 `PreToolUse` 可以是 deny-only 也可以是 ask，能力位应该描述「能否在写前拦住」 |
| C5 | 审批 IPC 命名 | `agent:onApprovalRequest` / `agent:resolveApproval` | `agent:approvalRequested` / `agent:approvalDecision` / `agent:approvalResolved` | **A 的命名 + B 的 `onApprovalResolved`** | 仓库既有事件一律 `agent:onOutput` 前缀（[preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L17-L118)）；`approvalDecision` 与 `approvalResolved` 语义易混 |
| C6 | 审批决策载荷 | 含 `argsHash` + main 5 条校验 | 仅 `approvalId + decision + remember` | **A** | TOCTOU 不可检测（K4） |
| C7 | 表集合 | `agent_sessions/turns/steps/events/approvals/artifacts/usage` | `agent_runs/events/approvals/snapshots` | **A 的 7 张 + B 的 `agent_runs`（聚合）+ `agent_snapshots`** | 见 6.4 |
| C8 | `agent_events` 键 | `(turn_id, seq)`，无 run_id | `(run_id, seq)`，无 turn_seq | **两者合并**：`(run_id, seq)` 全序 + `(turn_id, turn_seq)` 局部 | 恢复要全序，单 turn 幂等要局部（I6） |
| C9 | 崩溃标记 | `orphaned` | `interrupted` | **`orphaned`** | A 的词能区分「进程死了没人管」与「用户主动中断」；`interrupted` 与 `run.paused` 重复 |
| C10 | 恢复方式 | artifact hash 对账 + `rerun/reconcile-then-rerun/abandon` | snapshot + replay 到最后事件 | **合并**：B 的快照做基线，A 的对账做副作用判定 | 单靠 replay 不知道副作用是否落地；单靠 hash 没有回放基线 |
| C11 | 恢复承诺 | 「状态可对账、副作用可审计」（§0.8） | §0.4 说「任意步骤」，§6.2 说「只能到最后边界」 | **A 的表述** | B 内部自相矛盾（K8） |
| C12 | `thread.sessionId` 语义 | 指向 `agent_sessions.id` | 指向「最近一次 run 的 runId」 | **A** | 现有代码里它是「会话指针」（[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L264-L290)）；改成 runId 会让「继续这个会话」变成「继续那次执行」 |
| C13 | 适配器改造方式 | 逐个 `LegacyAdapterExecutor` 包 | 通用 `CLIDriver` 统一 7 个 | **A** | B 的 CLIDriver 实质是重写，且与自述「不重写」冲突（I2） |
| C14 | `AgentOutput` 地位 | 需要新事件类型，但保留旧投影 | 明确「双写：`AgentEvent` + `AgentOutput`」 | **B 的双写策略**，类型定义用 A | 双写是唯一不破坏现有 UI 的过渡方式 |
| C15 | 表上外键 | 不设 FK | `ON DELETE CASCADE` | **A（不设 FK）** | CASCADE 会删审计（K8） |

### 6.4 合并结论（后续实现只认这一套）

**一句话口径**：以 A 为主干（类型、审批、安全、验证纪律），**吸收 B 的三件东西**（`run` 聚合行、`snapshots` 快照恢复、`loopOwnership` 轴），其余术语与枚举按下面的表统一。

**术语表（唯一说法）**

| 术语 | 定义（写进 `src/shared/types/agent-runtime.ts` 的注释） | 废弃 |
|---|---|---|
| `run` | 一次用户/系统发起的执行请求（`agent_runs` 一行，聚合用，**不是状态机**） | `NodeExecution` 里的隐式 run |
| `turn` | 执行器的一次 `send`，**状态机唯一原子**，锁与唯一索引锚点 | — |
| `attempt` | 同一节点同一 `group` 的第 N 次执行 | B 的「重放」 |
| `step` | turn 内可审计执行单元（不承诺可恢复） | — |
| `seq` | run 级全序（恢复用） | — |
| `turn_seq` | turn 内局部序号（幂等/断号校验） | A 的单一 `seq` |
| `fidelity` | `exact \| aggregate \| synthesized \| opaque`（事件相对 vendor 语义） | B 的 `derived \| coarse` |
| `streamGranularity` | `token \| message \| item \| turn \| session`（能力位，原 B 的 `eventFidelity`） | `eventFidelity` |
| `loopOwner` | `backend \| host`（谁决定下一步） | `loopOwnership`（语义过载） |
| `toolExecution` | `backend \| host`（谁真正执行工具） | — |
| `interception` | `pre \| post \| none`（能否在执行前拦住） | `approval: native\|hook\|policy-only` |
| `ApprovalMode` | `step_blocking \| turn_policy \| none`（A） | B 的三值 |
| 状态词 | `queued / running / waiting_approval / cancelling / completed / failed / cancelled / orphaned` | `awaiting_approval`、`interrupted` |

**采信对照（"以哪份的哪一节为准"）**

| 主题 | 准据 |
|---|---|
| 类型契约 | A §3.1–§3.6（全量，含 `ApprovalBridge`）；B 只补 `agent_runs` / `snapshots` 的字段 |
| 审批 | A §3.4 + §7.3 + §7.4（校验顺序、`argsHash`、fail-closed） |
| 能力矩阵 | A §3.3 的 `ExecutorCapabilities` + B §3.3 的 `loopOwner` 一列；数值按本报告 §7.1 修正 |
| 表结构 | A §4.1 的 7 张 + B §6.1 的 `agent_runs` / `agent_snapshots`；统一 `seq`/`turn_seq`，去掉 CASCADE |
| 恢复 | B §6.2 的「快照 + replay」流程 + A §4.4 的 artifact 对账表 + A §0.8 的承诺边界 |
| 并发 | A §6.1–§6.4 + 本报告 K1/K5（`tryAcquire` + ALS 键控 + 工作区租约 API） |
| 分期 | A §9，但 M0 增加「启动对账」，并把「Claude 审批 spike」提到 M0 之前作为独立门 |
| 降级文案 | A §7.2 矩阵（数值修正后）作为唯一来源，落到 `capabilities_json` |

**两份文档都需要统一修掉的三处硬伤**：① 事件归属机制（K1）；② 已批未执行窗口（K7）；③ 迁移版本号与 checksum（I1）。

---

## 7. 事实核对

### 7.1 被代码/类型推翻的说法

| # | 说法（出处） | 实际 | 证据 | 影响 |
|---|---|---|---|---|
| F1 | 「13 个 CLI 适配器」「老的 10 个 CLI 适配器」（A §2.3，两处） | **12 个注册项**：10 个外部 agent 适配器 + `mcp`（API/MCP 兜底）+ `mindmap-internal`（内部 one-shot） | [registry.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/registry.ts#L61-L272) **[实测]** | 排期与「主路径 3 个」的分母都错 |
| F2 | 「Codex 不支持中断」「`cancel: cooperative\|none`」（A §7.2/§11 R2；B §3.2B/§3.3） | SDK 0.135.0 **有** `TurnOptions.signal: AbortSignal` | [codex index.d.ts](file:///Users/zhumingchen/tiangong/node_modules/@openai/codex-sdk/dist/index.d.ts#L167-L172) **[实测]** | A 的 V5 整条验证项与 B 的降级都可以删；Codex 可声明 `cancel: abort` |
| F3 | 「Codex 阻塞到结束，无中间事件，工具事件只能 derived」（A §7.2/§13.3；B §3.2B/§3.3） | SDK 有 `runStreamed()` 产出 `thread.started / turn.started / item.started\|updated\|completed / turn.completed\|failed`；`ThreadItem` 联合含 `command_execution / file_change / mcp_tool_call / reasoning / web_search / todo_list / error` | [codex index.d.ts](file:///Users/zhumingchen/tiangong/node_modules/@openai/codex-sdk/dist/index.d.ts#L104-L187)、[L206](file:///Users/zhumingchen/tiangong/node_modules/@openai/codex-sdk/dist/index.d.ts#L206) **[实测]** | 两文档把 Codex 的能力**系统性低估**；`derived` 应为 `exact`（item 级），`streamGranularity` 应为 `item` 而不是 `turn` |
| F4 | 「Codex 的 `result.items` 完整类型待验证」（A §13.3） | 静态即可回答（见 F3） | 同上 | 可删除此待验证项 |
| F5 | 「`canUseTool` 签名未能确认」（B §3.2A/§12.1/§13.1；A 也标「待验证」） | 0.3.286 typings 明确存在 `canUseTool?: CanUseTool`；`PreToolUseHookSpecificOutput.permissionDecision: 'allow'\|'deny'\|'ask'\|'defer'` | [sdk.d.ts](file:///Users/zhumingchen/tiangong/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts#L1587)、[L2746-L2752](file:///Users/zhumingchen/tiangong/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts#L2746-L2752) **[实测]** | 「签名」不再是风险；只剩「运行时是否按期回调」需 spike |
| F6 | 「ClaudeDriver `eventFidelity: token`」（B §3.2A/§3.3） | 当前集成**没有**开 `includePartialMessages`（选项里无该字段），实际粒度是 message；B 自己又写 `mode: 'block'` | [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L219-L240)、[sdk.d.ts L1860](file:///Users/zhumingchen/tiangong/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts#L1860) **[实读+实测]** | 要么改能力位为 `message`，要么在 spike 里开 `includePartialMessages` 再声明 `token` |
| F7 | 「OpenCode `loopOwnership: host`、`approval: hook`、工具调用走宿主内联协议」（B §3.2C/§3.3） | 宿主的 `<tool_call>` 协议**只用于 subagent / recipe 派发**；文件写入由 OpenCode CLI 自己完成，宿主只看 stdout，scope 仅靠 prompt 文本追加 | [base.ts L978-L1049](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L978-L1049)、[opencode.ts L72-L103](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts#L72-L103) **[实读]** | 按 B 会去建一个**拦不住写入**的 `ToolRuntime`；应为 `loopOwner: backend`、`toolExecution: backend`、`interception: post`、`ApprovalMode: turn_policy` |
| F8 | 「`AgentChatPanel` JSX 多根导致无法编译/必须先修」（B §12.6、§9 表） | 全仓 `tsc --noEmit` **exit 0**，tsconfig 含 `src/renderer/**/*.tsx` + `jsx: react-jsx` | [tsconfig.json](file:///Users/zhumingchen/tiangong/tsconfig.json) **[实测]** | 不是阻塞项，可从风险表删除 |
| F9 | 「不重写 12 个适配器」（B §13） vs §3.2D「通用 `CLIDriver` 统一包 7 个 CLI」 | 两个陈述互相矛盾；包一个通用 Driver 必然重写各 CLI 的入参差异 | B 自身 | 采 A 的 shim |
| F10 | 「`ON DELETE CASCADE` 可用于审计表」（B §6.1） | `foreign_keys = ON` 已开启，级联会真删 | [database.ts L46](file:///Users/zhumingchen/tiangong/src/main/database.ts#L46) **[实测]** | 见 K8 |

### 7.2 我确认成立的关键事实（供后续引用）

- `BaseAdapter` 每个实例只有一份输出归属栈，归属取栈顶（`base.ts L53-55 / L459-461`）；`emitOutputForSession` 这条精准通道已存在（`L604-609`）但未被普遍使用。
- 每个 adapter 名全进程单实例（`ipc-handlers.ts L116-131`），事件广播到全部窗口（`ipc-handlers.ts L145-148`）。
- Claude 适配器：`permissionMode: transparent ? 'default' : 'acceptEdits'`（`claude-code.ts L229`）；只有 `PostToolUse`（`Edit|Write`）hook；只消费 `text`/`result`。
- Codex 适配器：`thread.run()` 阻塞；`threads` Map 仅在内存；`doCloseQuery` 只清 Map。
- OpenCode：`spawn('opencode', ['-q'])`，stdout 缓冲到 exit 才返回；scope 靠 prompt 后缀（`buildConstraintSuffix`）。
- DB：`foreign_keys = ON`；`CURRENT_SCHEMA_VERSION = 17`；迁移有 checksum 文件；迁移事务内关 FK。
- `RequestQueue` 目前**只有测试引用**，未接入派发路径。
- `agent:startSession` 直接透传 `adapterName + config`（`ipc/agent.ts L25-28`）。
- preload 是显式白名单，新增通道需改 4 处。

---

## 8. 仍是推断 / 仍需实跑的部分

| # | 未验证 | 为什么不能只靠静态 | 建议验证方式 |
|---|---|---|---|
| U1 | Claude `canUseTool` 在 `default` 模式下是否**每次**高风险工具都回调 | 类型只证明存在，不证明运行时行为 | A 的 V3 spike（读目标文件 hash） |
| U2 | `PreToolUse` 的 `ask` 在 SDK 无交互 surface 时的落点 | 文档说 headless 会拒绝，但 SDK 有 `canUseTool` 时行为可能不同 | 装/不装 `canUseTool` 两组对照 |
| U3 | Codex `runStreamed` 的 `item.updated` 频率与 `command_execution` 是否含完整 argv | 类型只给字段名 | 录制真实 codex 会话，产出夹具（可直接补 A §12.4 的 `codex/*.json`） |
| U4 | ALS 在 IPC handler / 定时器 / subagent 路径的实际传播 | Node 文档语义清楚，但项目里这三条路径是否真的换根需实测 | 单测：在 `setInterval` 内调用 `sendCommand` 观察是否静默跳过 |
| U5 | `better-sqlite3` 高频写入是否阻塞主进程 >16ms | A 的 R4，需压测 | A 的 V10 |
| U6 | Electron 打包后 SDK/CLI 二进制是否可用 | 需真实 `electron-builder` 产物 | A 的 R12 smoke test |
| U7 | `thread.sessionId` 历史数据里到底存了什么（vendor id 还是运行时 id） | 代码上是运行时 `session.id`，但历史库可能有更早格式 | 用真实旧库副本统计（A 的 V9） |

---

## 9. 结论：能否按 M0 开工

**不能。** 开工前必须先补三件事：

1. **统一一份「实现口径」**：按 §6.4 的术语表与采信对照，产出一份单一文档（建议直接改 A，把 B 的三节并进去并删除 B）。当前两份文档的枚举值互不兼容，任何代码一旦落地就会绑定到其中一套，之后改动成本翻倍。
2. **重做事件归属与锁的契约**：把归属从 `outputSessionStack` 栈顶改为显式 `sessionId/turnId` 入参（或 M0 强制 per-executor 并发 1）；`SessionLockRegistry` 增加 `tryAcquire`；ALS store 改为 `Set<sessionKey>`；补「父 turn 内派发子 session」的并发单测。这是 M0 唯一无法用「后面再修」带过去的横切面。
3. **让 M0 的验收等于 M0 的交付**：加「启动对账」（boot 时 `orphaned/expired` 归置 + 全量快照广播）；把 `agent_steps` 的 `approved_at / executing_at` 三阶段写进表结构，明确「已批未执行」与「执行中」的对账规则；把 `idempotency_key` 的组成写死。否则「kill -9 后不出现悬空态」与「恢复不重复执行」这两条核心承诺在最危险的时间窗里是空的。

补充建议的执行顺序：**先跑 Claude 审批 spike（U1/U2）→ 再确认 Codex `runStreamed` 能力（U3）→ 然后才建表**。当前数值矩阵把 Codex 的能力低估了 2 档、把 OpenCode 的拦截能力高估了 1 档，先建表会把错误的 `fidelity`/`ApprovalMode` 写进历史数据。
