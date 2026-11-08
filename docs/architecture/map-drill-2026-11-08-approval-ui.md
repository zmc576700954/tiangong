# 受控演练失败记录：审批弹窗未挂载（2026-11-08）

> 三态口径：**实测**＝本次真机跑出来的观测；**推断**＝由代码/条件推出的解释，未直接观测；**未验证**＝本轮未跑到或未核对的环节。
> 本记录只记录失败，不在本文语境里修任何东西；修复见 `535479d`（全局审批入口）与 `b55048e`（gate 逐道诊断），重跑结论另行记录。

## 1. 演练目标与方式

用 `c602ee7`（schema v35 验收确认独立存储）之后的构建，在完全隔离环境跑一次受控闭环，验证：

gate 六道 → tick 领取 → kernel turn → **工具调用时的写前审批** → 验收执行器 → `manual` 落 `needs_input` → 面板确认收口 → 证据绑定 → 退出无残留。

方式：

- 构建：仓库内 `npx vite build`（2026-11-08 15:33 产物）。
- 项目目录：`/tmp/bizgraph-drill-20261108/project`（空目录，仅放演练目标文件）。
- userData：`/tmp/bizgraph-drill-20261108/userData`（通过 `--user-data-dir` 隔离，实测 `app.getPath('userData')` 随之改变）。
- 真实库：`~/Library/Application Support/bizgraph/data/bizgraph.db`，演练前后只读核对 mtime，**未被打开**。
- 两阶段启动：先不带开关启动一次建 schema（v0 → v35）；再由脚本直连 sqlite3 落种子数据；再带 `BIZGRAPH_MAP_EXECUTION=1`、`BIZGRAPH_MAP_EXECUTION_ADAPTER=claude-code` 启动演练进程。
- 种子：`g_drill` / `n_drill`(dev) / `wi_drill`（`status=queued`、`gate_status=pass`、scope 一个文件）/ `ws_drill`（`status=pending`），`acceptance_json` 含 1 条 `command` + 1 条 `manual`。

## 2. 结果：断在「审批可见可决议」

| 环节 | 结论 | 三态 | 依据 |
|---|---|---|---|
| gate 六道判定 | 未逐道可查（tick 内评估，只留最终判定） | 推断（通过） | item 进入 running + 后续 claim/run 成立，说明未走 waived/blocked 分支；无逐道日志 |
| tick 领取 | 通过 | 实测 | `workitem:step:run` 返回 `STEP_NOT_PENDING "step status=running"`；`work_runs` 出现 `wr_1794124243679_…` |
| kernel turn 真实启动 | 通过 | 实测 | `[MapExecutionRuntime] 执行触发已启动：adapter=claude-code`；`[prompt-orchestrator] Assembled prompt … 245 tokens` |
| **工具调用审批真的弹了** | **失败** | 实测 | 主进程侧审批真实生成（`agent_approvals` 两条 Bash 行），事件也到达 renderer（`pending=1`），但 **DOM 中始终没有审批卡片**；180s 后超时被 fail-closed 拒绝 |
| 验收执行器跑并给结果 | 未达 | 未验证 | step 停在 running，无验收结果 |
| `manual` 落 `needs_input` | 未达 | 未验证 | `input_request_json` 为空 |
| 面板确认按钮点击收口 | 未达 | 未验证 | — |
| 证据绑定实际执行内容 | 未达 | 未验证 | `node_evidence` 无行 |
| 退出正常无残留 | 通过 | 实测 | `APP_CLOSED`；`LEFTOVER_CHECK exit=1 output=[]`（`pgrep -fl <project>` 无匹配） |

## 3. 断点与根因

### 3.1 断点（实测）

审批卡片没有出现在界面上：

- `DIAG_APPROVAL` 每 5s 一条，持续 180s，均为 `pending:1`、`domHasApprovalText:false`；
- 等待 `button.bg-orange-600`（允许按钮）180s 超时，落 `APPROVAL_DIALOG_NOT_VISIBLE_IN_180S`；
- 失败截图里右栏 Agent tab 显示「欢迎使用 Agent」空态，没有任何审批卡片。

### 3.2 根因（推断，已由代码位置确认）

`ApprovalRequestDialog` 只挂在 `AgentChatPanel` 的「存在 UI 会话线程」分支：

```
{!currentThread && threads.length === 0
  ? 空态「欢迎使用 Agent」
  : (<ChatHeader/> … <ApprovalRequestDialog/> …)}
```

编排 runtime 的 kernel turn 由主进程发起，不写入 renderer 的 `threads`/`currentThread`。
因此 `currentThread` 为空 → 走空态 → 对话框从未挂载 → 请求虽到达 renderer 但无组件渲染。
120s 交互超时后 `ApprovalGateway` 按 fail-closed 落 `denied`。

