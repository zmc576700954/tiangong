# Agent 体系审计复核（2026-11-05）

> **文件状态说明**：任务要求“更新 `docs/architecture/agent-audit-2026-11-05.md`（追加复核轮章节）”，但复核开始时该文件**在磁盘上不存在**（`docs/architecture/` 下只有 `agent-consistency-audit-2026-11-05.md`）。因此本文件先落“复核轮”，并把原任务要求的三段内容（结论表 / 收敛清单 / 原判纠错）完整写入。全程只读，未改源码、未 commit。

## 最该先修的 3 件事

1. **Bash 只读白名单的“参数面”过宽**（P1，用户可见）：`rg` / `git` 的只读子命令被整条放行且不校验参数，`rg --pre`、`git diff --output=`、`git grep -O`、`git branch <name>` 可在**零审批**下执行外部命令或写盘。证据 [bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L209-L213)、[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L251-L253)、[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L297-L313)、[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L316-L337)。
2. **同一 turn 被 legacy 与 kernel 两条路径各记一次用量**（P1，用户可见）：Claude/Codex 的 kernel turn 会同时产生 `legacy:<adapter>:<session>:<turnSeq>` 与 `turn:<turnId>` 两行，会话成本约 2x，且 kernel 行 `graph_id` 为空。证据 [agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L282-L313)、[session-lifecycle-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/session-lifecycle-manager.ts#L193-L229)、[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L821-L841)。
3. **`agent_events` 无任何保留策略，且落全量工具入参**（P1，内部风险，长期转为用户可见）：全仓无 `DELETE FROM agent_events / agent_usage / agent_turns / agent_sessions`、无 `VACUUM` / `auto_vacuum` / 归档；写入内容含 write 全文、bash 命令、审批入参。证据 [schema.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L141-L161)、[repository.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L723-L760)。

---

## 一、复核结论表

| # | 条目 | 判定 | 证据（文件:行） | 若确认，最小修复 |
|---|---|---|---|---|
| 1 | P0-1 会话级授权可被“先批合法写 → 再写工作区外”绕过 | **原判有误** | [gateway.ts:96-109](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L96-L109)（工具名白名单）、[gateway.ts:130-146](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L130-L146)（每次调用重新 realpath）、[gateway.ts:359-371](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L359-L371)（grant 命中条件）、[gateway.ts:314-327](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L314-L327)（grant 只记 `toolScope:'write'` + `cwd`） | 无需修 P0；仅剩 P3：hardlink 与 TOCTOU（见下） |
| 2 | P1 seq 并发重复/跳号 | **部分确认**（重复不可达；跳号确认） | 分配点 [runtime.ts:210](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L210)、[:216-237](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L216-L237)；写库 [repository.ts:723-760](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L723-L760)（`seq` run 级、`turn_seq` 用 `event.seq`）；跳号源 [runtime.ts:544-560](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L544-L560)（用 run 级 `event.seq` 算下一个 `turn_seq`） | `emitReclaimAudit` 改用 `Math.max(...events.map(e => e.turn_seq))`；或让 `appendEvents` 自行分配 `turn_seq` |
| 3 | P1 `agent_usage` legacy+kernel 双记 | **确认** | legacy key [agent-manager.ts:304-308](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L304-L308) + [session-lifecycle-manager.ts:219-229](file:///Users/zhumingchen/tiangong/src/main/agent/session-lifecycle-manager.ts#L219-L229)；kernel key [runtime.ts:838](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L838)；两者 key 形状不同 → `ux_agent_usage_dedupe` 不会合并 | kernel 派发时把 `turnId` 透传给 adapter 的 usage 上报并统一用 `turn:<turnId>`；或在 kernel 绑定会话时关闭 legacy 记账 |
| 4 | P1 token 缓存重复计数 | **部分确认**：Claude 读缓存不重复、但漏记 cache 写；Codex 疑似重复计缓存（需实测） | Claude 映射 [claude-code.ts:420-436](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L420-L436)、[adapter-driver.ts:352-375](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts#L352-L375)；Codex 映射 [adapter-driver.ts:377-388](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts#L377-L388)；计价 [pricing.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/cost/pricing.ts) `costMicrosOf` 三项直接相加 | Claude 增加 `cache_creation_input_tokens`（需价格表新增字段）；Codex 先确认 `input_tokens` 是否含 cached，若含则计价时 `input - cached` |
| 5 | P1 `agent:resolveApproval` 缺归属校验 | **确认** | [ipc/agent.ts:46-61](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L46-L61)（只校验 shape，不校验调用方）；[gateway.ts:267-333](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L267-L333)（只校验 `argsHash`）；[:461-480](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L461-L480) 把全部 pending 的 `argsJson` 暴露给任一 renderer | handler 增加 `sessionId`/`turnId` 与 `event.senderFrame` 校验，`decide` 校验 `row.turn_id` 属于该会话 |
| 6 | P1 `--resume` 被内部 id 污染 | **已修复** | [native-session-id.ts](file:///Users/zhumingchen/tiangong/src/shared/native-session-id.ts)；[claude-code.ts:292](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L292)；`codex.ts:152/210/352`、`cursor.ts:56` 同款过滤；恢复侧 [agent-manager.ts:894-903](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L894-L903)；opencode 无 resume | 无 |
| 7 | P1 恢复窗口：in-flight turn 未终态即续接 | **已修复**（仅剩“只查最新 turn”的 P3 残差） | [agent-manager.ts:874-892](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L874-L892)（最新 turn 非终态 → 抛 `SessionRestoreError`）；启动对账先于审批重放在 [runtime.ts:764-769](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L764-L769) + `planner.ts` 全量 orphan | 无；可把“最新”改为“任一会话 turn 非终态即阻断”（P3） |
| 8 | P0-2 事件无保留策略 | **确认** | [schema.ts:141-161](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L141-L161)；全仓检索无 `VACUUM` / `auto_vacuum` / `retention` / 对 `agent_events`、`agent_usage`、`agent_turns`、`agent_sessions` 的 `DELETE`；仓库里只有 `agent_logs`（[agent-log-repository.ts:48](file:///Users/zhumingchen/tiangong/src/main/repositories/agent-log-repository.ts#L48)）、memory（`pruneStale`）、snapshot（`pruneOldSnapshots`）有清理 | 启动/每日低峰按天数或行数裁剪 `agent_events` + `agent_usage`；payload 里 write/bash 入参改存 hash+摘要；定期 `VACUUM`（或 `auto_vacuum=INCREMENTAL`） |
| 9 | P1 `bash-readonly` 可读工作区外文件 | **确认存在，属设计边界未收紧** | 文件内无任何 `cwd/workspace/resolve/homedir/path` 约束（全文件检索无命中）；[bash-readonly.ts:316-337](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L316-L337)；策略入口只传命令字符串 [claude-code.ts:319](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L319)；审批网关的路径作用域只覆盖写类工具 [gateway.ts:96-100](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L96-L100) | 产品决策：要么显式接受“只读可读任意路径”，要么把 `evaluateBashPolicy` 增加 cwd 参数并对 `cat/ls/grep/...` 做词法+realpath 的路径范围判定 |
| F2 | 重启后同会话 UI 发送失败 | **已修复** | [agent-manager.ts:853-960](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L853-L960)；真机证据 `docs/architecture/agent-realdevice-verification.md` §21（`Restored persisted session … via native resume`、`r8-03-rollback-continued.png`、`r8-main-rollback-continue.log`） | 无 |
| F3 | C13b symlink 抢占 | **已修复** | `spikes/reaper-isolation/README.md` §9.4（`writeFileNoFollow`：`O_CREAT + O_EXCL + O_NOFOLLOW`、rename 前 re-lstat、6 变体 PASS）；§8 保留 FAIL 快照 | 无；顺手清理 `verification-ledger.md:22` 的 U14 过时条目 |

### 逐条依据摘要（只写判定需要的“为什么”）

**1）原判有误。** 命中会话级授权要同时满足三件事，缺一即回落人工审批：
- `isWriteScopedTool(toolName)`：[gateway.ts:96-100](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L96-L100) 的 `WRITE_TOOL_PATTERN` 是大小写不敏感的锚定正则，`mcp__*`、`Bash` 都不会命中；
- `targetPathOf(args)` 必须能取到路径：[gateway.ts:103-109](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L103-L109)；
- `isPathInside(grant.cwd, target)`：[gateway.ts:359-371](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L359-L371)。

`isPathInside` 每次调用都现算：`root` 与 `candidate` 都 `path.resolve`，存在的目标 `fs.realpathSync`，不存在时回退父目录 realpath 再拼 basename，最后做 `\`rootReal + sep\`` 前缀比较（[gateway.ts:130-146](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L130-L146)）。所以“先批 `/repo/src/a.ts`（session 授权）→ 再写 `/etc/passwd`”在 **第 369 行** 被挡住：`isPathInside('/repo','/etc/passwd') === false` → `matchSessionGrant` 返回 null → 走正常 pending 审批。

关键点：grant 的 `cwd` 来自 `input.cwd`，而 driver 传的是 `request.workingDirectory`（会话配置目录），**不是子进程 hook 自报的 cwd**（[adapter-driver.ts:247](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts#L247)、[:265](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts#L265)），因此子进程也无法把 grant 的根“抬”到 `/etc`。

**仍存在的 P3 残差**：① 若工作区内放一个指向工作区外的 **hardlink**，`realpath` 仍显示工作区内，写入会改到外部 inode；② 校验与实际写入之间是 TOCTOU（SDK 侧写文件，宿主只做字符串/realpath 判断）。这两点是所有路径网关的共性，不是本案独有。

**2）重复不可达、跳号可达。** 同一 turn 内只有两个同步写入点：`record()`（[runtime.ts:216-237](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L216-L237)）与 `emitReclaimAudit()`；前者用闭包 `seq` 递增，后者单独计算。`appendEvents` 在事务内用 `MAX(seq)+1` 分配 **run 级 seq**（[repository.ts:734-757](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L734-L757)），并把 `event.seq` 写入 `turn_seq`（第 746 行）。`emitReclaimAudit` 的“下一个序号”取自 `listTurnEvents(...).reduce(max, event.seq)`（[runtime.ts:544-546](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L544-L546)），**`event.seq` 是 run 级**，不是 `turn_seq`。一个 run 含多轮时，第 2 轮的 `turn_seq` 会被写成 run 级的下一号 → 跳号（且 `eventIdFor(turn.id, seq)` 跟着跳）。单写者 + 事务下重复不可达。

**3）双记确认。** Claude 的 usage 上报没有 `backendEventId`（[claude-code.ts:420-436](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L420-L436) 只传 tokens/model/source），所以 `recordAdapterUsage` 落到 `legacy:${turnKey}`，`turnKey = claude-code:<sessionId>:<turnSeq>`（[session-lifecycle-manager.ts:225](file:///Users/zhumingchen/tiangong/src/main/agent/session-lifecycle-manager.ts#L225)）。kernel 同一条 turn 又在 [runtime.ts:838](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L838) 写 `turn:<turnId>`。两个 key 形状不同 → 唯一索引不去重 → 会话汇总 ~2x。并且 kernel 行 `graphId` 为空（[runtime.ts:831](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L831) 取 `request.graphId`，而派发没传，见下），图/日维度的汇总只包含 legacy 行。

**4）口径确认 / 待实测。**
- Claude：`input_tokens` 不含 cache 读写，所以 `input + cache_read` 不是重复；但代码只映射 `cache_read_input_tokens`，**没有 `cache_creation_input_tokens`**（[claude-code.ts:423-427](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L423-L427)），缓存写入部分被漏计。另 `inputTokens > 0` 才上报（第 429 行），纯输出或零输入的 usage 会被整条丢弃。
- Codex：`extractUsage` 把 `input_tokens` 与 `cached_input_tokens` 两个字段分别原样传出（[adapter-driver.ts:382-384](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts#L382-L384)），计价把两者相加（[pricing.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/cost/pricing.ts) `costMicrosOf`）。若上游 `input_tokens` 是“含 cached 的总输入”，则缓存 token 被按全价 + 缓存价各算一次。本地 d.ts 只写 “number of input tokens used”，**无法从仓库内确认语义** → 标为推测。

**5）确认。** IPC handler 只校验字段形状（[ipc/agent.ts:46-53](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L46-L61)），`decide()` 只校验 `approvalId + argsHash`（[gateway.ts:268-277](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L268-L277)），不校验调用方会话/turn，也不校验 `senderFrame`。同时 `agent:getPendingApprovals` 把**所有会话**的 pending payload（含 `argsJson`）返回给任一 renderer（[ipc/agent.ts:44](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L44)、[gateway.ts:461-480](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L461-L480)）。在“renderer 可信”的单窗口模型下属内部风险；多窗口/被注入页面时是跨会话批准。`typedHandle` 只按 webContents 限流，无 origin/senderFrame 校验（[utils.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/utils.ts)）。

**6）已修复。** 恢复侧只认 `run.started.payload.backendSessionId`，且对内部 id 显式拒绝并给出中文原因（[agent-manager.ts:894-930](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L894-L930)）；三个适配器在真正下发前都过 `isTrustedNativeSessionId`；opencode 根本没有 resume 分支。

**7）已修复。** 恢复入口在最新 turn 非终态时直接抛错，不自动重放（[agent-manager.ts:879-892](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L879-L892)）。启动时 `planRecovery/applyRecoveryPlan` 先把所有非终态 turn 置 orphan，之后才 `approvals.reconcileStartup()`（[runtime.ts:764-769](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L764-L769)），所以 `isFulfillable` 的结构性结果为 false，`replayed` 恒为空。残差：只检查“最新一条 turn”，若历史里存在更早的非终态 turn（正常流程下不应出现），不会被这条守卫拦住。

**8）确认。** 全仓（排除 `node_modules`）检索 `VACUUM|auto_vacuum|retention|DELETE FROM agent_events|DELETE FROM agent_usage|DELETE FROM agent_turns|DELETE FROM agent_sessions`，命中全部属于其它子系统（`agent_logs.pruneOld`、memory `pruneStale`、snapshot `pruneOldSnapshots`、`chat_threads` 归档）。Agent Runtime 的 9 张表没有任何清理/归档/压缩。`agent_events.payload_json` 里含 `tool.requested.input`（write 全文）、bash `command`、`approval.required.argsJson`。

**9）确认存在，属设计边界。** 策略函数只接收命令字符串（[claude-code.ts:319](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L319)），`bash-readonly.ts` 里没有任何 cwd/workspace/路径处理；`cat/ls/grep/head/tail/stat/file/du/df` 全是 `simpleRule`（[bash-readonly.ts:316-337](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L316-L337)），因此 `ls ~/.ssh`、`cat /etc/passwd` → `allow`。这不是“漏了一行”，是**只读策略从未定义路径范围**。是否收紧属产品决策；若收紧，需要把 cwd 作为参数传入并在词法层拒绝绝对路径/`~`/`..` 越界（realpath 在词法阶段拿不到，需二次校验）。

同时确认了同一文件的**真实放行绕过**（比“读任意路径”更严重）：
- `rg: simpleRule('rg')`（第 324 行）→ `rg --pre '<cmd>' pattern .` 每条文件执行一次命令；
- `GIT_READ_SUBCOMMANDS` 无参数校验（第 209-213、303 行）→ `git diff --output=<file>` 任意写、`git grep -O <cmd>` / `--open-files-in-pager` 执行命令、`git show --ext-diff/--textconv`、`git cat-file --filters`；
- `branchRule` 只查写 flag，位置参数 `git branch <name>` 落到 `allowRule('git:branch:list')`（第 267-276 行）→ 新建分支；
- `git fsck --lost-found` 会写 `.git/lost-found`。

---

## 二、收敛后的清单（只保留“确认仍存在”）

> 标注：**【用户可见】** = 用户能观察到错误结果/行为；**【内部风险】** = 当前架构下不可直接利用，但会放大其它缺陷或造成审计失真。

### P1

| ID | 问题 | 类型 | 证据 | 最小修复 |
|---|---|---|---|---|
| P1-1 | Bash 白名单对 `rg`/`git` 只读子命令**不校验参数**，可零审批执行命令/写盘（`--pre`、`--output=`、`-O`、`--ext-diff`、`branch <name>`、`fsck --lost-found`） | **用户可见** | [bash-readonly.ts:209-213](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L209-L213)、[:251-253](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L251-L253)、[:267-276](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L267-L276)、[:297-313](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L297-L313)、[:316-337](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L316-L337) | 对这 5 个子命令加参数 allow-pattern：`rg` 禁 `--pre*`；`git diff` 禁 `--output`；`git grep` 禁 `-O/--open-files-in-pager`；`git show` 禁 `--ext-diff/--textconv`；`git branch` 仅允许空参/只读 flag；其余 unknown arg → ask |
| P1-2 | 同一 turn legacy + kernel 双记用量，会话成本 ~2x；kernel 行 `graph_id` 为空 | **用户可见** | [agent-manager.ts:304-308](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L304-L308)、[session-lifecycle-manager.ts:225](file:///Users/zhumingchen/tiangong/src/main/agent/session-lifecycle-manager.ts#L225)、[runtime.ts:838](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L838) | kernel 派发把 `turnId` 传到 adapter usage 并统一 `dedupeKey='turn:<turnId>'`；或在 kernel 绑定会话上跳过 legacy 记账 |
| P1-3 | `agent_events` 无保留策略 + 全量敏感入参落库 | **内部风险**（长期转为用户可见：DB 膨胀/启动变慢） | [schema.ts:141-161](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L141-L161)、[repository.ts:723-760](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L723-L760) | 启动时按 `created_at`/行数裁剪；`tool.requested.input` 只存 `argsHash`+摘要；定期增量 VACUUM |
| P1-4 | `resolveApproval` 无会话/调用方归属校验；pending payload 全量暴露 | **内部风险** | [ipc/agent.ts:44-61](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L44-L61)、[gateway.ts:267-333](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L267-L333)、[:461-480](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L461-L480) | handler 接收 `sessionId`/`turnId` 并与 `row.turn_id` 对账 + `senderFrame` 校验；`getPendingApprovals` 按会话过滤 |

### P2

| ID | 问题 | 类型 | 证据 | 最小修复 |
|---|---|---|---|---|
| P2-1 | kernel 派发未传 `graphId`/`runId`/`attempt` → ① 图/日维度成本漏记 kernel 行；② 幂等键退化为 `new:<node>:<branch>:1:<promptHash>`，**同节点重复相同 prompt 静默复用旧结果**，且 key 不含 session，可跨会话复用 | **用户可见** | [agent-manager.ts:1118-1127](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L1118-L1127)、[runtime.ts:127-140](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L127-L140)、[repository.ts:497-499](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L497-L499) | 派发传入真实 `graphId`；幂等键纳入 `agentSessionId` 与真实 attempt；或仅在显式 idempotencyKey 时复用 |
| P2-2 | 恢复审计强制 `residualRisk:'none'` + `clearProc:true` + `kills:0`，覆盖启动清扫的未决风险与 pid 证据 | **内部风险**（影响运维判断/二次回收） | [agent-manager.ts:978-987](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L978-L987)、[repository.ts:387-421](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L387-L421) | `recordRestoreNote` 只追加 note，不改 `residual_risk`/`clearProc`/`kills`；或保留原值 |
| P2-3 | `tool.result` 同步步骤时**忽略 `payload.ok`**，一律 `done/completed`；`tool.failed` 分支无任何生产者 | **内部风险**（审计失真；若 UI 展示步骤状态则用户可见） | [runtime.ts:857-860](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L857-L860)、[normalize/claude.ts:104-116](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/normalize/claude.ts#L104-L116) | `ok === false` → `failed/needs-human`（并补 `tool.failed` 或直接按 `ok` 分支） |
| P2-4 | `agent:runNode` / `agent:verify` 接受 renderer 任意 `executor/workingDirectory/prompt`，无校验无 sender 校验 | **内部风险** | [ipc/agent.ts:30-34](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L30-L34)、[:151-175](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L151-L175)、[preload/index.ts:83-94](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L83-L94) | 加白名单执行器 + `workingDirectory` 必须属于已打开项目 + `senderFrame` 校验 |
| P2-5 | kernel 路径未限制 `settingSources`（仅 transparent 设为 `[]`）→ 仓库 `.claude/settings.json`/`.mcp.json` 会加载，项目级 allow 规则可能让**非写类工具/MCP 工具**绕过网关 | **推测**（需实测优先级） | [claude-code.ts:288-296](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L288-L296)、[:335-350](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L335-L350) | kernel 路径也传 `settingSources: []`，MCP servers 只从主进程白名单注入 |

### P3

| ID | 问题 | 类型 | 证据 | 最小修复 |
|---|---|---|---|---|
| P3-1 | `emitReclaimAudit` 用 run 级 seq 计算 `turn_seq` → 多轮 run 的 `turn_seq`/eventId 跳号 | 内部风险 | [runtime.ts:544-560](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L544-L560) | 用 `Math.max(...turn_seq)` |
| P3-2 | Claude 未记 `cache_creation_input_tokens`；`inputTokens > 0` 才上报（零输入 usage 整条丢） | 用户可见（成本偏低） | [claude-code.ts:423-436](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L423-L436) | 增加 cache 写字段与价格；去掉 `>0` 门，改为“有任意 usage 即报” |
| P3-3 | `canUseTool` 固定 `mode:'interactive'`，D-B 的 unattended 30s 路径不可达 | 内部风险 | [adapter-driver.ts:233-247](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts#L233-L247) | 由会话模式决定 `mode` |
| P3-4 | 启动对账在 `residualRisk:'possible'` 时也 `clearProc:true`，`recovery_kills` 只覆盖不累加 | 内部风险 | [runtime.ts:664](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L664)、[repository.ts:397](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L397) | 仅在 `residualRisk==='none'` 时清证据；kills 累加 |
| P3-5 | 缺索引：`agent_usage(session_id)`、`agent_turns(session_id)`；pending 审批查询需按 `created_at` 排序，现有部分索引前导列是 `turn_id` | 内部风险 | [schema.ts:268-283](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L268-L283)、[repository.ts:847-857](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L847-L857) | 补 `agent_usage(session_id, recorded_at)`、`agent_turns(session_id, created_at)`、`agent_approvals(status, created_at)` |
| P3-6 | 恢复只检查“最新一条 turn”，历史里更早的非终态 turn 不阻断 | 内部风险 | [agent-manager.ts:875-892](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L875-L892) | 改为“任一会话 turn 非终态即阻断” |
| P3-7 | 会话级授权粒度为“写类工具 + 目录”，不绑定具体文件/argsHash；grant 命中即覆盖任意 `Edit/MultiEdit` 目标 | 内部风险 | [gateway.ts:314-327](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L314-L327)、[:359-371](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L359-L371) | 产品语义确认；若要更严，grant 记“首次文件集合”而非目录 |
| P3-8 | hardlink / TOCTOU：工作区内 hardlink 指向外部 inode 时 `realpath` 仍判“内” | 内部风险 | [gateway.ts:130-146](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L130-L146) | 用 `lstat` 检 `nlink>1` 或拒绝非常规文件；TOCTOU 归入已知共性风险 |

---

## 三、原判为什么会错（防再犯）

| 原判 | 当初的依据 | 错在哪 | 以后怎么避免 |
|---|---|---|---|
| P0-1 会话授权可绕过 | 只看到 `sessionGrants` 是 `Map<sessionId, ...>`，推断“按会话放行所有工具/所有路径” | 没有继续读 `matchSessionGrant` 的三重条件；也没有注意 grant 只在校验 `decision==='allow' && scope==='session'` 时创建，且 `cwd` 来自宿主会话配置而非子进程 | 判定授权类缺陷必须三步都读到：**谁创建**、**命中条件**、**每次调用是否重算**；只读 Map 结构不足以定性 |
| P1 `--resume` 内部 id 污染 | 在 `restorePersistedSession` 里看到 `runtime_session_id` 被读取，且早期版本确实直接用它 | 修复后链路已改为：`backendSessionId` 只来自 `run.started.payload`，入口与三个适配器双重过滤；判断时读的是旧快照/上游文档 | 对“修过”的条目，必须同时看**生产端**（谁写入 native id）、**读取端**（恢复）、**消费端**（适配器下发前过滤）三段 |
| P1 恢复窗口 in-flight 未终态 | 只读了 `sendCommand → resolveKernelAdapter → restore` 的调用链，未读 restore 内部的 pending 守卫 | `restorePersistedSession` 已有显式非终态阻断，且启动 planner 先 orphan 再重放审批 | 判定“恢复会重放”前必须找到**终态检查点**与**启动对账顺序**；没有终端状态写入证据就不下结论 |
| F2 重启后同会话发送失败（文档方） | 早期 R1 前的行为 | R1 已加 native resume + 中文错误 + 下一次建新会话；r8 真机有截图与日志 | 以真机证据文件为准，不以旧待修清单为准 |
| F3 C13b symlink 抢占（文档方） | `verification-ledger.md:22` 写“修复中；未见最终结论” | 第 13 章已用 `writeFileNoFollow` 修复并复跑 6/6；ledger 条目未同步 | 修完即回写 ledger；复核以 spikes README 的复跑记录为准 |

---

## 四、我这次没能确认的部分

1. **Codex `input_tokens` 是否包含 `cached_input_tokens`**（决定复核表第 4 条是否真的是“缓存重复计费”）。
   - 仓库内只有 `@openai/codex-sdk` 的 d.ts，字段注释没有说明包含关系。
   - 验证方法：跑一次真实 Codex turn，记录 `usage.input_tokens / cached_input_tokens`；对比上游 Responses API 的 `usage.input_tokens_details.cached_tokens`（若存在且与 `cached_input_tokens` 相等，则 `input_tokens` 是总量）。或用同一 prompt 连跑两次（第二次命中缓存）：若 `input_tokens` 基本不变而只有 `cached_input_tokens` 上升，则 `input_tokens` **不含**缓存；若 `input_tokens` 随缓存上升而下降，则含。
2. **项目级 `.claude/settings.json` 的 `permissions.allow` 与程序化 `PreToolUse` hook 的优先级**（决定 P2-5 是否可绕过 MCP/非写类工具）。
   - 代码注释声称“PreToolUse 不受 allow 规则短路”（[claude-code.ts:336-340](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L336-L340)），但这是针对写类工具返回 `ask` 的路径；`mcp__*` 与其它非写工具返回 `{}`，没有实测。
   - 验证方法：在临时仓库放 `.claude/settings.json` 允许某个 MCP 写工具，kernel 路径下发一次调用，观察是否弹审批；再放一个项目级 `PreToolUse` hook 观察是否与内置 hook 合并/覆盖。
3. **hook 抛异常时的失败取向**（`onBashPolicy`/`onPreToolUse`/`canUseTool` 内 `context.record` 抛错会不会导致命令放行或被中止）。
   - 代码没有 try/fail-closed 包装（[adapter-driver.ts:233-286](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts#L233-L286)）。
   - 验证方法：在 hook 内注入抛错（临时构建，不改仓库源码），观察 SDK 对该工具的处理是 deny 还是 continue。
4. **`U14` 之后的多窗口场景**：`agent:resolveApproval` 跨会话批准在单窗口下不可达；双开窗口是否共享同一 renderer 信任域、是否都能列出全部 pending，未做运行时验证（代码层已确认无校验）。
5. **`agent_events` 实际增长速率**：没有生产库样本，未量化“多久会到 GB 级”。可用现有 DB 统计 `COUNT(*)`、`AVG(length(payload_json))` 估算；本次未执行（只读审查未触碰用户库）。

---

# 终审（冻结基线）

> 本轮目标：在**冻结快照**上给出最终判定，避免上一轮“边改边审”导致的结论漂移。全程只读，未改源码、未 commit。

## 0. 冻结信息

### 0.1 采集方式

```bash
git rev-parse HEAD
git status --porcelain
shasum -a 256 <被审文件清单>
```

基线落盘于 `/tmp/agent-audit-freeze.txt`（99 行 = HEAD 1 行 + 分隔符 1 行 + status 76 行 + 分隔符 1 行 + 20 个文件 hash）。审计开始、写入本报告前、写入本报告后各采集一次，用 `diff` 比对。

### 0.2 HEAD

```
2c0045377e819853efefcca6284a42377fced86d
```

### 0.3 被审文件 shasum（开始时 = 结束时，逐字节一致）

```
1c2407bef6b22e3d14e6a877fee74dbe9d1b1fcee3fe18be71580db82a9c83f3  src/main/agent/runtime/approval/gateway.ts
7264fa24e05363802add47f7e2bf6ae8831f66dab43276ff907e569c82b1a687  src/main/agent/runtime/approval/bash-readonly.ts
c5e85203054793f94cec0cf7bd3fb034a4387d212ba3747222d3947b1e389676  src/main/agent/runtime/runtime.ts
40240cbfed403abea95386825789bb20c676eb968613a31baf0edbc672f0fd25  src/main/agent/runtime/db/repository.ts
b1188aa6f4508855a3f7ea5dea454d7195fa2a16abbb46919ffb708dc3644666  src/main/agent/runtime/db/schema.ts
f7d2ec2d8412ca932cc8ae398a2d029cd936eae3d85525b30cd05704d20f3dfd  src/main/agent/agent-manager.ts
c8c58f5a681b9fca6ec2cba7dd28302af82c0fb5b96cc3afad3c3c8172a2132c  src/main/agent/session-lifecycle-manager.ts
98d705ed19f7dd90e2488563a69cb83972cc45d4b8071194500d1c8e75b8cf3f  src/main/ipc/agent.ts
42c551c925fa367e5e2ea1fcc41f6cd4d0917fefa32bf2cc49467ba8275222f5  src/main/adapters/claude-code.ts
ac89f6b7cc0e45bd61481b2799251442acd09eb5c1e50eaba963cda802431dd1  src/main/adapters/codex.ts
56711bc8cb981303ea326f7f9cfb35a8609fb9ea53956ef6a407efa124174ddc  src/main/adapters/cursor.ts
6006d144d22674d63715560fd3405af7028e62fc5f4e60e2de68b0d8d390251c  src/main/adapters/opencode.ts
06868856d1a70ffdd01f25e403a3ebc7f10d17e578875e64dfc63343bf8f05ba  src/shared/native-session-id.ts
8fa6cab0460cb64e1bb212302e816bdb799a1b10c8e789bfc12ac3045e0c68b1  src/main/agent/runtime/cost/ledger.ts
e692cfb1bf8fb41548546a6722b8281fed31159cb396249d09226994b5ca13e3  src/main/agent/runtime/cost/pricing.ts
aac6119361eec381bdacdd10c77964f5767c0d6820fb77597aced40a7a785b9c  src/main/agent/runtime/executors/adapter-driver.ts
984913731f557e71ef18155c4f3237a737aa426240c65e3201d0db4e1192c932  src/main/shared/redaction.ts
04d814893a8ffabbc4c1bbf3f3bb3538b7deabeaa80c63642ad3eb0cc0b36e84  src/main/shared/logger.ts
edd2eb926a2ab17946c6aee3dea137ae82e148bca5c9451ebf7780e811075ce0  src/main/agent/runtime/recovery/planner.ts
cac6258a9cade59a161e82d97e71d13d397f5bc16a2857437eafada804175676  src/main/agent/runtime/locks/session-lock.ts
```

> 另有 3 个文件在取证时读过但未纳入冻结清单：`src/main/index.ts`（`git status` 未修改，且工作区 hash 与 `git show HEAD:` 完全相同 = `240db2b3…c29c8e`，可视为稳定）、`src/main/ipc-handlers.ts`（`b906d64d…1edea210`）、`src/main/repositories/agent-log-repository.ts`（`9f7d0cf4…2ecb5d1e9`）。后两者在冻结时已是 M 状态且未记录 hash，凡依赖它们的结论一律进“未确认”，不参与 P 级排序。

### 0.4 工作区状态（`git status --porcelain` 全量，76 行）

```
 M src/main/__tests__/agent-log-repository.test.ts
 M src/main/__tests__/agent-manager.test.ts
 M src/main/__tests__/chat-service.test.ts
 M src/main/__tests__/claude-code.test.ts
 M src/main/__tests__/codex.test.ts
 M src/main/__tests__/settings.test.ts
 M src/main/adapters/base.ts
 M src/main/adapters/claude-code.ts
 M src/main/adapters/codex.ts
 M src/main/adapters/cursor.ts
 M src/main/adapters/mcp-adapter.ts
 M src/main/adapters/opencode.ts
 M src/main/agent/__tests__/session-lifecycle-manager.test.ts
 M src/main/agent/agent-manager.ts
 M src/main/agent/session-lifecycle-manager.ts
 M src/main/agent/types.ts
 M src/main/database.ts
 M src/main/errors.ts
 M src/main/ipc-handlers.ts
 M src/main/ipc/agent.ts
 M src/main/ipc/utils.ts
 M src/main/repositories/agent-log-repository.ts
 M src/main/repositories/chat-repository.ts
 M src/main/settings.ts
 M src/main/shared/__tests__/logger.test.ts
 M src/main/shared/logger.ts
 M src/preload/index.ts
 M src/renderer/components/agent/AgentChatPanel.tsx
 M src/renderer/components/agent/ChatHeader.tsx
 M src/renderer/components/agent/ConfirmationDialog.tsx
 M src/renderer/components/agent/TerminalView.tsx
 M src/renderer/panels/FileTreeContextMenu.tsx
 M src/renderer/store/agentStore.ts
 M src/renderer/store/sessionStore.ts
 M src/shared/i18n/resources/domains/agent.ts
 M src/shared/types.ts
 M src/shared/types/agent.ts
 M src/shared/types/ipc.ts
 M vite.config.ts
?? AGENT_ARCHITECTURE_DESIGN.md
?? AI_AGENT_ARCHAEOLOGY.md
?? docs/architecture/agent-architecture.md
?? docs/architecture/agent-audit-2026-11-05.md
?? docs/architecture/agent-consistency-audit-2026-11-05.md
?? docs/architecture/agent-decisions.md
?? docs/architecture/agent-m0-report.md
?? docs/architecture/agent-m0-verification.md
?? docs/architecture/agent-realdevice-verification.md
?? docs/architecture/agent-rollout.md
?? docs/architecture/agent-system-design-review.md
?? docs/architecture/agent-system-design.md
?? docs/architecture/evidence/
?? docs/architecture/verification-ledger.md
?? spikes/
?? src/main/__tests__/agent-manager-restore.test.ts
?? src/main/adapters/__tests__/synthetic-file-evidence.test.ts
?? src/main/agent/runtime/
?? src/main/shared/process-supervisor.ts
?? src/main/shared/redaction.ts
?? src/preload/__tests__/
?? src/renderer/components/agent/ApprovalRequestDialog.tsx
?? src/renderer/components/agent/FileChangeEvidenceCard.tsx
?? src/renderer/components/agent/UsagePanel.tsx
?? src/renderer/components/agent/__tests__/
?? src/renderer/components/agent/approvalCountdown.ts
?? src/renderer/components/agent/sessionRefresh.ts
?? src/renderer/components/agent/usageFormat.ts
?? src/renderer/lib/__tests__/ipcResult.test.ts
?? src/renderer/lib/ipcResult.ts
?? src/shared/__tests__/agent-error-text.test.ts
?? src/shared/__tests__/ipc-error.test.ts
?? src/shared/__tests__/native-session-id.test.ts
?? src/shared/agent-error-text.ts
?? src/shared/ipc-error.ts
?? src/shared/native-session-id.ts
?? src/shared/types/agent-runtime.ts
```

### 0.5 冻结结论

- HEAD：开始时 `2c004537…` = 结束时 `2c004537…`。
- status：两次输出逐行相同（仅基线文件末尾多一行分隔符 `---`，非内容差异）。
- 20 个被审文件：`diff` 为空，`HASH_IDENTICAL`。
- **无基线漂移**，下面结论均针对该快照。

---

## 1. 收敛清单（只保留能给出最小复现的问题）

排序：P0 → P3。**没有 P0**。每条包含：原文片段（3–15 行）+ 文件/函数 + 最小复现。

### P1-1｜“允许本会话”把一次 Bash 批准升级为工作区写授权

**文件/函数**：`src/main/agent/runtime/approval/gateway.ts` → `ApprovalGateway.decide`

```ts
    // 「允许本次会话」：建立内存授权；来源即本次 approval id，供后续自动放行审计。
    // 只有能定位 session 且知道工作目录时才建立，否则退化为「仅本次」。
    if (input.decision === 'allow' && input.scope === 'session' && updated.status === 'allowed') {
      const turn = this.repo.getTurn(updated.turn_id)
      const sessionId = turn?.session_id
      if (sessionId && updated.cwd) {
        this.sessionGrants.set(sessionId, {
          sessionId,
          approvalId: updated.id,
          grantedAt: this.now(),
          toolScope: 'write',
          cwd: updated.cwd,
        })
```

创建授权时**没有校验本次被批准的工具本身是否写类工具**（`isWriteScopedTool(updated.tool_name)` 只在命中时校验，创建时没校验）。而 UI 对任何工具都渲染“允许本会话”按钮：

```tsx
              <button
                disabled={busy[payload.approvalId]}
                onClick={() => void resolve(payload, 'allow', 'session')}
                className="px-3 py-1 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {t('agent.approval.allowSession')}
              </button>
```

**后果**：用户只批准了一条 Bash 命令（例如 `npm test`），点“允许本会话”后，同一会话内任意 `Write/Edit` 只要落在 `updated.cwd` 内就**不再弹卡片**。人审闸门被一次与写操作无关的批准静默打开。

**最小复现**（单测，不碰真实文件系统）：

```ts
const gw = new ApprovalGateway({ db, repo })
const a = await gw.request({ sessionId: 's1', turnId: 't1', toolName: 'Bash', args: { command: 'npm test' }, cwd: '/ws' })
gw.decide({ approvalId: a.approvalId, decision: 'allow', scope: 'session', argsHash: hashArgs('Bash', { command: 'npm test' }) })
const w = await gw.request({ sessionId: 's1', turnId: 't2', toolName: 'Write', args: { file_path: '/ws/src/x.ts' }, cwd: '/ws' })
// 断言：w 直接 allowed（没有 pending），而用户从未批准任何写操作
```

### P1-2｜同一 turn 的用量被 legacy 与 kernel 各记一行（成本约 2x）

**文件/函数**：`src/main/agent/session-lifecycle-manager.ts` → `attachAdapter`（usage handler）

```ts
    // ---- Usage handler: 透传给 AgentManager 的成本账本（M1） ----
    // 仅当适配器实现了 onUsage 才登记，避免 detach 时对无能力的适配器空调用
    if (adapter.onUsage) {
      const usageHandler = (data: AdapterUsageReport) => {
        if (data.source !== 'unknown') this.usageSeen.add(data.sessionId)
        const turnSeq = this.turnSeq.get(data.sessionId) ?? 0
        // legacy 无 turn id：用 session 内轮次序号构造 turn 级幂等键，
        // 同一 turn 的重复上报不会重复计费。
        this.callbacks.onAdapterUsage?.(adapter.name, {
          ...data,
          turnKey: data.turnKey ?? `${adapter.name}:${data.sessionId}:${turnSeq}`,
        })
      }
```

**文件/函数**：`src/main/agent/runtime/runtime.ts` → `AgentRuntime.recordUsage`

```ts
  private recordUsage(
    turn: AgentTurnRow,
    sessionId: string,
    request: RunNodeRequest,
    usage: DriverUsage,
  ): void {
    this.usageLedger.record({
      turnId: turn.id,
      sessionId,
      executor: request.executor,
      graphId: request.graphId,
      nodeId: request.nodeId,
      model: usage.model ?? null,
```

两处写入的 dedupe key 形状不同：`agent-manager.ts` 的 `recordAdapterUsage` 走 `legacy:${data.turnKey}`，runtime 走 `turn:${turn.id}`；`ux_agent_usage_dedupe` 是**按 key 值**的唯一索引，合并不了。kernel 路径下适配器实例没被替换，`onUsage` 仍经 lifecycle 上报，且 `AdapterUsageReport` 没有 `backendEventId`（Claude 侧未提供），所以必落 `legacy:` 行。

**最小复现**：kernel 开启（默认对 claude 生效），跑一个 turn，然后

```sql
SELECT dedupe_key, input_tokens, output_tokens FROM agent_usage WHERE session_id = ?;
-- 期望 1 行；实际 2 行：legacy:claude-code:<sid>:0 与 turn:<turnId>
```

### P1-3｜`git grep -O<pager>` 的“贴写”形式未被危险参数表覆盖

**文件/函数**：`src/main/agent/runtime/approval/bash-readonly.ts` → `dangerousArgOf`

```ts
function dangerousArgOf(
  args: string[],
  specs: readonly DangerousArgSpec[],
): { spec: DangerousArgSpec; arg: string } | null {
  for (const arg of args) {
    const flagName = arg.split('=')[0]
    for (const spec of specs) {
      if (arg === spec.flag || flagName === spec.flag) return { spec, arg }
    }
  }
  return null
}
```

`spec.flag` 是 `'-O'`，而 `git grep -Ocat` 的 `flagName` 仍然是 `-Ocat`（没有 `=`），永远不相等。于是：

```ts
  git: [
    { flag: '--output', rule: 'git-output-file', reason: 'git --output=<file> 会写文件', risk: HIGH },
    ...
    { flag: '-O', rule: 'git-grep-pager', reason: 'git grep -O 会把文件交给外部 pager 执行', risk: CRITICAL },
    { flag: '--open-files-in-pager', rule: 'git-grep-pager', reason: 'git grep --open-files-in-pager 会执行外部 pager', risk: CRITICAL },
```

**后果**：`git grep -Osh <pattern>` / `-Ocat` 被判为只读白名单，零审批执行。`sh` 会把匹配到的文件当脚本执行。

**最小复现**（已在本机实测 git 接受贴写形式）：

```bash
git grep -Ocat -e '"name"' -- package.json   # exit 0，cat 作为 pager 打印整文件
# 策略层：
evaluateBashPolicy('git grep -Osh -e x -- .')  // => { decision: 'allow' }
```

对照：`rg --pre`、`git diff --output=`、`git grep -O`（空格分隔）、`git fsck --lost-found`、`git branch <name>` 均已被正确判为 `ask`（见 §2 判定表）。

### P2-1｜事件保留删掉 `run.started` 后，原生续接锚点消失

**文件/函数**：`src/main/agent/runtime/db/repository.ts` → `AgentRepository.getLatestBackendSessionId`

```ts
  getLatestBackendSessionId(sessionId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT e.payload_json AS payloadJson
           FROM agent_events e
           JOIN agent_turns t ON t.id = e.turn_id
          WHERE t.session_id = ? AND e.type = 'run.started'
          ORDER BY e.created_at DESC, e.seq DESC
          LIMIT 1`,
      )
      .get(sessionId) as { payloadJson: string } | undefined
```

**文件/函数**：`AgentRepository.runEventRetention`（删除动作）

```ts
      const deleteIds = (ids: string[]): void => {
        const idPlaceholders = ids.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM agent_events WHERE id IN (${idPlaceholders})`).run(...ids)
      }
```

`run.started` 属于 turn 级事件，随 turn 一起被删；恢复时 `restorePersistedSession` 只认这个锚点：

```ts
    const recordedNativeId = repo.getLatestBackendSessionId(sessionId)
```

**最小复现**：`retentionDays=1`，写入一个 completed turn + `run.started`（`backendSessionId='abc123'`），`created_at = now - 2d`，调用 `runEventRetention({retentionDays:1}, now)`；再调 `getLatestBackendSessionId` 得 `null`，`restorePersistedSession` 抛“没有找到可续接的底层会话 id（首轮可能未完成）”。默认 90 天，但一旦命中就会永久丢失续接能力（下一轮可新建会话，但上下文断裂）。

**加重项**：`retention_hold` 是为此设计的保护位，但生产代码**从未写入**（见 P3-3），所以等于没有保护。

### P2-2｜kernel 派发缺 `runId/graphId/attempt`：幂等键跨会话复用时静默不执行 / 图归属为空

**文件/函数**：`src/main/agent/runtime/runtime.ts` → `AgentRuntime.runNode`

```ts
  async runNode(request: RunNodeRequest): Promise<TurnOutcome> {
    const branchKey = request.branchKey ?? ''
    const attempt = request.attempt ?? 1
    const resumeMode = request.resumeMode ?? 'native'
    const idempotencyKey =
      request.idempotencyKey ?? `${request.runId ?? 'new'}:${request.nodeId}:${branchKey}:${attempt}:${hashArgs('prompt', { prompt: request.prompt })}`

    const existing = this.repo.findTurnByIdempotencyKey(idempotencyKey)
    if (existing) {
      if (!TERMINAL.includes(existing.status)) {
        throw new SessionBusyError(`turn:${existing.id}`)
      }
      return this.outcomeFromTurn(existing, true)
    }
```

**文件/函数**：`src/main/agent/agent-manager.ts` → `AgentManager.sendCommandThroughKernel`

```ts
          await this.runtime!.runNode({
            agentSessionId: sessionId,
            adapterSessionId: sessionId,
            executor: adapter.name,
            prompt: command.description,
            commandType,
            workingDirectory: state?.config.workingDirectory ?? process.cwd(),
            nodeId,
            threadId: state?.threadId,
          })
```

派发没有 `runId`、`graphId`、`attempt`，于是 key 固定为 `new:<nodeId>:<branch>:1:<hash(prompt)>`；`findTurnByIdempotencyKey` 又**不带 session 过滤**：

```ts
  findTurnByIdempotencyKey(key: string): AgentTurnRow | null {
    return (this.db.prepare('SELECT * FROM agent_turns WHERE idempotency_key = ?').get(key) as AgentTurnRow | undefined) ?? null
  }
```

**最小复现**：

1. 同一会话、同一 node，连续发两次完全相同的 prompt：第二次直接 `return outcomeFromTurn(existing, true)`，后端进程根本没有被调用（对 driver 的 `execute` 计数断言 = 1 次）。
2. 两个会话对同一 `targetNodeId` 发同一 prompt：第二个会话复用第一个会话的 turn（`findTurnByIdempotencyKey` 无 session 过滤），拿到别人的结果。
3. 同时 `recordUsage` 里 `graphId: request.graphId` 为 `undefined` → `agent_usage.graph_id = NULL`，图/日成本归因缺失。

### P2-3｜`resolveApproval` 只校验 approvalId+argsHash，没有会话/发起方归属

**文件/函数**：`src/main/ipc/agent.ts` → `agent:resolveApproval`

```ts
    typedHandle('agent:resolveApproval', async (_, input) => {
      if (!input || typeof input.approvalId !== 'string' || (input.decision !== 'allow' && input.decision !== 'deny') || typeof input.argsHash !== 'string') {
        throw new IpcError('resolveApproval requires approvalId, decision, argsHash', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      if (input.scope !== undefined && (input.scope !== 'once' && input.scope !== 'session')) {
        throw new IpcError('scope must be once or session', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      const outcome = runtime.approvals.decide(input)
```

`decide` 侧同样只查 hash 与状态：

```ts
  decide(input: ApprovalDecisionInput): ApprovalOutcome {
    const row = this.repo.getApproval(input.approvalId)
    if (!row) {
      throw new AgentRuntimeError('APPROVAL_NOT_FOUND', `Approval not found: ${input.approvalId}`)
    }
    if (input.argsHash !== row.args_hash) {
      throw new AgentRuntimeError(
        'APPROVAL_ARGS_MISMATCH',
        `APPROVAL_ARGS_MISMATCH: args changed after request: ${input.approvalId}`,
      )
    }
    if (row.status !== 'pending') {
```

**最小复现**：窗口 A 的会话 s1 与窗口 B 的会话 s2 各挂一条 pending。在 B 调 `agent:getPendingApprovals()`（返回**全部** pending，含 s1 的 `approvalId/argsHash`），再调 `agent:resolveApproval({approvalId: s1, decision:'allow', argsHash: s1hash})` → 允许成功。归属（session/turn/sender）从未参与判定。单窗口下多个会话同样成立。

### P3（可复现，但影响有限）

| # | 问题 | 原文位置 | 最小复现 |
|---|---|---|---|
| P3-1 | Claude 少记 `cache_creation_input_tokens`，且 `inputTokens > 0` 才上报导致 0 输入轮次的缓存量丢失 | `claude-code.ts` `handleMessage`（`message.type==='result'` 分支） | 构造 `usage={input_tokens:0, cache_read_input_tokens:100, cache_creation_input_tokens:50}` → 不触发 `reportUsage`；lifecycle 合成 `unknown` 行，缓存 token 全丢 |
| P3-2 | 保留策略自身事件永不被清理（`turn_id` 无对应 turn → `irreconcilable` 跳过） | `runtime.ts` `writeRetentionEvent` + `repository.ts` `runEventRetention` | 连跑两次 `runEventRetentionNow()` → `retention.cleanup` 事件 +2，且第二次仍跳过自身 |
| P3-3 | `retention_hold` 是“配置了但从不生效”的保护位：生产无写入方 | `repository.ts` `setRetentionHold`（仅测试引用） | `rg "setRetentionHold" src/main` → 只有定义 + 测试，无生产调用 |
| P3-4 | `sweepExpired` 无生产调用方（依赖 per-approval timer；timer `unref`，休眠/时钟漂移时到期回收会晚到） | `gateway.ts` `sweepExpired` | `rg "sweepExpired" src/` → 只有定义 + 测试 |
| P3-5 | `keep_pending_approval` / `replayPending` 实际是死路径，planner 注释与运行时行为相反 | `planner.ts`（`'pending approvals survive restart and are re-emitted'`）vs `runtime.ts` `reconcileStartup` | 造一条重启前 pending：重启后 `plans` 含 `keep_pending_approval`，但 `reconcileStartup().replayed.length === 0`、审批被 `deny`（行为本身是刻意安全选择，注释是错的） |
| P3-6 | 无 `render-process-gone` 兜底：renderer 崩溃后窗口空白，macOS 上应用不退出也不自愈；同时也没有“主进程反复崩溃”的退避/熔断——因为本就没有自动重启，退出即终止 | `src/main/index.ts`（该文件 = HEAD，可信） | dev 下 `webContents.forcefullyCrashRenderer()` → 窗口空白，无 reload/重建 |

> 说明：用户要求的“崩溃循环退避/熔断”，结论是**当前不存在崩溃循环的放大机制**（主进程崩溃 = 进程结束，无自动重启），因此不需要退避；缺的是 renderer 崩溃后的窗口自愈（P3）。

---

## 2. “已修复”判定表（逐条验证）

### 2.1 用户指定的 5 项

| # | 项 | 最终判定 | 依据（原文/实测） | 残留 |
|---|---|---|---|---|
| 1 | 会话级授权 `matchSessionGrant` 每次调用重校验 | **已修复（命中侧）** | 每次 `request()` 都调 `matchSessionGrant`：`isSessionAlive`（DB 状态 ∈ `LIVE_SESSION_STATUSES`）、`isWriteScopedTool`、`targets.every(t => isPathInside(grant.cwd, t))`、`revokedGrants` 墓碑。多路径用 `every`（任一越界整体回审批）；symlink 用 `resolveRealPath` 逐次 realpath、不缓存；会话关闭 `endSession` 写 `'session-ended'` 墓碑 → 三场景都会重新 ask | **创建侧有 P1-1**：非写类工具（Bash）的 session 批准也能建 `toolScope:'write'` 授权 |
| 2 | `runEventRetention` 只删超期且终态、无待审批、无 holds 的 turn 的事件 | **已修复（删除范围）** | 逐条守卫齐全：`TERMINAL_TURN_STATUSES`、`retention_hold===1`、`hasPendingApproval`、`hasUnsettledStep`；`DELETE` 仅一处且只针对 `agent_events`。全仓 `DELETE FROM agent_` 仅命中 `agent_events`（另有 `agent_logs` 的独立清理，不属于该策略）→ `agent_usage/approvals/turns/sessions` 永不删 | P2-1（删掉 resume 锚点）、P3-2（自身事件不清理）、P3-3（hold 从未写入） |
| 3 | Bash 白名单与 `DANGEROUS_ARGS_BY_COMMAND` 双向相等；5 条命令变 ask | **部分修复** | 双向相等成立：`WHITELIST` 20 个 key，危险参数表 20 个 key 一一对应，且有 `WHITELIST_COMMANDS = Object.keys(WHITELIST)` + 覆盖测试兜底。逐条实测：`rg --pre` ✓ ask、`git diff --output=` ✓ ask（`flagName` 命中 `--output`）、`git grep -O`（空格）✓ ask、`git fsck --lost-found` ✓ ask、`git branch <name>` ✓ ask（`branchRule` 位置参数即创建） | **P1-3**：`git grep -O<pager>` 贴写形式未覆盖 |
| 4 | 脱敏覆盖面 | **已修复（4 个指定面）** | `agent_events.payload_json`：`appendEvents` 落库前 `redactPayload`（只改落库副本）；`agent_approvals.args_json`：`insertApproval` 用 `redactArgsJson`，且 `args_hash` 由 `request()` 对**原文**计算后原样落库；`agent_logs`：`command/outputs` 过 `redactUnknown`；主进程 logger：所有参数过 `redactLogArg`。实时卡片/`onEvent` 拿原文（落库才脱敏） | `agent_logs.result` 仍是原样写入（文件未冻结 → 未确认）；脱敏只覆盖 8 类可识别模式 |
| 5a | legacy+kernel 双记用量 | **未修复** | 见 P1-2：`onUsage` 在 kernel 路径同样注册；`legacy:` 与 `turn:` 两个 dedupe key 不同；Claude 上报不带 `backendEventId` | — |
| 5b | token 缓存口径 | **部分修复 / 未确认** | Claude：`cachedInputTokens` 只取 `cache_read_input_tokens`，未取 `cache_creation_input_tokens`；计价 `costMicrosOf` 三项直接相加。Codex：`input_tokens` 与 `cached_input_tokens` 同时上报，但仓库内无法证明前者是否含后者（见 §4） | P3-1（Claude 少记）；Codex 是否重复计费仍未确认 |
| 5c | `resolveApproval` 归属校验 | **未修复** | 见 P2-3：IPC 与 `decide` 均只校验 approvalId+argsHash+status | — |
| 5d | `--resume` 内部 id | **已修复** | 恢复只读 `run.started.payload.backendSessionId`；`isTrustedNativeSessionId` 在 `claude-code.ts`、`codex.ts`、`cursor.ts` 下发前二次过滤；内部 id（`claude-<uuid>` / `sess_`）被拒绝并给出明确错误 | 无 |

### 2.2 额外扫查面

| 面 | 结论 | 复现/依据 |
|---|---|---|
| 多窗口同一 session 发命令 | **安全（符合既定 fail-fast）** | 第二个 `runNode` 在 `SessionLockRegistry.acquire` 抛 `SessionBusyError`（M0 明确不排队）；不会并发写同一会话 |
| 多窗口批准同一审批 | **安全（幂等）** | 第二次 `decide` 命中 `row.status !== 'pending'` → `outcomeFromRow` 返回既有结果，不重复执行、不重复发事件 |
| `bash.policy` 与 approval 多 turn 复用对齐 | **对齐** | `bashPolicyForTool` / `evaluateBashPolicy` 是纯函数（同 args 同结果）；approval 行绑 `args_hash`；session grant 明确排除 Bash/网络类，不会跨 turn 扩大；命中 grant 时 `policyDecision` 落 `allow` 并写 `grantSource` 可追溯 |
| 保留策略 vs `stepOutcomes` 对账 | **对账本身安全** | `hasUnsettledStep` 拒绝删除仍有 `requested/awaiting_approval/approved/running/unknown` 的 turn；`stepOutcomes` 来自 `agent_steps`，不读事件。**但** resume 锚点在 `agent_events` 里 → P2-1 |
| “配置了但从不生效”的同类字段 | **仅发现 `retention_hold`（P3-3）** | `mergeSettings` 已把 `agentRuntime` 整体透传（`costRates`/`retention` 均已接线并在 `ipc-handlers.ts` 消费）；`retention.enabled` 在 `startEventRetention` 生效。agentRuntime 配置面未发现第二处漏接线。`sweepExpired`/`replayPending` 属死代码（P3-4/5），不是配置字段 |

---

## 3. 基线漂移 / 未确认

### 3.1 基线漂移

**无。** HEAD、status、20 个文件 hash 三次采集一致（见 §0.5）。

### 3.2 未确认（按用户规则，不给 P 级）

1. **Codex `input_tokens` 是否包含 `cached_input_tokens`**：`extractUsage` 把两者并列上报，`costMicrosOf` 直接相加。若 `input_tokens` 是总量（OpenAI Responses 的常见口径），则缓存被重复计价；若不含，则计价正确。仓库内 d.ts 无字段语义，未实测 → 降级“未确认”。
2. **`agent_logs.result` 是否泄漏敏感内容**：`agent-log-repository.ts` 的 INSERT 只对 `command`/`outputs` 脱敏，`result` 原样写入。但该文件**不在冻结清单**（冻结时已是 M 且未记 hash），无法证明审计期间未被改写 → 降级“未确认”；若需定论，重新冻结该文件后复读第 21–31 行。
3. **`ipc-handlers.ts` 的实际启动顺序**（`reconcileOnStartup` → `finally` → `startEventRetention`）：同一原因（文件未冻结）→ 只作为行为背景，不作判定依据。
4. **项目级 `.claude/settings.json` 的 `permissions.allow` 与程序化 `PreToolUse` 的优先级**（是否能让非写工具绕过 kernel 审批）：沿用复核轮的未确认，未做真机实验。

### 3.3 明确降级、不进收敛清单的观察

- **窗口重载后的“待审批卡片”**：`ApprovalRequestDialog` 挂载时会 `agent:getPendingApprovals()` 重新拉取并展示，用户仍能看到（脱敏后的）命令并决定。上一轮“盲批”表述过强，降级为观察项；唯一真实副作用是 `argsRedacted` 时不再展示 `policyRule`（`listPendingPayloads` 对脱敏参数刻意不重算策略），属可接受的防误导设计。
- **`agent_approvals` 跨会话列出**：`getPendingApprovals` 返回全部 pending。单用户桌面下是产品选择；与 P2-3 合并看待（缺少归属校验才是问题）。

---

## 4. 发布判定

**不可发布给真实用户。**

唯一必要条件（修完这一条即可解除阻断）：**会话级授权的创建必须与“被批准的工具”绑定**——只有 `isWriteScopedTool(approved.tool_name)` 为真时才允许落 `toolScope:'write'` 的 session grant；对 Bash/网络/其它非写工具的“允许本会话”，只能退化为“仅本次”或直接不提供该按钮。否则“用户批准了一条命令”会被静默解释为“用户批准了本会话内所有工作区写入”，写前人工审批的核心保证不成立。

其余 P1/P2（双记用量、`-O<pager>` 绕过、保留删 resume 锚点、幂等键跨会话复用、审批无归属校验）应在发布前修复，但它们不单独否定“可发布”——它们要么影响成本准确性，要么需要特定输入/时序，要么是纵深防御。

---

# 修复复核（第三次冻结）

> 目的：对“终审清单”的修复做一次冻结基线复核。只读，不改源码、不 commit。每条结论附原文片段与最小复现；无法静态复现的明确标注“需运行时验证”。

## 0. 冻结信息与漂移

### 0.1 HEAD 与工作区

```
HEAD = 2c0045377e819853efefcca6284a42377fced86d
git status --porcelain = 78 行
```

相对上一轮终审的 76 行，只新增 2 个**测试文件**的 `M`（`src/main/adapters/__tests__/claude-code-compact.test.ts`、`src/main/ipc/__tests__/agent.test.ts`），源码文件集合不变。

### 0.2 被审文件 shasum（开始时 = 写报告前，逐字节一致）

```
05d0d7eb48dce8031ab4bfa307634fcf4828acaca9d00de0c1170456dd399b18  src/main/agent/runtime/approval/gateway.ts
039a5e125f4fcfbc76fb5815384ba16991c1773245b24f69df81223f7420844e  src/main/agent/runtime/approval/bash-readonly.ts
810b82aa4444e04936b03ae69d99f2829d3fe9ac3b82177edcb4379f98c5b7b7  src/main/agent/runtime/runtime.ts
70e5ceb1fff015595dc58219fec321cb094de3cb1fd747ebf6c5010640fd5a06  src/main/agent/runtime/db/repository.ts
b6f5bd073dc0db3722fd66da0e99d8719ff365d5d7270f381f2f023e5df2e990  src/main/agent/runtime/db/schema.ts
84637def2907060c1c8f5dfee7b7d271b74392d716cfa8fc89ae77594ee46445  src/main/agent/agent-manager.ts
c8c58f5a681b9fca6ec2cba7dd28302af82c0fb5b96cc3afad3c3c8172a2132c  src/main/agent/session-lifecycle-manager.ts
f09a140646cfd33b153cb8d734a23a337b6bbd29a7f916a4d5be96cec70d7415  src/main/ipc/agent.ts
0d1e221d78d69b12d71f907bf1d2edde7f7ff2d1ead5503b1f5c197e09288035  src/main/adapters/claude-code.ts
ac89f6b7cc0e45bd61481b2799251442acd09eb5c1e50eaba963cda802431dd1  src/main/adapters/codex.ts
56711bc8cb981303ea326f7f9cfb35a8609fb9ea53956ef6a407efa124174ddc  src/main/adapters/cursor.ts
6006d144d22674d63715560fd3405af7028e62fc5f4e60e2de68b0d8d390251c  src/main/adapters/opencode.ts
06868856d1a70ffdd01f25e403a3ebc7f10d17e578875e64dfc63343bf8f05ba  src/shared/native-session-id.ts
8588636b7eb82e12d6eca47b058310ed86047b6f99f3c0eb808c44c974e7d04d  src/main/agent/runtime/cost/ledger.ts
2dfdef56b1f34967718af52adc1a43664b8833b6beac438058f55703596b9bef  src/main/agent/runtime/cost/pricing.ts
4c3c46d92d57cf8e7762d6939c4f4df8fd378c144f167f1dc73718203d2908c9  src/main/agent/runtime/executors/adapter-driver.ts
984913731f557e71ef18155c4f3237a737aa426240c65e3201d0db4e1192c932  src/main/shared/redaction.ts
04d814893a8ffabbc4c1bbf3f3bb3538b7deabeaa80c63642ad3eb0cc0b36e84  src/main/shared/logger.ts
edd2eb926a2ab17946c6aee3dea137ae82e148bca5c9451ebf7780e811075ce0  src/main/agent/runtime/recovery/planner.ts
cac6258a9cade59a161e82d97e71d13d397f5bc16a2857437eafada804175676  src/main/agent/runtime/locks/session-lock.ts
b906d64d5fe651049de821975b70f4de22a6fed8865241fc920ea7671edea210  src/main/ipc-handlers.ts
3c3c3bad974ad4007fa66587933d6e52246f8fc09950df016e007bf833ae059e  src/main/settings.ts
2263c463fee5fd4ae892c480a9321d0828cfdb36567b2ebef29a659fd7194ade  src/shared/types/agent-runtime.ts
ff66db67fab0925abce332f55f09252eb326da3d0f8381538405d4c39bf476b6  src/main/errors.ts
b5ca3d254e60a9515991c60be703aded98223767c213de109e3880e5bbaf72dd  src/preload/index.ts
9c0015ef451f59930fcb79f5feb7c07874d991ed9dcd175a59699c359937acc7  src/renderer/components/agent/ApprovalRequestDialog.tsx
```

### 0.3 相对上一轮发生改动的文件

`gateway.ts`、`bash-readonly.ts`、`runtime.ts`、`repository.ts`、`schema.ts`、`agent-manager.ts`、`ipc/agent.ts`、`claude-code.ts`、`ledger.ts`、`pricing.ts`、`adapter-driver.ts`（共 11 个）。其余 9 个（含 `session-lifecycle-manager.ts`、`planner.ts`、`redaction.ts`、`logger.ts`、`session-lock.ts`）未变。

### 0.4 漂移结论

**无漂移。** 开始与写报告前两次采集的 26 个文件 hash 全部相同；HEAD 未变；status 仅新增 2 个测试文件的 M。

---

## 1. 8 项判定

### ① 阻断项：非写类工具的「允许本会话」→ **确认修复**

**文件/函数**：`gateway.ts` → `ApprovalGateway.decide`

```ts
    if (
      input.decision === 'allow' &&
      input.scope === 'session' &&
      updated.status === 'allowed' &&
      isWriteScopedTool(updated.tool_name)
    ) {
      const turn = this.repo.getTurn(updated.turn_id)
      const sessionId = turn?.session_id
      if (sessionId && updated.cwd) {
        this.sessionGrants.set(sessionId, {
          sessionId,
          approvalId: updated.id,
          grantedAt: this.now(),
```

**文件/函数**：`gateway.ts` → `ApprovalGateway.matchSessionGrant`

```ts
    if (!this.isSessionAlive(sessionId)) return { grant: null, reason: 'session', targets }
    // 授权必须由写类工具建立（旧进程/非法来源留下的非写类授权一律不认）。
    if (!isWriteScopedTool(grant.toolName)) return { grant: null, reason: 'tool', targets }
    if (!isWriteScopedTool(toolName)) return { grant: null, reason: 'tool', targets }
    // 没有可解析路径，或任一路径越界 → 不命中（多路径场景任一越界即整体回到审批）
    if (targets.length === 0 || !targets.every((target) => isPathInside(grant.cwd, target))) {
      return { grant: null, reason: 'path', targets }
```

**UI**：`ApprovalRequestDialog.tsx`（`sessionGrantable === false` 时不渲染按钮）

```tsx
              {payload.sessionGrantable !== false && (
                <button
                  disabled={busy[payload.approvalId]}
                  onClick={() => void resolve(payload, 'allow', 'session')}
                  className="px-3 py-1 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {t('agent.approval.allowSession')}
                </button>
              )}
            </div>
            {payload.sessionGrantable === false && (
```

`request()` 三条 payload 产出路径都写入 `sessionGrantable: isWriteScopedTool(row.tool_name)`（`request()` / `listPendingPayloads` / re-emit）。

**最小复现**（单测）：
1. `request({toolName:'Bash', args:{command:'npm test'}, cwd:'/ws'})` → `decide({scope:'session'})`；
2. 断言 `gateway.peekSessionGrant({sessionId, toolName:'Write', args:{file_path:'/ws/a'}})` 不命中；
3. 再 `request({toolName:'Write', …})` → 仍为 `pending`（弹卡片）。
4. UI：同一 payload 的 `sessionGrantable === false`，按钮不渲染且显示 `sessionUnavailable` 文案。
**残留**：`sessionGrantable !== false` 把 `undefined` 也当作可授权；当前三条产出路径都会赋值，属防御性 P3。

### ② 用量双记 → **部分修复（正常路径已单条；重叠调用可回退为双条）**

**文件/函数**：`runtime.ts` → `AgentRuntime.runNode`

```ts
    this.kernelActiveSessions.add(request.adapterSessionId ?? request.agentSessionId)
    try {
      return await this.runNodeInner(request)
    } finally {
      this.kernelActiveSessions.delete(request.agentSessionId)
      this.kernelActiveSessions.delete(request.adapterSessionId ?? request.agentSessionId)
    }
  }
```

**文件/函数**：`agent-manager.ts` → `AgentManager.recordAdapterUsage`

```ts
    if (this.runtime?.hasActiveTurn?.(data.sessionId)) {
      logger.debug(`[usage] legacy report ignored while kernel turn is accounting: ${adapterName} ${data.sessionId}`)
      return
    }
    ...
        dedupeKey: data.backendEventId
          ? `bev:${adapterName}:${data.backendEventId}`
          : data.turnKey
            ? `legacy:${data.turnKey}`
            : null,
```

- kernel 在途：legacy 上报被丢弃 ✓（`hasActiveTurn` 只在 `runNode` 执行期间为真）。
- 空闲会话：guard 为假 → legacy 正常记账 ✓。
- key 组成：kernel `turn:<turnId>`；legacy `legacy:<adapter>:<session>:<turnSeq>`；有 backend 事件时 `bev:<adapter>:<eventId>`。三者形状不同，只能靠“抑制”而不是去重合并。

**逻辑漏洞（并发）**：`kernelActiveSessions` 是普通 `Set`，`finally` 无条件删除。若同一会话发生**重叠调用**，后一次即使立刻失败（`SessionBusyError`）也会把前一次的标记删掉，此后前一次 turn 的 legacy 上报不再被抑制 → 同一轮两条记录。

**最小复现**（单测，需运行时验证真实适配器时序）：
1. 让第一次 `runNode(req)` 的 driver 挂起；
2. 并发调用第二次 `runNode(req)`（同 `agentSessionId`）→ 抛 `SessionBusyError`，其 `finally` 清空标记；
3. 断言此时 `runtime.hasActiveTurn(sid) === false`（而第一轮仍在执行）；
4. 调 `agentManager.recordAdapterUsage('claude-code', {sessionId:sid, turnKey:'claude-code:<sid>:0', …})` → 落 `legacy:` 行；第一轮结束再落 `turn:` 行 → 同一轮 2 条。

可达性：`agent:runNode` 直接暴露给 renderer（`preload/index.ts:83`），且该通道不经过 `AgentManager` 的会话锁，因此上述重叠调用是可构造的。

### ③ `git grep -Ocat/-Osh` → **部分修复（贴写已 ask；簇写仍 allow）**

**文件/函数**：`bash-readonly.ts` → `dangerousArgOf` / `isAttachedShortFlag`

```ts
  for (const arg of args) {
    const flagName = arg.split('=')[0]
    for (const spec of specs) {
      if (arg === spec.flag || flagName === spec.flag) return { spec, arg }
      // 短选项「贴写值」：-Ocat / -Ofile / -cfoo=bar。
      if (isAttachedShortFlag(arg, spec.flag)) return { spec, arg }
    }
  }
```

```ts
function isAttachedShortFlag(arg: string, flag: string): boolean {
  return (
    flag.length === 2 &&
    flag.startsWith('-') &&
    !flag.startsWith('--') &&
    arg.length > flag.length &&
    arg.startsWith(flag)
  )
}
```

- `git grep -Ocat`、`git grep -Osh`：`arg.startsWith('-O')` → **ask** ✓（已实测 `git grep -Ocat` 被 git 接受）。
- 但**簇写** `git grep -iOcat` / `-nOcat` / `-wOcat`：`arg` 不以 `-O` 开头 → 规则不命中 → **allow**。本机实测 `git grep -iOcat -e '"name"' -- package.json` **exit 0**，`cat` 作为 pager 执行。
- 正常只读仍 allow（`git status`、`rg -n` 等无危险参数）。
- 其余指定命令均已 ask：`rg --pre`、`git diff --output=`、`git grep -O`（空格）、`git fsck --lost-found`、`git branch <name>`。

**最小复现**：
```bash
git grep -iOcat -e '"name"' -- package.json   # exit 0（pager 执行）
# 策略层：evaluateBashPolicy('git grep -iOsh -e x -- .') === allow
```

### ④ 续接锚点 → **确认修复**

**文件/函数**：`repository.ts` → `AgentRepository.runEventRetention`

```ts
           FROM agent_events e
           JOIN agent_turns t ON t.id = e.turn_id
          WHERE e.created_at < ?
            AND e.type <> '${RESUME_ANCHOR_EVENT_TYPE}'
          GROUP BY e.turn_id
```

```ts
        `SELECT id, created_at
           FROM agent_events
          WHERE created_at < ? AND type <> '${RESUME_ANCHOR_EVENT_TYPE}'
            AND turn_id IN (${placeholders})
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
```

候选统计与取批删除**两条路径**都排除 `run.started`（`RESUME_ANCHOR_EVENT_TYPE = 'run.started'`），`getLatestBackendSessionId` 只读该事件类型 → 清理后仍有值。

**最小复现**：`retentionDays=1`；写入 completed turn + `run.started(backendSessionId='abc123')`（`created_at=now-2d`）；执行 `runEventRetention`（不传 hold，hold 列已不参与）→ 断言该事件仍在、`getLatestBackendSessionId` 返回 `'abc123'`、`restorePersistedSession` 不再报“没有找到可续接的底层会话 id”。
**残留**：锚点事件永久保留，每个 turn 一行（增长极小，P3）。

### ⑤ 相同 prompt 二次发送 → **确认修复**

**文件/函数**：`runtime.ts` → `AgentRuntime.runNodeInner`

```ts
    const dispatchScope = request.runId ?? `dispatch:${randomUUID()}`
    const idempotencyKey = request.idempotencyKey
      ? `${request.agentSessionId}:${request.idempotencyKey}`
      : `${dispatchScope}:${request.agentSessionId}:${request.nodeId}:${branchKey}:${attempt}:${hashArgs('prompt', { prompt: request.prompt })}`

    const existing = this.repo.findTurnByIdempotencyKey(idempotencyKey, request.agentSessionId)
    if (existing) {
      if (!TERMINAL.includes(existing.status)) {
        throw new SessionBusyError(`turn:${existing.id}`)
      }
      return this.outcomeFromTurn(existing, true)
```

**文件/函数**：`repository.ts` → `findTurnByIdempotencyKey`

```ts
  findTurnByIdempotencyKey(key: string, sessionId?: string): AgentTurnRow | null {
    const row = sessionId
      ? this.db
          .prepare('SELECT * FROM agent_turns WHERE idempotency_key = ? AND session_id = ?')
          .get(key, sessionId)
      : this.db.prepare('SELECT * FROM agent_turns WHERE idempotency_key = ?').get(key)
    return (row as AgentTurnRow | undefined) ?? null
  }
```

**最小复现**：同一会话、同一 node、相同 prompt 连续发两次（两次调用都不传 `runId/idempotencyKey`）→ 两次 `dispatch:uuid` 不同 → `agent_turns` 新增 2 行，driver `execute` 被调用 2 次。跨会话：key 内嵌 `agentSessionId` 且查询再按 session 过滤 → 不同会话不可能命中。
**说明**：调用方显式传 `runId` 或 `idempotencyKey` 时仍会复用（重试语义，刻意保留）。

### ⑥ `resolveApproval` 归属 → **确认修复（三种拒绝均生效）；残留“窗口重开后误拒”**

**文件/函数**：`ipc/agent.ts` → `agent:resolveApproval`

```ts
      // 归属校验必填：审批必须带上所属会话/轮次，主进程才能确认「这次决议是给谁的」。
      if (typeof input.sessionId !== 'string' || typeof input.turnId !== 'string') {
        throw new IpcError(
          'resolveApproval requires sessionId and turnId for ownership validation',
          ErrorCode.IPC_INVALID_ARGUMENT,
        )
      }
      const senderId = getIpcContext().senderId
      const boundSender = sessionWindowBindings.get(input.sessionId)
      if (boundSender !== undefined && boundSender !== senderId) {
        throw new AgentRuntimeError(
          'APPROVAL_NOT_OWNED',
          `该审批属于其它窗口发起的会话（session=${input.sessionId}），当前窗口无权决议。`,
        )
      }
```

**文件/函数**：`gateway.ts` → `ApprovalGateway.assertDecisionOwnership`

```ts
  private assertDecisionOwnership(row: AgentApprovalRow, input: ApprovalDecisionInput): void {
    if (input.turnId !== undefined && input.turnId !== row.turn_id) {
      throw new AgentRuntimeError(
        'APPROVAL_NOT_OWNED',
        `该审批不属于指定轮次（approval=${row.id}，期望 turn=${row.turn_id}，收到 turn=${input.turnId}）。`,
      )
    }
    ...
    if (input.sessionId !== undefined) {
      const turn = this.repo.getTurn(row.turn_id)
      if (!turn || turn.session_id !== input.sessionId) {
        throw new AgentRuntimeError(
          'APPROVAL_NOT_OWNED',
          `该审批不属于指定会话（approval=${row.id}，收到 session=${input.sessionId}），可能属于其它窗口或已结束的会话。`,
        )
      }
    }
```

**最小复现**：
- 缺 session/turn：`invoke('agent:resolveApproval', {approvalId, decision, argsHash})` → `IPC_INVALID_ARGUMENT`，文案可读。
- 跨窗口：窗口 A `startSession`（绑定 senderA）→ 窗口 B 用同一 `sessionId+turnId` 决议 → `APPROVAL_NOT_OWNED`。
- hash 不符：改一个字节的 argsHash → `APPROVAL_ARGS_MISMATCH`（gateway 在 `assertDecisionOwnership` 之后校验）。

**逻辑漏洞（误拒）**：`sessionWindowBindings` 只在 `agent:startSession` 写入，**全仓只有 `Map` 的 set/get，没有在窗口销毁时清理，也没有在新窗口重连时重绑**。macOS 上关闭最后一个窗口不退出应用；重新打开后是新的 `webContents.id`（`getIpcContext().senderId` 来源），而旧绑定仍在 → 该会话的新审批一律 `APPROVAL_NOT_OWNED`，用户看到卡片却永远批不了，直到轮次超时自动 deny。

**最小复现**（需运行时验证，步骤明确）：
1. 窗口 A 启动会话并发起一条需要审批的 Bash；
2. 关闭窗口 A（应用不退出），重新打开窗口 B；
3. B 收到 pending 卡片，点“允许本次” → 报 `APPROVAL_NOT_OWNED`；
4. 等待超时后审批被 deny，该轮无法继续。
**修复方向**：窗口销毁时清理绑定；或在 `resolveApproval` 发现绑定的 sender 已不存在时重新绑定到当前 sender（单用户桌面下安全）。

### ⑦ `cache_creation_input_tokens` → **部分修复（legacy 正确；kernel 全 0 仍落 0 值行）**

**文件/函数**：`claude-code.ts` → `parseClaudeUsage`

```ts
export function parseClaudeUsage(raw: ClaudeUsageShape): {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
} | null {
  const inputTokens = raw.input_tokens ?? 0
  const outputTokens = raw.output_tokens ?? 0
  const cachedInputTokens = raw.cache_read_input_tokens ?? 0
  const cacheCreationInputTokens = raw.cache_creation_input_tokens ?? 0
  if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0 && cacheCreationInputTokens === 0) {
    return null
  }
  return { inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens }
```

**文件/函数**：`runtime.ts` → `AgentRuntime.recordUsage`

```ts
    this.usageLedger.record({
      turnId: turn.id,
      sessionId,
      executor: request.executor,
      graphId: request.graphId,
      nodeId: request.nodeId,
      model: usage.model ?? null,
      source: usage.isEstimate ? 'estimated' : 'provider',
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? null,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
      dedupeKey: `turn:${turn.id}`,
```

- 纯写缓存轮次（`input=0/output=0/cache_read=0/cache_creation=50`）：legacy 侧 `parseClaudeUsage` 返回非 null → 记账 ✓。
- 四维分开：`input/output/cached/cache_creation` 四列独立落库 ✓（schema 与 ledger 均含 `cache_creation_input_tokens`）。
- 全 0：legacy 返回 `null` → 不产生 provider 行（由 lifecycle 合成 `unknown` 占位）✓；但 **kernel 路径** `extractUsage` 对 `result.usage` 存在时返回一个**全 0 对象**（不是 `undefined`），`recordUsage` 无条件落一条 `turn:<id>` 的 0 值 provider 行 → 与 legacy 行为不一致。
- 计价：`cache_creation` 按 input 单价计入（Anthropic 写缓存通常为 input 的 1.25x，存在系统性低估；不在本次 8 项范围）。

**最小复现**：
- legacy：`parseClaudeUsage({input_tokens:0, output_tokens:0, cache_read_input_tokens:0, cache_creation_input_tokens:50})` → 非 null。
- 全 0：`parseClaudeUsage({…全 0})` → `null`。
- kernel 0 值行（需运行时验证）：构造 `result.usage` 全 0 的 Claude 结果事件 → `agent_usage` 出现 `turn:<id>` 且四列均为 0；同场景走 legacy 则只有 `unknown` 占位行。

### ⑧ 死路径 → **确认修复**

- `replayPending`：全仓 `grep -rn "replayPending" src` **零命中**，已删除。
- `sweepExpired`：已接到启动对账（`runtime.ts` `reconcileOnStartup`）：

```ts
    // ——这是 sweepExpired 的生产调用点，定时器只覆盖本进程内创建的审批。
    const sweptExpired = this.approvals.sweepExpired()
    if (sweptExpired > 0) {
      this.logger.info(`[approval] swept ${sweptExpired} expired pending approval(s) at startup`)
    }
    // P1-3：重启后旧 pending 审批已无人能兑现 → 统一 deny（decided_by=startup），
    const reconciled = this.approvals.reconcileStartup()
```

- `retention_hold`：生产代码**无任何写入方**（`grep -rn "retention_hold\|setRetentionHold" src` 只剩 schema 定义与类型），且保留策略的候选查询已不看此列；schema 注释亦明确：

```ts
        -- 遗留列：人工 hold 已移除（续接锚点由 run.started 事件类型豁免，不依赖此列）
        retention_hold INTEGER NOT NULL DEFAULT 0, -- 已无生产写入方，保留策略不看它
```

**最小复现（静态）**：`rg "replayPending" src` → 空；`rg "retention_hold" src/main --glob '!**/__tests__/**'` → 仅 schema/类型；`rg "sweepExpired" src/main` → 定义 + `runtime.reconcileOnStartup` 调用点。
**残留**：`retention_hold` 成为永久死列（无行为影响，P3 清理项）。

---

## 2. 仍存在的问题（P0 → P3）

### P1｜`git grep` 的 `-O` 簇写仍可零审批执行

- 原文：§1③ `isAttachedShortFlag` 只做 `arg.startsWith(flag)` 前缀匹配。
- 复现：`evaluateBashPolicy('git grep -iOsh -e x -- .')` → `allow`；本机 `git grep -iOcat …` exit 0。
- 最小修复：短选项匹配改为“`arg` 的第一个短选项簇中包含 `flag` 的字符”（`^-([a-zA-Z]*O)` 等），或直接把 `git grep` 从只读白名单移除 / 对含 `-O` 的任何形态一律 ask。**这是当前唯一发布阻断项。**

### P2｜kernel 用量抑制标记在重叠调用下被提前清除

- 原文：§1② `kernelActiveSessions` 的 `add/delete` 无引用计数。
- 复现：两个重叠 `runNode`（第二个失败）→ `hasActiveTurn` 提前变 false → legacy 行 + kernel 行 = 2 条/轮。
- 最小修复：改为 `Map<sessionId, count>`，或在 `finally` 只删除“本次真正 add 成功（从 0→1）”的标记。

### P2｜`agent:runNode` 仍是 renderer 直通入口（本次未变）

- 原文：`ipc/agent.ts:41-45` 仅校验 `nodeId/agentSessionId` 就 `return runtime.runNode(request)`；`preload/index.ts:83` 在允许清单内。
- 复现：renderer `invoke('agent:runNode', {agentSessionId:'任意', nodeId:'x', executor:'claude-code', workingDirectory:'/任意目录', prompt:'cat ~/.ssh/id_rsa'})` → 读类工具在 `onPreToolUse` 直接标 approved，无卡片。该入口也绕过 `AgentManager` 会话锁，是上一条 P2 的直接可达路径。
- 最小修复：该通道只对受信内部窗口开放，或在主进程侧校验 session 归属/工作目录，并复用 `sendCommandThroughKernel`。

### P2｜窗口重开/销毁后 `APPROVAL_NOT_OWNED` 误拒（可用性阻断）

- 原文：§1⑥ `sessionWindowBindings` 无销毁清理/重绑。
- 复现：窗口 A 启动会话 → 关窗（macOS 不退出）→ 新窗口 B 收到 pending → 决议被拒 → 超时 deny。
- 最小修复：监听 webContents 销毁清理绑定；决议时若绑定 sender 已不存在，重绑到当前 sender。

### P3

- kernel 全 0 usage 落 0 值行（legacy 不落），账本口径不一致。
- `sessionGrantable !== false` 把 `undefined` 当可授权（当前生产者都会赋值，防御性）。
- `retention_hold` 永久死列。
- `run.started` 锚点事件永久保留（每 turn 一行，增长可忽略）。

---

## 3. 发布判定

上一轮的阻断项（**Bash「允许本会话」→ 写授权放大**）**已清除**：创建侧只接受写类工具、命中侧再校验 `grant.toolName`、UI 对非写类工具隐藏按钮并给出一致文案。

但整体判定仍为 **不可发布**。唯一必要条件：**把 `git grep` 的 `-O` 全形态（贴写 `-Ocat` 与簇写 `-iOcat`/`-nOcat`）都变为 ask，或直接从白名单移除该能力**——否则仍存在零审批执行仓库文件（pager=`sh`）的通道。

其余已知且可接受（修复该 P1 后即可发布）的风险：kernel 重叠调用导致的双记（成本偏高，不影响安全）、窗口重开后的审批误拒（可用性，超时后自动 deny）、`agent:runNode` 直通入口（需先有 renderer 沦陷前提）、kernel 全 0 行与死列（账本/卫生问题）。

---

# 第四次冻结终审（发布门禁复核）

## 0. 冻结基线

| 项 | 值 |
|---|---|
| HEAD | `2c0045377e819853efefcca6284a42377fced86d`（与上一轮相同，未产生新 commit） |
| 工作区 | **未提交**：`git status --porcelain` 78 行 = 41 modified + 37 untracked + 0 staged |
| 关键文件 sha256 | 下表 20 个；写报告前 / 写报告后各复算一次，逐字节一致 → **无漂移** |
| 定向用例 | `vitest run` 4 套件（bash-readonly / ipc agent / approval-gateway / run-node）：**4 files, 77 tests passed** |

| sha256 | 文件 |
|---|---|
| `a9e0ff5d35eb8912…` | `src/main/agent/runtime/approval/bash-readonly.ts` |
| `05d0d7eb48dce803…` | `src/main/agent/runtime/approval/gateway.ts` |
| `8ae91425f586acca…` | `src/main/agent/runtime/runtime.ts` |
| `1ce61499a4fd90c3…` | `src/main/agent/runtime/db/repository.ts` |
| `b6f5bd073dc0db37…` | `src/main/agent/runtime/db/schema.ts` |
| `84637def2907060c…` | `src/main/agent/agent-manager.ts` |
| `c8c58f5a681b9fca…` | `src/main/agent/session-lifecycle-manager.ts` |
| `09c558d008704a6d…` | `src/main/ipc/agent.ts` |
| `cc2c3afc335b3c1f…` | `src/preload/index.ts` |
| `47475bc08473f7cb…` | `src/shared/types/ipc.ts` |
| `0d1e221d78d69b12…` | `src/main/adapters/claude-code.ts` |
| `4c3c46d92d57cf8e…` | `src/main/agent/runtime/executors/adapter-driver.ts` |
| `8588636b7eb82e12…` | `src/main/agent/runtime/cost/ledger.ts` |
| `fe75156ca960d5c0…` | `src/main/agent/runtime/util.ts` |
| `cfb578e1f4f57adb0…` | `src/main/agent/runtime/feature-flags.ts` |
| `84bb2ec161eddbf9…` | `src/renderer/components/agent/ApprovalRequestDialog.tsx` |
| `135dcfeda3bddeb7…` | `src/main/ipc-handlers.ts` |
| `ff66db67fab0925a…` | `src/main/errors.ts` |
| `2263c463fee5fd4a…` | `src/shared/types/agent-runtime.ts` |
| `06868856d1a70ffd…` | `src/shared/native-session-id.ts` |

> **「未提交」对可发布性的影响**：37 个 untracked 文件包含整个 `src/main/agent/runtime/`（审批网关、kernel、保留策略、成本账本）以及 `src/shared/types/agent-runtime.ts`。HEAD 快照里**没有本轮被审代码**，从 HEAD 构建的产物无法复现本结论，也无法回滚/追溯提交来源。发布前必须先把这 78 行变更收敛成一个受控 commit，并在该 commit 上重跑本终审；否则“已审通过”不构成发布依据。

## 1. 结论（先给）

**不可发布。**

- 上一轮的唯一阻断（`git grep -O` 任意 pager 执行）**已清除**：整条 `grep` 子命令移出只读白名单，`-Ocat` / `-iOcat` / `--no-pager` 前缀 / 簇写全部 `ask`。
- 但本轮按“命令 + 参数”两段式重扫发现**新的零审批代码执行通道**：`node --check` 被放行后，附加 `-r` / `--require` / `--import` 会**执行任意 JS**（实测写盘成功；`--import data:` 连文件都不需要）。
- 另有 `file -bC`（短选项前缀簇）绕过 `file -C`，免审写盘（实测重写 `magic.mgc`）；`rg -nz` / `-iz` 同样绕过 `rg -z` 的 ask。

## 2. 8 项独立核验

| # | 声明 | 判定 | 一句话证据 |
|---|---|---|---|
| 1 | `git grep` 移出白名单，所有形态 ask | **确认生效** | `GIT_READ_SUBCOMMANDS` 无 `grep`；`gitRule` 在 allow 分支前无条件 `askRule('git-grep')`；实测 `-Ocat`/`-iOcat`/`--no-pager grep` 全 ask |
| 2 | `git -p/--paginate`、`rg -z/--search-zip` → ask | **部分生效** | 分离形态全 ask；但短选项簇 `rg -nz`/`-iz`/`-pz` 仍 allow（`isAttachedShortFlag` 只做前缀匹配） |
| 3 | `kernelActiveSessions` 改 `Map<string,number>` 引用计数 | **确认生效** | `retain` 只 0→1、`release<=0` 才删；`runNode` 在 `try/finally` 成对调用；重叠/取消/异常均由 finally 覆盖；77 用例通过 |
| 4 | 删除 `agent:runNode` IPC | **确认生效** | `ipc/agent.ts` 只剩注释；`preload/index.ts`、`shared/types/ipc.ts` 零命中；生产调用只剩 `sendCommandThroughKernel → runtime.runNode` |
| 5 | 窗口绑定生命周期 | **确认生效（有偏差）** | `startSession` 只订阅一次 `destroyed`；销毁清该窗口全部绑定；决议时绑定 sender 已死则重绑、存活则 `APPROVAL_NOT_OWNED`。偏差：`destroyed` 已先删绑定，重绑分支实际只在“销毁事件未送达”时生效 |
| 6 | kernel 全 0 usage 不落 0 值行 | **确认生效** | `hasReportedUsage()` 四项全 0 返回 false；否则落 `source=unknown` + `backend_reports_no_usage`，tokens/cost 为 NULL |
| 7 | `sessionGrantable` 严格布尔 | **确认生效** | 网关三处均为 `isWriteScopedTool(...)` 的布尔值；UI 用 `=== true` / `!== true`；非写类工具不渲染按钮且显示不可用文案 |
| 8 | `retention_hold` 仅保留列 + `@deprecated` | **确认生效** | schema 注释“已无生产写入方，保留策略不看它”；全仓无写该列的 SQL；清理 SQL 不引用 |

### 2.1 第 1 项：`git grep` 已彻底 ask

[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L210-L217)

```ts
 * `grep` 故意不在其中：它支持 `-O/-iO.../--open-files-in-pager`，会把命中文件交给外部
 ...
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'blame', 'ls-files',
```

[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L388-L397)

```ts
  if (sub === '--no-pager') return gitRule(args.slice(1))
  if (sub === '-p' || sub === '--paginate') {
    return askRule('git-paginate', 'git -p/--paginate 会强制调用 core.pager，可能执行外部程序', HIGH)
  }
  // git grep 的语义允许把命中文件交给外部 pager 执行（-O / --open-files-in-pager，
  if (sub === 'grep') {
    return askRule('git-grep', 'git grep 支持 -O/--open-files-in-pager 执行外部 pager，不纳入只读白名单', CRITICAL)
  }
  if (GIT_READ_SUBCOMMANDS.has(sub)) return allowRule(`git:${sub}`)
```

最小复现（策略函数实测）：`evaluateBashPolicy` 对 `git grep -Ocat TODO src`、`git grep -iOcat -e name -- package.json`、`git --no-pager grep TODO src` 全部返回 `ask / git-grep`；`git -p status`、`git --paginate log` 返回 `ask / git-paginate`。

### 2.2 第 2 项：分离形态生效，簇写仍漏

[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L244-L250)

```ts
  grep: [],
  rg: [
    { flag: '--pre', rule: 'rg-pre', reason: 'rg --pre 会为每个文件执行外部程序', risk: CRITICAL },
    { flag: '-z', rule: 'rg-search-zip', reason: 'rg -z 会按文件类型调用外部解压程序', risk: HIGH },
    { flag: '--search-zip', rule: 'rg-search-zip', reason: 'rg --search-zip 会按文件类型调用外部解压程序', risk: HIGH },
```

[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L444-L465)

```ts
  for (const arg of args) {
    const flagName = arg.split('=')[0]
    for (const spec of specs) {
      if (arg === spec.flag || flagName === spec.flag) return { spec, arg }
      ...
      if (isAttachedShortFlag(arg, spec.flag)) return { spec, arg }
    }
```

```ts
function isAttachedShortFlag(arg: string, flag: string): boolean {
  return (
    flag.length === 2 && flag.startsWith('-') && !flag.startsWith('--') &&
    arg.length > flag.length && arg.startsWith(flag)
  )
}
```

最小复现（策略函数实测）：`rg -z x`、`rg --search-zip x` → ask；`rg -nz x`、`rg -iz x`、`rg -pz x` → **allow**（`-nz` 不以 `-z` 开头）。本机 `rg -nz -e '"name"' package.json` 可正常执行，说明 ripgrep 接受短选项簇。

### 2.3 第 3 项：引用计数不漏减、不误删

[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L243-L267)

```ts
  private readonly kernelActiveSessions = new Map<string, number>()

  private retainKernelSessions(ids: Array<string | undefined>): void {
    for (const id of new Set(ids.filter((v): v is string => !!v))) {
      this.kernelActiveSessions.set(id, (this.kernelActiveSessions.get(id) ?? 0) + 1)
    }
  }

  private releaseKernelSessions(ids: Array<string | undefined>): void {
    for (const id of new Set(ids.filter((v): v is string => !!v))) {
      const next = (this.kernelActiveSessions.get(id) ?? 0) - 1
      if (next <= 0) this.kernelActiveSessions.delete(id)
      else this.kernelActiveSessions.set(id, next)
    }
  }

  async runNode(request: RunNodeRequest): Promise<TurnOutcome> {
    const ids = [request.agentSessionId, request.adapterSessionId ?? request.agentSessionId]
    this.retainKernelSessions(ids)
    try {
      return await this.runNodeInner(request)
    } finally {
      this.releaseKernelSessions(ids)
    }
  }
```

三条路径核对：
- **重叠派发**：A retain→1，B retain→2；B 在 `runNodeInner` 抛 `SessionBusyError` 后 finally 释放→1，A 的上报仍被抑制；A 结束→0。
- **取消**：`cancelTurn` 不直接改 Map，取消使 `runNodeInner` 返回/抛错，仍走 finally。
- **异常**：`try/finally` 覆盖；`retain` 之前无可能抛错的语句。
- 别名安全：`[agentSessionId, adapterSessionId]` 用 `Set` 去重，retain/release 对称。

最小复现：同会话连续两次 dispatch（第二次必然 `SessionBusyError`），第一次执行期间抓 `onAdapterUsage` 日志，应看到 `legacy report ignored…`；第一次结束后再上报，应正常落库。

### 2.4 第 4 项：唯一受信路径

[ipc/agent.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L59-L62)

```ts
  if (runtime) {
    // 不暴露 agent:runNode：renderer 直通 runtime 会绕过 AgentManager 的会话锁与审批前置。
    // 节点执行只能走 agent:sendCommand / agent:resolveAndSendCommand → sendCommandThroughKernel。
```

[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L1111-L1113)（`sendCommandThroughKernel`）与 `kernel:<session>:<dispatchId>` 幂等键（L1159）。全仓 `runtime.runNode` 调用点仅此一处；`agent:runNode` 在 `preload/index.ts`、`shared/types/ipc.ts` 均零命中。

### 2.5 第 5 项：窗口绑定生命周期

[ipc/agent.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L86-L98)

```ts
      const senderId = getIpcContext().senderId
      const boundSender = sessionWindowBindings.get(input.sessionId)
      if (boundSender !== undefined && boundSender !== senderId) {
        // 原发起窗口已销毁：重绑当前窗口（继续走 session/turn 归属校验），
        // 否则重开窗口后合法审批会被误拒。
        if (!isSenderAlive(boundSender)) {
          sessionWindowBindings.set(input.sessionId, senderId)
          logger.info(`[approval] rebind session ${input.sessionId} from destroyed sender ${boundSender} to ${senderId}`)
        } else {
          throw new AgentRuntimeError(
            'APPROVAL_NOT_OWNED',
            `该审批属于其它窗口发起的会话（session=${input.sessionId}），当前窗口无权决议。`,
```

[ipc/agent.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L148-L163)

```ts
    const result = await agentManager.startSession(adapterName, config)
    const senderId = getIpcContext().senderId
    sessionWindowBindings.set(result.sessionId, senderId)
    if (!watchedSenders.has(senderId)) {
      watchedSenders.add(senderId)
      watchSender(senderId, () => {
        for (const [sessionId, bound] of sessionWindowBindings) {
          if (bound === senderId) sessionWindowBindings.delete(sessionId)
        }
        watchedSenders.delete(senderId)
      })
    }
```

生产接线（[ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L472-L482)）：`watchSender = webContents.fromId(id)?.once('destroyed', cb)`，`isSenderAlive = !!webContents.fromId(id) && !isDestroyed()`。

**偏差（P3）**：`destroyed` 回调会先把该窗口的所有 session 绑定删掉，因此正常时序下 `resolveApproval` 看到的 `boundSender` 已是 `undefined`，不会进入“重绑”分支——效果等于“窗口关闭后任何窗口都可决议”。归属校验仍依赖 `sessionId + turnId + argsHash + assertDecisionOwnership`，同应用窗口可信，不构成安全阻断，但与“重绑当前 sender”的文字描述不完全一致。

### 2.6 第 6 项：全 0 usage

[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L79-L87)

```ts
/** 后端是否真的报了用量：四项全 0 视为「没报」，避免落 0 值行。 */
function hasReportedUsage(usage: DriverUsage): boolean {
  return (
    (usage.inputTokens ?? 0) > 0 ||
    (usage.outputTokens ?? 0) > 0 ||
    (usage.cachedInputTokens ?? 0) > 0 ||
    (usage.cacheCreationInputTokens ?? 0) > 0
  )
}
```

[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L499-L517)

```ts
          // 全 0 usage 视为「后端没给用量」：与 legacy 口径一致，不落 0 值行。
          if (result.usage && hasReportedUsage(result.usage)) {
            this.recordUsage(turn, session.id, request, result.usage)
          } else {
            this.usageLedger.record({
              turnId: turn.id,
              sessionId: session.id,
              executor: request.executor,
              graphId: request.graphId,
              nodeId: request.nodeId,
              source: 'unknown',
              attributionNote: 'backend_reports_no_usage',
              dedupeKey: `turn:${turn.id}`,
              recordedAt: this.now(),
            })
          }
```

最小复现：kernel 返回 `usage` 四维全 0 → `agent_usage` 只有 `source=unknown`、`input_tokens/output_tokens/cached/cache_creation` 全 NULL、`cost_micros` NULL 的一行，不出现 provider 0-token 行。

### 2.7 第 7 项：`sessionGrantable` 严格布尔

网关三处请求 payload 均为 `sessionGrantable: isWriteScopedTool(row.tool_name)`（返回 `boolean`）；UI：

[ApprovalRequestDialog.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/ApprovalRequestDialog.tsx)（`sessionGrantable === true` 才渲染「允许本会话」，`!== true` 显示 `sessionUnavailable` 文案）。

复现：Bash（非写类）审批 payload `sessionGrantable=false` → 无按钮；`Write` → `true` → 有按钮。

### 2.8 第 8 项：`retention_hold` 死列

[schema.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L108-L109)

```sql
  -- 遗留列：人工 hold 已移除（续接锚点由 run.started 事件类型豁免，不依赖此列）
  retention_hold INTEGER NOT NULL DEFAULT 0, -- 已无生产写入方，保留策略不看它
```

[repository.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L111-L112) 的 `AgentTurnRow.retention_hold` 带 `@deprecated` 注释。全仓 grep `retention_hold` 只命中 schema 定义、类型定义、测试与迁移，无生产写入；`runEventRetention` 的候选/删除 SQL 不引用该列。`sweepExpired` 已接入 `reconcileOnStartup`（runtime L925-926），`replayPending` 零命中。

## 3. 本轮新发现的阻断项（可实测复现）

### P0 · `node --check` 可携带执行选项 → 零审批任意代码执行

[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L354-L358)

```ts
function nodeRule(args: string[]): RuleVerdict {
  // 只放行语法检查；`node script.js` 会执行任意代码，必须走审批。
  if (args[0] === '--check') return allowRule('node:--check')
  return askRule('node:run', 'node 执行脚本不在只读白名单，需人工审批')
}
```

Node 的 `--check` 只约束“主脚本不执行”，但 `-r/--require`、`--import` 是**启动期模块加载**，会照常执行。策略只看 `args[0]`，后续参数全部放行。

最小复现（本轮重新实测，策略判定与真实执行都验过）：
```bash
printf 'const x = 1\n' > /tmp/a.js
printf 'require("node:fs").writeFileSync("/tmp/nc-require-marker","R")\n' > /tmp/req-probe.js
node --check -r /tmp/req-probe.js /tmp/a.js      # exit=0，marker 写入 → 执行了
node --check --import 'data:text/javascript,import{writeFileSync}from"node:fs"%3BwriteFileSync("/tmp/nc-import-marker","I")' /tmp/a.js
# exit=0，marker 写入；%3B 是 `;` 的百分号编码，无需预置任何文件，也不触发 shell 元字符规则
```
策略侧实测：以上两条均返回 `allow / node:--check`（`bash-readonly.ts` 重新打包后调用 `evaluateBashPolicy`）。
补充：`node --check -e` / `-p` 被 Node 自身拒绝（`either --check or --eval`），不构成通道；`--loader` / `--env-file` 本轮未实测，按同一原理（启动期参数）保守视为可利用。

这是比 `git grep` 更直接的发布阻断：一条 Bash 命令即可执行任意 JS，完全不需要审批卡片。

最小改法：把 `nodeRule` 收紧为“只允许 `node --check <file>` 且没有其他选项”：
```ts
function nodeRule(args: string[]): RuleVerdict {
  if (args.length !== 2 || args[1].startsWith('-')) return askRule('node:exec-option', '...', HIGH)
  return args[0] === '--check' ? allowRule('node:--check') : askRule('node:run', '...')
}
```
更稳妥的做法：任何参数含 `-r`/`--require`/`--import`/`--loader`/`--env-file` 一律 ask（这些都可能触发启动期代码执行）。

### P1 · `file -bC` 短选项簇绕过 `file -C` → 免审写盘

`file` 的 specs 只登记了 `-C`/`--compile`；`isAttachedShortFlag` 只匹配“以 `-C` 开头”，因此 `-bC`（BSD getopt 会解析为 `-b` + `-C`）漏网。

最小复现（已实测）：
```bash
cd /tmp/fileprobe
printf '0 string X probe\n' > magic.test
file -bC -m magic.test     # policy = allow / file
ls -la                     # magic.mgc（约 7MB）被创建/重写
```
策略侧实测：`file -bC -m /tmp/m` → `allow / file`；`file -cC -m /tmp/m` 同样 allow；`file -C -m /tmp/m` → `ask / file-compile`。

最小改法：把 `isAttachedShortFlag` 改成“在首个短选项簇内查找标志字符”，而不是前缀匹配：
```ts
function isAttachedShortFlag(arg: string, flag: string): boolean {
  if (flag.length !== 2 || !flag.startsWith('-') || flag.startsWith('--')) return false
  if (!arg.startsWith('-') || arg.startsWith('--')) return false
  const cluster = arg.slice(1, arg.indexOf('=') === -1 ? undefined : arg.indexOf('='))
  return cluster.includes(flag[1])
}
```
该改法同时修掉 `rg -nz`、`date -us`（GNU date 上确实会设置系统时间；macOS BSD date 不支持 `-s`，故本机不成立）。

### P2 · `rg -nz` / `-iz` 簇写绕过 `rg -z`

策略实测 allow，且 ripgrep 接受短选项簇。`-z` 会按文件类型调用外部解压程序，属于“语义可执行”，与已登记的 `rg-search-zip` 风险等级一致。修复同上（簇内查找 `z`）。

## 4. 只读白名单「命令 + 参数」两段式复扫（本轮）

对 20 个白名单命令逐一复核“命令本身是否可执行外部程序 / 命令 + 参数是否可写盘”，结论：

| 命令 | 参数面登记 | 本轮复扫结果 |
|---|---|---|
| `ls` `pwd` `cat` `head` `tail` `wc` `grep` | 空 | 无执行/写盘参数；重定向已被 shell 元字符规则拦截 |
| `rg` | `--pre`(CRITICAL)、`-z`、`--search-zip` | 分离形态 ask；**簇写 `-nz`/`-iz` 仍 allow（P2）** |
| `stat` `du` `df` `which` `whoami` `uname` `echo` | 空 | 无执行/写盘参数 |
| `file` | `-C`、`--compile` | 精确形态 ask；**簇写 `-bC`/`-cC` 仍 allow（P1，实测写 `magic.mgc`）** |
| `date` | `-s`、`--set` | 精确形态 ask；**簇写 `-us` 仍 allow（P3；macOS BSD date 不支持 `-s`，GNU date 上成立）** |
| `find` | `-delete/-exec/-execdir/-ok/-okdir/-fprint/-fprintf/-fls/-fprint0` | 全部 ask；`-name` allow |
| `node` | 空（由 `nodeRule` 硬编码） | 只接受 `args[0]==='--check'`，其余参数全放行 → **P0** |
| `git` | `--output/--ext-diff/--textconv/--filters/--lost-found/-c/--config-env/--exec-path/--upload-pack/--receive-pack` | 全部 ask；`--no-pager` 递归后仍能命中 `grep`/`-p`；`grep` 整条 ask |

结论：参数面登记的**精确形态**都生效，缺口集中在“短选项簇中间位”（`-bC`、`-nz`、`-us`）和 `node` 的启动期选项 —— 这是同一个判定缺口的两类表现。

## 5. 已确认修复与仍需注意的非阻断残留

已确认修复：
- `git grep` 全形态 ask；`git --no-pager` 剥离顺序正确（`--no-pager → grep` 仍 ask；`--no-pager -p` → `git-paginate` ask）。
- `git fsck --lost-found`、`git diff/log/show --ext-diff/--textconv/--filters`、`git --output`、`git -c<cfg>`、`git --exec-path/--upload-pack/--receive-pack` 均 ask；`git branch` 写形态 ask、只读形态 allow。
- `find -delete/-exec/-execdir/-ok/-okdir/-fprint/-fprintf` 全 ask；`find -name` allow。
- 引用计数、`agent:runNode` 删除、`retention_hold`、`sweepExpired`、全 0 usage、`sessionGrantable` 均按声明生效；77 个定向用例通过。

非阻断残留（P3，已知可接受）：
- 窗口销毁后绑定被删除 → 任一应用窗口可决议该会话审批（仍受 session/turn/argsHash 约束）。
- kernel turn 结束后姗姗来迟的 legacy / synthesized unknown 上报可能形成第二行（需运行时验证：让适配器在 `complete` 之后补发 usage）。
- 恢复会话时 `runtime_session_id`（CLI session id）与 `agentSessionId` 不同名，理论上 legacy 上报会绕过 `hasActiveTurn`（需运行时验证）。
- `git` 只读子命令仍会执行仓库配置驱动的 `core.fsmonitor` / `textconv`（前提：仓库本地配置已被污染，属既有信任假设）。
- `run.started` 锚点事件永久保留；`retention_hold` 死列。
- `git log/show --show-signature`（及 `%G?` 系列格式）会启动 `gpg` 做签名校验，属于“语义可执行”，但入参受 git 约束、不改写工作区；未登记为危险参数，记为 P3。
- 未提交状态本身：HEAD 不含被审代码，77 个用例是在工作区跑的；发布前须先收敛 commit 并重跑。

未验证（需运行时验证）：
- `rg -z` 实际是否 spawn 外部解压程序（策略层已确认 `-z` 与 `-nz` 的 allows 差异）。
- `node --check --env-file` / `--loader` 的实际执行效果（`-r` / `--import` 已实测执行）。
- 窗口关闭→重开→决议的完整 Electron 路径（`destroyed` 时序）。

## 6. 发布判定

**不可发布。**

冻结校验（写完后复算）：HEAD 仍为 `2c004537…`，`git status --porcelain` 仍为 78 行（41 M + 37 ??），20 个关键文件 sha256 与冻结基线逐字节一致 → **无漂移**。

阻断清单（按可实测性与最小改法排序）：
1. **P0** `node --check` + `-r/--require/--import` → 任意代码执行（实测写盘，含 `%3B` 编码的 `data:` 形式）。改 `nodeRule` 为只接受 `--check <file>`。
2. **P1** `file -bC`（以及 `-cC`）→ 免审写 `*.mgc`（实测创建 7MB `magic.mgc`）。改 `isAttachedShortFlag` 为簇内匹配。
3. **P1** 同一簇写缺口导致 `rg -nz`/`-iz` 绕过 `rg -z`（与 2 同一处修复）。
4. **P3** 窗口销毁后审批可被其它窗口决议（设计取舍，记录即可）。

结论一句话：**上一轮的 `git grep` 阻断已清除，但本轮发现 `node --check` 的零审批任意代码执行通道，发布阻断项未清零，仍不可发布。**

# 第五次冻结终审（发布门禁复核）

## 0. 冻结基线

| 项 | 值 |
|---|---|
| HEAD | `3b36fce54b78f25218e5bcfceb4cbf9780630982` |
| subject | `feat(agent): 落地 M0→M1 内核运行时、审批网关与成本账本` |
| `git show --stat` | 400 files changed, 42780 insertions(+), 177 deletions(-) |
| 工作区 | 仅 `?? spikes/spikes/`（11 个 sabotage 日志，`-uall` 展开后 11 file） |
| 定向用例 | 4 suites / **80 tests passed**（上一轮 77） |

关键文件 sha256（写报告前后各复算一次，见 §7）：

```
0456b3d1…  src/main/agent/runtime/approval/__tests__/bash-readonly.test.ts
05d0d7eb…  src/main/agent/runtime/approval/gateway.ts
09c558d0…  src/main/ipc/agent.ts
0cdcc32e…  src/main/ipc/__tests__/agent.test.ts
0d1e221d…  src/main/adapters/claude-code.ts
135dcfed…  src/main/ipc-handlers.ts
1b831349…  src/main/agent/runtime/errors.ts
1ce61499…  src/main/agent/runtime/db/repository.ts
2263c463…  src/shared/types/agent-runtime.ts
47475bc0…  src/shared/types/ipc.ts
4c3c46d9…  src/main/agent/runtime/executors/adapter-driver.ts
84637def…  src/main/agent/agent-manager.ts
84bb2ec1…  src/renderer/components/agent/ApprovalRequestDialog.tsx
8588636b…  src/main/agent/runtime/cost/ledger.ts
8ae91425…  src/main/agent/runtime/runtime.ts
92f3eae9…  src/main/agent/runtime/approval/bash-readonly.ts
b6f5bd07…  src/main/agent/runtime/db/schema.ts
c8c58f5a…  src/main/agent/session-lifecycle-manager.ts
cac6258a…  src/main/agent/runtime/locks/session-lock.ts
cc2c3afc…  src/preload/index.ts
```

与上一轮冻结 hash 逐文件比对：**只有 `bash-readonly.ts` 变化**，其余 16 个同名文件字节一致 → 上一轮 8 项结论继续成立，本轮只需复核策略文件。

“已提交”对可发布性的影响：本轮基线是真实 commit，不再有“HEAD 不含被审代码”的问题；但工作区仍有 1 个 untracked 目录，严格意义上不是干净 worktree。

## 1. 结论

**不可发布。**

上一轮的 3 个阻断（`node --check`、`file -bC`、`rg -nz`）已全部清除，但本轮重扫发现同类缺口的新形态：`file` 的长选项前缀缩写（`--comp` / `--compil`）绕过 `--compile` 登记，实测仍可免审写出 7MB `magic.mgc`。

## 2. 本轮 4 项修复独立核验

| # | 判定 | 证据 |
|---|---|---|
| 1 `node --check` 严格形态 | **确认** | `nodeRule` L359 仅 `args.length === 2 && args[0] === '--check'`；实测 `--check script.js`=allow；`-r/--require/--import/--loader/--env-file/--import=x`=ask；`NODE_OPTIONS=… node --check`=ask（`not-in-whitelist`）；`env NODE_OPTIONS=…`=ask（`shell-escape:env`） |
| 2 短选项簇算法 | **确认** | `-bC/-cC/-zC`、`-nz/-iz/-wz` 均 ask；`-mC/-bPC/-eC/-rnz`、`date -df` 均 allow 且不误判；`git -ccore.pager=cat` ask；`git grep -iOcat` 走 `git-grep` ask |
| 3 `git help` 收紧 | **确认** | L387 仅 `args.length === 1` 的 `--version/-v/--help/-h/help` allow；`git help log` / `git help --web` → `git:unknown:help` ask |
| 4 `--show-signature` | **确认** | 登记为 `git-show-signature`；`git log/search` 实测 ask |

簇算法本身未引入新漏判：`SHORT_OPTIONS_WITH_VALUE` 的四个值集（file: M/m/e/f/F/P；rg: A/B/C/d/e/E/f/g/j/M/m/r/t/T；git: C/c/O；date: d/f/I/r/s/v）逐项对照 `--help` 全部是“取值选项”，没有把布尔选项误收进去；命中判定先于取值截断，因此 `-c` 这种“既危险又取值”的选项仍会命中。`-bC=x`、`-nz=x` 这类 `=` 形态也命中。

## 3. 阻断清单

### P1 · `file` 长选项前缀缩写绕过 `--compile`

- 现象：GNU `file` 走 `getopt_long`，接受**唯一前缀**。
- 实测（策略与真实执行）：
  ```bash
  cd /tmp/abbr && printf '0 string TEST hello\n' > test.magic
  file --comp -m test.magic        # exit=0，生成 magic.mgc(7.2MB) + test.magic.mgc
  file --compil -m test.magic      # 同上
  ```
- 策略判定：`file --comp` / `file --compil` / `file --c` 均 `allow / file`（只有精确 `--compile` 命中 `file-compile`）。
- 影响：与上一轮 `file -bC` 同级——免审批写盘、可覆盖工作区同名文件；且 `-m` 可指向仓库内可写的 magic 源文件。
- 最小改法（`dangerousArgOf`，L445-458）：长选项增加前缀匹配，`if (arg.startsWith('--') && spec.flag.startsWith(flagName) && flagName.length > 2) return …`。宁可多弹（`file --c` 本来就是歧义前缀），不可漏放。
- 同类对照已实测不可利用：`rg --search-z/--search-zi` 报 unrecognized；`git --outpu/--show-signatu` 报 unrecognized；`date --se` 在 BSD date 上直接 illegal option。

## 4. 只读白名单「命令 + 参数」复扫（本轮）

| 命令 | 结论 |
|---|---|
| `ls/pwd/cat/head/tail/wc/grep/stat/du/df/which/whoami/uname/echo` | 无危险参数登记，元字符/逃逸命令已先行拦截 |
| `rg` | `--pre`、`-z`、`--search-zip` 及簇写全部 ask；不支持长选项缩写 |
| `file` | 短选项已补齐；**长选项缩写漏（见 §3）** |
| `date` | `-s/--set` 与簇写 ask；`-df` 不误判；BSD date 无长选项 |
| `find` | `-delete/-exec/-execdir/-ok/-okdir/-fprint/-fprintf/-fls/-fprint0` 全 ask |
| `node` | 仅严格 `--check <file>` allow；其余 ask |
| `git` | `grep`/`-p`/`--paginate`/`--no-pager` 递归/危险参数全 ask；`git help` 收口；长选项不支持缩写 |
| 绝对路径/提权 | `/bin/file`、`/usr/bin/rg` → `not-in-whitelist`；`sudo`/`xargs`/`env` → `shell-escape` |

已知语义可执行残留（非阻断）：`git diff/log/show` 在 gitattributes + 用户 config 配置 textconv 时会自动执行外部转换程序；`git status` 的 `core.fsmonitor` 同理；`git log --format=%G?` 可能拉起 gpg。均需本机既有配置，非仓库内容可直接触发。

## 5. `agent:runNode` 绕过路径复核

- `agent:runNode` 在 `ipc/agent.ts`、`shared/types/ipc.ts`、`preload/index.ts` 中零命中（仅注释与断言测试）。
- 全仓生产代码 `.runNode(` 仅 `agent-manager.ts:1149`（`sendCommandThroughKernel`）。
- 该路径进入 `AgentRuntime.runNode` → `runNodeInner`，会话锁与审批前置未变。
- 其余 23 个 `agent:*` handler 均不执行 turn（仅取消、查询、决议、会话开关）。

## 6. 新增审计项：`docs/architecture/evidence/` 与 `spikes/` 入库

实测数据：

| 项 | 实测 |
|---|---|
| `docs/architecture/evidence` | 15 MB，154 files（131 png / 17 log / 5 json / 1 txt） |
| `spikes`（tracked） | 0.5 MB，123 files（39 jsonl / 35 ts / 14 json / 11 log / 10 mjs …） |
| `.git` | 约 22 MB（loose 15.09 MiB + pack 6.23 MiB） |
| DB 快照 | **未入库**：`m1-migration-before-v21.db`(122,880B) 与 `…after-v23.db`(512,000B) 命中 `.gitignore:52 *.db`，`git ls-files` 为空 |
| 绝对路径 | 9 个 log/json 含 `/Users/zhumingchen/tiangong/…`（最多 18 处/文件）；PNG 元数据零命中 |
| 凭据扫描 | `sk-*` / API key / 私钥 / `ghp_*` 仅误配到构建日志里的模块路径，无真实凭据 |

判定：

- **信息泄露面：可延后**。当前不含凭据、不含 DB 快照；只有开发者绝对路径（用户名 + 仓库路径）。若仓库保持私有/内网，可接受；若计划开源或对外分发，发布前必须把路径替换为 `<repo>` 或直接剔除 evidence 目录。
- **仓库体积：可延后**。当前 22 MB 不构成发布阻断，但 131 张 PNG 每轮复测新增约 15 MB，属不可 delta 压缩的二进制；建议后续迁到独立 `*-evidence` 仓库或 LFS。
- **`spikes/`：可延后**。tracked 仅 0.5 MB，无构建产物；建议后续剥离到独立原型仓，避免与主线代码混淆，但不影响本次发布。
- **`spikes/spikes/`（untracked 11 文件）：无需处理**（不在提交内），但建议删除以保持 worktree 干净。

## 7. 冻结后复算

写报告后重新执行：`git rev-parse HEAD`、`git status --porcelain -uall`、20 文件 `shasum -a 256`，与 §0 逐字节比对，结果见回复正文；若有漂移，以漂移后的状态为准并撤回结论。

## 8. 发布判定

**不可发布**。阻断项 1 条：`file --comp/--compil` → 免审写盘（§3，可实测复现、单行改法）。

修复后预期可发布，前提：
1. `dangerousArgOf` 增加长选项前缀匹配，并补一条 `file --comp` / `--compil` 用例；
2. 4 套件全绿（当前 80 passed）；
3. worktree 干净（处置 `spikes/spikes/`）；
4. evidence/spikes 的处置按 §6 结论：可延后，但若仓库要开源则必须先处理路径泄露。

# 修复记录（第五次冻结后，基线 `3b36fce`）

## 1. 唯一阻断已修复：长选项唯一前缀缩写

`bash-readonly.ts` 新增 `isAbbreviatedLongFlag(flagName, specFlag)` 并接入 `dangerousArgOf`：

- 双方都以 `--` 开头（排除 `-` 短选项与 `--` 分隔符本身）；
- `specFlag.startsWith(flagName)`；
- `flagName.length > 2`（最短 `--x`）；`--flag=value` 先 `split('=')[0]`；
- 大小写敏感。

长度下限取 3（`> 2`）的理由：`--` 长度恰为 2 必须排除；`--co`（长度 4）实测已能执行 `file --compile`，不能用更长的下限；`file --c` 实测歧义报错，但按「宁可多弹」仍 ask。

实测（审计方复现路径，本机 `macOS` + `file` 5.41）：

```
cd /tmp/abbr && printf '0 string TEST hello\n' > test.magic
file --comp -m test.magic     # exit=0，生成 magic.mgc 7,273,344B
file --compil -m test.magic   # exit=0，同上
file --c -m test.magic        # file: option '--c' is ambiguous
```

策略判定修复后：`--compile` / `--compil` / `--compi` / `--comp` / `--com` / `--co` / `--c` / `--compil=1` 全部 `ask / file-compile`；`file /etc/passwd`、`file -b /etc/passwd`、`file --brief /etc/passwd`、`file --version` 仍 `allow / file`。

**修复前会失败**（临时把 `isAbbreviatedLongFlag` 改为恒 `false` 后复跑）：`file --compil` 得到 `decision: 'allow'`（期望 `ask`），首个失败断言即 `expected { decision: 'allow', … } to match object { decision: 'ask' … }`；还原后 22 passed，`diff -q` 校验 `RESTORED_OK`。

## 2. 全部登记危险参数的长选项缩写实测表

| 登记项 | 工具/子命令 | 唯一前缀实测 | 是否真可绕过 |
|---|---|---|---|
| `file --compile` | file（GNU getopt_long） | `--compile/--compil/--comp/--com/--co` 接受；`--c` ambiguous | **是（已覆盖）** |
| `git fsck --lost-found` | git fsck（parse-options） | `--lost-f` / `--lost` 接受 | **是（已覆盖）** |
| `git --textconv` | git diff/log/show | `--textc/--textco` invalid option | 否 |
| `git --ext-diff` | 同上 | `--ext/--ext-d` invalid option | 否 |
| `git --filters` | 同上 | `--filt/--fi` invalid option | 否 |
| `git --output=` | 同上 | `--out/--outp=` invalid option | 否 |
| `git --show-signature` | git log/show | `--show-sig` unrecognized argument | 否 |
| `git --paginate` | git 全局（手写解析） | `--pag` unknown option | 否 |
| `git --config-env` | 同上 | `--config-en` unknown option | 否 |
| `git --exec-path` | 同上 | `--exec-p` unknown option | 否 |
| `git --upload-pack` | 同上 | `--upload-p` unknown option | 否 |
| `git --receive-pack` | 同上 | `--receive-p` unknown option | 否 |
| `rg --pre` | ripgrep | `--pr` unrecognized flag | 否 |
| `rg --search-zip` | ripgrep | `--sea/--se/--search-z` unrecognized flag | 否 |
| `find -delete` 等 | find（BSD） | `-del`/`--delete` unknown predicate | 否 |
| `date --set` | BSD date / GNU date | BSD date illegal option；GNU date 接受唯一前缀 | 否（保守 ask） |
| `--open-files-in-pager` | git grep | N/A | 否（整条子命令已移出白名单） |

结论：**真正可被唯一前缀缩写绕过的登记项只有 `file --compile`（`--co` 起）与 `git fsck --lost-found`（`--lost-f` 起）**，两者已被通用前缀规则覆盖；其余工具拒绝缩写，通用规则只会让它们多弹一次（如 `git diff --text` 是独立真实选项，会被 `--textconv` 前缀规则误 ask，属安全侧成本，非漏判）。

## 3. 收紧 `git log -c` 误判（不新增漏判）

`DangerousArgSpec` 新增 `requiresAssignment?: boolean`；`dangerousArgOf` 改为索引循环，命中后若 `spec.requiresAssignment && !hasAssignmentValue(...)` 则 `continue`。`hasAssignmentValue` 同时看选项自身与紧邻下一个 token 是否含 `=`。

- `git log -c` / `git diff -c` / `git show -c` → `allow / git:log|diff|show`（combined diff，只读）；
- `git -c core.pager=cat status` / `git -ccore.pager=cat status` / `git -c core.fsmonitor=/tmp/hook status` → `ask / git-config-override`；
- git 全局 `-c` 缺少 `=` 时 git 自身报错，因此不会放走真实配置覆盖。

**修复前会失败**：临时移除 `requiresAssignment: true` 后，`git log -c -1` 得到 `decision: 'ask'` / `rule: 'git-config-override'`（期望 allow），用例首个断言失败；还原后 22 passed。

## 4. 校验结果

| 项 | 结果 |
|---|---|
| 定向套件 `approval` | 1 suite / **22 passed**（原 21 + 本轮 `git -c` 收紧 1） |
| `npx tsc --noEmit` | 通过（无输出） |
| `npx eslint src` | 通过（无输出） |
| `npx vite build` | 通过（main/preload 均 built） |
| 全量 `npx vitest run` | **173 failed / 3094 passed / 93 skipped（3360）**；26 个失败文件与既有集合一致 |
| 失败原因核验 | 173 条均为 `better-sqlite3` ABI（`NODE_MODULE_VERSION 130` vs 115） |

补充说明：首两次全量运行出现 **174 failed / 27 files**，多出的一条是既有的时序 flaky 断言 [pipeline.test.ts](file:///Users/zhumingchen/tiangong/src/main/memory/__tests__/pipeline.test.ts) `tracks duration`（`expect(durationMs).toBeGreaterThanOrEqual(10)` 在整仓并发下偶发 9.26ms）；单独运行该文件 6/6 passed，再次全量运行恢复 173/26。该断言与本轮改动无关，未修改该测试。

## 5. 文档同步

[agent-architecture.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md) §4.6 已补：长选项唯一前缀缩写规则、长度下限 `--x`（总长 3）的理由、实测缩写接受表、`git -c` 的 `name=value` 收紧、危险参数表对应行更新。

