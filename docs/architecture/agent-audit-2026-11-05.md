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


# 第六次冻结终审（发布门禁复核）

## 0. 冻结基线

| 项 | 值 |
|---|---|
| HEAD | `c11bab81e24636a6624e3530689b0b4f754e74f7` |
| subject | `fix(agent): 长选项唯一前缀缩写按命中处理，并收紧 git -c 误判` |
| 提交范围 | 4 files changed, 383 insertions(+), 10 deletions(-)：`bash-readonly.ts`、`bash-readonly.test.ts`、`agent-architecture.md`、本审计文档 |
| 工作区 | 仅 `?? spikes/spikes/`（11 file）；无修改、无暂存 |
| 定向用例 | 4 suites / **83 tests passed**（上一轮 80） |

与上一轮 `3b36fce` 同名 20 文件比对：**实际变化 2 个**——

```
5d1dc76a30d3…  src/main/agent/runtime/approval/bash-readonly.ts        （92f3eae9… → 5d1dc76a…）
4c7889ed28aa…  src/main/agent/runtime/approval/__tests__/bash-readonly.test.ts（0456b3d1… → 4c7889ed…）
```

其余 18 个（runtime / gateway / agent-manager / ipc / preload / schema / repository / ledger / locks / 适配器 / UI）sha256 与上一轮逐字节一致 → 上两轮结论直接沿用，本轮只需审策略文件。

`git show HEAD -- bash-readonly.ts` 全文 109 行 diff，只有两处：`dangerousArgOf` 增加 `isAbbreviatedLongFlag` 与 `requiresAssignment`，以及对应 `DangerousArgSpec` 注释/`-c` 的 `requiresAssignment: true`；`nodeRule`、`gitRule`、`git help` 分支、短选项簇函数均未改动。

## 1. 结论

**可发布。**

上一轮唯一阻断（`file --comp/--compil` 长选项缩写写盘）已由通用前缀规则封闭；本轮独立复扫未发现新的可实测绕过路径。

## 2. 本轮 3 项修复独立核验

### 2.1 `isAbbreviatedLongFlag`（长选项唯一前缀）

规则：`specFlag.startsWith('--') && flagName.startsWith('--') && flagName.length > 2 && specFlag.startsWith(flagName)`，`flagName = arg.split('=')[0]`，大小写敏感。

实测判定（策略层，重建 bundle 后逐条调用 `evaluateBashPolicy`）：

| 输入 | 判定 |
|---|---|
| `file --c` / `--co` / `--com` / `--comp` / `--compi` / `--compil` / `--compile` | 全部 `ask / file-compile` |
| `file --compil=1` / `--compile= ` / `--compile=a=b` | 全部 `ask / file-compile` |
| `file --brief` / `--version` / `file -b /etc/passwd` | `allow / file` |
| `file --Compile`（大小写不同） | `allow`（正确：GNU 长选项大小写敏感） |
| `rg --pr` / `--pre` / `--pre=` / `--search-z` | 全部 `ask` |
| `rg --pretty` / `--pre-glob` | `allow`（不是任何危险选项的前缀） |
| `date --se` / `--set=…` | `ask` |

真实执行侧复核：`file --co -m test.magic` exit=0 并写出 `magic.mgc`（证明该前缀确实等价 `--compile`），现已被 ask 拦截。

误判方向检查：规则是「参数是危险选项的前缀」，因此 `--pretty`、`--pre-glob`、`--brief` 这类独立选项不会被命中；`--flag =value`（空格）走精确匹配，`--flag=` 空值走 `flagName` 精确匹配，`--flag=value=more` 只在第一个 `=` 处切分 —— 三种形态均 ask，无漏判。

### 2.2 `git fsck --lost-found` 缩写

| 输入 | 策略 | 真实 git |
|---|---|---|
| `git fsck --lost-f` | `ask / git-lost-found` | **接受**：在 `/tmp/fsckrepo2` 造悬空对象后，`--lost-f` 与 `--lost` 都成功创建 `.git/lost-found` |
| `git fsck --lost` | `ask / git-lost-found` | 同上，接受 |
| `git fsck --lost-found` | `ask` | 接受 |
| `git fsck` | `allow / git:fsck` | 只读 |

结论：这是本机**确实可利用**的第二条缩写路径，现已被覆盖。

### 2.3 `git -c` 的 `requiresAssignment`

`hasAssignmentValue`：参数自身含 `=`，或紧邻下一 token 含 `=`。

| 角色 | 输入 | 判定 | 说明 |
|---|---|---|---|
| 子命令选项 | `git log -c` / `git diff -c` / `git show -c` | `allow / git:log|diff|show` | combined diff，只读，放宽正确 |
| 子命令选项（后跟路径） | `git log -c -p` | `allow` | `-p` 不是全局 paginate |
| 全局选项（分离） | `git -c core.pager=cat status` | `ask / git-config-override` | 下一 token 含 `=` |
| 全局选项（贴写） | `git -ccore.pager=cat status` | `ask / git-config-override` | 参数自身含 `=` |
| 全局选项（缺 `=`） | `git -c core.pager status` | **`ask / git:unknown:-c`** | `dangerousArgOf` 放过后，`gitRule` 因 `-c` 不是读子命令仍 ask —— 放宽未产生新通道 |
| 全局缺值 | `git -c --version` | `ask / git:unknown:-c` | 同上 |
| `--config-env` | `git --config-env=K=V` / `--config-e=K=V` | `ask / git-config-override` | 精确 + 缩写均命中 |

补充实测：`git -c <name>` 在 git 里等价 `<name>=true`（不需要等号），但 `gitRule` 的 unknown 分支仍然 ask，因此不存在“无等号即免审”的缝隙；`git log -c core.pager=cat` 这类子命令后的 `?=` 形态会被 `hasAssignmentValue` 多弹一次（安全侧过严，非缺陷）。

## 3. 长选项缩写面独立复扫

对每个已登记危险长选项，用本机工具实测其“少一个字符”的缩写是否被接受（接受=历史可利用，现已全部被前缀规则覆盖）：

| 命令 | 危险长选项 | 缩写实测 | 策略 |
|---|---|---|---|
| `file` | `--compile` | **接受**（`--co` exit 0，写 `magic.mgc`） | ask |
| `rg` | `--pre` / `--search-zip` | 拒绝（exit 2） | ask |
| `date` | `--set` | 拒绝（BSD date 无长选项） | ask |
| `git` | `--lost-found` | **接受**（`--lost-f` 创建 `.git/lost-found`） | ask |
| `git` | `--output` | `git diff --outpu` 拒绝（129） | ask |
| `git` | `--ext-diff` / `--textconv` | 拒绝（129） | ask |
| `git` | `--filters` | `git cat-file --filter` 拒绝（128） | ask |
| `git` | `--show-signature` | 拒绝（128） | ask |
| `git` | `--exec-path` / `--config-env` | 拒绝（129） | ask |
| `git` | `--upload-pack` / `--receive-pack` | 仅 fetch/clone/push 子命令，本身不在读白名单 → 恒 ask | ask |
| `find` | `-exec/-delete/...` | 单破折号原语，不支持缩写 | ask |

与修复方结论一致：本机可利用缩写仅 `file --co`（含 `--c`~`--compile`）与 `git fsck --lost-f/--lost`，两者均已覆盖。`git log --onelin`、`--outpu` 等拒绝缩写的形态被多弹一次，属安全侧误 ask。

## 4. 上两轮 12 项复核

| 项 | 判定 | 依据 |
|---|---|---|
| 1 `git grep` 整条 ask | 确认 | `--no-pager` 递归后 ask；`git grep -iOcat` 走 `git-grep` |
| 2 `git -p/--paginate`、`rg -z/--search-zip` | 确认 | 分离与簇写（`-nz/-iz/-wz`）全 ask |
| 3 引用计数 Map | 确认 | 文件 hash 未变 |
| 4 `agent:runNode` 删除 | 确认 | 三处零命中；生产 `.runNode(` 仅 `agent-manager.ts:1149` |
| 5 窗口绑定生命周期 | 确认（P3 偏差仍在） | 文件 hash 未变 |
| 6 全 0 usage 占位 | 确认 | 文件 hash 未变 |
| 7 `sessionGrantable` 严格布尔 | 确认 | 文件 hash 未变 |
| 8 `retention_hold` 死列 | 确认 | 文件 hash 未变 |
| 9 `node --check` 严格形态 | 确认 | `--check <file>` allow；`-r/--require/--import/--loader/--env-file` 全 ask；`NODE_OPTIONS=` 前缀形态 ask |
| 10 短选项簇算法 | 确认 | `-bC/-cC/-zC/-nz/-iz` ask；`-mC/-eC/-rnz/date -df` 不误判 |
| 11 `git help` 收紧 | 确认 | 仅 `args.length===1` allow |
| 12 `--show-signature` | 确认 | 精确与缩写均 ask |

## 5. worktree 不干净的影响

`?? spikes/spikes/` 为 11 个 sabotage 日志的重复副本，未进 git 索引，不会进入构建产物或安装包。判定：**不阻断发布**。建议处置（任选其一）：删除该目录，或在 `.gitignore` 增加 `spikes/spikes/`；发布流水线以 HEAD `c11bab8` 为准。

## 6. 非阻断残留与未验证

- `git diff/log/show` 的 textconv 自动执行、`git status` 的 `core.fsmonitor`、`git log --format=%G?` 拉 gpg：需本机既有配置，非仓库内容可直接触发（延续上一轮 P3）。
- `file -z`（解压查看）是否 spawn 外部解压程序未实测；`rg -z` 已登记为 ask。
- 窗口销毁后审批可被其它窗口决议（设计取舍）。
- 131 张 evidence 截图的画面内容仍未逐张审；DB 快照经 `.gitignore:52 *.db` 排除、未入库（与上一轮结论一致）。
- 未验证：`git -c` 缺等号等价 `<name>=true` 在具体“命令型配置”上能否造成执行（以 `gitRule` 恒 ask 兜底，理论上不可达）。

## 7. 冻结后复算

写报告后重跑 HEAD、`git status --porcelain -uall`、20 文件 sha256：源码 20 项与 §0 逐字节一致；HEAD 未变；新增变化仅本审计文档自身。若出现其它漂移，以漂移后状态为准并撤回结论。

## 8. 发布判定

**可发布。**

前提条件：
1. 发布以 `c11bab8` 为源；`bash-readonly.ts` 与测试的 hash 与 §0 一致；
2. 4 套件 83 用例全绿（已复核）；
3. `spikes/spikes/` 未进索引（现状满足），建议删除或 gitignore；
4. evidence/spikes 的处置沿用第五轮结论：私有/内网可延后；若要开源，先处理 9 个日志/JSON 中的绝对路径。

## 9. 第九轮独立复审（新审查方，2026-11-06）

本轮为独立复审：不采信前六轮结论，所有判定均来自本轮读码与实测。审查过程中一旦复现发布阻断，已先行口头报告（见 9.1）。

### 9.0 冻结基线

- HEAD：`9ef5c57a0465530d5434744da6a949280fa7d734`
- 审查开始时 `git status --short` 为空（干净工作区），审查结束时仍为空。
- 关键文件 sha256（审查开始时记录，写入本文件前又复算一次，见 9.6）：

| 文件 | sha256 |
| --- | --- |
| `src/main/agent/runtime/approval/bash-readonly.ts` | `5d1dc76a30d32676372f2bb685e587e60eb9342e73bea4d62cd4b95cc41aeda8` |
| `src/main/agent/runtime/runtime.ts` | `8ae91425f586accaeba5dc0938bdbc506862d895daac4ff7bf575a2b836525c1` |
| `src/main/agent/runtime/approval/gateway.ts` | `05d0d7eb48dce8031ab4bfa307634fcf4828acaca9d00de0c1170456dd399b18` |
| `src/main/agent/runtime/process/reaper.ts` | `d6c3594eee11b0301d2547ac20d57c2623a43cebbb5c916cdb87c6440c77fb43` |
| `src/main/agent/runtime/db/repository.ts` | `1ce61499a4fd90c3dac08c65f70075006a447479b2b27f7dfc3420be2efbe491` |
| `src/main/agent/runtime/db/schema.ts` | `b6f5bd073dc0db3722fd66da0e99d8719ff365d5d7270f381f2f023e5df2e990` |
| `src/main/ipc/agent.ts` | `09c558d008704a6d565902692bddcad0d89229b8ebf47f842ddf9291d9d8fb6f` |
| `src/main/agent/agent-manager.ts` | `84637def2907060c1c8f5dfee7b7d271b74392d716cfa8fc89ae77594ee46445` |
| `src/main/agent/runtime/feature-flags.ts` | `cfb578e1f4f57adb03c86174fb83717393ee2154211ba13311978ad6ed8aca86` |
| `src/main/agent/runtime/cost/ledger.ts` | `8588636b7eb82e12d6eca47b058310ed86047b6f99f3c0eb808c44c974e7d04d` |
| `docs/architecture/agent-architecture.md` | `1e014ceb97e0a3f64d2e1b59560c9f20bdbc707227748ba8036e5cb6e8adfd5e` |
| `docs/architecture/verification-ledger.md` | `291fb39631ee67c888a05999f1e1634377e5f2c5521b31c9239341791334211f` |
| `docs/architecture/agent-audit-2026-11-05.md` | `b0b4c26d4826b8be758b12e0c4af69d2e5df9ede08a0c75889821df8df5ab40e` |

### 9.1 结论：不可发布

唯一必要阻断 **B1（P0）**：Bash 只读白名单对「shell 动态展开」完全没有建模。策略判定发生在变量/花括号/ANSI-C 展开之前，因此只要把危险参数拆成 `$VAR`、花括号或 ANSI-C 片段，策略看到的就是一个"无害字面量"并返回 `allow`，而 shell 在执行时把它拼回危险参数。本轮实测四类变体全部零审批生效：

| ID | 命令原文（策略看到的文本） | 策略判定 | 实测效果 |
| --- | --- | --- | --- |
| A | `file --compil$UNSET -m t.magic` | `allow` | 生成 `magic.mgc`（7,273,344 字节） |
| B | `git diff --output$UNSET=/tmp/ev-b/out.diff` | `allow` | 写出 `out.diff` |
| C | `rg --pre$UNSET=/bin/rm TODO .` | `allow` | 目录内文件被 `/bin/rm` 删除，`remaining=0` |
| D | `find . {-delete,-delete}` | `allow` | 目录内文件全部被删除，`remaining=0` |
| E | `file {--comp,ile} -m t.magic` | `allow` | 生成 `magic.mgc`（7,273,344 字节） |
| F1 | `file --comp\<换行>ile -m t.magic` | `allow` | 反斜杠续行拼回 `--compile`，生成 `magic.mgc` |
| F2 | `file $'\x2d\x2d\x63\x6f\x6d\x70\x69\x6c\x65' -m t.magic` | `allow` | ANSI-C 引用拼回 `--compile`，生成 `magic.mgc` |