**这是产品侧缺口，不是驱动/构建问题**（实测：构建产物含 `getPendingApprovals` 与 `bg-orange-600`；renderer 收到事件、`getPendingApprovals` 返回 1 条）。

## 4. 证据清单

留档目录：`/tmp/bizgraph-drill-20261108/`（临时、易失；条目随环境清理会消失）。

| 文件 | 内容 |
|---|---|
| `drill.mjs` | 演练脚本（两阶段启动、种子、断言、诊断、收尾） |
| `out/drill.log` | 逐行观测（`SCHEMA_READY version=35`、`SEED_OK`、`ENQUEUE_PROBE`、`DIAG_APPROVAL`、`APPROVAL_DIALOG_NOT_VISIBLE_IN_180S`） |
| `out/main-process.log` | 主进程日志（默认关闭行、开关启动行、prompt 组装行） |
| `out/99-failure.png` | 失败时整屏截图（右栏空态，无审批卡片） |
| `out/bizgraph-final.db(+wal/shm)` | 演练库退出后快照 |
| `out/db-query.log` | 快照查询结果 |
| `out/leftover-processes.log` | 残留进程检查 |

关键日志原文：

```
[Database] Migrating schema from v0 to v35...
[Database] 历史人工验收确认行 0 条（agent_approvals 无需迁移）
[Database] Schema migrated to v35
[MapExecutionRuntime] 执行触发未开启（默认关闭）：tick 不启动，写通道将拒绝调用
[MapExecutionRuntime] 执行触发已启动：adapter=claude-code interval=1000ms
[prompt-orchestrator] Assembled prompt for session claude-…: 245 tokens …
ENQUEUE_PROBE {"ok":false,"error":{"code":"STEP_NOT_PENDING","message":"step status=running"}}
DIAG_APPROVAL {"events":["appr_143f0ed9-…"],"pending":1,"domHasApprovalText":false}
APPROVAL_DIALOG_NOT_VISIBLE_IN_180S
```

库快照（退出时）：

```
schema_version|35
work_items | wi_drill | running | pass
work_steps | ws_drill | running | 1 | (input_request_json 空)
work_runs  | wr_1794124243679_ff228049 | running | | claude-…
agent_approvals | appr_143f0ed9-… | Bash | denied | timeout
agent_approvals | appr_ab6c6783-… | Bash | pending |
```

## 5. 环境核对（实测）

- 真实库 mtime 基线 `1794051235`（`2026-11-07 19:33:55`），演练后复核同为 `1794051235`，未被触碰。
- 演练库 `schema_version=35`（本次构建的当前版本）。
- `BIZGRAPH_MAP_EXECUTION` 默认值：首次启动日志明确「执行触发未开启（默认关闭）」，代码 `isMapExecutionEnabled()` 未设置即 false——演练只在第二进程注入，开关未落任何持久配置。
- 演练结束 `app.close()` 后无残留进程；临时 `project` 与 `userData` 已删除，仅保留证据目录。

## 6. 为什么单测发现不了

1. **测试环境从不「无线程」**：`ApprovalRequestDialog.test.tsx` 直接渲染对话框组件本身，断言「有 pending 就出现卡片」。它验证的是组件内逻辑，而断点在**父组件的挂载条件**——单测绕过了 `AgentChatPanel` 的条件分支。
2. **组件测试不覆盖编排来源**：既有用例投递的都是「聊天 turn」形状的请求，`sessionId/turnId` 均在 UI 线程里；编排 runtime 发起的 turn 不会进入 `threads`，这一差异只在真机集成里出现。
3. **IPC 与渲染分层各自为绿**：主进程测试证明网关会广播、会超时；renderer 测试证明组件能渲染。两段都对，但中间「审批入口挂在哪」没有断言，属于集成层契约缺口。
4. **类型系统帮不上**：「对话框必须在有线程时才能挂载」不是类型错误，而是 UI 结构假设；只有把审批入口改成应用级（与线程无关）并在非 Agent 页面也能看到的集成断言，才能覆盖。
5. **演练才有的时序**：tick 在 `createWindow()` 之前启动并自动领取，窗口出现时审批往往已在进行——单测按「先有界面、再有请求」构造，恰好掩盖了「界面无挂载点」的情形。

## 7. 后续（仅指向，不含修复细节）

- 审批入口改为应用级、与聊天线程解耦：`535479d`（`approvalStore` + 全局 `ApprovalInbox`，聊天弹窗投影同一事实源）。
- gate 逐道诊断：`b55048e`（引擎只读、tick 落 `map_migration_reports`）。
- 重跑演练：标准提高为「非 Agent 页面可见并决议 + 六道 gate 各自可查 + 全链路收口 done」。