- 复现环境：macOS 默认 shell；`UNSET` 为未定义变量，展开为空串；`file --compile` 在 9ef5c57 上已被 `c11bab8` 判定为危险参数并应 `ask`。
- 影响面：`kernel` 对 Claude 默认开启（[feature-flags.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/feature-flags.ts)），Bash 白名单是当前 Claude 路径上唯一审批闸门，命中 `allow` 时**不经过** `ApprovalGateway`。因此 C/D/F 属于零审批任意执行与任意删除，不需要任何前置写权限；C 只使用系统自带 `/bin/rm` 即可完成。
- 根因：[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts) 的 `tokenize()` 只把 `$(` 与反引号识别为替换；`$VAR`/`${VAR}`/`$'...'` 只是普通字符累积（`$` 后不是 `(` 时走普通分支），`{`/`}` 与 `,` 从不作为 metachar，反斜杠+换行被当作字面换行拼进 token；`evaluateBashPolicy` 于是对参与「命令+参数」白名单匹配的是展开前文本。
- 最小改法：在 `tokenize()` 增加三类「动态展开」判定，命中即让 `evaluateBashPolicy` 返回 `ask`（rule 建议 `shell-expansion` / `shell-brace` / `shell-continuation`）：
  1. 单引号外的任意 `$`（覆盖 `$VAR`、`${VAR}`、`$'...'`、`$"..."`）；
  2. 单引号外的任意 `{` 或 `}`（brace expansion 先于分词）；
  3. `\` 后紧跟换行（line continuation）。
  这三项与现有「宁可多弹」原则一致，且不影响现有 allow 用例中不包含这些字符的命令。
- 配套测试（修复前必须失败）：`file --compil$UNSET`、`file {--comp,ile}`、`file $'\\x2d...'`、`file --comp\<换行>ile`、`rg --pre$UNSET=/bin/rm`、`find . {-delete,-delete}` 全部断言 `ask`；再补 `ls -la`、`git log --oneline -5`、`file -m t.magic` 仍为 `allow` 作为反向对照。

在该项修复并通过回归前，前一轮「可发布」判定（§8）作废。

### 9.2 本轮新发现（除 B1 外）

**B2（P1）`git status/diff/show/log -p` 默认执行仓库配置的外部程序。** 前轮已把 textconv/`core.fsmonitor` 记为 P3，但只描述了显式 `--textconv`/`--ext-diff` 参数。本轮实测：只要 `.git/config` 里存在 `diff.<driver>.textconv` 或 `core.fsmonitor` 或 `diff.external`，`git diff`（无任何危险参数）、`git log -p -1`、`git show HEAD`、`git status --porcelain` 都会以零审批执行配置中的程序（复现输出：`textconv=EXECUTED`、`fsmonitor=EXECUTED`）。该配置可由一次已批准的 Write 写入工作区 `.git/config`，随后在不触发任何审批的情况下获得任意命令执行，构成「一次写审批 → 后续零审批执行」的升级链；若打开的是带 `.git/config` 的不可信仓库目录，则无需任何前置审批。
- 最小改法（二选一）：(a) 在 `git` 规则命中 `status|diff|show|log|blame` 前，读取该仓库 `git config --get-regexp '^(diff\..*\.(textconv|command)|core\.fsmonitor|diff\.external)'`，命中即 `ask`；(b) 直接将 `diff/show/log/blame/status` 移出只读白名单，全部 `ask`。建议 (a)，成本可控且不牺牲全部只读体验。

**B3（P2）取消与完成的终态竞态，双向均可复现。** [runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L560-L568) 在 driver 返回后无条件 `updateTurnStatus(finalStatus)`；`cancelTurn()` 在 [runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L738-L761) 也多次无条件写 `cancelling/cancelled` 与 `output={reason}`；仓储层没有终态 CAS。两条实测：
1. 用户先取消、driver 之后仍返回 `completed` → 终态被覆盖为 `completed`，`output_json` 为空结果，取消记录与终态矛盾；
2. driver 已真正完成、`cancelTurn` 卡在慢速 `driver.cancel()` 时 → 终态被覆盖为 `cancelled`，`output_json` 被替换成 `{reason}`，真实最终文本丢失。
- 最小改法：终态写入改为条件更新（`UPDATE ... WHERE status IN ('running','waiting_approval','cancelling')`），首个终态胜出；`cancelTurn` 在 `driver.cancel` 返回后再次读取 DB，若已是终态则只补审计不覆盖；`runNode` finally 若检测到 `cancelled` 只记审计不覆盖。两条竞态需各自新增用例（本轮用临时 vitest 文件复现，文件已删除，git 状态干净）。

**B4（P2）测试基线依赖未入库的本地产物。** `openTestDb`（9 个测试文件使用）在 `NODE_MODULE_VERSION` 不匹配时回退到 `spikes/agent-core/node_modules/better-sqlite3`；该目录被 gitignore、`git ls-tree HEAD spikes` 中无任何 `node_modules/`。因此干净克隆无法复现「3094 passed / 173 failed」，改用 `openTestDb` 的 9 个文件会新增失败。173 条失败本身的归因成立（见 9.5）。

**B5（P2）文档承诺的「重启重推审批 + 批准后 replay」未实现。** [agent-architecture.md §7.4](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md#L989-L996) 写「未过期 pending 保留并重启重推、按 mode 计时；所属 turn 已 orphaned 则批准后走 RecoveryPlan(replay)」；实际 `ApprovalGateway.reconcileStartup` 对全部 pending 直接 `deny`（因 RecoveryPlanner 已把所有非终态 turn 标 orphaned），`reported.pendingApprovals` 恒为 0，`replay` 仅有类型和报告字段、无执行路径。行为本身比文档更保守（安全方向），但契约与代码不一致，且「无人值守 30s」在 `mode` 上不可达（driver 恒传 `interactive`）。建议改文档或在 M1 实现 replay。

**B6（P3）跨重启回收的「证据」合同被实现放宽。** [agent-architecture.md §6.5 b)](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md#L904) 要求「≥2 项且至少 1 项内容证据」；[reaper.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/process/reaper.ts) 额外允许 `trust==='trusted' && matched 含 startedAt && pid===pgid` 直接回收。该路径仅在「启动时 ps 可得 startedAt、但命令与记录不一致（exec 换镜像）」时可达，签名由本机运行时自铸，跨 uid 不可伪造；但按文档的定义（pid/startedAt 均属非内容证据）它不满足合同。建议或收紧实现，或把签名记录明确列为第三种内容证据并同步文档。

**B7（P3）`verification-ledger.md` U10 已过时。** ledger 仍写「§14.5 未验证（受阻）」，对应 [agent-realdevice-verification.md 第 443 行 §14.1 第 5 项](file:///Users/zhumingchen/tiangong/docs/architecture/agent-realdevice-verification.md#L443) 的历史状态；但同文件 [第 579 行 §15.1 第 2 项](file:///Users/zhumingchen/tiangong/docs/architecture/agent-realdevice-verification.md#L579) 已记录「不继承授权 通过」，[第 701 行 §15.5 第 6 项](file:///Users/zhumingchen/tiangong/docs/architecture/agent-realdevice-verification.md#L701) 又做了回归闭合。属于台账未同步，不影响行为。

**B8（P3）帮助类命令收紧不完整。** 文档 §4.6 声称 `git help <cmd>` 已收紧；实测 `git help status` 为 `ask`，但 `git log --help`、`git show --help`、`git status --help`、`git diff --help` 与裸 `git help` 均为 `allow`。它们会拉起 `man`/pager/`help.format=web` 配置的浏览器程序，属于 B2 同一「配置驱动执行」面，但当前未计入。

**B9（P3）跨窗口控制面无归属校验。** `agent:cancelTurn`/`agent:cancelSessionTurn`/`agent:terminateSession`/`agent:revokeSessionGrant`/`agent:closeAllSessions` 不校验调用窗口；`agent:resolveApproval` 仅对 `agent:startSession` 建立过绑定的会话生效，而重启后 `resumeSession` 只恢复本地状态、不重建绑定，故恢复会话的审批可由任意窗口决定。单窗口下不可利用，多窗口下语义不一致。

**B10（P3）`pipeline.test.ts` 时长断言存在理论 flaky 风险，本轮未复现。** 断言 `durationMs >= 10`，而 `durationMs` 用小数 `performance.now()` 差值，`setTimeout(10)` 的时钟域与 performance 时钟存在亚毫秒偏差；连续 12 次单跑全绿，未观察到 9.x。建议改 `toBeGreaterThanOrEqual(9)` 或去掉绝对值断言。

### 9.2.1 关键原文摘录（对应上节结论）

`src/main/agent/runtime/approval/bash-readonly.ts` → `tokenize()`（B1：只识别 `$(`/反引号；`\`+换行被拼进 token；`{`/`}` 从未处理）：
```ts
// 双引号内命令替换/反引号仍然生效
if (ch === '$' && command[i + 1] === '(') substitution = true
if (ch === '`') substitution = true
current += ch
i += 1
continue
...
if (ch === '\\' && i + 1 < len) {
  current += command[i + 1]
  i += 2
  continue
}
if (ch === '$' && command[i + 1] === '(') {
  substitution = true
```
第 102 行把 `\`+换行原样拼进 token（shell 会删除该续行），第 90/107 行只识别 `$(`，`$VAR` 落入普通字符分支；花括号 `{`/`}` 全文件无处理。

`src/main/agent/runtime/process/reaper.ts` → `killRegistered()`（B6：签名放宽路径不要求内容证据）：
```ts
const ownGroupLeader =
  identity.pgid !== undefined &&
  identity.pgid === identity.pid &&
  current !== undefined &&
  current.pgid === identity.pid
const structurallyBound = trust === 'trusted' && proof.matched.includes('startedAt') && ownGroupLeader
if (!proof.proved && !structurallyBound) {
  unresolved.push(proof)
  continue
}
```

`src/main/agent/runtime/runtime.ts` → `runNode()` finally（B3：无条件写终态，无 CAS）：
```ts
this.repo.updateTurnStatus(
  turn.id,
  finalStatus,
  finalStatus === 'completed'
    ? { endedAt: this.now(), output: { finalStatus, finalText } }
    : { endedAt: this.now(), failureClass: finalStatus === 'cancelled' ? 'aborted' : 'runtime' },
  this.now(),
)
```

`src/main/agent/runtime/runtime.ts` → `cancelTurn()`（B3：慢取消期间完成后仍会覆盖为 cancelled）：
```ts
const turn = this.repo.getTurn(turnId)
if (!turn || TERMINAL.includes(turn.status)) return false
this.repo.updateTurnStatus(turnId, 'cancelling', undefined, this.now())
...
if (driver) {
  try { await driver.cancel(this.requestFromTurn(turn)) } catch {}
}
this.repo.abortOpenSteps(turnId, this.now())
this.repo.updateTurnStatus(turnId, 'cancelled', { endedAt: this.now(), failureClass: 'aborted', output: { reason } }, this.now())
```

`src/main/agent/runtime/runtime.ts` → `reconcileOnStartup()`（B5：先 orphan 全部在途 turn，再统一 deny）：
```ts
const planned = planRecovery(this.repo)
applyRecoveryPlan(this.repo, planned)
assertNoDangling(this.repo)
const sweptExpired = this.approvals.sweepExpired()
...
// P1-3：重启后旧 pending 审批已无人能兑现 → 统一 deny（decided_by=startup），
// 且不再推 UI；只有所属 turn 仍存活的审批才会重推。
const reconciled = this.approvals.reconcileStartup()
```
配合 `repository.applyRecoveryPlan()` 的 `case 'abort_turn'` 会把 `running/waiting_approval/cancelling` 写成 `orphaned`，因此 `reconcileStartup` 的 `isFulfillable()` 对所有重启前 pending 都返回 false，`replayed` 恒为空。

`src/main/agent/runtime/db/repository.ts` → `applyRecoveryPlan()`（B5 的前置动作）：
```ts
case 'abort_turn':
  if (!plan.turnId) return
  this.abortOpenSteps(plan.turnId, now)
  for (const outcome of plan.stepOutcomes ?? []) {
    this.setStepDisposition(outcome.stepId, outcome.disposition)
    if (outcome.disposition === 'completed') {
      this.updateStepStatus(outcome.stepId, 'done', { endedAt: now, resultRef: 'recovery:snapshot-match' }, now)
    }
  }
  this.updateTurnStatus(plan.turnId, 'orphaned', { endedAt: now, failureClass: 'crash' }, now)
```

`src/main/agent/runtime/__tests__/helpers/test-db.ts` → `openTestDb()`（B4：干净克隆无回退模块）：
```ts
const direct = tryConstructor('better-sqlite3')
const fallback = path.resolve(process.cwd(), 'spikes/agent-core/node_modules/better-sqlite3')
const candidates = [direct, tryConstructor(fallback)].filter((item): item is DatabaseConstructor => item !== null)
...
throw new Error(
  'No Node-ABI better-sqlite3 available. Root module targets Electron ABI; ' +
    'spikes/agent-core/node_modules/better-sqlite3 is the expected local fallback.',
)
```

`src/main/ipc/agent.ts` → `agent:cancelTurn` / `agent:resolveApproval`（B9：前者无窗口归属，后者的绑定仅对 startSession 建过的会话生效）：
```ts
typedHandle('agent:cancelTurn', async (_, turnId) => {
  if (typeof turnId !== 'string' || turnId.length === 0) {
    throw new IpcError('turnId must be a non-empty string', ErrorCode.IPC_INVALID_ARGUMENT)
  }
  return runtime.cancelTurn(turnId)
})
...
const boundSender = sessionWindowBindings.get(input.sessionId)
if (boundSender !== undefined && boundSender !== senderId) {
  if (!isSenderAlive(boundSender)) {
    sessionWindowBindings.set(input.sessionId, senderId)
  } else {
    throw new AgentRuntimeError(...)
  }
}
```

### 9.3 对前轮结论的独立复核表

| 前轮结论 | 本轮判定 | 本轮依据 |
| --- | --- | --- |
| `c11bab8` 长选项前缀缩写已阻断 `file --compile` 绕过 | **推翻** | 字面缩写确实 `ask`（`--co/--compil/--c`），但 `$UNSET`/花括号/ANSI-C/续行四类变体均 `allow` 并实测生效；见 9.1 |
| `file -C/-bC`、`rg -z/-nz` 短选项簇已覆盖 | 确认 | 实测 `file -bC`、`rg -nz` 均 `ask`；但同属 9.1 根因可被展开绕过，覆盖不等于阻断 |
| `git grep` 整体移出白名单 | 确认 | `git grep TODO`、`git -iOcat TODO` 均 `ask` |
| `node --check` 严格形态 | 确认 | `node --check a.js` allow；带 `-r/--import` 均 `ask` |
| `--show-signature` 危险参数 | 确认 | `git log --show-signature -1` 为 `ask` |
| `git -c` 用 `requiresAssignment` 避免误判 | 确认 | `git -c core.pager=cat status` ask；`git -ccore.pager=cat` ask；`git log -c -1` allow |
| `git help` 收敛 | **部分** | `git help status` ask；裸 `git help` 与 `git <sub> --help` 仍 allow（B8） |
| 会话级授权与写类工具绑定（P0 阻断已修） | 确认 | `decide()` 用 `isWriteScopedTool` 拒绝非写类授予；`matchSessionGrant` 再次校验写类；Bash 恒 `interactive`/单向 |
| 成本双记已修 | 确认（有残余窗口） | `recordAdapterUsage` 在 `hasActiveTurn` 时丢弃 legacy 用量；但 kernel 标记在 `runNode` finally 释放，迟到的 legacy 事件理论上仍可双记，未复现 |
| `run.started` 续接锚点保留 | 确认 | 保留 SQL 显式排除 `RESUME_ANCHOR_EVENT_TYPE`；`getLatestBackendSessionId` 只读该类型 |
| 内核派发幂等键含 run/graph/attempt 且跨会话隔离 | 确认 | `dispatched = ${agentSessionId}:${runId|kernel:session:dispatch}`，`findTurnByIdempotencyKey` 同时按 session 过滤 |
| `resolveApproval` 归属校验 | 部分 | 有窗口绑定与 session/turn 校验；恢复会话无绑定（B9） |
| `agent:runNode` 删除，无 renderer 直通执行路径 | 确认 | `src/main/ipc` 与 preload 均无该 handler；其余 `agent:*` 无执行型副作用 |
| 173 失败均为 `better-sqlite3` ABI | 确认（基线可复现性另计） | 95 条 `NODE_MODULE_VERSION 130`，5 条为 setup 失败后的 `Cannot read ... 'close'` 级联，无业务断言失败；见 9.5 |
| 正常完成只 forget 不 kill、不裸 PID 回收 | 确认 | `runNode` 正常路径仅 `forgetProcess`；`killRegistered` 需 `proveOwnership`；启动清扫只对 `executor_pid` 且无法证明时告警 |
| 跨重启 ≥2 证据（含内容证据） | **部分** | 签名放宽路径见 B6 |
| evidence/spikes 提交卫生 | 确认（有非阻断项） | 无密钥、无 `node_modules`、`.db` 已 ignore；`spikes` 文档含本机绝对路径（用户名可见） |
| 当前版本可发布 | **推翻** | B1 阻断 |

### 9.4 `verification-ledger.md` 未验证项复核

- U1/U2/U3/U5/U6/U8/U9/U11/U12/U13/U16：本轮未做真机验证，仍按 ledger 保持「开放」；其中 U14 在 ledger 自身标注「未知」，本轮未取得新证据，仍为未知。
- U10（会话恢复后授权不继承）：**已闭合**，依据为 `agent-realdevice-verification.md` 的「不继承授权 通过」与 §15 闭合记录；ledger 未同步（B7）。
- U15（macOS 残留清理）：与前轮一致，属设计承诺；本轮静态复核 `proveOwnership`/`killRegistered` 路径与文档一致，但未做真实崩溃注入。
- 结论：ledger 中除 U10 外没有「已被真机验证但台账仍写未验证」的项；不要以「文档说已验证」替代真机证据。

### 9.5 测试与提交卫生

- `npx tsc --noEmit`：exit 0，无输出。
- 全量 `npx vitest run`：`3094 passed / 173 failed`，失败文件共 26 个，与基线一致。首行报错归类：95 处 `NODE_MODULE_VERSION 130 vs 115`，5 处为 setup 失败后的 `Cannot read properties of undefined (reading 'close')` 级联；日志中未出现 `AssertionError`/`expected ... to` 类业务断言失败（173 与 100 的差值来自同一测试的重复报错行，不是另一类失败）。
- 定向套件（`session-lock` / `run-node` / `approval-gateway` / `approval-startup-reconcile` / `recovery` / `cost-ledger`）全绿。
- 两个由本轮临时编写的复现用 vitest 文件（取消竞态、同幂等键并发）在取证后已删除，`git status` 回到空；同幂等键 + 不同 node 的并发派发实测第二个 `SESSION_BUSY`，锁语义符合约定。
- `pipeline.test.ts` 连续 12 次单跑未失败（B10 仅理论风险）。
- 提交卫生：HEAD 中 `spikes/` 123 文件、`docs/architecture/evidence/` 154 文件（13.6 MB），无 >2 MB 单文件、无 `node_modules`、无密钥/凭据模式、无 `Authorization` 头；`.db` 未被跟踪且 `.gitignore` 覆盖；`spikes` 文档含本机绝对路径 `/Users/zhumingchen/...`，属非阻断的卫生项。

### 9.6 冻结后复算

- HEAD 复算仍为 `9ef5c57a0465530d5434744da6a949280fa7d734`；`git status --short` 为空；9.0 表中 12 个源码/文档文件 sha256 逐字节复算一致，无基线漂移。
- 唯一变化是本审计文件自身（写入前 `b0b4c26d…`，写入后按定义变化，不计为漂移）。
- 本轮未修改源码、未 commit、未 push；`spikes/` 未改动。

# 修复记录（第七次终审后，基线 `9ef5c57`）

## B1（P0）：tokenize 未建模 shell 展开 → 修代码

`lex()` 增加 `expansion / brace / continuation / backslash / glob / tilde` 六个标记；`evaluateBashPolicy` 在危险参数判定之后、白名单规则之前，遇任一标记即 ask：

- 单引号外任何 `$`（含 `${}`、`$'...'`、`$"..."`、`$#`/`$?`/`$@`）→ `shell-expansion`；
- 单引号外 `{`/`}` → `shell-brace`；
- 反斜杠+换行 → `shell-continuation`；反斜杠转义空白/`-`/`${}`/glob/引号等语义字符 → `shell-backslash`；
- 单引号外 `*`/`?`/`[` → `shell-glob`；token 首或 `=`/`:` 后的 `~` → `shell-tilde`。

**glob / tilde 的取舍**：两者都能在运行时把字面 token 换成目录内容或家目录路径，且无法静态解析（`*` 甚至可能展开出名为 `-delete` 的文件，使 `find . *` 变成删除），因此按「无法静态解析就 ask」纳入；代价是 `rg TODO *` 会多弹一次。引号内的 glob/tilde 不展开，保持 allow（`find . -name "*.ts"` 仍 allow）。

**修复前会失败**：临时把 `shellExpansionVerdict` 的判定关掉后，新增用例首个断言 `rg --pre$UNSET=/bin/rm TODO .` 得到 `allow / rg`（期望 `ask / shell-expansion`）。还原后 24 passed。

六条原始写法全部断言 ask（其中两条因先命中已有危险参数，规则名不同但仍 ask）：

| 复审写法 | 判定 |
|---|---|
| `rg --pre$UNSET=/bin/rm TODO .` | `shell-expansion` |
| `git diff --output$UNSET=/tmp/out.diff` | `shell-expansion` |
| `file --compil$UNSET -m t.magic` | `shell-expansion` |
| `file $'\x2d\x2d\x63\x6f\x6d\x70\x69\x6c\x65' -m t.magic` | `shell-expansion` |
| `find . {-delete,-delete}` | `shell-brace` |
| `file {--comp,ile} -m t.magic` | `shell-brace` |
| `file --comp\` + 换行 + `ile -m t.magic` | `file-compile`（续行拼成精确标志，先命中危险参数） |
| `file \-\-compile -m t.magic` | `file-compile`（同上） |
| `cat a\ b`（转义空白改变 token 边界） | `shell-backslash` |
| `rg TODO *` / `cat ~/.zshrc` | `shell-glob` / `shell-tilde` |

反向对照：`rg '$HOME' file`、`grep '$PATH' file`、`find . -name "*.ts"`、`ls -la`、`git log --oneline -5` 仍 allow。

## B2（P1）：仓库配置驱动的执行 → 修代码（未移除白名单）

新增策略侧配置探针（未把 `git diff/log/show/status` 移出白名单，避免显著增加弹窗）：

- 从 cwd 向上定位 `.git`（支持 worktree 的 `gitdir:` 文件与 `commondir`）；
- 递归 follows `include.path` / `includeIf.path`（条件不复判，按可能命中处理）；
- 读取 `GIT_CONFIG_GLOBAL`、`~/.gitconfig`、XDG、系统配置（进程内缓存一次）；
- 任一文件出现 `[diff] external`、`[diff "x"] textconv`、`[core] fsmonitor` 的非空值 → `git-repo-config-exec` ask；
- 文件存在但不可读 → fail-closed（按危险处理）；配置干净 → 保持 allow。

覆盖子命令：`diff` / `log` / `show` / `status` / `blame` / `whatchanged`。用例用临时 `.git/config` 验证 `textconv`、`include` 里的 `fsmonitor`、以及干净仓库仍 allow。

已知边界：`includeIf` 条件未求值（读过但可能不生效 → 只会多弹）；配置值不做完整 git 语法求值（只做键值行扫描）；`git -C` / `--git-dir` 本身不在白名单（会 ask），不存在借道未扫描仓库的路径。

## B3（P2）：取消/完成终态双向竞态 → 修代码

`repository.finalizeTurnStatus()` 改为 CAS：`WHERE id = ? AND status NOT IN ('completed','failed','cancelled','orphaned')`，只有第一次终态写入生效。`runNode` 的 finally 与 `cancelTurn` 都改用它；若 runNode 的 `completed` 因取消先落而 CAS 失败，再用 `mergeTurnOutput()` 补记真实 `finalText`（不改状态/结束时间）。

**修复前会失败**：临时去掉 CAS 守卫后，两条新用例分别得到 `completed`（期望 `cancelled`）与 `cancelled`（期望 `completed`），且后者 `output` 被 `{reason}` 覆盖。还原后两条通过。

## B4：基线复现 → 改文档（不 skip）

全量 173 条 ABI 失败依赖未入库的 `spikes/agent-core/node_modules/better-sqlite3`。选择在 `agent-architecture.md §16` 写清复现步骤（`spikes/agent-core` 安装依赖后回仓库根跑全量），不为 26 个 DB 文件逐个加 skip —— 那会把真实回归一起静默掉。

## B5：§7.4 承诺 → 改文档（不改代码）

实际行为是「启动先扫过期 pending → 其余统一 deny(`decided_by='startup'`) → 不推 UI」；`RecoveryReport.pendingApprovals`（取 `reconcileStartup().replayed.length`）恒为 0，陈旧审批数记 `RecoveryReport.deniedStaleApprovals`；`mode='unattended'` 的 30s 分支无生产调用方，不可达。§7.4 与 V7 表述已降级为实际行为，并明确标注「改的是承诺，不是代码」。

## P3

- reaper 的结构性绑定例外已在 §6.5(b) 写明：仅对 HMAC 验签通过、`pgid===pid`、实时同组长、`startedAt` 匹配的身份生效；无签名/篡改记录仍须两项内容证据。**改的是合同表述**，代码维持。
- `verification-ledger.md` U10 已更新为「已验证（单测）+ 已关闭」。
- `git help` / `git --help` / `-h` / `<子命令> --help` 一律 `git-help` ask（`--version`/`-v` 仍 allow）；裸 `git help` 原 allow 已收紧。
- `cancelTurn`/`terminateSession`/`revokeSessionGrant` 三个 IPC 未校验调用窗口归属：同 uid renderer 只能取消/终止本机 agent 会话，属 DoS/UX 面，非权限提升；本轮不改，风险**中低**。

## 校验

- 定向：`approval` + `run-node` 共 47 passed。
- `tsc --noEmit` / `eslint src` / `vite build` 全过。
- 全量：`173 failed / 3098 passed / 93 skipped`（3364），失败 26 文件与基线集合一致；日志无 `AssertionError`，95 处 ABI 主错 + 级联，属既有 `better-sqlite3` ABI。


---

## 10. 第十轮独立复审（2026-11-06）

### 10.0 基线（复算）

| 项 | 值 |
|---|---|
| HEAD | `aa1fa49647e3d27cfddc60c9ee9fd97d8ebe7753`（父 `9ef5c57`，未 amend、未 push） |
| `git status --short` | 空 |
| `git ls-files spikes \| wc -l` | 123 |
| `bash-readonly.ts` sha256 | `de81d4bf8e327ea64ec981e3568e8490201a5e3cdf183c65d2c9024a66b259a5` |
| `runtime.ts` sha256 | `0f820b2bab5b7ed3cfa41f97b7fc3dfe223764cab0e6736a81db01cd1654e296` |
| `repository.ts` sha256 | `faa6c1635a68e2e0132ab60bb18dafc787d98708c65b723f0707f2d4b3fda6d3` |
| 本文档（追加前） | `27f595c0c73272d1c589c78fb6a5c338697e5f0301d66db7cdb79bb4b6566cbf` |

### 10.1 结论：**不可发布**

B1、B3 已闭合；B4/B5 的"文档处置"基本成立；**B2 只修了一半**：新增探针覆盖了常规配置，但仍有三条可实测绕过，其中两条能让 `git diff` 在 **allow 判定下**执行配置里的任意命令。按第九轮把 B2 定为 P1 的口径，本轮维持**不可发布**。

### 10.2 阻断项（均本轮实测）

#### P1-1 `diff.<driver>.command` 未被探针识别（零审批执行）

复现（真实 git 仓库）：

```bash
git init /tmp/r10-git && cd /tmp/r10-git
# 提交 a.txt 与 .gitattributes（*.txt diff=evil），修改 a.txt 后：
git config diff.evil.command '/bin/sh -c "echo EXEC_COMMAND > /tmp/r10-marker-command"'
git diff -- a.txt
ls -l /tmp/r10-marker-command      # 文件已生成 → 命令确实被执行
```

策略判定：`git diff HEAD` 返回 `allow / git:diff`。原因是 [bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts) 的 `gitConfigTextExecutes()` 对 `[diff ...]` 只认 `textconv` 与 `external`，漏了 git 同样会执行的 `command`（`diff.<driver>.command` 与 `diff.<driver>.textconv` 并列存在于 gitattributes 文档）。

最小改法：diff 节内把 `key === 'command'` 一并判危险（一行）。

#### P1-2 旧式子节语法 `[diff.<driver>]` 未被解析（零审批执行）

复现：

```bash
git init /tmp/r10-dot2 && cd /tmp/r10-dot2
printf '\n[diff.evil]\n\ttextconv = /bin/echo\n' >> .git/config
git config --get diff.evil.textconv   # 输出 /bin/echo（git 认可旧式语法）
```

在带 `.gitattributes: *.txt diff=evil` 的仓库中，把该行换成写 marker 的 textconv，`git diff -- a.txt` 实际生成了 `/tmp/r10-marker-legacy`；而策略对同一 `git diff HEAD` 返回 `allow / git:diff`。原因是 `[diff.evil]` 的 section 被解析成 `diff.evil`，`section.split(/\s+/)[0]` 不等于 `diff`。

最小改法：section 名按前缀判定（`/^diff(\.|\s|$)/` 视为 diff 节；`core` 同理），而不是只取第一个空格前的整串。

#### P1-3 生产路径的探针读的是 `process.cwd()`，不是会话工作目录

[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts) 的 PreToolUse 钩子直接 `evaluateBashPolicy(bashCommandOf(toolInput))`，未传 `cwd`，于是 `cwd` 默认 `process.cwd()`（Electron 主进程启动目录），而 SDK 实际在 `session.config.workingDirectory` 里执行 Bash。

实测（临时用例，走真实 `ClaudeCodeAdapter` + mock SDK）：会话目录是一个 `.git/config` 含 `[diff] external=/bin/rm` 的仓库，hook 对 `git diff HEAD` 返回 `permissionDecision: 'allow'`；同一命令在 `cwd` 指向该仓库时策略返回 `ask`。也就是说，**只要会话不在主进程 cwd，B2 的整套探针都不生效**。

最小改法：给 `evaluateBashPolicy`/`bashPolicyForTool` 增加可选的 `{ cwd }`，在 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts) 传 `session.config.workingDirectory`，在 [adapter-driver.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts) 与 [gateway.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts) 传 `request.workingDirectory`（否则审批卡片上的 rule 也会与钩子不一致）。

#### P2-1 全局配置缓存永不失效（长进程内 TOCTOU）

`globalGitConfigCache` 是模块级一次算好、永不更新。实测：进程内第一次（全局配置干净）`git diff HEAD` → `allow`；随后把 `$GIT_CONFIG_GLOBAL` 指向的配置写入 `[diff] external=/bin/true`，同一进程内再判 → 仍 `allow`；只有重新加载模块才 `ask`。Electron 是长驻进程，一次先安全的评估会让后续所有 `git diff` 放行。

最小改法：缓存按 `mtime + size` 失效，或直接去掉缓存（实测单次判定 0.047 ms，见 10.5，去掉缓存也无感）。

#### P3-1 `core.fsmonitor` 对 `git diff` 过度 ask

`git diff` 不使用 fsmonitor，但探针按"任一执行型键命中即 ask"，导致 `[core] fsmonitor=...` 的仓库连 `git diff` 也弹。只增加摩擦，无安全损失；可不改。

### 10.3 对 B1–B5 的独立判定

| 项 | 判定 | 依据（本轮实测） |
|---|---|---|
| B1 | **确认** | 7/7 原始命令策略判 `ask`；再经真实 `ClaudeCodeAdapter` 的 PreToolUse 钩子，7/7 返回 `permissionDecision: 'ask'`。见 10.4 的"没落地"方法说明。 |
| B2 | **部分（推翻"已闭合"）** | 常规矩阵全部正确：`diff.*.textconv`、`diff.external`、`core.fsmonitor`、`include.path`、`.git` 文件 + commondir、不可读配置、全局/系统配置均 `allow→ask`；干净配置不误 ask；探针不被 `'${X}'`/`'$X'` 绕过。但 P1-1/2/3、P2-1 仍开放。 |
| B3 | **确认** | 双向 + `cancel→complete→cancel` 三连：状态只写一次；取消先到时 `status` 保持 `cancelled`，`mergeTurnOutput` 补记 `real-final`，`ended_at` 保持取消时刻；第二次取消返回 `false`。既有两条用例 + 本轮临时三连用例均通过。 |
| B4 | **确认（文档可复现）** | `spikes/agent-core/package.json` 已入库（含 `better-sqlite3 ^12.11.1`）；根 `better-sqlite3` 实例化报 `NODE_MODULE_VERSION 130 vs 115`，`spikes/agent-core/node_modules` 版本可正常建库；本轮走 fallback 的 47 条定向用例通过。文档数字写 3098，用户基线 3094，属近似口径，非阻断。 |
| B5 | **部分（行为一致，字段名错）** | §7.4 的"启动扫描过期 pending → 其余 deny(`decided_by='startup'`) → 不推 UI"与 `reconcileStartup` 一致；`mode='unattended'` 仅测试使用，30s 分支不可达属实。但文档写 `RecoveryReport.replayed` 恒空——该类型**没有 `replayed` 字段**，实际字段是 `pendingApprovals`（`replayed.length`，启动后恒 0）。另外 [planner.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/recovery/planner.ts) 仍保留 `keep_pending_approval` 的误导注释，`agent-decisions.md` D-B 仍写"重启重推即重计时"，与 §7.4 新表述冲突。 |

### 10.4 B1"没落地"的验证方法与边界

- **策略层**：7 条命令逐条 `evaluateBashPolicy` → `ask`（规则分别为 `shell-expansion` / `shell-brace` / `file-compile`）。
- **真实钩子层**：用真实 `ClaudeCodeAdapter`（SDK `query` 仅 mock，不调模型）构建 PreToolUse 钩子，7 条全部返回 `permissionDecision: 'ask'`，未出现 `allow`。
- **无第二条执行路径**：`src/main/agent` 内 grep `execFile|execSync|spawn(|child_process`，只命中进程回收（`ps`/`taskkill`/`codex doctor`），没有任何"把 Bash 工具命令在宿主侧执行"的代码；Bash 实际由 Claude CLI 子进程执行，唯一闸门就是这个钩子。
- **ask 不可被自动放行**：审批网关的 `sessionGrants` 只对写类工具生效（授予工具与请求工具都必须是 write-scoped），Bash 永远无法命中会话级 grant。
- **边界（诚实说明）**：本轮没有可用的模型 API，未跑真实 CLI 回合；"无人审批即不落地"依据的是 SDK 契约（`permissionDecision: ask` 必须经 `canUseTool` 批准才执行）+ 上述无宿主侧执行路径，而不是端到端观察。该条列为仍未验证项。

### 10.5 新模型语法面与代价

语法面（自建临时用例，全部实测）：

- 相邻拼接 `a'b'c`、`"x"'y'`、`rg '"$X"'`、单引号内 `$(...)`/反引号/`${x:-y}` → **allow**，且真实 shell 下均为字面量，安全。
- `\'` → `shell-backslash` ask；`$((...))`、`$(<file)` → `shell-escape` ask；`${x:-y}` → `shell-expansion` ask。
- `!`、`case`、`for`、数组 `a=(x y)`、`;`/`&&`/`||`/`|`/换行、重定向、heredoc → 全部 ask（`not-in-whitelist` / `command-chain` / `and-chain` / `or-chain` / `pipe` / `newline` / `redirect` / `subshell`）。
- 注释 `ls -la # x` → allow（`#` 作为普通 token，真实 shell 忽略注释，无副作用）；`git diff HEAD~1` → allow（`~` 不在 token 首，不展开，判定正确）。
- 探针不被花括号绕过：evil 仓库中 `git diff '${X}'`、`git diff '$X'` 仍判 `git-repo-config-exec`；`git diff ${X}` 在进探针前就 `shell-expansion` ask。

代价回归（38 条常见命令抽样）：allow 30 / ask 8（78.9% allow）。ask 的 8 条为 `rg TODO *`、`cat ~/.zshrc`、`ls *.ts`（未加引号的 glob/tilde）、`npm test`、`rm -rf`、`find -delete`、`git commit`、`curl | sh`。常态只读命令（`ls -la`、`git log --oneline -5`、`git diff`、`rg TODO .`、`find . -name "*.ts"`）均 allow，未出现"绝大多数都 ask"的摩擦。主要新增摩擦是**未加引号的 `*`/`~`**，属有意保守。

探针成本：无子进程；同步 `existsSync` 向上最多 30 层 + 读取 `.git/config`/commondir/全局/系统配置（全局有缓存）。本机 200 次 `git diff HEAD` 平均 **0.047 ms/次**，可忽略；没有新增异步阻塞，TOCTOU 仅剩"策略判定 → CLI 执行"之间的毫秒级窗口（任何配置型防护都有）。

### 10.6 新发现汇总

| 级别 | 项 | 状态 |
|---|---|---|
| P1 | `diff.<driver>.command` 未识别 | 实测，阻断 |
| P1 | 旧式 `[diff.<driver>]` 子节语法未解析 | 实测，阻断 |
| P1 | 生产钩子用 `process.cwd()` 而非会话目录 | 实测，阻断 |
| P2 | 全局配置缓存永不过期（长进程 TOCTOU） | 实测 |
| P3 | §7.4 字段名 `RecoveryReport.replayed` 不存在（应为 `pendingApprovals`） | 实测（读类型定义） |
| P3 | `planner.ts` 的 `keep_pending_approval` 注释仍与行为不符 | 实测（读码） |
| P3 | `agent-decisions.md` D-B 仍承诺"重启重推即重计时" | 实测（读文档） |
| P3 | `core.fsmonitor` 对 `git diff` 过度 ask | 实测，仅摩擦 |
| P3 | 取消先到时 `status=cancelled` 而 `output_json.finalStatus=completed` | 语义不一致，需产品确认是否可接受 |

### 10.7 仍未验证项

1. **B1 端到端"没落地"**：无模型 API，未跑真实 CLI 回合；仅由"钩子 ask + 无宿主执行路径 + SDK 契约"推断。
2. **`log.showSignature` + `gpg.program` 配置触发执行**：`git log` 在不带 `--show-signature` 时会读取 `log.showSignature`，理论上可执行 `gpg.program`；探针未覆盖。需要带签名的提交与可用 gpg 才能实测，本轮未构造。
3. **per-worktree `config.worktree`**：启用 `extensions.worktreeConfig` 时 `core.fsmonitor` 可写在 `.git/config.worktree`，当前探针未读该文件；未实测。
4. **全量测试基线**：本轮只跑了走 fallback 的 47 条定向用例，未重跑 3094/173 全量；B4 的"同一基线"依赖 10.3 的组件级验证。
5. **`pipeline.test.ts` 时长断言 flaky**：本轮未复现并发下的 174/27 抖动。

### 10.8 冻结复算

追加后复算：源码三文件哈希与 10.0 一致；工作区仅有本文件 `M`。

- `bash-readonly.ts` = `de81d4bf…`（同 10.0）
- `runtime.ts` = `0f820b2b…`（同 10.0）
- `repository.ts` = `faa6c163…`（同 10.0）
- 本文档追加前 = `27f595c0…`（10.0）；写入第十轮后哈希按定义变化，文档自身不参与冻结漂移判定。
- `git status --short` = 仅 ` M docs/architecture/agent-audit-2026-11-05.md`

### 10.9 修复记录（基线 `aa1fa49`）

**B2（代码，四条全修）**

- P1-1：`gitConfigTextExecutes()` 的 diff 节判定加入 `command`；`[diff "evil"] command` 现为 `ask / git-repo-config-exec`。
- P1-2：节名改为前缀判定 `section === name || section.startsWith(name + '.') || section.startsWith(name + ' ')`；`[diff.evil]` 与 `[diff "evil"]` 同等命中，`core` / `filter` / `log` 也走同一 helper。节头允许尾随注释（`[diff "evil"] # note`）。
- P1-3：`bashPolicyForTool` 接收可选的 `{ cwd }` 并透传 `evaluateBashPolicy`；生产路径三处接线：`claude-code.ts` 取 `session.config.workingDirectory`，`adapter-driver.ts` 取 `request.workingDirectory`，`gateway.ts` 取请求 `cwd`（审批重放用 `row.cwd`）。
- P2-1：删除全局配置缓存，每次现读。选择「去缓存」而非 mtime+size：单次约 0.05 ms，mtime 失效仍受时间戳精度与同尺寸改写竞态影响。
- 顺带（可安全修）：仓库本地 `filter.<driver>.clean|smudge|process` 在 `status`/`diff` 判定；`log.showSignature=true` 在 `log`/`show`/`whatchanged` 判定；新增读取 `.git/config.worktree`（per-worktree `core.fsmonitor`）。全局 `filter` 刻意排除：`git lfs install` 会写 `clean/smudge/process`，纳入会让所有 LFS 用户的每次 `status`/`diff` 弹窗；仓库本地配置才是「一次 Write 改写 `.git/config`」的直接威胁面。`gpg.program` 单独不执行，故只探测 `log.showSignature`。
- 保留：`core.fsmonitor` 对 `git diff` 仍 ask（10.2 P3-1 已判「仅摩擦、可不改」；按安全侧保留）。

**B5（承诺/字段名，不改行为代码）**

- `agent-architecture.md §7.4`：`RecoveryReport.replayed` → `pendingApprovals`（取 `reconcileStartup().replayed.length`，恒 0）；陈旧审批数记 `deniedStaleApprovals`。
- `planner.ts` 的 `keep_pending_approval` 注释改为「保留供审计，启动对账 deny(startup)，不重推」；`gateway.ts` / `repository.ts` 同类误导注释同步。
- `agent-decisions.md` D-B 及 IPC/UI/依赖/时间点表述统一为「重启不重推、不重计时，启动即 deny」。

**修复前会失败（临时回退实测）**

| 用例 | 回退后实际 | 期望 |
|---|---|---|
| P1-1 `diff.evil.command` | `allow / git:diff` | `ask / git-repo-config-exec` |
| P1-2 `[diff.evil] textconv` | `allow / git:diff` | `ask / git-repo-config-exec` |
| P1-3 会话 cwd ≠ 主进程 cwd | `allow / git:diff` | `ask / git-repo-config-exec` |
| P2-1 同进程改写全局配置 | 第二次仍 `allow` | `ask / git-repo-config-exec` |

**校验**

- 定向：`bash-readonly` 29 passed；三个套件共 57 passed。
- `tsc --noEmit` / `eslint src` / `vite build` 全过。
- 全量：`26 failed 文件 / 253 passed`；`173 failed / 3103 passed / 93 skipped (3369)`，失败文件集合与基线 26 个 ABI 文件一致。

---

## 11. 第十一轮独立复审（第三轮 B2 复验，2026-11-06）

### 11.0 基线（复算）

| 项 | 值 |
|---|---|
| HEAD | `6839fe7132f0efe2cc811deb04eefed34eac497b`（父 `aa1fa49`，未 amend、未 push） |
| `git status --short` | 空（本轮开始前） |
| `git ls-files spikes \| wc -l` | 123 |
| `bash-readonly.ts` sha256 | `9069db8958084f75e8ea95649360ba007507bf5c647a3ad36237211b6f548515`（父提交 `de81d4bf…`） |
| `claude-code.ts` sha256 | `d033bc2249a4bf833c2c2fcbdebca1129f39ee60f888413d199607bee558c24d`（父提交 `0d1e221d…`） |
| `adapter-driver.ts` sha256 | `fdbdcda730c8a8e7739aa2e5959414a3a1e991e3b1f975654d1f559460ede1d8` |
| `gateway.ts` sha256 | `1f9f6a0d3d79198fcfedf3cca66f15fb7d5d4f230c60b9e2c031cd17c23642c5` |
| `planner.ts` sha256 | `825ff131add8d51d5bdd0053a8fb72b5619b2663e58c1dff9ec26146900b4d07` |
| `repository.ts` sha256 | `8075bfccb10aab237d3462b6e45fc67878e68526d7b14531f021557419a7d2d0` |
| 本文档（追加前） | `376b4dcf21affb24536bdc8c6d28659aa49d0f742f8d3456042cfb6cb328e869` |

本轮所有判定均来自自建复现（真实 git 仓库 + 真实 `ClaudeCodeAdapter` PreToolUse 钩子 + 临时 vitest 用例），不采信“已修复”的书面声明。临时用例跑完即删除。

### 11.1 结论：**可发布**（B2 四条阻断闭合）

P1-1、P1-2、P1-3、P2-1 四条在上轮均为实测阻断，本轮在 `6839fe7` 上逐条复现为 `ask / git-repo-config-exec`，且真实执行侧（策略判定之外直接跑 git）仍能产生副作用——说明探针是唯一屏障，而探针现在生效。旧提交 `aa1fa49` 与新提交的对照也复现了修复前后差异。

保留两条非阻断缺口，见 11.2；若产品把“全局 `filter` 驱动”也纳入 B2 威胁面，则应改判**不可发布**。本审计按“一次被批准的 Write 改写仓库本地 `.git/config`”这一既有威胁模型判**可发布**。

### 11.2 阻断清单

**无。** 上轮四条阻断全部闭合。

非阻断残留（不改变发布判定，但建议排期）：

| 级别 | 项 | 证据 |
|---|---|---|
| P2 | 全局 `filter.<name>.clean/smudge/process` 被刻意跳过；恶意仓库只要在 `.gitattributes` 写 `* filter=<name>`，即可让 `git status`/`git diff` 执行**全局配置里已有的**同名 filter，而策略 `allow`。不要求全局 `core.attributesFile`，比第十轮描述更宽 | 11.4 实测：全局 `filter.evil.process` + 仓库 `.gitattributes`，`git status` 写出 marker，策略 `allow` |
| P3 | §7.4 “不重推 UI，也不进入 replay” 只在“先 `planRecovery` 把活 turn 置 orphaned、再 `reconcileStartup`”的生产顺序成立；`reconcileStartup` 自身遇到活 turn 会 `replayRow → onRequest` | 11.3 实测 `replayed=1 / pushed=1` |
| P3 | `agent-rollout.md` D4 交付物名仍写“pending 重推”，与 D-B 已统一的“不重推”冲突 | 读文档 |
| P3 | `core.fsmonitor` 探针未按子命令收窄：`git log`/`git show` 不执行 fsmonitor 却仍 ask（真实过度 ask）；`git diff` 反而**确实执行** fsmonitor（第十轮“diff 过度 ask”的结论应撤回） | 11.4 实测 |
| P3 | `config.worktree` 无条件读取：未开 `extensions.worktreeConfig` 时 git 根本不读该文件，策略仍 ask（过度 ask，安全侧） | 11.4 实测 |

### 11.3 对 P1-1 / P1-2 / P1-3 / P2-1 / B5 的独立判定

| 项 | 判定 | 本轮实测依据 |
|---|---|---|
| P1-1 `diff.<driver>.command` | **确认修复** | 真实仓库 `[diff "evil"] command = /bin/sh -c "echo X > marker"`：策略 `ask / git-repo-config-exec`；绕过钩子直接 `git diff HEAD` 仍生成 marker。`diff.external` 同样。空值 `command =` 判 `allow`（git 实测不执行）；`command = ""` 判 `ask`。`include.path` 链、节头尾随注释均命中。 |
| P1-2 旧式 `[diff.evil]` | **确认修复** | `[diff.evil] textconv = …`：策略 `ask / git-repo-config-exec`；直接 `git diff HEAD` 生成 marker。节名前缀匹配同时覆盖 `[diff "evil"]` / `[diff.evil]` / `[diff]`。 |
| P1-3 会话 cwd ≠ 主进程 cwd | **确认修复** | 同一真实适配器钩子用例：`aa1fa49` 树 → `allow / git:diff/low`；`6839fe7` 树 → `ask / git-repo-config-exec/high`（会话目录 evil、进程 cwd clean）。DB 侧 `row.cwd` 反序列化后仍指向原仓库：`listPendingPayloads()` 复算得到 `policyRule=git-repo-config-exec`。 |
| P2-1 全局配置缓存 | **确认修复** | 同进程先判干净全局配置 → `allow`；写入 `[diff] external` 后**立即** `ask`，无需重载模块；单次判定 0.0911 ms（200 次平均）。 |
| B5 文档/字段/30s | **部分** | `RecoveryReport.pendingApprovals` 字段存在（`planner.ts`、`shared/types`），`runtime.ts` 取 `reconcileStartup().replayed.length`，`deniedStaleApprovals` 取 `denied`；planner 注释、D-B 主表与关键约束已改为“不重推、不重计时、启动即 deny”；生产代码中无 `mode='unattended'` 调用方（仅测试），30s 不可达属实。**但** §7.4 的“不进入 replay”是序列级而非函数级：活 turn 上 `reconcileStartup` 实测 `replayed=1、denied=0、pushed=1`；终态 turn 上才是 `replayed=0、denied=1、pushed=0`。`agent-rollout.md` D4 标题仍写“pending 重推”。 |

### 11.4 顺带项真实性

| 项 | 结论 | 证据 |
|---|---|---|
| per-worktree `config.worktree` | **真被读**；但 git 只在 `extensions.worktreeConfig=true` 时才执行 | 仓库 `.git/config.worktree` 写 `core.fsmonitor`：未开扩展时真实 `git status` 不调用（marker NO），策略仍 `ask`（过度 ask）；开启扩展后真实调用（marker YES），策略 `ask` 正确 |
| `filter.clean/smudge/process` 仅仓库本地 | **符合代码**，且 `status`/`diff` 边界准确 | 仓库本地 `filter.evil.clean`：`git status`、`git diff` 真实调用（marker YES）；`git log -p`、`git show HEAD`、`git blame a.txt` 均不调用（marker NO）。全局 filter 不纳入判定 |
| 全局 filter 的威胁面 | **比文档描述更宽**（P2） | 只需仓库 `.gitattributes` 指向一个**全局已存在**的 filter 名，即可在 `status`/`diff` 执行；无需全局 `core.attributesFile`。实测 marker YES，策略 `allow` |
| `git lfs install` 不误 ask | **确认**（模拟） | 本机全局配置确有 `filter.lfs.clean/smudge/process/required`；仓库 `.gitattributes: *.bin filter=lfs …` 下 `git status` / `git diff` 判定 `allow`。本机未安装 `git-lfs` 二进制，长驻 process 协议未实跑 |
| `log.showSignature` + `gpg.program` | **触发条件精确偏保守** | 手工构造带 `gpgsig` 头的提交 + `[log] showSignature=true` + `[gpg] program=<marker>`：普通 `git log` 真实调用 gpg 程序（marker YES）；同一配置下 unsigned 提交不调用（marker NO）。策略对 `log`/`show`/`whatchanged` 一律 ask，不看提交是否带签名 |
| `gpg.program` 单独不执行 | **确认** | 只读子命令不设 `log.showSignature` 时，`gpg.program` 不会被拉起 |
| `core.fsmonitor` 触发范围（**更正第十轮**） | `git diff` **会**调用 fsmonitor；`git log`/`git show` **不会**，但探针仍 ask | 真实仓库 `core.fsmonitor=<marker>`：`git diff HEAD` marker YES、`git status` YES、`git blame` YES；`git log`/`git show` NO。第十轮 P3-1 “`git diff` 过度 ask”应撤回；真实过度 ask 在 `log`/`show`/`whatchanged` |

### 11.5 新模型 + B2 探针的组合绕过

| 组合 | 结果 | 说明 |
|---|---|---|
| `git -C <evil-repo> diff HEAD` | **ask**（`git:unknown:-C`） | 探针不会跟着 `-C` 走，但整条命令在进探针前就因未知全局选项 ask，无法借此绕过 |
| `git --git-dir=… diff` / `--work-tree=…` / `GIT_DIR=…` | **ask** | 同上（未知选项 / 未在白名单的环境赋值） |
| `GIT_CONFIG_GLOBAL=<evil> git status` | **ask**（`not-in-whitelist`） | 环境赋值不改变判定，也不会让探针误读该文件 |
| `git -c core.attributesFile=… diff` / `git -c core.pager=… status` | **ask**（`git-config-override`） | 带 `=` 的 `-c` 一律 ask |
| `git log -c -1` / `git diff -c` | **allow** | 无等号的 `-c` 是子命令选项，只读 |
| `git diff '${X}'` / `'$X'`（evil 仓库） | **ask**（`git-repo-config-exec`） | 单引号内不展开，进入探针后仍命中 |
| `git diff ${X}` / `"$X"`（evil 仓库） | **ask**（`shell-expansion`） | 在探针之前就 fail-closed |
| `git diff --submodule=diff`（子模块 evil） | 子模块 external **不执行**（marker NO） | 策略仍按父仓库判定；该形态不构成额外执行面 |

### 11.6 摩擦与成本

本轮自建 38 条常态命令抽样（含只读、git、包管理、危险样例）：

- **allow 31 / ask 7（81.6%）**。
- ask：`node --version`（`node` 只放行 `--check` 严格形态）、`npm test`、`npm run build`、`yarn test`（非只读白名单）、`rm -rf dist`、`curl … | sh`、`cat ~/.zshrc`（`~` 展开）。
- 常态只读（`ls -la`、`git status`、`git log --oneline -5`、`git diff`、`rg TODO .`、`find . -name "*.ts"`、`git show HEAD`、`git blame` 等）均 allow。
- 与上一轮相比比例基本持平；本轮新增的可见摩擦只在**仓库已配置 `core.fsmonitor` 时对 `git log`/`git show` 的过度 ask**（探针未按子命令收窄），以及 `config.worktree` 未开扩展时的过度 ask。`filter`/`showSignature` 探测本身没有抬高常态命令摩擦（干净仓库不命中）。
- 成本：200 次 `git diff HEAD` 平均 **0.0911 ms/次**（同步读配置，无子进程），可忽略。

### 11.7 仍未验证

1. **真实 CLI 端到端**：无模型 API，未跑真实 Claude CLI 回合；ask 不落地仍由“钩子 ask + 无宿主执行路径 + SDK 契约”推断。
2. **全量测试基线**：本轮只跑定向套件（`bash-readonly`、`approval-gateway`、`approval-startup-reconcile` 共 61 passed），未重跑 3103/173 全量。
3. **`git-lfs` 真机**：本机未安装二进制，LFS 场景只用主机现有全局 `filter.lfs.*` + 仓库 attributes 模拟，长驻 `filter-process` 协议未实跑。
4. **全局 filter 缺口（复验时未修）**：属文档明确取舍（LFS 摩擦 vs 威胁面）；本轮已按“全局只放行已知 LFS 值、其余 ask”修复，见 11.9。
5. **`includeIf` 条件未求值**：探针按“可能命中”递归，未按 `gitdir:`/`onbranch:` 条件裁剪；只会过度 ask，不漏判。
6. **`GIT_CONFIG_SYSTEM` 实环境**：代码读取该变量与 `/etc/gitconfig`，本轮未构造系统级配置实测。

### 11.8 冻结复算

- 源码/文档哈希与 11.0 一致（本轮未改源码、未 commit、未 push）。
- `git status --short` = 仅 ` M docs/architecture/agent-audit-2026-11-05.md`。
- 三个临时测试文件（策略矩阵、真实钩子、网关 `row.cwd`）与两个补充用例（LFS、成本）均已删除，工作区无 `__tmp_r11_*` 残留。
- 定向回归：`bash-readonly.test.ts` 29 passed、`approval-gateway.test.ts` 28 passed、`approval-startup-reconcile.test.ts` 4 passed（共 61）。

### 11.9 修复记录（第三轮复验后，基线 `6839fe7`）

**必修：全局 `filter` 缺口（代码）**

- `gitConfigTextExecutes()` 的全局分支不再跳过 `filter`：`status`/`diff` 下，`filter.*.clean|smudge|process` 仅当值匹配 git-lfs 标准写法才 allow，其余一律 `git-repo-config-exec` ask。仓库本地 filter 仍三项全 ask。
- LFS 匹配：先归一化（去包裹双引号、折叠连续空白），再要求二进制 basename 为 `git-lfs` 或 `git-lfs.exe`（允许 `/usr/local/bin/…` 路径前缀）且参数精确为 `clean -- %f` / `smudge -- %f` / `filter-process`。误判风险：伪装成 `git-lfs` 的绝对路径（如 `/tmp/git-lfs`）也会放行；但全局配置属于用户，能改全局配置者本就能用 `diff.external` 执行任意程序，不扩大威胁面。
- 复现：全局 `[filter "mine"] clean = /bin/echo pwned` + 仓库 `.gitattributes` `* filter=mine` → 修复前 `allow / git:status`（marker 会写入），修复后 `ask / git-repo-config-exec`；`git diff` 同样。
- LFS 对照：标准 `git-lfs clean -- %f` / `git-lfs smudge -- %f` / `git-lfs filter-process` → `allow / git:status`、`allow / git:diff`；`/usr/local/bin/git-lfs`、`git-lfs.exe`、引号包裹写法同样 allow。

**文档与探针精度（代码 + 承诺）**

- `core.fsmonitor` 收窄到 `status`/`diff`/`blame`：修复前 `git log` / `git show` 被 ask，修复后 allow；`status` / `diff` / `blame` 仍 ask。依据：复审实测这三条会调用 fsmonitor，`log`/`show` 不刷新 index。
- `config.worktree` 按 `extensions.worktreeConfig` 判定：未开启时不读该文件，修复前 `git status` 被 ask，修复后 allow；开启后仍 ask。
- `agent-architecture.md §7.4`：明确“不进入 replay”是**生产启动序列级**语义；`reconcileStartup` 函数对活 turn 会 `replayed=1 / pushed=1`，对终态/orphaned turn 才是 `replayed=0 / denied=1 / pushed=0`。
- `agent-rollout.md` D4 标题改为“启动即 deny（不重推）”。
- `includeIf` 保留不求值：只多 ask 不漏判；求值需匹配 gitdir/onbranch 等条件与通配符，成本高。
- `GIT_CONFIG_SYSTEM`：已纳入候选，解析与不可读 fail-closed 逻辑同全局配置；未构造非默认路径实测，风险低。

**修复前会失败（临时回退实测）**

| 用例 | 回退后实际 | 期望 |
|---|---|---|
| 仓库 `.gitattributes` → 全局自定义 filter | `allow / git:status` | `ask / git-repo-config-exec` |
| `core.fsmonitor` + `git log` / `git show` | `ask / git-repo-config-exec` | `allow / git:log`、`git:show` |
| 未开 `extensions.worktreeConfig` + `config.worktree` | `ask / git-repo-config-exec` | `allow / git:status` |

**校验**

- 定向：三个套件实测 **66 passed**（`bash-readonly` 34、`approval-gateway` 28、`approval-startup-reconcile` 4）。§11.9 初稿写作“62 passed”是修复过程中较早一次运行的临时计数，已被本轮 §12.8 复算（66）修正；第四轮复审后追加 3 条裸键用例，定向变为 69（见 §12.9）。
- `tsc --noEmit` / `eslint src` / `vite build` 全过。
- 全量：`26 failed 文件 / 253 passed`；`173 failed / 3108 passed / 93 skipped (3374)`，失败文件集合与基线 26 个 ABI 文件一致。

## 十二、最终轮 B2 复验（第四轮，2026-11-06）

### 12.0 冻结基线（复算前）

| 项 | 值 |
|---|---|
| `git rev-parse HEAD` | `938504a40458550d80b922bae967fb9e1988e745` |
| `git rev-parse HEAD~1` | `6839fe7132f0efe2cc811deb04eefed34eac497b` |
| `git status --short` | 空 |
| `git ls-files spikes \| wc -l` | 123 |

关键文件 sha256（追加前）：

```
f9e2c6dd79da3b8c7438f55bdbe9e4abe4f3ae8c93dc38abb2922060e7cc3a32  src/main/agent/runtime/approval/bash-readonly.ts
42777f11366ff4c78a2a9cea8955490bf8a5b9b588669b174e3cdeba36796638  src/main/agent/runtime/approval/__tests__/bash-readonly.test.ts
d033bc2249a4bf833c2c2fcbdebca1129f39ee60f888413d199607bee558c24d  src/main/adapters/claude-code.ts
fdbdcda730c8a8e7739aa2e5959414a3a1e991e3b1f975654d1f559460ede1d8  src/main/agent/runtime/executors/adapter-driver.ts
1f9f6a0d3d79198fcfedf3cca66f15fb7d5d4f230c60b9e2c031cd17c23642c5  src/main/agent/runtime/approval/gateway.ts
825ff131add8d51d5bdd0053a8fb72b5619b2663e58c1dff9ec26146900b4d07  src/main/agent/runtime/recovery/planner.ts
9f92e0a27e3864133bce6127c77821850d49dfb2b750684ece748133bb5f1887  docs/architecture/agent-architecture.md
7b948a2c62fcc742e956245622e8863f8723cc5edf9bf5ed93ad255b9c2fccd0  docs/architecture/agent-rollout.md
54b69b10bbb487a1c8a5733a34c838869c29a8f0aff0d0ece8e5638c441f54aa  docs/architecture/agent-decisions.md
ed09e84d82b9953e094ebf57c3da26e63423c613e9f2a45322d4396d79482061  docs/architecture/agent-audit-2026-11-05.md
```

### 12.1 结论：**不可发布**

本轮声称的两处修复（全局 filter 只放行标准 LFS、`config.worktree` 按扩展门控）本身有效；但**门控实现引入了 1 项新回归**，并保留 1 项同根因的既有漏判。两项都能在零审批下真实执行外部程序，属于 P1 阻断。

共同根因：**git 配置的裸布尔键（`[section]` 下只写键名、不写 `= value`）等价于 `true`，但 `bash-readonly.ts` 的 KV 解析只认 `key = value`**。

### 12.2 阻断清单

#### B-12-1（本轮回归）：裸 `worktreeConfig` 使 `config.worktree` 未被读取

复现（全部在本机实测；`marker.sh` 只做 `echo x >> marker.txt`）：

```sh
git init -q /tmp/r12-b1/repo && cd /tmp/r12-b1/repo
# 裸键，注意没有 "= true"
printf '[extensions]\n\tworktreeConfig\n' >> .git/config
# 用被门控的文件承载 fsmonitor
printf '[core]\n\tfsmonitor = /tmp/r12-b1/marker.sh\n' > .git/config.worktree
git config --bool extensions.worktreeConfig   # → true
```

实测输出：

```
[B-12-1] bare policy = allow git:status
[B-12-1] real executed = YES
[B-12-1] explicit-true policy = ask git-repo-config-exec
```

- 策略：`evaluateBashPolicy('git status', { cwd })` → `allow / git:status`；真实 `git status` 执行 `marker.sh`。
- 对照：同一文件改为 `worktreeConfig = true` → `ask / git-repo-config-exec`。
- 父提交 `6839fe7` 无条件把 `config.worktree` 纳入解析，该形态在父提交下会 ask；本轮门控后漏判，属**本轮引入的回归**。
- 根因：`gitConfigEnablesWorktreeConfig()` 的 KV 正则 `^([A-Za-z0-9_.-]+)\s*=\s*(.*)$` 不匹配裸键。
- 附带：`[extensions]` 裸键带行内注释（`worktreeConfig # on`）会被 git 判为 `fatal: bad config line`，不可利用；但**纯裸键是合法且常见**的 Git 写法。

#### B-12-2（既有）：裸 `log.showSignature` 使 `git log` 拉起 `gpg.program`

复现：

```sh
git init -q /tmp/r12-b2/repo && cd /tmp/r12-b2/repo
printf '[log]\n\tshowSignature\n[gpg]\n\tprogram = /tmp/r12-b2/marker.sh\n' > .git/config
git config --bool log.showSignature               # → true
# 构造带 gpgsig 的提交（hash-object -t commit -w --stdin + update-ref）
git log --max-count=1
```

实测输出：

```
[B-12-2] bare policy = allow git:log
[B-12-2] real executed = YES | marker content: x
```

- 策略 `allow / git:log`；真实 `git log` 调起 `gpg.program`。
- 根因同上：`gitConfigTextExecutes()` 只认带等号的 `showsignature`，裸键漏判。
- 与 B-12-1 同属“裸布尔键”一类；建议统一在解析层把裸键归一为 `true`（含 `diff`/`filter`/`core`/`log` 各段）。

### 12.3 本轮四项独立判定

#### 1）全局 filter：**修复有效，判定通过（含 1 项 P2 说明）**

沿用“仓库 `.gitattributes` 指向全局已存在 filter”复现，矩阵实测（`includeGlobalGitConfig=true`）：

| 场景 | 判定 |
|---|---|
| 全局自定义 filter（clean/process）+ 仓库 `.gitattributes` | `ask / git-repo-config-exec` |
| 同上，`git diff` | `ask / git-repo-config-exec` |
| 全局标准 LFS（clean/smudge/process） | `allow / git:status`、`allow / git:diff` |
| 整值引号 `"git-lfs clean -- %f"` | `allow / git:status` |
| 多余空白 / 制表符 | `allow / git:status` |
| `/usr/local/bin/git-lfs` 前缀 | `allow / git:status` |
| `git-lfs.exe` | `allow / git:status` |
| `/tmp/git-lfs` 伪装路径 | `allow / git:status` |
| 仅二进制名带引号 `"git-lfs" clean -- %f` | `ask / git-repo-config-exec`（过度 ask，见 P3） |
| LFS + `required = true` | `allow / git:status` |
| `git-lfs clean %f`（缺 `--`） | `ask` |
| `clean = git-lfs filter-process` | `ask` |
| `clean = /bin/sh -c "…"` | `ask` |
| 未加引号 `;`（原始配置文件） | `allow`，且 git 视为注释、**不执行** |
| 带引号 `;`（`git config` 写入形态） | `ask`，真实执行 |

- **真实执行侧**：自定义 filter 形态下，绕过策略直接 `git status` 会写 marker；策略层 `ask` 是唯一屏障（与上轮结论一致）。
- **`/tmp/git-lfs` allow 的理由是否认同**：**有条件认同**。全局配置属于用户，能改全局配置者已可用 `diff.external` 执行任意程序，放行“仅换二进制路径”不扩大威胁面；但代价是“把 LFS 换成一个名字正确、位置任意”的程序不会被质询。建议后续收窄到已知安装前缀（`/usr/local/bin`、`/opt/homebrew/bin`、`/usr/bin`、Windows 常见目录），把 `/tmp` 等改为 ask。这是 P2 精度问题，不作为阻断。
- **`filter.<name>.required=true`**：无额外执行语义。它只影响“filter 失败时是报错还是静默跳过”，不改变可执行面；LFS + `required` 仍 allow 属正确。
- **PAREN 条件缺口（P2，非阻断）**：若 PATH 含仓库目录或 `.`，恶意仓库可放置同名 `git-lfs` 且全局配置为标准 LFS，`git status` 会执行它而策略 allow（实测 YES）。本机 PATH 不含 `.`；该缺口在旧版“全局 filter 全放行”时即存在，本轮未扩大。

#### 2）fsmonitor 收窄：**通过**

实测 `[core] fsmonitor = <marker>`（带等号）：

```
[fsmon] log/show/status = allow allow ask
[fsmon] after log/show invoked = NO
[fsmon] after status invoked = YES
```

- `git log` / `git show`（含 `-p` / `--stat` / `--name-status`）/ `git whatchanged` → `allow`，且**从不调用** fsmonitor。
- `git status` → `ask`，必调用；`git diff` / `git blame` → `ask`，调用与否与 index 刷新状态相关（fresh repo 在设置后才改动时不一定调用）。
- 与 §11.9 “这三条会调用 fsmonitor” 的表述有偏差：应改为“`status` 必调用，`diff`/`blame` 可能调用（状态相关）”。属 P3 文档精度。

#### 3）`config.worktree` 门控：**常规形态通过，裸键形态回归（见 B-12-1）**

自建真实仓库与 linked worktree 实测：

```
[wt-main] gate-closed policy=allow/git:status real=NO
[wt-main] gate-open policy=ask/git-repo-config-exec real=YES
[wt-linked] gate-open policy=ask/git-repo-config-exec real=YES
[wt-linked] gate-closed policy=allow/git:status real=NO
```

- 主仓库未开 `extensions.worktreeConfig`：不读 `config.worktree`，`allow` 且真实不执行。
- 开启（`= true`）：`ask` 且真实执行。
- linked worktree 的 per-worktree `config.worktree`：开启 → `ask`/执行；关闭 → `allow`/不执行。
- **例外**：开启扩展用的是裸键 `[extensions]\n\tworktreeConfig`（git 合法写法）时，门控误判为关闭 → B-12-1。

#### 4）文档：**§7.4 准确、D4 已修、§11.9 有 1 处陈旧**

- `agent-architecture.md §7.4`：现文本明确区分“生产启动序列级语义”与 `reconcileStartup` 函数分支（活 turn `replayed=1/pushed=1`，终态/orphaned `replayed=0/denied=1/pushed=0`），与代码和 `applyRecoveryPlan` 顺序一致；**无误读风险**。
- `agent-rollout.md` D4：已改为“启动即 deny（不重推）”，与实现一致。
- 审计文档 §11.9：“三个套件共 **62 passed**（`bash-readonly` 34）”仍与实测 **66**（34 + 28 + 4）不一致；属陈旧/自相矛盾，按要求仅指出、不改。

### 12.4 §11 遗留项状态更新

| §11 项 | 原状态 | 本轮状态 |
|---|---|---|
| 全局 `filter` 缺口（P1） | 必修 | **已关闭**（自定义 filter → ask；标准 LFS → allow） |
| `fsmonitor` 对 `log`/`show` 过度 ask | 必修 | **已关闭**（`log`/`show` allow 且不调用） |
| `config.worktree` 未开扩展仍被读取 | 必修 | **常规形态已关闭**；裸键形态回归（B-12-1） |
| `agent-architecture.md §7.4` 语义 | 待修 | **已修**，准确 |
| `agent-rollout.md` D4 | 待修 | **已修** |
| §11.9 “62 passed” | 陈旧 | **仍陈旧**（实测 66） |
| `includeIf` 不求值 | 保留 | **保留**：实测 `allow`（只多 ask，不漏判） |
| `GIT_CONFIG_SYSTEM` 非默认路径 | 未测 | **本轮已测**：`ask / git-repo-config-exec` |
| `git-lfs` 真机 | 未测 | **仍未测**：本机无 `git-lfs` 二进制（`command -v git-lfs` 失败），仅配置级模拟 |

### 12.5 仍未验证项

1. **真实 CLI 端到端**：本轮全部为策略函数 + `git` 子进程级验证，未启动 Claude CLI 走 PreToolUse hook 全链路（上轮 hooks 用例已删除）。
2. **`git-lfs` 二进制**：未安装，`filter-process` 长驻协议未跑；仅验证配置值判定。
3. **Windows 引号路径**：`"git-lfs" clean -- %f` 在 Windows 路径含空格场景会过度 ask，未在 Windows 实测。
4. **全量测试**：本轮未重跑全量；已知 `better-sqlite3` ABI（NODE_MODULE_VERSION 130 vs 115）导致 173 failed，与基线一致。
5. **PATH 劫持**：条件性缺口，本机 PATH 不含 `.`，未作为默认环境结论。

### 12.6 组合面复扫（本轮改动未新增开口）

| 组合 | 实测 |
|---|---|
| `git -C <repo> status` | `ask / git:unknown:-C` |
| `git --git-dir <path> status` | `ask / git:unknown:--git-dir` |
| `git --work-tree <path> status` | `ask / git:unknown:--work-tree` |
| `GIT_DIR=<path> git status` | `ask / not-in-whitelist:GIT_DIR=…` |
| `git -c <k>=<v> status` | `ask / git-config-override` |
| 仓库 `.gitattributes` → lfs + 全局标准 LFS | `allow / git:status` |
| 全局 `includeIf` 条件（未求值） | `allow`（只多 ask） |
| 全局系统配置非默认路径 | `ask / git-repo-config-exec` |
| 子模块 | 未发现新增开口 |

- `filter` 与 `.gitattributes` 路径：仓库本地 filter 仍三项全 ask；全局仅标准 LFS allow。
- `-C` / `--git-dir` 与 cwd 传参交互：策略的 `cwd` 仍由调用方（`session.config.workingDirectory` / `request.workingDirectory`）传入，命令内的路径参数不改变 cfg 读取根；上述命令在策略层已 ask，不存在“换目录读另一份配置而免弹”的路径。

### 12.7 摩擦与成本（本轮抽样）

- 42 条常态命令抽样：`allow 34 / ask 8` = **81.0%**（上轮 31/38 = 81.6%）。
- ask 项：`date -s`、`node --version`、`npm test`、`npm run build`、`yarn test`、`rm -rf dist`、`curl … | sh`、`cat ~/.zshrc`。
- 干净仓库、标准 LFS 仓库的 `git status` / `git diff` 均 `allow`，**无新弹窗**。
- 成本：`0.0679 ms/op`（200 次 `git status` 判定均值，`includeGlobalGitConfig=false`）。

### 12.8 冻结复算

- 追加本章后：`git status --short` = 仅 ` M docs/architecture/agent-audit-2026-11-05.md`；HEAD 仍 `938504a`；无 `__tmp_r12_*` 残留。
- 源码与 `agent-architecture.md` / `agent-rollout.md` / `agent-decisions.md` 的 sha256 与 12.0 完全一致（只追加本文档）。
- 定向回归：`bash-readonly.test.ts` 34 + `approval-gateway.test.ts` 28 + `approval-startup-reconcile.test.ts` 4 = **66 passed**。
- 本轮未改源码、未 commit、未 push。

### 12.9 修复记录（第四轮复审后，基线 `938504a`）

**根因（代码）**：配置解析只认 `^key\s*=\s*value$`，只写键名的裸布尔键被整行丢弃。Git 对裸键按 `true` 处理，因此：

- B-12-1：`[extensions] worktreeConfig`（裸键）+ `config.worktree` 中的 `core.fsmonitor` 未被读取 → `allow / git:status`，且真实执行；
- B-12-2：`[log] showSignature`（裸键）+ `gpg.program=…` → `allow / git:log`，gpg 真实执行。

**修复（解析层统一归一）**：新增 `parseGitConfigEntries()`，`gitConfigTextExecutes()`、`gitConfigEnablesWorktreeConfig()`、`gitConfigPaths()` 全部复用同一解析器；不是给两个键加特例。

归一化表（均以本机 `git` 实测为准）：

| 输入形态 | Git 实测 | 本策略归一化 |
|---|---|---|
| `[extensions]` + `worktreeConfig`（裸键） | `git config --bool` → `true` | `value='true'`、`bare=true` |
| `key =`（显式空值） | `--bool` → `false` | `value=''`，等价未设置 |
| `[CORE]` + `FSMonitor` | 节/键大小写不敏感 | section/key 统一小写 |
| `[log] showSignature`（节头同行） | `--list` 接受 | 同一行继续解析键值 |
| `[diff "a]b"]` | 子节可含 `]` | 引号内子节整体保留，不截断 |
| `[diff.evil]` + `textconv` 裸键 | 旧式子节 + bool true | 归一为 `diff.evil` / `true` |
| `value = x # note` / `x ; note` | 行内注释 | 引号外且前有空白才截断 |
| `key # note`（裸键 + 注释） | fatal bad config | 丢弃该行（Git 本身拒绝执行） |
| `a.b = 1` / `a_b = 1` | fatal bad config | 键名只允许字母/数字/连字符，丢弃 |
| `[include]` + `path`（裸键） | fatal “missing value” | 裸 `path` 不按 include 路径处理 |
| `[includeIf "gitdir:…"]` + `path = …` | 条件求值 | 仍不复判，按可能命中递归 |

**复现与“修复前会失败”**（临时回退为“裸键整行丢弃”，跑新增用例）：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| B-12-1 裸 `worktreeConfig` + config.worktree fsmonitor，`git status` | `allow / git:status` | `ask / git-repo-config-exec` |
| B-12-2 裸 `showSignature` + `gpg.program`，`git log --max-count=1` | `allow / git:log` | `ask / git-repo-config-exec` |
| 裸键矩阵（core/diff/filter + 大小写/同行/旧式子节） | 首条 `allow / git:status` | 全部 `ask` |
| 显式 `= true` | `ask`（不变） | `ask` |
| 显式 `= false` / `key =` | `allow`（不变） | `allow` |
| 未开扩展 + 干净配置 | `allow`（不变） | `allow` |

`worktreeConfig` 的回归安全属性保留：未开启（无裸键或 `= false`）不读 `config.worktree` → `allow`；开启（裸键或 `= true`）→ `ask`。

**文档精度**：`agent-architecture.md` 探针说明补充“裸布尔键等价 true”与解析归一化规则；fsmonitor 文案改为“`status` 必调用；`diff`/`blame` 与 index 刷新状态相关”，不再写成三条都无条件调用；§11.9 的陈旧定向计数订正为 66（62 是较早一次运行的临时计数，见该节说明）。

**校验**：定向 69 passed（`bash-readonly` 37 + `approval-gateway` 28 + `approval-startup-reconcile` 4）；`tsc --noEmit` / `eslint src` / `vite build` 全过；全量 `26 failed 文件 / 253 passed`，`173 failed / 3111 passed / 93 skipped (3377)`，26 个失败文件均为既有 `better-sqlite3` ABI 文件，集合与基线一致。

## 十三、B-12 修复复验（第五轮，2026-11-06）

### 13.0 冻结基线（追加前）

| 项 | 值 |
|---|---|
| `git rev-parse HEAD` | `09914650d35eaa5c1096c863efe9481f188325ec` |
| `git rev-parse HEAD~1` | `938504a40458550d80b922bae967fb9e1988e745` |
| `git status --short` | 空 |
| `git ls-files spikes \| wc -l` | 123 |

关键文件 sha256（追加前）：

```
2feb73e1f91831230bb54019d111dc9ff4aa7ba2ccb521bb301806925ee71dd6  src/main/agent/runtime/approval/bash-readonly.ts
95d5cff4a1e99f4e3f3d38dfd0a570e4aba1f32a8d498ea38760e64853b6e5c5  src/main/agent/runtime/approval/__tests__/bash-readonly.test.ts
d033bc2249a4bf833c2c2fcbdebca1129f39ee60f888413d199607bee558c24d  src/main/adapters/claude-code.ts
fdbdcda730c8a8e7739aa2e5959414a3a1e991e3b1f975654d1f559460ede1d8  src/main/agent/runtime/executors/adapter-driver.ts
1f9f6a0d3d79198fcfedf3cca66f15fb7d5d4f230c60b9e2c031cd17c23642c5  src/main/agent/runtime/approval/gateway.ts
825ff131add8d51d5bdd0053a8fb72b5619b2663e58c1dff9ec26146900b4d07  src/main/agent/runtime/recovery/planner.ts
00a5385f85afa83aa1a765dab064e37ee72b792f3d47b28f142ad394ede3dd3f  docs/architecture/agent-architecture.md
7b948a2c62fcc742e956245622e8863f8723cc5edf9bf5ed93ad255b9c2fccd0  docs/architecture/agent-rollout.md
ebe9cdfae3503b55daa422ad9c683f123ae1e4183548999ffffee91152bdb97c  docs/architecture/agent-audit-2026-11-05.md
```

### 13.1 结论：**不可发布**

B-12-1 / B-12-2 两条原缺口已修复（裸布尔键归一为 `true`），显式 `= true` / `= false` / `key =` 的语义也正确。但按要求对“Git 接受而解析器丢弃”做反向排查时，发现 **`include` 递归深度上限与 Git 不一致**，构成新的零审批执行缺口：

- Git 的 `MAX_INCLUDE_DEPTH = 10`（实测 10 层仍执行，11 层 `fatal`）；
- 探针的 `MAX_GIT_CONFIG_INCLUDE_DEPTH = 6`，第 7 层起直接停止递归；
- 因此 7–10 层 include 中的 `core.fsmonitor` / `diff.textconv` / 仓库本地 `filter` 完全不被探针看到 → 策略 `allow`，真实 `git status` 执行外部程序。

### 13.2 阻断清单

#### B-13-1（本轮新发现）：include 深度 7–10 漏读 → allow + 真实执行

复现（`marker.sh` 只写 `marker.txt`）：

```sh
git init -q /tmp/r13-depth/repo && cd /tmp/r13-depth/repo
# inc1..inc7：前者只 include 下一层；inc7 写 [core] fsmonitor
for i in 1 2 3 4 5 6; do printf '[include]\n\tpath = ./inc%s\n' "$((i+1))" > "inc$i"; done
printf '[core]\n\tfsmonitor = /tmp/r13-depth/repo/marker.sh\n' > inc7
printf '[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = ../inc1\n' > .git/config

# 策略：evaluateBashPolicy('git status', { cwd, includeGlobalGitConfig:false })
# 真实：git status
```

实测（危险文件位于第 N 层）：

```
depth=5  | policy=ask/git-repo-config-exec   | git=ok  | executed=YES
depth=6  | policy=ask/git-repo-config-exec   | git=ok  | executed=YES
depth=7  | policy=allow/git:status           | git=ok  | executed=YES   ← 漏判
depth=8  | policy=allow/git:status           | git=ok  | executed=YES
depth=9  | policy=allow/git:status           | git=ok  | executed=YES
depth=10 | policy=allow/git:status           | git=ok  | executed=YES
depth=11 | policy=allow/git:status           | git=ERR | executed=NO    （Git 自身拒绝）
 depth=12 | policy=allow/git:status          | git=ERR | executed=NO
```

- 同一路径也适用于 `filter.*`（仓库本地 filter 本应三项全 ask）与 `diff.*.textconv`；即攻击者把危险配置放到第 7 层 include 即可绕过全部仓库本地判定。
- Git 端实测 `git config --file` 的 11 层 `fatal` 证明其上限确为 10，不是本机特例。

**最小改法**（一行）：把 `MAX_GIT_CONFIG_INCLUDE_DEPTH` 从 `6` 改为 `10`，与 Git `MAX_INCLUDE_DEPTH` 对齐；`depth > 10` 时 Git 自身已 `fatal`，继续返回空不会产生执行面。建议同时补一条回归用例：7/10 层必须 `ask`，11 层 `allow` 但真实 `git` 必 `fatal`。

### 13.3 两项判定

#### 1）B-12-1 / B-12-2 复验：**已修复**（附父提交对照）

新树 `0991465` 与父提交 `938504a`（临时 worktree 实测同一用例）：

| 用例 | `938504a`（父） | `0991465`（新） |
|---|---|---|
| 裸 `[extensions] worktreeConfig` + config.worktree fsmonitor | `allow / git:status`，真实执行 YES | **`ask / git-repo-config-exec`**，真实配置仍可执行（证明门控生效） |
| 裸 `[log] showSignature` + `[gpg] program` + gpgsig 提交 | `allow / git:log`，真实执行 YES | **`ask / git-repo-config-exec`** |
| 显式 `worktreeConfig = true` | `ask` | `ask` |
| 显式 `showSignature = true` | `ask` | `ask` |
| `= false` / `key =`（显式空值） | `allow`，不执行 | `allow`，不执行 |
| 干净仓库 `status/diff/log/show/blame` | `allow` | `allow` |

说明：“真实执行侧不落地”在本产品语义下即策略为 `ask` 时不会自动执行；绕过策略直接跑 `git` 仍会执行（说明该配置本身是活的，门控是唯一屏障），与上一轮结论一致。

#### 2）反向语义：**未被误伤**

- `= true` → `ask`（`worktreeConfig` / `showSignature` 均如此）。
- `= false`、`key =`（空值）→ `allow`，且真实 `git` 不执行：`git config --bool` 对空值为 `false`，`core.fsmonitor` 为空等价未设置。
- 干净配置 → 五个常用命令全部 `allow`。
- 未出现“`false` 被当成 `true`”的回归。

### 13.4 解析器覆盖度实测（Git 行为对照）

| 形态 | 策略 | 真实 Git | 判定 |
|---|---|---|---|
| 裸 `fsmonitor` / 裸 `textconv` / 裸 `clean` | `ask` | 按 git 语义可执行 | 正确 |
| `[core]fsmonitor=…` 节头同行（无空格） | `ask` | 接受并执行 | 正确 |
| Tab/多空格缩进、CRLF、末行无换行、BOM | `ask` | 接受并执行 | 正确 |
| 值续接 `\` + 下一行注释 | `ask`（值尾含 `\`，不匹配 LFS） | 续接后仍为评论，执行 | 正确（宁可多 ask） |
| 值续接 + 额外参数 | `ask` | 续接为额外参数 | 正确 |
| 值内 `\"` / `\n` | `ask` | `\n` 会拆成两条命令并执行 | 正确（未 allow） |
| 引号内 `#` / `;` | `ask` | 引号保护，值不截断 | 正确（未 allow） |
| `[diff "a]b"]` / `[diff.evil]` / 含数字连字符子节 | `ask` | 接受 | 正确 |
| `include` 两层（≤6） | `ask` | 执行 | 正确 |
| `includeIf` 条件 | `ask` | 条件若命中则执行 | 正确（多 ask 不漏） |
| include 目标不可读 | `ask` | `git` 报错 | fail-closed 正确 |
| include 路径带引号空格 | `ask` | 执行 | 正确 |
| include 目标含 BOM | `ask` | 执行 | 正确（JS `trim()` 去 BOM） |
| 引号包裹 key（`"fsmonitor" = …`） | `allow` | `fatal: bad config` | 无执行面；P3 审计保真问题 |
| include 路径 `\ ` 转义空格 | `allow` | `fatal: bad config` | 无执行面；P3 |
| 全局标准 LFS（含 `required=true`、旧式 `[filter.lfs]`） | `allow` | 标准 LFS | 正确 |
| 全局 LFS + 裸 `clean` / 引号包二进制名 | `ask` | 非标准/不可执行 | 正确（过度 ask 属 P3） |
| 全局 LFS + `clean = … %f ; echo`（`;` 前有空格） | `allow` | `git config --get` 确认 `;` 后为注释 | **正确**（非绕过） |
| 全局 LFS + 同一节重复 `clean`（后者危险） | `ask` | 后者生效 | 正确 |
| **include 深度 7–10** | **`allow`** | **执行** | **B-13-1 阻断** |

### 13.5 新发现（按优先级）

- **P1 / 阻断：B-13-1** include 深度上限 6 与 Git 10 不一致（见 13.2）。
- ~~**P3（审计保真，无执行面）**：`"fsmonitor" = …` 与 `include.path = …\ …` 这类 Git 直接 `fatal` 的写法，策略返回 `allow`。当前不会执行，但会让“allow = 已检查且安全”的语义失真；可在解析层把“看起来像配置但无法解析的行”计为 `ask`（可选）。~~ **已关闭（见 §13.9）**：解析层已改为任何无法解析/无法归一的配置行命中相关命令时一律 `ask`（fail-closed），不再静默丢弃。
- **P3（既有过度 ask，未恶化）**：仅二进制名带引号 `"git-lfs" clean -- %f`、值内 `\"`、引号内 `#` 会 ask；属于安全侧多余弹窗。
- **P2（既有，未变化）**：`/tmp/git-lfs` 等任意路径 basename 放行；PATH 含仓库目录时的同名程序劫持。本机 PATH 不含 `.`。
- **正面确认**：值续接、`;` 注释、引号保护、BOM、CRLF、旧式子节、两层 include、includeIf、不可读 include 均未产生新的 allow+exec。

### 13.6 回归面 / 摩擦 / 成本

- 干净仓库：`status / diff / log / show / blame` 全部 `allow`。
- 标准 LFS 仓库（全局 clean/smudge/process）：上述五条全部 `allow`。
- 抽样 42 条：`allow 34 / ask 8` = **81.0%**（与上轮一致）；ask 项为 `date -s`、`node --version`、`npm test`、`npm run build`、`yarn test`、`rm -rf dist`、`curl … | sh`、`cat ~/.zshrc`。
- 单次判定成本：**0.0620 ms/op**（200 次 `git status` 均值，`includeGlobalGitConfig=false`）。
- 定向回归：69 passed（37 + 28 + 4）。

### 13.7 仍未验证项

1. **真实 CLI 端到端**：仍为策略函数 + `git` 子进程级验证，未走 Claude CLI PreToolUse 全链路。
2. **`git-lfs` 二进制**：本机仍无 `git-lfs`，`filter-process` 长驻协议未跑；LFS 结论仅来自配置值与 Git 解析对照。
3. **Windows**：引号/路径分隔符与 `.exe` 分支未在 Windows 实测。
4. **全量测试**：本轮未重跑；已知 `better-sqlite3` ABI 导致 173 failed。
5. **include 深度的其他 Git 版本**：本机实测上限为 10；未跨 Git 版本验证该常量是否变化。

### 13.8 冻结复算

- 追加本章后：`git status --short` = 仅 ` M docs/architecture/agent-audit-2026-11-05.md`；HEAD 仍 `0991465`；无 `__tmp_r13_*` 残留；临时 worktree `/tmp/r13-old` 已移除。
- 源码、测试与 `agent-architecture.md` / `agent-rollout.md` 的 sha256 与 13.0 一致（只追加本文档）。
- 本轮未改源码、未 commit、未 push。

### 13.9 修复记录（第五轮复审后，基线 `0991465`）

**B-13-1（阻断，代码）**：include 深度上限原为 6，且超限时 `gitConfigPaths` 返回空集合，等价“没扫到危险配置”的 fail-open。修复两点：

1. 常量对齐 Git：`MAX_GIT_CONFIG_INCLUDE_DEPTH = 10`（根配置为 0，第 10 层仍有效，第 11 层 Git 自身 `fatal`）。
2. **超限与成环不再返回空，而是标记 `undecidable`，由 `gitRepoConfigExecutes` / `globalGitConfigExecutes` 直接返回 ask**。理由是 `allow` 的语义是“已检查且安全”；返回空集合会让 Git 未来调整上限或异常 include 链把洞静默重开。保留同一个 rule `git-repo-config-exec`，不新增 rule 名：审批卡片与审计已用该 rule 表示“配置面不可判定/有执行风险”，新增名字只会增加消费者分支。

**解析失败 fail-closed（代码）**：`parseGitConfigEntries` 现在返回 `{ entries, invalid }`；任何非空行既不是注释、节头、合法键值，或节头缺 `]`、键名非法、值以未转义反斜杠结尾（Git 续行语义未建模 / EOF 裸尾随反斜杠），都置 `invalid = true`。`gitConfigTextExecutes` 与 `gitConfigEnablesWorktreeConfig` 见到 `invalid` 一律按危险/可能开启处理，不再静默丢弃。

Git 行为对照（本机实测，`git config --file … --list`）：

| 写法 | Git 结果 | 策略 |
|---|---|---|
| `"fsmonitor" = /tmp/hook` | `fatal: bad config line 1` | `ask` |
| `a.b = 1` / `a_b = 1` | `fatal` | `ask` |
| `fsmonitor # note`（裸键+注释） | `fatal` | `ask` |
| `[core`（缺 `]`） | `fatal` | `ask` |
| `include.path = /tmp/x\`（EOF 尾随反斜杠） | `fatal` | `ask` |
| `this is junk` | `fatal` | `ask` |
| `x = a\` + 换行 + `b`（合法续行） | 值 `ab` | `ask`（续行未建模，安全侧多 ask） |

**复现与“修复前会失败”**（临时回退为 `MAX=6` + 超限返回空 + 忽略 `invalid`，跑新增用例：3 failed / 1 passed / 37 skipped）：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| include 第 6 / 7 / 10 / 11 层放 `core.fsmonitor`，`git status` | 第 7 层起 `allow / git:status` | 全部 `ask / git-repo-config-exec` |
| 第 7 层放仓库本地 `filter.clean`，`git status` | `allow / git:status` | `ask / git-repo-config-exec` |
| 第 7 层放 `diff.textconv`，`git diff` | `allow / git:diff` | `ask / git-repo-config-exec` |
| 不可解析行（`"fsmonitor"=…`、EOF 尾随反斜杠） | `allow / git:status` | `ask / git-repo-config-exec` |
| 移除不可解析行后 | `allow` | `allow`（不变） |
| 干净仓库 / 标准 LFS 仓库的 `status/diff/log/show/blame` | 全 `allow` | 全 `allow`（无新弹窗） |

第 11 层说明：Git 自身会在第 11 层 `fatal`、命令不执行；策略仍返回 `ask`，因为“解析链超出已建模边界”属于不可判定，不应把“Git 恰好会在执行前报错”当作安全承诺（版本差异同样适用）。

**回归**：`extensions.worktreeConfig` 门控保持——未开启（无裸键或 `= false`）不读 `config.worktree` → `allow`；开启（裸键或 `= true`）→ `ask`。第 4 轮裸键用例全量通过。

**校验**：定向 `bash-readonly` 41 passed；`tsc --noEmit` / `eslint src` / `vite build` 全过；全量 `26 failed 文件 / 253 passed`，`173 failed / 3115 passed / 93 skipped (3381)`，26 个失败文件均为既有 `better-sqlite3` ABI 文件，集合与基线一致。

## 十四、B-13 修复复验（第六轮，2026-11-06）

### 14.0 冻结基线（追加本文件前）

| 项 | 值 |
|---|---|
| HEAD | `c0dbf8e5734c7100adf9742a7fc00843f243da60`（父 `0991465`，未 amend、未 push） |
| `git status --short` | 空 |
| `git ls-files spikes` | 123 |
| `bash-readonly.ts` | `f6c10e704836063d19f87b699a446a1b55db73c487b17850c2d5cf29095df1cf` |
| `bash-readonly.test.ts` | `9250337419e12a26521511534eef0d2ad6158d39329b91b50851b4544506d4cd` |
| `agent-architecture.md` | `39ae14f5ca90c8bc911e905efd3831fe753185aa49cb0f318650208d9d270c7a` |
| `agent-rollout.md` | `7b948a2c62fcc742e956245622e8863f8723cc5edf9bf5ed93ad255b9c2fccd0` |
| 本文件 | `3e99f67e3089f89e9752130c9629e6596414b019d7c576992d8b4f416ddaa186` |

### 14.1 结论：**不可发布**

声称的两处修复都成立并已实测：include 深度对齐 10（1–10 层危险配置全 `ask`）、超限/成环 `undecidable` → `ask`、不可解析行 fail-closed。父提交 `0991465` 对照也符合预期（第 7 层由 `allow` 变 `ask`）。

但**同一条 include 链上仍有一处 under-ask**：策略手写解析器不做 Git 的反斜杠解转义，`include.path` 的转义写法会让 Git 读到、策略读不到 —— `allow` 后由 Git 真实执行外部程序。仍属 B2 威胁模型（一次被批准的 Write 改写 `.git/config` 即可），因此本轮判**不可发布**（1 项 P1 阻断，见 14.2）。

### 14.2 阻断清单

#### B-14-1（既有，非本轮引入）：`include.path` 反斜杠转义未归一 → 策略漏读、Git 真读 → `allow` + 执行

复现（本机实测；`git status` 与 `git diff` 两条路径都验证）：

```sh
# 1) 双反斜杠：.git/config 里是两个 `\` 字符，Git 解转义后是单个 `\` 的文件名
rm -rf /tmp/verify14-demo && mkdir /tmp/verify14-demo && cd /tmp/verify14-demo && git init -q .
printf '%s\n' '[include]' '	path = evil\\cfg' > .git/config
printf '%s\n' '[core]' '	fsmonitor = /tmp/verify14-hook.sh' > '.git/evil\cfg'
printf '%s\n' '#!/bin/sh' 'touch /tmp/verify14-marker' 'exit 1' > /tmp/verify14-hook.sh && chmod +x /tmp/verify14-hook.sh
git status --short                 # exit 0；随后 /tmp/verify14-marker 存在 → fsmonitor 被真实执行
```

实测输出：

```
真实 git status（应触发 hook）: exit=0
marker: -rw-r--r--  ...  /tmp/verify14-marker      # 时间戳为本次运行
```

同一构造换成 `[filter "evil"] clean = /tmp/verify14-filter.sh` + `.gitattributes` 标记 `*.txt`，`git diff` 也会创建 `/tmp/verify14-filter-marker`（已实测）。而策略侧对同一个 `cwd` 的判定是：

```
escaped include: allow git:status
escaped quote include: allow git:status   # path = evil\"cfg → Git 解转义为 evil"cfg
```

根因（[bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L513-L550)、[:609-L636](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts#L609-L636)）：

- `parseGitConfigEntries` 只做 `trim`、节头归一、注释剥离，**不实现 Git 的转义归一**（`\\`→`\`、`\"`→`"`、`\n`→换行、`\t`→Tab、`\b`→退格）；
- `gitConfigPaths` 直接把原值当路径：`resolve(dirname(file), 'evil\\cfg')` → 找的是一份含两个反斜杠的文件名，实际 Git 读的是含一个反斜杠的文件；
- 该文件因此不在 `scan.files` 里，`gitConfigFilesExecute` 看不到任何危险键 → `allow`；
- `invalid` fail-closed 也拦不住：这一行**按策略的语法是合法的**（值以 `g` 结尾，不是续行），只是与 Git 的语法不同。

可达性：`.git/config` 与 `evil\cfg` 都在会话工作目录内，一次被批准的 Write 即建立会话写授权（[gateway.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L512-L515) 只校验 `isPathInside(grant.cwd, target)`，**没有 `.git` 例外**），随后 `git status` / `git diff` 走 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L349-L367) 的 `permissionDecision: 'allow'` 免弹执行。与第五轮的 B-13-1 同一威胁模型，只是绕过的层从“深度”换成了“转义”。

影响范围：只影响 `include.path` / `includeIf.path` 的解析（危险键本身的值不需要解转义：布尔类按“非 false 即真”判定，`diff.*`/`filter.*` 按“非空即危险”判定，转义不会把它们从危险变成安全）。但 include 路径被绕过等价于整条配置链被绕过。

最小改法（二选一，建议先做 1）：

1. **止血（最小改动、最保守）**：`parseGitConfigEntries` 中只要值的**非尾部**出现 `\`，就置 `invalid = true`（Git 允许的转义只有 `\\`、`\"`、`\n`、`\t`、`\b`，日常配置极少用；代价是这类配置一律多一次 ask，方向安全）。改动约 3 行，且能同时覆盖 `\n`/`\t` 造出的换行/Tab 文件名变体。
2. **对齐语义（后续）**：实现 `gitConfigUnescape`（只处理上述 5 种转义，其余视为不可解析），在存储 `value` 前归一；include 路径、`filter` 值、`showSignature` 布尔全部走同一份归一值。改动更大，需要补 Git 对照用例。

复验判据：同一复现里，`evaluateBashPolicy('git status --short', { cwd })` 必须返回 `ask / git-repo-config-exec`，且真实 `git status` 的 marker 只在人工批准后才出现。

### 14.3 本轮五项判定

#### 1）include 深度 1–10 与 11：**通过**

自建链（`config → inc1 … → incN`，危险叶子 `[filter "evil"] clean = /bin/sh …`）：

| 深度 | 当前树 `git status` | 当前树 `git diff` | 父提交 `0991465` |
|---|---|---|---|
| 1–6 | `ask / git-repo-config-exec` | `ask / git-repo-config-exec` | `ask` |
| 7–10 | `ask / git-repo-config-exec` | `ask / git-repo-config-exec` | **`allow / git:status`** |
| 11（及 12） | `ask / git-repo-config-exec`（`undecidable`） | 同左 | `allow` |

真实 Git 对照（文件都放在 `.git/` 内，路径才解析正确）：

```
危险在第 10 层：git status exit=0；git config --list --includes 输出 core.fsmonitor=true
危险在第 11 层：fatal: exceeded maximum include depth (10) while including .git/inc11.cfg
```

“策略 ask 时不落地”：`evaluateBashPolicy` 是纯函数，`ask` 在 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L360-L367) 被映射为 `permissionDecision: 'ask'`，强制回到审批网关；只有 `allow` 才免弹直接执行。1–10 层均为 `ask`，故都不会落地。

#### 2）成环与超限的其它形态：**通过（1 项与任务书预期不同，但语义正确）**

| 形态 | 策略 | 真实 Git | 说明 |
|---|---|---|---|
| `include` 自我引用 | `ask` | `fatal: exceeded maximum include depth (10) … circular includes` | 策略 `chain.includes` 命中 |
| 两文件互相 include | `ask` | 同上（`fatal ...`） | 同上 |
| `includeIf` 嵌套两层 | `ask` | 条件匹配时同样读取 | 条件不复判，安全侧 |
| 目标文件不存在 | **`allow`** | **静默忽略，exit 0，不执行** | **与 Git 语义一致**；任务书要求 “ask”，但放行不产生执行面。如需一致性可改成 ask（低优先） |
| 目标不可读（`chmod 000`） | `ask` | `fatal: unable to access ... Permission denied` | fail-closed |
| 目标是指向目录 | `ask` | `fatal: bad config line ... Is a directory` | fail-closed |
| 裸 `include.path`（无 `=`） | `allow` | missing value，不会 include | 与 Git 一致 |

#### 3）解析失败 fail-closed 的反向验证：**通过**

抽查 12 份“合法且常见”的配置，`git status` 判定如下（`includeGlobalGitConfig:false`）：

| 配置 | 判定 |
|---|---|
| 本仓库真实 `.git/config`（含 `[remote "origin"]`、`[branch "main"]`、`[submodule]`、`[lfs]`） | `allow / git:status` |
| 标准 LFS 仓库形态（`[core] repositoryformatversion` + `[lfs]`） | `allow` |
| `user.name/email` + `remote` + `branch` 全套 | `allow` |
| CRLF 行尾 | `allow` |
| 行首 BOM | `allow`（`trim` 会去掉 U+FEFF） |
| Tab / 多空格缩进 | `allow` |
| `[section]key=value` 同行 | `allow` |
| `#` / `;` 注释 + 值尾注释 | `allow` |
| 值内引号（`editor = "code --wait"`） | `allow` |
| `[diff.evil] textconv`（旧式子节） | `ask`（本应 ask，非误判） |
| 键名含数字（`fsmonitor2`） | `allow` |
| `[alias] x = !echo "a;b"`（引号内分号） | `allow` |

另用本机真实全局配置（`~/.gitconfig`：`[user]`、`[core] autocrlf`、`[filter "lfs"]` 标准三项 + `required`、`[http] version`、`[safe] directory = *`）跑默认 `includeGlobalGitConfig:true` → 全部 `allow`，**没有把标准 LFS 误判成 invalid**。

#### 4）合法值续行：**ask，摩擦可接受**

`[alias] lg = log --graph --pretty=format:'%h \` + 换行 + `%s'` → 真实 Git `git config --get alias.lg` 接受（exit 0），策略 `ask / git-repo-config-exec`。属安全侧多 ask；抽查主流写法（长 alias、`url.*.insteadOf`、LFS、`core.editor`、`[commit] template`）里只有多行 alias 命中，本机/常规仓库默认配置不命中。

#### 5）回归 / 摩擦 / 成本：**通过**

- 本仓库（含真实全局配置）25 条常用只读命令：**25/25 `allow`**（`status`/`diff`/`log`/`show`/`blame`/`rev-parse`/`ls-files`/`describe`/`shortlog`/`show-ref`/`for-each-ref`/`rev-list`/`merge-base`/`cat-file`/`count-objects`/`branch`/`remote -v`/`tag`）。
- 干净仓库五命令与标准 LFS 形态五命令全 `allow`（既有 41 条定向用例全绿）。
- 单次策略开销（200 次平均）：干净仓库 **0.048 ms**；10 层 include 链 **0.399 ms**。
- `git-lfs` 二进制本机仍不存在，故 LFS 只做了配置形态验证，**未做真机 LFS 仓库**。

### 14.4 战略问题：继续手写解析 vs 交回 Git 自己解析

**结论：建议把“配置探测”这一层迁到 Git 自身解析，手写解析器只保留为 fail-closed 的降级路径。** 依据是这六轮的证据形态：每一轮都能找到“Git 接受、解析器理解不同”的新差异（参数缩写 → shell 展开 → 配置驱动 → 裸键 → include 深度 → 续行 → 转义）。差异不是靠加用例收敛的，而是**语法所有权不在我们手里**：只要 Git 继续演进配置语法，手写解析器就有结构性漏判风险，而漏判的代价是零审批执行。

**三条对比**

| 维度 | 继续手写修补 | 交回 `git config` 解析 |
|---|---|---|
| 风险 | 每次 Git 语法演进/边角语法都可能再开一个 under-ask；已实测漏判 7 类 | 语义由 Git 保证，include 深度/成环/转义/条件/大小写等一次性对齐；剩余风险转为“探针本身”的风险（见下） |
| 成本 | 每轮 1–3 天复审 + 修复 + 用例；长期反复 | 一次性：进程封装（`execFile` 固定 argv + 超时 + 输出上限）、scope 解析、缓存、测试替身；约 1–2 天 |
| 可控性 | 高：纯函数、可单测、0.05 ms、无子进程 | 中：行为随 Git 版本；需处理 git 缺失/超时/非零退出；约 10 ms/次（本机实测 `git config --list --show-origin --includes` 与 `git status` 同量级） |
| 失败模式 | 静默漏判（最危险） | 显式失败（可 fail-closed 成 ask） |

**最小可行迁移边界（如果改路线）**

1. **只迁探测，不动 shell 词法器**。`include/转义/裸键/深度` 属于配置语法问题；命令词法（`-c`、`--git-dir`、展开、管道）是另一个问题域，继续留在 `bash-readonly.ts`。
2. **只对已门控的 6 个子命令**（`diff/log/show/status/blame/whatchanged`）做探测；其余命令不探测，避免把延迟扩散到全部只读命令。
3. **探针形态**：`execFile(gitPath, ['--no-pager','config','--list','--null','--show-origin','--show-scope','--includes'])`，不经过 shell、不接受用户输入、不拼 `-c`；固定超时（建议 250 ms）+ 输出上限（建议 1 MB）+ 失败即 `ask`。
4. **fail-closed 规则**：spawn 失败 / 超时 / 退出码非 0 / 输出无法按 NUL 记录解析 / `--show-scope` 不被支持（老 Git）→ 一律 `ask`，绝不 `allow`。若保留手写解析器作降级，也只能“降级为 ask”，不能“降级为 allow”。
5. **避免探针变成新攻击面**：
   - 用与应用执行命令时**同一个** git 可执行文件（启动时解析一次绝对路径），不要每次按 `PATH` 现查；
   - `--no-pager`，且不设置 `GIT_PAGER`；
   - include 指向 FIFO/设备文件时靠超时兜底（这是新增的挂起风险，必须显式处理）；
   - 探针的环境要与真实命令一致（`GIT_CONFIG_GLOBAL/SYSTEM`、`XDG`），否则“探针看到的”与“命令执行的”不是同一份配置；这也顺带补上 `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` 这类环境注入配置（手写解析器完全看不见）。
   - 探针与真实执行之间仍有 TOCTOU，但它不因迁移而变大，也不因迁移而变小；若要收窄，只能对配置做“执行前快照 + 比对”，属另一项设计。
6. **缓存**：用探针返回的 `--show-origin` 文件集合 + 各自 mtime/size（含 git 可执行文件 mtime）做键；任一变化即重跑。先不上缓存，实测 10 ms 可接受再决定。

**如果维持现状**，我能接受的残余风险清单（按重要性）：

- R1 `include.path` 转义差异（当前阻断，必须先修）；
- R2 其它值级转义/编码差异（非 UTF-8 配置会被 `readFileSync(utf8)` 改写字节；目前只影响 include 路径命中的可能性）；
- R3 环境注入配置（`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_PARAMETERS`）未被检查；
- R4 Git 未来新增“只读命令会执行”的配置键（例如新的 hook/driver 类键），白名单清单会过期；
- R5 `%(prefix)` 等路径展开语法（本机 2.50 实测 `include.path` 不展开，但不同版本/不同键可能不同）；
- R6 探针与执行之间的 TOCTOU；
- R7 非 TTY 假设（`core.pager` 在 agent 的管道里不会被执行；一旦执行环境变成 TTY 就需要重新评估）；
- R8 `includeIf` 条件不复判带来的摩擦（不是风险，是体验）。

**重估触发条件**（任一出现就应启动迁移）：① 再出现一次“Git 接受、解析器漏读”的 under-ask（本轮已是第二次同族）；② Git 发布说明出现新的“读命令会执行外部程序”的配置键；③ 需要把“无已知 allow+exec 绕过”写进发布标准；④ 摩擦抽样中合法续行/转义配置导致的 ask 超过可接受比例（例如常用仓库 >1%）。

### 14.5 仍未验证项

- `git-lfs` 真机仓库（本机无 `git-lfs` 二进制；只验证了配置形态与全局标准写法）。
- `GIT_CONFIG_SYSTEM` 指向非默认路径的真机行为（代码路径已含该候选，未单独构造）。
- `includeIf` 条件（`gitdir:`/`onbranch:`/`hasconfig:remote.*.url`）的真实求值差异（策略一概不复判，只多 ask）。
- `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` 环境注入配置（策略完全不读，未构造）。
- 非 UTF-8 编码的 `.git/config`（策略按 UTF-8 读，未构造）。
- `.git/config` 指向 FIFO 时手写解析器的阻塞行为（`readFileSync` 会阻塞；实际仓库不常见，未构造）。

### 14.6 冻结复算（追加本文件后）

- HEAD 仍为 `c0dbf8e5734c7100adf9742a7fc00843f243da60`（未 commit、未 push、未 amend）。
- 源码与测试文件 sha256 与本轮 14.0 记录一致（本轮只追加本文件、未改源码）。
- 本文件追加前 `3e99f67e…`；追加后哈希在复验回复中给出（写入正文会自指，故不内嵌）。
- `git status --short` 仅本文件为 `M`。

### 14.7 修复记录（第六轮复审后，基线 `c0dbf8e`，止血补丁）

**B-14-1（阻断，代码）**：`include.path` 的值含转义（两个反斜杠、`\"` 等）时，Git 会归一后读取真实路径，而策略用**未归一原值**算路径：`.git/config` 写 `path = evil\\cfg`、实际危险文件是 `.git/evil\cfg`，策略找 `.git/evil\\cfg`（不存在）→ 静默漏读 → `allow / git:status` + fsmonitor 真实执行。`git diff` 同路径同样可达。

**止血口径（本轮不做完整转义归一，迁移路线待用户拍板）**：`parseGitConfigEntries` 在取值后直接检查——**值内出现任何反斜杠即 `invalid = true`**，覆盖 `\\`、`\"`、`\n`、`\t`、`\b` 与尾部续行/EOF 裸尾随反斜杠。方向是安全侧：整份配置判不可解析 → 命中 `status`/`diff`/`log`/`show`/`blame` 等命令时 `ask / git-repo-config-exec`，不再用未归一原值算 include 路径。没有实现转义语义归一。

**复现与“修复前会失败”**（临时把 `gitConfigHasEscape` 改为恒 `false`，跑新增用例：3 failed / 2 passed / 39 skipped）：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| `include.path = evil\\cfg`（Git 读取 `evil\cfg`），`git status` | `allow / git:status` | `ask / git-repo-config-exec` |
| 同上，`git diff HEAD` | `allow / git:diff` | `ask / git-repo-config-exec` |
| `include.path = evil\"cfg`（Git 读取 `evil"cfg`），`git status` | `allow / git:status` | `ask / git-repo-config-exec` |
| 第 7 层 include 使用 `evil\\cfg`（叠加形态） | `allow / git:status` | `ask / git-repo-config-exec` |
| 不可解析行（含 EOF 尾随反斜杠） | `allow / git:status` | `ask / git-repo-config-exec` |

**反向（不误伤）**：普通 include 路径（`clean.cfg`）、带引号但无转义（`"clean.cfg"`）、标准 LFS 配置（全局 `git-lfs clean/smudge/process`）、本仓库真实 `.git/config` 的 `git status` 均保持 `allow`；干净仓库与标准 LFS 仓库的 `status/diff/log/show/blame` 仍全 allow。反斜杠只出现在行内注释时不会触发（检查对象是去注释后的值）。

**校验**：定向 `bash-readonly` 44 passed，`approval-gateway` 28 + `approval-startup-reconcile` 4 通过；`tsc --noEmit` / `eslint src` / `vite build` 全过；全量 `26 failed 文件 / 253 passed`，`173 failed / 3118 passed / 93 skipped (3384)`，26 个失败文件均为既有 `better-sqlite3` ABI 文件，集合与基线一致。

## 十五、B-14-1 止血补丁限定复验（第七轮，2026-11-06）

### 15.0 冻结基线（追加本文件前）

| 项 | 值 |
|---|---|
| HEAD | `5e4393fd2232727bba30f2edd0e1a71b5da6345c`（父 `c0dbf8e`，未 amend、未 push） |
| `git status --short` | 空 |
| `git ls-files spikes` | 123 |
| `bash-readonly.ts` | `f1d24f867202a46b26b544e03e0193e8ef759d7ef76123906c1dbad30f8ecba8` |
| `bash-readonly.test.ts` | `f187a71aaa5c24a5cbae898ff4739d137a938508de8910dc9e2e60ef91e07542` |
| `agent-architecture.md` | `97e20b082fa35522f1f07c58764e939f0f6b80bc2444b11ddb50bd28f99c1a79` |
| 本文件 | `e561f34c8be88e6cf607f12d6abedfb6587352ea6c0d9fdd88e24e2d338dbfc2` |

补丁内容：`gitConfigHasContinuation` 改为 `gitConfigHasEscape`（`value.includes('\\')`），值内任何反斜杠一律 `invalid`；顺带把 `stripGitConfigComment` 提到赋值前（`value` 先剥注释再判转义）。

### 15.1 结论：**止血成立，可进入迁移窗口**

- B-14-1 闭合：两条复现（`evil\\cfg`、`evil\"cfg`）在 `git status` 与 `git diff` 上均为 `ask / git-repo-config-exec`；父提交 `c0dbf8e` 对同一构造仍是 `allow`（已实测对照），真实 Git 仍会执行（marker 已创建）。`ask` 在 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L349-L367) 映射为 `permissionDecision:'ask'`，不落地。
- 误伤面存在但方向安全（纯 over-ask），macOS 主流配置不命中；Windows 系路径/自定义 diff 正则用户会每次弹窗。
- 无新增阻断。**迁移前不需要再打止血补丁**；建议下一次改动直接走“配置探测交回 Git”的迁移，不再在手写解析器上做局部修补。

### 15.2 三项判定

#### 1）B-14-1 闭合：**通过**

| 构造 | 当前树 `5e4393f` | 父 `c0dbf8e` | 真实 Git |
|---|---|---|---|
| `path = evil\\cfg` + `.git/evil\cfg` 危险 filter → `git status --short` | `ask / git-repo-config-exec` | `allow / git:status` | 读入并执行 |
| 同上 → `git diff HEAD` | `ask / git-repo-config-exec` | `allow / git:diff` | 读入并执行 |
| `path = evil\"cfg` + `.git/evil"cfg` → status / diff | `ask / ask` | — | 读入并执行 |

真实执行侧复核：`git status` 在 `c0dbf8e` 语义下退出码 0 且创建 `/tmp/v15-marker`（fsmonitor hook 被调用）；补丁不改 Git 行为，因此 `ask` 是必要的拦截点。

#### 2）误伤面：**7 类命中 over-ask（均安全方向）**

| 配置值（Git 实测均 `exit=0` 接受） | 当前策略 |
|---|---|
| `core.excludesFile = C:\\Users\\alice\\.gitignore` | `ask` |
| `safe.directory = C:\\work\\repo` | `ask` |
| `remote.origin.url = https://example.com/a\\b.git` | `ask` |
| `core.sshCommand = ssh -i C:\\Users\\a\\.ssh\\id_rsa` | `ask` |
| `core.hooksPath = C:\\hooks` | `ask` |
| `[alias] fmt = log --pretty=format:\"%h %s\"`（Git 解转义为 `"`） | `ask` |
| `[diff "go"] xfuncname = ^\\s*func`（正则 | `ask` |
| `include.path = inc1.cfg`（正常写法） | `allow` |
| 标准 LFS 仓库（仓库侧 `[lfs]`） | `allow` |
| 本仓库真实 `.git/config` | `allow` |

**是否常见**：macOS 主流用户（Homebrew Git、LFS、`~/.gitconfig` 常规项）**不命中**——本机真实全局配置 12/12 `allow`。命中的是三类少数但真实的用户：① Windows/macOS 双机共享 dotfiles（`C:\\` 路径）；② 自定义 diff driver 的正则值（`\\s`）；③ alias 里写 `\"`。由于 `invalid` 是**整份配置级**，这类用户会在这 6 个命令上每次都弹窗，摩擦偏高。

最小收敛建议（非阻断、可并入迁移）：把“值内反斜杠即 invalid”的判定**只作用于 `include.path` / `includeIf.path`**（只有这两处需要精确路径归一；其余键的转义不会把危险变安全——布尔按“非 false 即真”、`filter`/`diff` 按“非空即危险”），其余键保留现有的续行判定。约 5 行改动，可把上述 7 类误伤压到 0，同时不损失闭合性。

#### 3）回归：**通过**

- 干净仓库五命令（status/diff/log/show/blame）全 `allow`。
- 标准 LFS 仓库（含 `.gitattributes → filter=lfs`、全局标准 LFS 三项）五命令全 `allow`（定向用例覆盖）。
- 定向 `bash-readonly` **44 passed**（本轮 +87 行用例）。
- 本仓库真实全局配置下 12 条常用只读命令 **12/12 `allow`**。

### 15.3 迁移触发条件确认

上一轮列出的触发条件中已满足两条：

1. **“再出现一次 Git 接受、解析器漏读的 under-ask”** —— B-14-1 已实测（同族第二次：深度之后是转义）。
2. **“需要把‘无已知 allow+exec 绕过’写进发布标准”** —— 本轮止血把已知绕过清零，但实现方式证明手写解析器仍在“逐层补洞”，该标准在现状下只能靠持续复审维持。

结论：**迁移已具备启动条件**，不应再等。剩余待验项（`GIT_CONFIG_COUNT`、非 UTF-8、FIFO）都属于“迁移后由 Git 统一覆盖”的范畴，不必在手写解析器上单独补。

### 15.4 迁移排期建议：一次迁移、分三段落地

不建议继续“分阶段只迁一部分键”——那等于继续维护两套语义。建议**一个迁移单元**，内部三段：

- **S1（影子对照，不改行为，约 1 天）**：新增 `gitConfigProbe()`（`execFile` 固定 argv + 250 ms 超时 + 1 MB 上限），在 6 个子命令上并行跑“探针判定”与“手写判定”，只记差异日志。验收：真实仓库 + 构造仓库上差异为 0 或全部指向手写漏判。
- **S2（切换门控，约 0.5 天）**：以探针为权威；spawn 失败/超时/非零/解析失败 → `ask`；手写解析器降级为“只能返回 ask”的 fallback。验收：B-14-1 复现 + 本轮 7 类误伤全部 `allow`，定向用例 + 新增差异用例全绿。
- **S3（收尾，约 0.5 天）**：删除手写 include/转义/深度逻辑，保留 shell 词法器；文档与审计同步。

风险与边界（与上一轮一致）：探针必须用应用同一个绝对路径 git、`--no-pager`、环境与真实命令一致；FIFO include 靠超时兜底；缓存键用 `--show-origin` 文件集合 + mtime。若 `evaluateBashPolicy` 保持同步接口，`execFileSync` 每命令约 +10 ms（与 `git status` 本身同量级），可接受；若不可接受，再把接口异步化。

### 15.5 本轮未验证项

- `git-lfs` 真机（本机仍无二进制）。
- 迁移方案本身（本轮只做现状复验，未写原型）。
- 误伤面的真实分布（只做了构造样例，未统计真实用户配置语料）。

## 十七、转义 fail-closed 收窄复验（第八轮，2026-11-06）

### 17.0 冻结基线（追加本文件前）

| 项 | 值 |
|---|---|
| HEAD | `45f527cbf40db80fe5caed0cc2e79cff7210ca87`（父 `5e4393f`，未 amend、未 push） |
| `git status --short` | 空 |
| `git ls-files spikes` | 123 |
| `bash-readonly.ts` | `eff41811021734bde14195be829ce80cb0811cd7638d680b3b3536a42a0d0c35` |
| `bash-readonly.test.ts` | `88ca972a1de8ba7b88e552907ceb65859573416353750ca351a29135ecc2dd52` |
| `agent-architecture.md` | `dc58fb3217f091d141145203217f0a35bc36b2536a79f2df3e91ba219451d61d` |
| 本文件 | `9710dd321d1b602309bef16df6f7939fb54b38f2dda3e1bc9dfab2b4f0aed8dc` |

补丁：`invalid` 判定从“所有值含反斜杠”收窄为“`include`/`includeIf` 节下 `path` 键且值含反斜杠”；其余键不再因转义判 invalid。

### 17.1 结论：**可发布（功能面）/ 只差迁移**

收窄后闭合性没有下滑：5 类转义构造在相关命令上仍全 `ask`，与父提交 `5e4393f` 逐条对照**没有把原本 ask 的 include 类变成 allow**。唯一的 ask→allow 是 `core.fsmonitor = \\path` 在 `git log`/`git show` 上——这两条命令本来就不触发 fsmonitor（上一轮已收窄），属有意且安全的变化，不是闭合性回退。七类误伤全部回到 `allow`，回归面全绿。

迁移判断不变：绕过的根因是“手写解析器与 Git 语法所有权不同”，本轮只是把误伤从 7 类压到 0，并没有改变这个结构；触发条件仍成立。

### 17.2 四点判定

#### 1）七类误伤回到 allow：**通过（5 命令全 allow）**

| 配置（Git 实测均接受） | status / diff / log / show / blame |
|---|---|
| `core.excludesFile = C:\\Users\\alice\\.gitignore` | 5/5 `allow` |
| `safe.directory = C:\\work\\repo` | 5/5 `allow` |
| `remote.origin.url = https://example.com/a\\b.git` | 5/5 `allow` |
| `core.sshCommand = ssh -i C:\\Users\\a\\.ssh\\id_rsa` | 5/5 `allow` |
| `core.hooksPath = C:\\hooks` | 5/5 `allow` |
| `[alias] fmt = log --pretty=format:\"%h %s\"` | 5/5 `allow` |
| `[diff "go"] xfuncname = ^\\s*func` | 5/5 `allow` |

**真实出现频率判断**：本产品的目标平台是 macOS。`C:\\` 形态主要出现在 Windows/macOS 双机共享 dotfiles 或从 Windows 同步过来的全局配置，macOS 单机用户少见；`xfuncname` 正则里的 `\\s` 属于自定义 diff driver 的高级用法，占比更低；alias 里写 `\"` 少见。三类合计估计在个位数百分比以内，且此前会造成“每次 git status 都弹窗”，收窄收益明显。

#### 2）闭合性没有下滑：**通过**

| 构造 | 当前 `45f527c` | 父 `5e4393f` |
|---|---|---|
| `[include] path = evil\\cfg` | 5/5 `ask` | 5/5 `ask` |
| `[include] path = evil\"cfg` | 5/5 `ask` | 5/5 `ask` |
| `[includeIf "gitdir:x"] path = evil\\cfg` | 5/5 `ask` | 5/5 `ask` |
| 第 7 层 include 叶子为 `evil\\cfg` | 5/5 `ask` | 5/5 `ask` |
| `[diff "x"] command = a\\b` | 5/5 `ask` | 5/5 `ask` |
| `[core] fsmonitor = \\path` | status/diff/blame `ask`；log/show `allow` | 5/5 `ask` |

最后一行是唯一 ask→allow。`git log`/`git show` 不读取/不调用 fsmonitor（上一轮已把探测收窄到 status/diff/blame），所以放行不产生执行面；判定依据是“命令是否真会调用该键”，不是“键是否含转义”。

另核对了一条收窄的正确性前提：非 include 键的转义**不会**把危险变安全。布尔判定用“非 false 即真”——原始值只要含 `\` 就不可能归一到 `false`，只会更保守；`filter.*`/`diff.*` 按“非空即危险”，转义不改变非空性；`core.fsmonitor`/`log.showSignature`/`extensions.worktreeConfig` 同布尔口径。故无非 include 的 under-ask。

#### 3）收窄边界精度：**通过（略偏保守，无漏判）**

| 构造 | 当前 | 真实 Git |
|---|---|---|
| `[Include "sub"] path = evil\\cfg` | `ask` | **不采纳**（`include.sub.path`，不是 include 指令）→ 过度 ask，安全 |
| `[INCLUDE] Path = evil\\cfg` | `ask` | 采纳 → 正确 |
| `[includefoo] path = evil\\cfg` | `allow` | **不采纳** → 放行正确（无执行面） |
| `[credential] path = a\\b` | `allow` | 只是普通键 → 不误伤 |
| `[url "x"] path = a\\b` | `allow` | 普通键 → 不误伤 |
| `[include] helper = a\\b`（非 `path`） | `allow` | 非 include 指令 → 不误伤 |
| `[include] path = inc1.cfg`（正常） | `allow` | 采纳但无危险 → 正确 |

节名匹配用的是 `^include(?:\.|\s|$)` / `^includeif(?:\.|\s|$)`，对 `includeIf "cond"`、`include.foo` 都命中；`includefoo` 不命中。由于 Git 对 `[include "sub"]` / `[includefoo]` 并不采纳，这两处的过度 ask/放行都不会造成漏判。`path` 键大小写经 `toLowerCase()` 归一。

#### 4）回归：**通过**

- 本仓库真实 `.git/config`、干净仓库、标准 LFS 形态：五命令 5/5 `allow`。
- 定向 `bash-readonly` **45 passed**（本轮 +44 行用例）。
- 摩擦抽样（本仓库真实全局配置）12/12 `allow`。
- 单次策略开销 **0.060 ms**（200 次平均），与上一轮同量级。

### 17.3 迁移判断与验收标准

结论不变：**触发条件已满足，应启动迁移**；本轮的收窄不改变判断，反而再次说明“每轮都要为新差异打补丁”。

| 阶段 | 通过条件 | 必须回滚 |
|---|---|---|
| S1 影子对照 | ① 行为零变化：所有命令判定与现状逐条一致；② 在真实仓库语料 + 构造语料上，探针与手写的差异**全部**是“手写 allow / 探针 ask”（即只见漏判，不见反向）；③ 探针 p95 ≤ 30 ms、无挂起、无额外进程 | 出现任一“探针 allow / 手写 ask”（说明探针更松，需先解释）；探针超时率 > 0.5%；p95 > 50 ms；出现非预期子进程 |
| S2 切换门控 | ① B-14-1 与 17.2 的 5 类转义构造全部 `ask`；② 七类误伤全部 `allow`；③ 注入故障（git 缺失、超时、退出码 128、空输出、非法 NUL 记录）全部 `ask`，无 fail-open；④ 定向 + 新增差异用例全绿 | 任一 allow+exec 复现；任一注入故障返回 allow；崩溃/挂起 1 次即回滚到 S1 状态 |
| S3 收尾 | ① 手写 include/转义/深度逻辑删除后，shell 词法器用例仍全绿；② 影子日志连续 7 天 0 条“手写 allow / 探针 ask”；③ 文档与审计同步 | 影子期出现新的手写漏判，或删除后出现判定漂移 |

回滚方式统一：保留 `gitConfigProbe` 的开关，S2/S3 出问题时一键退回“手写 + 一律 ask”的组合（不回退到“手写 allow”）。

### 17.4 本轮未验证项

- `git-lfs` 真机（本机仍无二进制）。
- 迁移原型（S1 的探针封装、超时/输出上限、缓存键）未实现，验收标准只是纸面。
- 七类误伤与“Windows 系配置”的真实用户占比只有定性判断，无真实语料统计。
- `[include "sub"]` 在各 Git 版本下是否始终不采纳（本机 2.50 实测不采纳；未跨版本验证）。

## 十六、B-14-1 误伤收敛（第八轮，基线 `5e4393f`）

### 16.0 冻结基线

| 项 | 值 |
|---|---|
| HEAD | `5e4393fd2232727bba30f2edd0e1a71b5da6345c`（父 `c0dbf8e`，未 amend、未 push） |
| `git status --short` | 空 |
| `git ls-files spikes` | 123 |

### 16.1 修复内容（收窄，不迁移）

第七轮“值内任何反斜杠即 `invalid`”是**整份配置级**判定，Git 能正常接受的七类真实配置会连带让 `status`/`diff`/`log`/`show`/`blame` 全部弹窗。本轮把该判定收窄到只作用于 `include.path` / `includeIf.path`：

- `parseGitConfigEntries` 增加 `isIncludePath`（`key === 'path'` 且节名命中 `include` / `includeIf`），仅该形态下的反斜杠置 `invalid = true`；
- 其余键不再因值内反斜杠置 `invalid`，解析器照常产出条目并由既有规则判定；
- **理由**：转义不会把「危险」变「安全」——布尔按「非 false 即真」、`filter`/`diff` 按「非空即危险」，归一化与否不改变判定方向；只有 include 路径需要精确归一（`evil\\cfg` → `evil\cfg`），归一缺失会漏读。
- **闭合性**：B-14-1 的 `evil\\cfg`、`evil\"cfg` 与第 7 层叠加形态仍走 `invalid → ask`，既有 3 条用例保持通过。
- 未做转义语义归一，未启动“配置探测交回 Git”的迁移（等用户拍板）。

### 16.2 “修复前会失败”证据

临时把 `isIncludePath &&` 从条件中移除（即回到整份配置级判定），跑新增用例：**1 failed / 44 skipped**，首个七类配置即断言失败（`expected { decision: 'ask' } to match { decision: 'allow' }`）。恢复收窄后 **45 passed**。

| 用例（Git 实测均 `exit=0` 接受） | 收窄前 | 收窄后 |
|---|---|---|
| `core.excludesFile = C:\\Users\\me\\.gitignore` | `ask` | `allow` |
| `safe.directory = C:\\work\\repo` | `ask` | `allow` |
| `remote "origin".url = https://example.com/a\\b.git` | `ask` | `allow` |
| `core.sshCommand = ssh -i C:\\Users\\me\\.ssh\\id_rsa` | `ask` | `allow` |
| `core.hooksPath = C:\\hooks` | `ask` | `allow` |
| `[alias] lg = log --pretty=format:\"%h %s\"` | `ask` | `allow` |
| `[diff "go"] xfuncname = ^\\s*func` | `ask` | `allow` |

七类均对 `git status` / `git diff` / `git log --oneline -5` / `git show HEAD` / `git blame a.txt` 五条命令断言 `allow`。

### 16.3 自检：收窄后危险值仍 fail-closed

| 用例 | 结果 |
|---|---|
| `[core] fsmonitor = \\path`（布尔按非 false 即真） | `ask / git-repo-config-exec` |
| `[diff "x"] command = a\\b`（非空即危险） | `ask / git-repo-config-exec` |
| `[includeIf "gitdir:~/work/"] path = evil\\cfg` | `ask / git-repo-config-exec` |
| `include.path = evil\\cfg` / `evil\"cfg`（既有 B-14-1 用例） | `ask / git-repo-config-exec`（status、diff） |
| 第 7 层 include 用转义路径（既有用例） | `ask / git-repo-config-exec` |
| 普通 include、带引号无转义、标准 LFS、本仓库真实 `.git/config` | `allow` |

### 16.4 校验结果

- 定向：`bash-readonly` **45 passed**（+1 条收敛用例）；`approval-gateway` 28、`adapter-driver-approval` 5、`approval-startup-reconcile` 4 通过。
- `tsc --noEmit`、`eslint src`、`vite build` 全过。
- 全量：`26 failed 文件 / 253 passed`，`173 failed / 3119 passed / 93 skipped (3385)`；26 个失败文件仍为既有 `better-sqlite3` ABI 文件，集合与基线一致（总数 +1 来自新增用例）。
- 未 push、未 amend；提交后不再改代码。

## 十八、迁移 S1：影子对照（起点 `1980eed`）

### 18.0 冻结基线

| 项 | 值 |
|---|---|
| HEAD | `1980eede5d6a622ff087dd20a44c9c96e0dc7659`（父 `45f527c`，未 amend、未 push） |
| `git status --short` | 空 |
| `git ls-files spikes` | 123 |

### 18.1 实现

- 新增固定 argv 探针：`git --no-pager config --list --null --show-origin --show-scope --includes`；不做任何字符串拼接。
- git 绝对路径按与应用相同的 `PATH` 解析（`delimiter` + `X_OK`），不写死 `/usr/bin/git`；继承 `process.env`，因此 `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`/`GIT_CONFIG_SYSTEM`/`GIT_DIR` 与真实命令一致；`includeGlobalGitConfig=false` 时用 `GIT_CONFIG_NOSYSTEM` + `GIT_CONFIG_GLOBAL=/dev/null` 隔离（仅测试口径）。
- 250 ms 超时、1 MB 输出上限；输出按 `--null` 三字段记录（scope / origin / `key\nvalue`，裸键无换行）解析。
- 失败分类：`missing-git` / `timeout` / `non-zero-exit` / `show-scope-unsupported` / `empty-output` / `invalid-nul-record` / `io-error`。
- 影子模式：手写结论继续决定用户可见判定；探针只记录差异与延迟，`getGitConfigShadowDiagnostics()` 暴露样本数、两个方向的差异计数、失败分布、p95/max。

### 18.2 S1 判定：**通过（附一条已解释的反向差异）**

**真实仓库语料**（本仓库 `.git/config` + 本机全局配置，五命令）：

| 命令 | 判定 | 差异 | p95 |
|---|---|---|---|
| `git status` / `git diff` / `git log` / `git show` / `git blame` | 5/5 `allow` | 0 | 11 ms |

**构造语料**：

| 用例 | 手写 | 探针 | 方向 |
|---|---|---|---|
| `GIT_CONFIG_COUNT=1` + `diff.external=/tmp/evil-diff` | `allow` | `ask` | `probeStricter`（允许方向：手写漏读 command 作用域） |
| `[includeIf "gitdir:/nonexistent/"] path = ignored.cfg`（目标含 fsmonitor） | `ask` | `allow` | `manualStricter`（反向） |

反向差异只有上述一类：Git 原生不满足 includeIf 条件、不读取目标文件，因此不会执行；手写把 includeIf 一律按「可能命中」扫描，属于已知过保守的误报。**未出现「探针 allow 但 Git 实际会执行」的形态**。`[Include "sub"]` 同理（Git 不当作 include 指令）。按验收口径记录为「解释后接受」，未据此判定回滚。

**探针失败分类**（伪造 git，`timeout` 用 500 ms 口径避免用例受调度抖动影响；生产仍为 250 ms）：缺失 / 超时 / exit 2 / 空输出 / 非法 NUL / `--show-scope` 不支持 全部按预期分类。

**行为零变化**：定向 `bash-readonly` **51 passed**（既有 45 + 新增 6），全部既有用例判定不变。

### 18.3 校验与提交

- `tsc --noEmit` / `eslint src` / `vite build` 全过（见提交前记录）。
- 全量失败集合与基线一致（26 个 `better-sqlite3` ABI 文件）。
- 未 push、未 amend；未开始 S2。

## 十九、迁移 S2：探针切门控（起点 `d3df13d`）

### 19.0 冻结基线

| 项 | 值 |
|---|---|
| HEAD | `d3df13dda6313c29ad379b2c0e1bd3c70e18287c`（S1 提交，未 amend、未 push） |
| 工作树 | 仅 `bash-readonly.ts`、其测试、本文件与 `agent-architecture.md` |
| 定向基线 | `bash-readonly` 51 passed |

### 19.1 实现

- **探针成为权威**：判定改为 `probeGitConfigExecutes(probe, sub) || manualExecutes`。手写解析器降级为「只能把结果变得更严」：探针 allow / 手写 ask → 仍 ask；探针 ask / 手写 allow → ask（不得由手写提升为 allow）。
- **探针失败一律 fail-closed**：`missing-git` / `timeout` / `non-zero-exit` / `show-scope-unsupported` / `empty-output` / `invalid-nul-record` / `io-error` 全部返回 `ask / git-repo-config-exec`，reason 带失败分类，不 fail-open。
- **运行时开关**：`BIZGRAPH_GIT_CONFIG_PROBE=off` 时，`status/diff/log/show/blame/whatchanged` 五个配置执行面子命令一律 `ask / git-repo-config-exec`（「手写 + 一律 ask」，不退回「手写 allow」）；非 git 白名单命令不受影响。
- **影子观测保留**：S1 的差异计数 / 失败分类 / p95 继续记录，供 §17.3 的 7 天运营观察；S2 起它只作观测，不再影响判定。

### 19.2 门控后的回归判定

| 用例组 | 实测 |
|---|---|
| B-14-1 `include.path = evil\\cfg` / `evil\"cfg`（status、diff） | 全 `ask / git-repo-config-exec` |
| 17.2 的五类转义 + 第 7 层 include 叠加 | 全 `ask / git-repo-config-exec` |
| 七类真实配置（`excludesFile` / `safe.directory` / `remote.url` / `sshCommand` / `hooksPath` / `alias` 内 `\"` / `[diff "go"] xfuncname`） | 全 `allow` |
| 干净仓库的 `status/diff/log/show/blame` | 全 `allow` |
| 标准 LFS（全局 `filter.lfs` 三项标准写法） | 全 `allow` |
| 本仓库真实 `.git/config` 的五命令 | 全 `allow` |
| 注入故障：git 缺失 / 超时 / exit 128 / 空输出 / 非法 NUL / `--show-scope` 不支持 | 全 `ask / git-repo-config-exec` |
| `BIZGRAPH_GIT_CONFIG_PROBE=off` 的五命令 | 全 `ask / git-repo-config-exec`（`ls` 仍 `allow`） |

**已知语义变化**：`[include]\n\tpath`（裸 `include.path`）从 S1 的 `allow` 变为 `ask`。原因是 Git 自己对 missing value 报 `error: missing value for 'include.path'` / `fatal: bad config line`，`git config --list` 退出码 128；S2 按「非零退出 → fail-closed ask」处理。Git 在该配置下执行 `status` 同样 fatal，因此不是可利用的 allow+exec。

### 19.3 「修复前会失败」证据

临时把 `gitRule` 还原为 S1 口径（手写权威、探针失败 fail-open），运行 `-t S2`：

| 用例 | 结果 |
|---|---|
| `S2：探针权威，手写漏读的 GIT_CONFIG_COUNT 注入项由探针判 ask` | `expected {decision:'ask'} / received {decision:'allow'}` |
| `S2：探针失败一律 fail-closed ask` | 首个「git 缺失」用例即 `expected {decision:'ask'} / received {decision:'allow'}` |

即 S2 之前注入故障确实会 fail-open 成 `allow`。恢复 S2 实现后同一批用例全绿（19.4）。

### 19.4 校验与提交

- 定向 `bash-readonly` **53 passed**（S1 的 51 条 + 2 条 S2 用例；S1 影子用例改写为 S2 语义）。
- 探针失败分类用例改为「非超时用例给 5000 ms、超时用例给 100 ms」，避免全量并行调度把快速退出误判为 `timeout`（首轮全量曾出现一次该抖动）。
- `tsc --noEmit` / `eslint src` / `vite build` 全过。
- 全量：`27 failed 文件 / 252 passed`，`174 failed / 3126 passed / 93 skipped (3393)`。
  - 其中 26 个文件 / 173 条为既有 `better-sqlite3` ABI（与基线一致）。
  - **新增 1 个非 ABI 失败**：`src/main/__tests__/claude-code.test.ts` 的 hook 用例使用 `workingDirectory: '/project'`（本机不存在）。S2 探针在该 cwd spawn 失败（ENOENT）按 fail-closed 判 `ask`，用例仍断言 `allow`。这是测试 fixture 使用不存在目录导致，不是 allow+exec 回归；本轮范围只允许改 `bash-readonly.ts` 及其测试，故未改该文件。**待办：把该 fixture 的 workingDirectory 换成真实临时仓库**。
- 未 push、未 amend；S3 未开始。

## 二十、迁移 S3：删除手写解析器（起点 `a7f4eb8`）

### 20.0 冻结基线

| 项 | 值 |
|---|---|
| HEAD | `a7f4eb8`（S2 提交，未 amend、未 push） |
| 工作树 | 仅 `bash-readonly.ts`、其测试、本文件与 `agent-architecture.md` |
| 前置 | S2 的 53 条定向用例在探针权威下全绿 |

### 20.1 删除范围

删除的手写逻辑：

- 配置文本解析：`gitConfigSectionIs` / `stripGitConfigComment` / `GitConfigEntry` / `parseGitConfigEntries` / `gitConfigHasEscape` / `gitConfigTextExecutes`；
- include 展开：`gitConfigPaths` / `gitConfigFilesExecute` / `findGitDir` / `gitConfigEnablesWorktreeConfig` / `repoGitConfigFiles` / `globalGitConfigExecutes` / `gitRepoConfigExecutes`；
- 相关常量与规则：`MAX_GIT_CONFIG_INCLUDE_DEPTH`、include 深度/成环不可判定、include 路径转义 invalid、裸键归一、手写 `includeIf`「条件不匹配也按可能命中扫描」。

保留：shell 词法器、命令+参数判定、`GIT_CONFIG_EXEC_SUBCOMMANDS`、`gitConfigBoolean`、`isStandardLfsFilterValue`、探针与失败分类、运行时开关。

观测接口：`getGitConfigShadowDiagnostics` → `getGitConfigProbeDiagnostics`，只保留 `samples` / `failures` / `p95LatencyMs` / `maxLatencyMs`；`probeStricter` / `manualStricter` 随手写解析器删除。

### 20.2 语义变化（S3 vs S2）

| 形态 | S2（手写 + 探针并集） | S3（Git 唯一口径） | 理由 |
|---|---|---|---|
| `includeIf` 条件不匹配，目标文件含 `fsmonitor` | `ask` | `allow` | Git 不求值匹配就不读取、不执行；手写「可能命中」是过保守误报 |
| `includeIf` 条件匹配当前仓库，路径为转义写法 | `ask` | `ask` | Git 读取转义后的危险文件（已加实测用例） |
| `include.path` 尾部反斜杠（EOF） | `ask` | `allow` | Git exit 0，按普通字符处理；include 目标不存在，无执行面 |
| B-14-1、五类转义（普通 `include.path`） | `ask` | `ask` | Git 自己解析转义路径并读取危险文件 |
| 七类真实配置 / 标准 LFS / 干净仓库 / 本仓库配置 | `allow` | `allow` | 不变 |
| 探针注入故障、`BIZGRAPH_GIT_CONFIG_PROBE=off` | `ask` | `ask` | 不变 |

### 20.3 「7 天影子观察」状态

- **未完成，不假装完成**：§17.3 的「影子日志连续 7 天 0 条『手写 allow / 探针 ask』」不在本次交付范围内，记为**待运营观察项**。
- S3 删除手写解析器后，运行时不再产生「手写 vs 探针」差异计数；该观察必须在 **S1/S2 影子构建**上完成后再把 S3 推上生产。
- `BIZGRAPH_GIT_CONFIG_PROBE=off` 回滚开关保留至观察期满（退回「一律 ask」，不退回「手写 allow」）；运行时探针失败分类与 p95 延迟观测保留。

### 20.4 校验与提交

- 定向 `bash-readonly` **53 passed**。
- `tsc --noEmit` / `eslint src` / `vite build` 全过。
- 全量：`27 failed 文件 / 252 passed`，`174 failed / 3126 passed / 93 skipped`，与 S2 一致（26 个 ABI 文件 + `claude-code.test.ts` 的 `/project` fixture 待办）。
- 未 push、未 amend。

## 二十一、迁移合并复验（S1→S2→S3，按面，2026-11-06）

### 21.0 冻结基线

| 项 | 值 |
|---|---|
| 起点 | `45f527c`（第八轮复验基线） |
| HEAD | `5a839858a97e5ac33bc888e2ec3da41310bc0d33`（S3） |
| 父链 | `5a83985` ← `a7f4eb8`（S2） ← `d3df13d`（S1） ← `1980eed` ← `45f527c` |
| 工作树 | `git status --short` 为空；`git ls-files spikes` = 123 |
| 区间变更 | 4 文件 / 772 insertions / 317 deletions（`bash-readonly.ts` 549 行变更、测试 301 行、审计文档 237 行、架构文档 2 行） |
| 复验方式 | 全部结论来自本机实测；S1 使用 `git archive d3df13d` 导出树 + 本仓 `esbuild` 打包后重跑，未改源码、未 commit、未 push |

### 21.1 面一｜S1 影子：代码存在，但“观测”无留档，只能回溯复算

**结论：S1 的生产影子观测无法验证；只能在 `d3df13d` 树上复算。**

- 影子模式确实存在：`d3df13d` 的 `bash-readonly.ts` 含 `gitConfigShadowState`、`recordGitConfigShadow`、`getGitConfigShadowDiagnostics()`，每次 `gitRule` 都同时算「手写」与「探针」，判定仍以手写为准（影子不影响 `decision`）。这一点有代码可查，不是自述。
- 但**没有留下可复算的观测证据**：全仓无影子日志、无序列化产物、无 IPC/持久化；`getGitConfigShadowDiagnostics()` 只是进程内窗口（500 条）。`§18.2` 的 `5/5 allow、差异 0、p95 11 ms` 是作者自述数字，**无法用留档复核**。
- S3 之后**影子不可运行**：HEAD 只剩 `getGitConfigProbeDiagnostics()`（`samples`/`failures`/`p95LatencyMs`/`maxLatencyMs`），没有 `probeStricter`/`manualStricter`，也没有手写解析器可比。要再产影子数据只能回退到 `d3df13d`/`a7f4eb8`。

回溯复算（`git archive d3df13d` 导出 + 同一语料）：

| 语料 | samples | probeStricter | manualStricter | p95 |
|---|---|---|---|---|
| 本仓库 `5a83985` 工作树，五命令 | 5 | 0 | 0 | 10 ms（max 10 ms） |
| `GIT_CONFIG_COUNT` + `diff.external` | 1 | 1 | 0 | 9 ms |
| `includeIf` 条件不匹配 | 2 | 0 | 2 | 9 ms |
| `include.path` EOF 尾反斜杠 | 3 | 0 | 3 | 8 ms |
| 尾部转义反斜杠、目标不存在 | 3 | 0 | 3 | 8 ms |
| 1.8 MB 本地配置 | 3 | 3 | 0 | 17 ms |
| `diff.external` / `textconv` / `filter` / `fsmonitor` / `showSignature` / `config.worktree` / `depth10` / `depth11` / 转义 include / 符号链接 include | 各 3 | 0 | 0 | 8–10 ms |

- **差异方向不是单向**：构造语料里除 `probeStricter` 外还有 `manualStricter`（`includeIf` 不匹配、EOF 尾反斜杠、尾反斜杠目标不存在）。`§18.2`「反向差异只有 `includeIf` 一类」只对当时那份语料成立；这三类本轮都用真实 git 证明无执行面（见 21.3）。
- **p95 / 超时率在哪查**：只在 `getGitConfigShadowDiagnostics()`（S1/S2）与 `getGitConfigProbeDiagnostics()`（HEAD）的内存返回值里；无落盘、无上报。HEAD 的探针指标也只有测试在调用，生产路径不读。因此运营侧「7 天 0 差异」缺数据源，不能事后补算。

### 21.2 面二｜S2 fail-closed 注入（十类，逐项实测）

| 注入 | 结果 | 分类 | 判定 |
|---|---|---|---|
| git 缺失（`PATH=""`） | `ask` | `missing-git` | 通过 |
| `PATH=/nonexistent-bin` | `ask` | `missing-git` | 通过 |
| 超时（`include.path` 指向 FIFO） | `ask`，252 ms | `timeout` | 通过（无残留子进程） |
| 非零退出（include 深度 11，Git fatal） | `ask` | `non-zero-exit` | 通过 |
| 非零退出（`.git/config` 语法坏） | `ask` | `non-zero-exit` | 通过 |
| 空输出（非仓库 + 全局/系统配置指向 `/dev/null`） | `ask` | `empty-output` | 通过 |
| 非法 NUL（伪造 git，2 字段） | `ask` | `invalid-nul-record` | 通过 |
| 非法 NUL（4 字段） | `ask` | `invalid-nul-record` | 通过 |
| `--show-scope` 不支持（伪造 git，exit 129） | `ask` | `show-scope-unsupported` | 通过 |
| 输出 > 1 MB（真实 1.8 MB 配置） | `ask` | 记为 `timeout`（实为 `ENOBUFS`） | 安全通过，**分类错**（P3） |
| 输出 > 1 MB（伪造 git 输出 2 MB） | `ask` | 记为 `timeout` | 同上 |
| 只读目录（仓库目录 `chmod 555`） | `allow` | 无失败 | **未落 ask**，但探针读取成功、无执行面，不构成 fail-open |
| `.git/config` `chmod 000` | `ask` | `non-zero-exit` | 通过 |
| `.git` 目录 `chmod 000` | `allow` | 无失败 | Git 视为「非仓库」，真实命令同样读不到仓库配置；无执行面 |
| `cwd` 不存在 | `ask` | `missing-git`（ENOENT 误标） | 安全通过，分类错（P3） |
| `GIT_CONFIG_COUNT=1` + `diff.external`（应用进程环境） | `ask` | 探针读到 `command` 作用域 | 通过 |
| `GIT_CONFIG_GLOBAL` 指向坏文件 | `ask` | `non-zero-exit` | 通过 |
| `GIT_DIR` 指向含危险配置的仓库 | `ask` | 探针读到该仓库 | 通过 |
| `GIT_WORK_TREE` 指向别处 | `allow` | 无失败 | 通过（不改变配置来源） |
| `BIZGRAPH_GIT_CONFIG_PROBE=off` | 五类 git 读命令全 `ask`；`ls` 仍 `allow` | 运行时开关 | 通过 |
| **应用进程环境含 `GIT_DIR` 指向干净仓库，cwd 为脏仓库** | **`allow`，真实 `git diff` 执行 `diff.external`** | 环境不一致 | **fail-open（P2）**，见 21.4 |

小结：十类里 8 类稳定落 `ask`；「只读目录」不构成失败条件；真正的缺口是**探针环境与真实命令环境不一致**（21.4 第 3 条），不是失败分类本身。

### 21.3 面三｜S3 删除手写逻辑后的旧洞回归（策略 + 真实 git 双验）

| 族谱 | 策略 | 真实 git | 结论 |
|---|---|---|---|
| `git status $HOME` / `{a,b}` / `\`+换行 / `$'\x67it status'` | `ask`（`shell-expansion`/`shell-brace`/`shell-continuation`） | — | 未松 |
| `git stat\us`（反斜杠转义普通字母） | `allow` | shell 同样得到 `status` | 等价，未松 |
| `file --co` / `git fsck --lost-f` | `ask`（长选项缩写按前缀匹配） | — | 未松 |
| `diff.external` | `ask` | `EXEC` 已复现 | 闭合 |
| `diff.<drv>.textconv` | `ask` | `EXEC`（`git diff` 调用） | 闭合 |
| `filter.<name>.clean` | `ask` | `EXEC`（`git status` 调用） | 闭合 |
| `core.fsmonitor=<path>` | `ask`（status/diff/blame） | `EXEC`（`git status` 调用） | 闭合 |
| `log.showSignature=true` + `gpg.program` | `ask` | `EXEC`（对含 `gpgsig` 头的提交，`git log --show-signature` 调用伪造 gpg） | 闭合 |
| 仅 `gpg.program`，显式 `git log --show-signature` | `ask`（参数规则 `--show-signature`） | `EXEC` | 闭合 |
| `config.worktree` + `extensions.worktreeConfig` | `ask` | `EXEC` | 闭合 |
| include 深度 10（第 10 层含危险键） | `ask` | 探针读取成功并命中 | 闭合 |
| include 深度 11 | `ask` | Git fatal | 闭合（与 Git 一致） |
| `evil\\cfg`（转义反斜杠路径） | `ask` | `EXEC`（目标文件名含字面反斜杠） | 闭合 |
| `evil\"cfg`（转义引号路径） | `ask` | `EXEC` | 闭合 |
| 相对 `include.path=../evil-rel.cfg` | `ask` | `EXEC` | 闭合 |
| `includeIf` 条件**匹配**当前仓库 | `ask` | `EXEC` | 闭合 |
| **`includeIf` 条件不匹配** | `allow` | `NO`（Git 不求值就不读） | 变松但无执行面 |
| **`include.path` EOF 尾反斜杠（目标存在）** | `allow` | `NO` | 变松但无执行面 |
| **尾部 `\\`、目标不存在** | `allow` | `NO`；同名「字面反斜杠」文件存在时策略转 `ask` 且真实 git `EXEC` | 变松但目标不存在时无执行面 |

三处变松的更正（`§20.2` 的说明需要修订）：

- `include.path` 尾部反斜杠的真实机制不是「目标不存在」，而是 **Git 的 include 解析使用含尾反斜杠的原始值，因此该 include 根本不被展开**（`git config --get include.path` 只显示去掉反斜杠后的路径，容易误导）；即使目标存在（`evil-nl.cfg`，且文件以换行结尾）实测也不执行。
- 只要存在「字面反斜杠」的同名文件（`evil\cfg`），Git 就会读取并执行；此形态策略为 `ask`（探针读到 `diff.external`），未放行。
- `includeIf` 不匹配同理：Git 不读、不执行，`allow` 正确；`includeIf` 匹配形态为 `ask` 且执行，已实测。

### 21.4 面四｜探针自身新攻击面

1. **FIFO**：`include.path` 指向 FIFO 时探针阻塞到 250 ms 超时后 `ask`；未留下 `git config` 僵尸进程。副作用是**同步阻塞主进程 252 ms/次**，属可感知的 DoS 面（需要先有一次被批准的写/mkfifo）。
2. **符号链接 include**：Git 跟随软链，探针同样跟随并读到危险键 → `ask`；未见漏放。
3. **超大配置**：`maxBuffer` 1 MB 截断，Node 以 `ENOBUFS`/`SIGTERM` 终止子进程；内存不随输出无限增长。**分类错**：代码判 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，Node 实际给 `code='ENOBUFS'`，落到 `signal==='SIGTERM'` 分支被记成 `timeout`（仍是 fail-closed）。
4. **探针环境 vs 真实命令环境（重要，P2）**：探针用 `{...process.env}`；Bash 子进程用 `buildSafeEnv()`，后者**丢弃全部 `GIT_*`（仅保留 `GIT_EDITOR`）**并丢弃 `GIT_CONFIG_*`。
   - 方向一（只多弹）：应用环境含 `GIT_CONFIG_COUNT` → 探针读到 `command` 作用域 → `ask`，真实命令读不到 → 误 ask。
   - 方向二（**漏放**）：应用环境含 `GIT_DIR` 指向干净仓库、cwd 为含 `diff.external` 的仓库 → 探针 `allow`；真实 Bash（`GIT_DIR` 被剥离）在 cwd 执行 `diff.external`。已复现（21.9 命令 2）。
   - `GIT_WORK_TREE`/`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_NOSYSTEM` 同类，均可造成「探针读 A、命令读 B」。桌面端正常启动（Finder/Dock）不会带这些变量；从终端/CI/hook 启动的开发者环境可能带。
5. **探针用绝对路径 git**：`resolveGitExecutable()` 每次按 `process.env.PATH` 解析绝对路径，未写死 `/usr/bin/git`。若 PATH 中有可写目录被投毒，探针与被测命令通常同源（同样受害），不构成额外提权；但若 shell 启动脚本改写了 PATH（nvm 等），探针与真实命令可能用的是**不同版本/不同二进制**，语义随之分叉。
6. **TOCTOU**：探针读完配置到命令执行之间无锁。配置（或原本不存在的 include 目标）在窗口内被其他会话改写，可出现「判定 allow、执行时已变脏」。窗口为毫秒级，且需要并发写入；当前架构未消除，属已知残余。

### 21.5 面五｜性能与摩擦

同一语料、每条 20 次（五次 git 读命令），手写基线取 `45f527c`：

| 语料 | 手写 avg / p95 | 探针 avg / p95 | 增量 |
|---|---|---|---|
| 干净仓库 | 0.27 / 1.38 ms | 8.27 / 10.09 ms | **+8.0 ms/次** |
| 10 层 include | 1.47 / 1.89 ms | 9.38 / 10.21 ms | +7.9 ms/次 |
| 1.8 MB 配置 | 39.62 / 49.81 ms | 17.30 / 18.68 ms（`ask`） | 更快，但一律 ask |
| 本仓库 | 0.09 / 0.35 ms | 7.54 / 8.67 ms | +7.5 ms/次 |
| FIFO（最坏） | — | 252 ms（`ask`） | 同步阻塞 |

- 单次 `status`/`diff` 新增约 7–8 ms；正常人类交互不可感，但 agent 连续执行几十条 git 命令会累计约 0.2–0.5 s。
- 非 git 命令不触发探针（`ls` 0 ms）；只有 `diff/log/show/status/blame/whatchanged` 六类子命令探测。
- 抽样 allow 比例：本仓库五命令 5/5 allow；41 条常见命令合成样本 27 allow / 14 ask = **66%**（6 条 git 读子命令全 allow）。生产 `agent_events` 抽样不可得（本机应用库无 `agent_events` 表），未编造生产比例。

### 21.6 面六｜测试基线

本机复跑（HEAD `5a83985`）：

- `27 failed 文件 / 252 passed`；`174 failed / 3126 passed / 93 skipped (3393)`。
- 与迁移前基线（`45f527c`，`173 failed / 3119 passed`）相比：**+1 failed、+7 passed、+8 总数**，与 S1→S3 新增 8 条定向用例吻合。
- 唯一新增失败文件是 `src/main/__tests__/claude-code.test.ts`：fixture `workingDirectory: '/project'` 在本机不存在；探针 `execFileSync` 以该 cwd 启动 git 得 `ENOENT` → `missing-git` → `ask`，用例仍断言 `allow`。
  - 同一 cwd 在 `45f527c` 的手写口径下判 `allow`（`findGitDir` 找不到仓库即放行），故这是**探针引入后的行为差**。
  - 性质：**fixture 假 cwd 导致**，不是 allow+exec 回归。生产等价场景是「会话工作目录不存在/已删除/未挂载」，此时行为是 fail-closed `ask`（摩擦变大，不是漏放）。
  - 最小修法（测试侧）：`claude-code.test.ts` 的 `makeConfig` 用 `fs.mkdtempSync` 真实目录（或 `process.cwd()`），并同步改两处 `options.cwd === '/project'` 断言。
- 其余 26 个失败文件均为既有 `better-sqlite3` ABI（`NODE_MODULE_VERSION 130 vs 115`）；`pipeline.test.ts` 单独跑 6/6 通过，不在失败集，属全量并发下的已知抖动，不计入迁移差异。

### 21.7 判定与阻断项

**一句话判定：不可发布。**

阻断项 **2 个**：

1. **代码（P1，B2 模型内可达）**：`core.alternateRefsCommand` + `git rev-list --alternate-refs` 零审批执行外部程序。策略 `allow`（`git:rev-list`），真实 git 已复现执行。攻击面与 B2 完全同构：一次被批准的写即可写 `.git/config` 与 `.git/objects/info/alternates`。探针不检查该键，参数表也未登记 `--alternate-refs`。**非 S3 引入**（`45f527c` 同样存在），但 HEAD 仍可打。
2. **流程（验收）**：`§17.3` 的 S3 验收要求「影子日志连续 7 天 0 条『手写 allow / 探针 ask』」。三段时间戳为 S1 `19:36` → S2 `19:47` → S3 `19:55`，影子窗口实际只有约 **11 分钟**（S2 到 S3 约 8 分钟），且 S3 已删除影子计数；没有任何留档证据。S1 验收按用户要求只能记「**无法验证**」。

非阻断但必须在下一版修的 2 项：

3. **P2｜探针/执行环境不一致**（21.4 第 4 条）：`GIT_DIR` 可复现 allow+exec；修法是探针改用与 Bash 子进程相同的 `buildSafeEnv()`。
4. **P3｜失败分类可观测性**（`ENOBUFS` 记成 `timeout`；`cwd` ENOENT 记成 `missing-git`）：不影响 fail-closed，但会误导运营判断。

### 21.8 运营问题：S3 在 7 天观察期满前上生产

- **构成发布阻断（流程性），但不是安全阻断**：它使 `§17.3` 的 S3 验收条件不可满足，且 S3 删除影子后**无法补采**。安全面本身已由 21.3 的族谱回归兜住已知形态；未知形态仍缺观测。
- **最小回退形态**：部署 `a7f4eb8`（S2），即「**保留探针门控 + 恢复手写影子计数**」，继续观察至 7 天/足够样本后再上 S3。
  - **不要**回退到 `d3df13d`（S1：手写权威）——手写解析器含已闭合的 allow 洞（B-14-1、include 深度等），回退等于重开。
  - **不要**把「降低探针阈值」当成替代：阈值只影响延迟与误 ask，不产生「手写 vs 探针」差异证据。
  - `BIZGRAPH_GIT_CONFIG_PROBE=off` 只能退到「一律 ask」，不能用于观察。
- 替代路径：由产品+安全书面豁免观察期，补偿证据采用 21.3 的族谱回归 + 21.2 的注入全覆盖，并在豁免单上注明「无生产影子数据」。

### 21.9 最小改法（交给修复方，本轮未改源码）

1. `core.alternateRefsCommand`（阻断项 1）——在 `DANGEROUS_ARGS_BY_COMMAND.git` 追加两条（长选项按前缀匹配，已覆盖缩写）：
   ```ts
   { flag: '--alternate-refs', rule: 'git-alternate-refs', reason: 'git rev-list --alternate-refs 会执行 core.alternateRefsCommand', risk: HIGH },
   { flag: '--include-alternate-refs', rule: 'git-alternate-refs', reason: 'for-each-ref 的 alternate refs 选项会读取仓库配置', risk: HIGH },
   ```
   并补一条定向用例。复现：
   ```sh
   # 构造：仓库 B 的 .git/objects/info/alternates 指向另一仓库，config 写 core.alternateRefsCommand=/tmp/marker.sh
   git -C <repo> rev-list --alternate-refs        # 真实执行 marker
   # 策略：decision=allow, rule=git:rev-list
   ```
2. 探针环境一致性（P2）——`probeGitConfig()` 内把 `const env = { ...process.env }` 改为 `{ ...buildSafeEnv() }`，再叠加现有的 `includeGlobal=false` 覆盖（`GIT_CONFIG_NOSYSTEM/GIT_CONFIG_SYSTEM/GIT_CONFIG_GLOBAL` 与删除 `GIT_CONFIG_COUNT*`）。`buildSafeEnv` 位于 `src/main/shared/env.ts`，无循环依赖。复现：
   ```sh
   GIT_DIR=/path/clean/.git node -e "evaluateBashPolicy('git diff',{cwd:'/path/dirty'})"  # 当前 allow
   env -u GIT_DIR git -C /path/dirty diff                                          # 真实执行 diff.external
   ```
3. 分类修正（P3）——`probeGitConfig` 的 catch 增加 `detail.code === 'ENOBUFS'` → `io-error`（现落到 `signal==='SIGTERM'` → `timeout`）；`cwd` 不存在可细分为独立失败码，避免与「git 缺失」混淆。

### 21.10 复算记录

| 文件 | 追加前 sha256 | 追加后 sha256 |
|---|---|---|
| `bash-readonly.ts` | `4b85e6c50f9b458484b39e0356fa346275b4017d448eca0c6c3f930911cf2a29` | 同左（未改） |
| `bash-readonly.test.ts` | `a910d77baa3aded1db66274d7a027b6ab35117cc5cdc467a1071a9f293f64ec0` | 同左（未改） |
| `agent-audit-2026-11-05.md` | `8ebc6488fa9a5fa0e17b0404da1ad3d869101eae760a52861a19448759ce7fa7` | `5adaccb9fa362038a06cd69247f1efc7b80cd43e7a3f134c141a5ce74c54f9da`（正文追加后、写入本表前；本表写入后最终值再变一次，以 `shasum -a 256` 现算为准） |

- HEAD 复算：`5a839858a97e5ac33bc888e2ec3da41310bc0d33`；源码/测试未改（`bash-readonly.ts`、`bash-readonly.test.ts` 哈希不变）；`git status --short` 仅显示本文件 `M`；未 commit、未 push、未 amend。
- 复验脚手架全部在 `/tmp/audit9`（`git archive` 导出树、esbuild 打包、伪造 git、FIFO/软链/深度/转义夹具），未写入工作区。

## 二十二、复验阻断修复（P1/P2/P3，起点 `5a83985`，2026-11-06）

### 22.1 范围

按复验结论只修 P1（零审批执行）、P2（探针环境不一致）、P3（失败分类与 fixture）；**未动影子模式、未改回退策略**（等产品决定）。P1 除修 `core.alternateRefsCommand` 两层外，按普查要求实测了执行型配置键全表，并在普查中发现两个**未被复验列出、但实测零审批执行**的路径，一并修掉：

| 新发现 | 复现 | 修法 |
|---|---|---|
| `core.hooksPath` + `post-index-change` 钩子 | `git config core.hooksPath /tmp/hooks`，`/tmp/hooks/post-index-change` 写 marker；`git status` 刷新/回写 index 时 marker 生成 | 配置面：`core.hookspath` + `status` → `git-repo-config-exec` ask |
| `git remote show` + `remote.*.uploadpack` / `ext::` | `git config remote.origin.uploadpack /tmp/up.sh` → `git remote show origin` 执行 marker；`remote.origin.url=ext::sh -c ...` + `protocol.ext.allow=always` 同样执行 shell | 参数面：`git remote show` → `git-remote-show` ask；`-v` / `get-url` 保持 allow |

### 22.2 修复前会失败（HEAD `5a83985` + 新用例）

把生产文件临时还原为 HEAD、只跑新增用例（`/tmp/pre-fix.log`）：

| 用例 | 修复前结果 | 修复后 |
|---|---|---|
| P1 参数面：`rev-list --alternate-refs` / `--alternate-ref` 缩写 | `allow`（`git:rev-list`） | `ask / git-alternate-refs / high` |
| P1 配置面：仓库含 `core.alternateRefsCommand` + `git rev-list HEAD` | `allow` | `ask / git-repo-config-exec` |
| P1 执行面：真实 git + alternates + marker | marker=true，但策略 `allow` | 策略 `ask / git-alternate-refs` |
| P1 普查：`git remote show origin` | `allow / git:remote:read` | `ask / git-remote-show / high` |
| P1 普查：`core.hooksPath` + `git status` | `allow / git:status` | `ask / git-repo-config-exec` |
| P2：`GIT_DIR` 指向干净仓库、cwd 为含 `diff.external` 的脏仓库 | 探针读干净仓库（无 `diff.external`）→ `allow` | 探针按 `buildSafeEnv()` 读脏仓库 → `ask` |
| P3：cwd 不存在 | `missing-git` | `cwd-missing` |
| P3：探针输出 > 1 MB | `timeout` | `io-error` |

真实 git 执行面证据（不是只断言策略输出）：

```sh
# P1 alternateRefsCommand（仓库 B 的 objects 作为 alternates）
git -C a rev-list --alternate-refs          # → core.alternateRefsCommand 执行，marker=ran（exit 129 是「无 ref」的参数错误，执行发生在参数校验前）
git -C a rev-list --alternate-ref        # → git 拒绝该缩写，marker=NONE（说明参数面前缀匹配是「如果 git 将来接受」的防御）
git -C a for-each-ref --include-alternate-refs  # → git 拒绝（exit 129），marker=NONE；§21.9 建议的这条登记可不需要
# P2 环境差异
GIT_DIR=clean/.git git -C dirty config --list | grep -c diff.external   # → 0（探针修复前读的是 clean）
env -u GIT_DIR git -C dirty diff                                        # → 真实执行 diff.external，marker 生成
# remote show
git -C repo remote show origin               # → remote.origin.uploadpack 执行，marker=ran
```

### 22.3 P1 修复内容

1. 参数面：`DANGEROUS_ARGS_BY_COMMAND.git` 新增 `--alternate-refs`（`git-alternate-refs`, high）；既有 `isAbbreviatedLongFlag` 将 `--alternate-ref` 唯一前缀一并覆盖。
2. 配置面：`probeGitConfigExecutes` 新增 `core.alternaterefscommand`（仅 `rev-list`）与 `core.hookspath`（仅 `status`）；`GIT_CONFIG_EXEC_SUBCOMMANDS` 增加 `rev-list`、`ls-files`（`ls-files` 实测会执行 `core.fsmonitor`）。
3. 参数面：`git remote show` 由 allow 改 ask（`git-remote-show`），切断 `remote.*.uploadpack` / `ext::` / `sshCommand` 的零审批执行入口；`remote -v` / `get-url` 仍 allow。
4. `git grep` 仍保持整条 ask（既有结论未受本轮影响）。

### 22.4 P2 修复内容

- `probeGitConfig()` 的 env 由 `{ ...process.env }` 改为 `buildSafeEnv()`，与真实 Bash 子进程**同一环境构造**。`buildSafeEnv` 剥离全部 `GIT_DIR` / `GIT_CONFIG_*` / `GIT_CONFIG_COUNT` / `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` / `GIT_EXTERNAL_DIFF` / `GIT_SSH*` 等，唯一放行的 `GIT_*` 是白名单里的 `GIT_EDITOR`；该键不被只读命令消费，因此无需为语义对齐额外保留。`HOME` / `XDG_CONFIG_HOME` / `PATH` 在两边都保留，全局配置读取范围与真实命令一致。
- 语义变化（必须记录）：应用进程若携带 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` 注入 `diff.external`，旧探针会 ask，而真实 Bash 子进程根本看不到这些变量。修复后探针与真实命令一致 → **allow**；原用例已改为断言 allow 并注明原因。
- 真实命令行为不变：`buildSafeEnv()` 仍是 Bash 子进程的环境来源，未改执行路径。

### 22.5 P3 修复内容

- catch 分类顺序：`show-scope` 不支持 → `ETIMEDOUT` → `ENOENT`（按 cwd 是否存在分 `missing-git` / `cwd-missing`）→ `ENOBUFS` / `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` → 其它 IO → `SIGTERM` → `timeout` → 非零退出 → `io-error`。`ENOBUFS` 不再因为伴随 SIGTERM 被误标为 `timeout`。
- `GitConfigProbeFailure` 增加 `cwd-missing`（探针侧 `existsSync(cwd)` 前置判定）。
- `src/main/__tests__/claude-code.test.ts` 的 `workingDirectory: '/project'` 改为模块级真实临时 Git 仓库（HEAD + objects + refs/heads + config），第 99 行断言同步；生产逻辑未为测试改动。

### 22.6 执行型配置键普查

完整表与「可能不全」结论见 `agent-architecture.md` §4.6「执行型配置键已知清单（2026-11-06 普查）」。要点：

- 已实测执行：`diff.external`（diff）、`core.fsmonitor`（ls-files）、`core.hooksPath`（status 的 `post-index-change`）、`core.alternateRefsCommand`（rev-list `--alternate-refs`）、`remote.*.uploadpack` / `protocol.ext.allow+ext::`（remote show）、`core.pager`（仅终端/`-p`）。
- 未单独实测、按同路径保守 ask：`diff.*.command/textconv`、`filter.*`。
- 只由写子命令或网络操作消费、只读命令 allow：`core.sshCommand`、`core.editor`/`sequence.editor`、`uploadpack.packObjectsHook`、`core.gitProxy`、`credential.helper`、单独 `gpg.program`。
- 部分实测：`log.showSignature` 在无签名提交上不调用 gpg，有签名才调用；策略仍保守 ask。
- 结论写为「已知清单 + 承认可能不全」：git 新增键、第三方 driver/filter 与未来版本执行点均可能不在此表。
- 结构性兜底（本轮未做）：本机 24 个配置键中系统级 `credential.helper` 命中 1 个，若全作用域按 `command|program|helper|hook|pager|editor|exec` 一律 ask，则所有仓库的每条 git 只读命令都会弹窗，代价不可接受；repo-local 命中 0，但 `filter.lfs.*` 等常见键不含关键词，兜底价值有限。建议维持显式清单，另加「未知执行语义键名」只记录告警。

### 22.7 验证

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `npx eslint src` | 通过 |
| `npx vite build` | 通过 |
| 定向 `bash-readonly.test.ts` | 61 条通过（新增 P1/P2/P3 8 条 + hooksPath 1 条） |
| 定向 `claude-code.test.ts` | 通过（fixture 修复后恢复 allow 语义） |
| 全量 `npx vitest run` | `173 failed / 3135 passed`，26 个失败文件全部是 `better-sqlite3` ABI（`NODE_MODULE_VERSION 130 vs 115`）；基线 `174 failed / 3126 passed`（27 文件）中的 `claude-code.test.ts` 已回落，新增用例计入 passed |

未 commit、未 push、未 amend。
