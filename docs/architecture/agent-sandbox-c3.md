# C3 执行面沙箱：立项与选型备忘

> 状态：**决策稿（2026-11-06）**，不含实现。用户已决定「先定 C3，再决定 P1 补丁粒度」。
> 本文只回答“做什么、能做到什么、代价多少、哪些仍不能放开”，不修改任何策略语义。
> 关联：[agent-architecture.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md) §4.6 / §4.6.1 / 覆盖边界；
> [agent-audit-2026-11-05.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-audit-2026-11-05.md) §30–§32。

---

## 0. 结论：推荐方案

**推荐 Tier 2（单平台可用）先做 macOS，再 Linux，Windows 最后且允许“只降级不落地”。**

1. **先做 macOS，不是因为 macOS 最安全，而是因为它最先能产生可用证据**：`sandbox-exec` 系统自带、无需额外二进制、对签名/公证无新增要求；本机 macOS 26.5.1 实测仍可用（见 §2.1）。POC 已证明它能同时做到「工作区可写、工作区外不可写、`.git/config` 不可写、外部 fsmonitor/gpg 不可执行」。
2. **Linux 第二**：Landlock 无特权可用且内核 ≥5.13 即可，但它是**纯 allow-list、没有 deny 规则**，无法在“整个工作区可写”之上单独挖掉 `.git/config`；要么枚举 `.git` 内允许写的子路径，要么引入 bubblewrap。这个表达力差异必须在选型时定死，不能照搬 macOS profile。
3. **Windows 最后**：AppContainer 需要原生 API（创建 profile、ACL 授权、带 `SECURITY_CAPABILITIES` 启动），Node/Electron 没有现成路径；restricted token + job object 只能做降权与进程树/资源限制，**不是文件路径沙箱**。Windows 首版建议只做「job object 收进程树 + 沙箱不可用即 ask」，不要承诺文件面隔离。
4. **判据采用“allow 集 ⊆ 沙箱安全集”作为门禁**，而不是“所有命令都进沙箱就完事”：沙箱必须逐命令证明自己能把该命令的配置执行面/写入面收敛，未证成的命令继续 ask（§4）。
5. **降级语义采用“不可用即不允许 allow 集，退回 ask”**（§6）。这不是零成本：在旧系统/被安全软件拦截的机器上，所有只读命令都会回到逐条审批；用可用性换可验证性，是本项目当前阶段的正确取舍。

**不推荐**：一开始就做三平台。三平台的差异不是“同一 profile 换语法”，而是三套能力模型；先做三平台会把 80% 工期花在 Windows 原生层，却拿不到 macOS/Linux 已有的安全收益。

---

## 1. 现状：执行面到底在哪

### 1.1 代码事实

| 事实 | 证据 |
|---|---|
| Claude 走 Agent SDK，但 CLI 子进程由**我们**通过 SDK 的 spawn 钩子拉起，可插入 wrapper | [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L537-L548) |
| Codex 通过 `codexPathOverride` 注入自有 shim，shim 再拉起真实 CLI，可插 wrapper | [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L138-L144) |
| OpenCode 直接 `spawn('opencode')`，可把 command 换成 wrapper | [opencode.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts#L48-L55) |
| 子进程统一 `detached: true`（POSIX 下 setsid，pgid=pid），wrapper 必须 `exec` 真 CLI 才能保组 | [process-supervisor.ts](file:///Users/zhumingchen/tiangong/src/main/shared/process-supervisor.ts#L339-L361) |
| Bash 策略判定在宿主（Claude 钩子/网关），**执行在 CLI 子进程内部** | [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L352-L359)、[gateway.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L62) |
| MCP server 由宿主 `spawn`，**不在 CLI 子进程树内**，且无进程组/沙箱 | [mcp/client.ts](file:///Users/zhumingchen/tiangong/src/main/mcp/client.ts#L120-L123) |
| Codex 自带 `sandboxMode: workspace-write`，但它把 `.git` 也算 workspace，不拦 `.git/config` | [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L151-L161) |

**结论**：所有后端工具（Bash、写文件、自定义工具）都在**各自 CLI 子进程树内**执行；Bash 策略只覆盖 Claude 的 Bash 入口。因此 C3 只能挂在 **CLI 子进程 spawn 处**（以及 MCP server spawn 处），挂在“工具调用”层没有意义——真正的副作用发生在子进程里。

### 1.2 与 C3 直接冲突/缺失的现状

- `buildSafeEnv()` 只做环境变量白名单，**没有 `no_new_privs`**（[env.ts](file:///Users/zhumingchen/tiangong/src/main/shared/env.ts#L13-L95)）。Linux Landlock 要求先 `PR_SET_NO_NEW_PRIVS`；Node `child_process` 没有该选项，必须由原生 wrapper 或独立 helper 设置。
- MCP server 进程不在任何沙箱内；`mcp__*` 工具由 server 进程执行，C3 若只包 CLI，MCP 是明确缺口。
- Codex 自己的 `workspace-write` 与宿主 profile 会叠加：宿主必须把 `.git/config`、`.git/hooks`、`.git/info/exclude` 再挖掉，否则 Codex 沙箱不拦。
- 受控 spawn 依赖 `detached: true`。wrapper 若 fork 后不 `exec`，进程组会变成 wrapper 的组，回收逻辑（按 pgid kill）会打偏；实现时必须 `exec`。
- 没有任何启动期“沙箱可用性自检”；当前设备能力未知即等于没有门禁。
- profile 路径必须用 **realpath 归一**：本机 POC 中 `/tmp/...` 与 `/private/tmp/...` 不一致时，`subpath` 放行会失效（§2.1 实测）。

---

## 2. 平台机制：真实能力边界

### 2.1 macOS：`sandbox-exec`（Seatbelt）

**可用性**：`/usr/bin/sandbox-exec` 在 macOS 26.5.1 上仍存在且可执行（本机实测）。Apple 自 10.15 起把它标为 deprecated，且 SBPL 是**未公开语言**；但截至本机版本没有替代品（EndpointSecurity 需要 entitlement，App Sandbox 需要签名/容器且不能约束任意 CLI 子进程）。

**本机实测（macOS 26.5.1 / arm64）**，仓库 `/private/tmp/c3poc/repo`，外部 marker `/tmp/c3poc/marker.log`：

| 场景 | profile 关键规则 | 结果 |
|---|---|---|
| 基线（无沙箱）`git status` + `core.fsmonitor=外部脚本` | — | marker **生成** |
| 写收敛：允许工作区写、允许 exec，外部脚本仍可执行 | `(allow file-write* (subpath "工作区"))` | `git status` exit 0，marker **未生成**（脚本运行但写被拒） |
| exec 收敛：只允许 `git`/`git-core`/`/bin`/工作区 exec | `(deny process-exec)` + 白名单 | 外部 fsmonitor 与外部 `gpg.program` **未执行**；git exit 65/71 |
| gitdir 收敛：工作区可写，但挖掉 `.git/config`、`.git/hooks`、`.git/info/exclude` | allow workspace + deny 具体路径 | `git config core.fsmonitor ...` **失败**；`git status` 正常；工作区普通文件写入正常 |
| 路径归一 | profile 未用 realpath | `/tmp` 与 `/private/tmp` 不一致时，工作区写被误拒；realpath 后正常 |

**能力边界**：

| 能力 | 是否可做到 | 说明 |
|---|---|---|
| 只允许工作区写、系统/家目录只读 | ✅ | `deny default` + `allow file-read*` + `allow file-write* (subpath 工作区)`。读范围可进一步收紧，但要把 dyld、系统库、git exec-path、`/dev`、用户临时目录逐条放行，profile 维护成本高。 |
| 只允许工作区写、其他路径读也禁止 | ⚠️ 可行但脆弱 | 需要列出大量系统路径；版本升级/新工具链可能缺路径导致“命令莫名失败”。建议首版只做写收敛 + 敏感目录读拒绝（`~/.ssh`、`~/.aws`、keychain 目录），不做全量读白名单。 |
| 禁掉“git exec 外部程序”链 | ✅（按可执行文件路径） | `deny process-exec` + 只放行 `git`、`/usr/libexec/git-core`、`/bin/sh`、工作区内脚本。代价：配置指向系统外二进制时 git 直接失败（exit 65/71），不是静默成功。 |
| 约束 gitdir 写入 | ✅（按具体文件） | 工作区整体可写之上，可 `deny file-write*` 对 `.git/config`、`.git/config.lock`、`.git/hooks/**`、`.git/info/exclude` 单独挖洞。**SBPL 例外优先，本机已验证**。 |
| 禁止网络 | ✅ | `(deny network*)`；对 git 只读命令足够，但以后要 `fetch/push` 时必须显式开口。 |
| 约束“合法允许目录内的内容” | ❌ | 沙箱只看路径，不看文件内容/来源；工作区内可写就是可写。 |
| 跨进程继承 | ✅ | fork/exec 子进程继承同一 profile，hooks/fsmonitor 的子进程也在笼子里。 |
| 防绕过 profile 表达力 | ❌ | SBPL 未公开；mach lookup、sysctl、文件描述符继承等无法像 Linux namespace 一样穷举。profile 要按“最小可用”维护。 |

**对本项目的额外约束**：App Store 沙箱化发行与非沙箱发行不同；若未来走 Mac App Store，沙箱是容器级，`sandbox-exec` 子进程策略仍需另测。当前直发/公证路径无新增签名要求。

### 2.2 Linux：Landlock / seccomp / bubblewrap

| 机制 | 能力 | 关键限制 | 对本项目适配 |
|---|---|---|---|
| **Landlock** | 无特权文件系统 allow-list：读/写/执行、按路径子树；内核 ≥5.13；网络 TCP bind/connect 从 ABI v4（≥6.7）；需 `no_new_privs` | **只有 allow，没有 deny**：无法“允许整个工作区可写，但排除 `.git/config`”；必须在规则里枚举允许写的子路径（如 `.git/index`、`.git/objects`、`.git/refs` + 工作区业务目录），或反过来只允许工作区且接受 `.git` 可写。不能按 syscall 过滤 | 首选。需原生 wrapper 设置 `no_new_privs` 后调用 `landlock_create_ruleset`/`add_rule`/`restrict_self`；Node 无 API，需 N-API 或随包分发的小 helper。旧内核（Ubuntu 20.04 5.4）不可用 → 降级 ask。 |
| **seccomp** | 可过滤 syscall；可整体禁 `execve/execveat`、限制危险 syscall | **无路径概念**：不能表达“只写工作区”；禁 `execve` 会连 `git` 自身拉起 `git-status`/hooks 一并禁掉 | 作为 Landlock 的补强（禁 `ptrace`、`socket` 等），不单独作为文件沙箱。 |
| **bubblewrap** | mount namespace + `ro-bind /` + `rw-bind 工作区` + `tmpfs` + `--unshare-all` + `--die-with-parent`；可 `--ro-bind` 单文件挖掉 `.git/config` | 依赖 unprivileged user namespace；Ubuntu 23.10+/24.04 默认 AppArmor 限制 unprivileged userns；发行版不一定预装；静态二进制需随包分发并处理签名/杀软 | 若产品愿意随包分发 bwrap，它比 Landlock 表达力更强（能做“工作区可写但 `.git/config` 只读”）；代价是 userns 兼容性与二进制供应链。 |

**Linux 结论**：**Landlock 可行但表达力不足**；要完整对齐 macOS 的 gitdir 挖洞，需要 bwrap 或“把 `.git` 内允许写的路径枚举出来”的 Landlock profile。建议 Linux 首版接受“`.git` 整体可写但 `.git/config`/hooks 通过 allow-list 排除”的枚举方案，枚举不完整就继续 ask。

### 2.3 Windows：AppContainer / restricted token + job object

| 机制 | 能力 | 关键限制 | 对本项目适配 |
|---|---|---|---|
| **AppContainer** | 进程级低权限容器：默认无网络（需 capability）、文件访问需显式 ACL 授予 AppContainer SID、可在 job 中限制资源 | 需要原生 API：`CreateAppContainerProfile`、`DeriveAppContainerSidFromAppContainerName`、`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 启动；Node/Electron 无直接支持；profile 创建/ACL 授权在受管企业环境与杀软下行为需实测；对 git 这类需要读系统 DLL、用户配置的进程，ACL 授权面很大 | 三平台里成本最高。建议先做“原生 helper + 最小 profile”POC，再决定是否产品化。 |
| **Restricted token** | 降低完整性级别/移除管理员 SID；可配合低完整性 IL 阻止写多数用户文件 | **不是路径沙箱**：低 IL 也会阻止写工作区（工作区是 medium IL），需要改 ACL/IL 或给工作区单独授权；不能表达“只允许工作区写” | 可作为 AppContainer 的补充（再降权），不能单独作为 C3。 |
| **Job object** | 进程树可靠回收、内存/CPU/进程数限制、`KILL_ON_JOB_CLOSE` | 不是安全边界；不限制文件/网络/exec | 应做（与安全无关，但补现有进程回收的可靠性）；不能算 C3 达成。 |

**Windows 结论**：若必须三平台对等，Windows 需要一个原生 helper（C++/Rust + N-API 或独立 exe），工期与风险显著高于 macOS/Linux。首版建议只承诺 **job object + 不可用即 ask**，文件面隔离留到有明确客户需求。

---

## 3. 判据落地：可执行验收物

### 3.1 三条判据的定义

1. **allow 命令在沙箱内执行**：`evaluateBashPolicy` 返回 `allow` 的命令，其子进程必须处于已启用的平台沙箱；任何未沙箱化的 allow 都视为门禁失败。
2. **毒化矩阵 Harness**：对「配置键 × 仓库状态 × allow 命令」的笛卡尔积运行真实 git，断言工作区外无 marker、gitdir 关键文件哈希不变、工作区外 canary 文件未创建/未修改。
3. **`allow 集 ⊆ 沙箱安全集`**：每条 allow 命令必须在 Harness 里至少有一条“毒化配置下仍无外部副作用”的通过记录；没有记录的命令不得进入 allow 集（新增命令必须同时补 Harness 行）。

### 3.2 Harness 矩阵

- **配置键**：`core.fsmonitor`、`core.hooksPath`、`diff.external`、`diff.*.textconv`、`diff.*.command`、`filter.*.clean/smudge/process`、`core.alternateRefsCommand`、`gpg.program`、`log.showSignature`、`format.pretty`、`include.path` / `includeIf.*.path`、`protocol.*.allow`。
- **仓库状态**：fresh / stale index、bare、linked worktree、submodule、`.git` 为文件（gitdir pointer）、`.git` 为 symlink、dangling symlink、`include` 指向工作区内/外、大小写折叠路径（macOS）、hardlink 到工作区外。
- **命令集**：当前 allow 集全量（18 条子命令 + 各参数形态），以及 `describe --dirty`、`shortlog --format=%G?` 等已确认执行面。
- **断言**：
  - 工作区外 marker **不存在**；
  - `gitdir` 的 `.git/config`、`.git/hooks/**`、`.git/info/exclude` 内容哈希**不变**；
  - 工作区外 canary **未创建**；
  - 良性仓库下命令仍能产出预期输出（防止“全部失败也算安全”的假绿）。

### 3.3 CI 可行性

| 平台 | 能否在托管 CI 跑 | 说明 / 兜底 |
|---|---|---|
| macOS（GitHub Actions） | ✅ 大概率可行 | `sandbox-exec` 是系统自带；runner 是 VM，SIP 不影响。但必须先跑 **canary 自检**：沙箱内写工作区外必须失败；若 canary 未被拒绝，判为“CI 不支持沙箱”，跳过而非误报通过。 |
| Linux（GitHub Actions） | ✅ 可行（Landlock） | `ubuntu-latest` 内核 ≥6.8，支持 Landlock；bwrap 依赖 userns，Ubuntu 24.04 默认 AppArmor 可能拒绝，需先探测。seccomp/Landlock helper 需在 CI 镜像里可执行。 |
| Windows（GitHub Actions） | ⚠️ 不确定 | AppContainer 需要原生 API 与权限，托管 runner 的账户/权限与杀软行为未知；**不把 Windows 沙箱作为 CI 门禁**，只做 job object 测试。Windows 文件面验收改为**发布前本地/自托管 runner**执行。 |
| 本地发布门禁 | ✅ 必须做 | `npm run sandbox:verify`：跑 canary + Harness 子集（当前平台全量、其他平台 skip），日志归档到发布清单。CI 跑不了时，这一步是唯一证据，发布负责人签字。 |

**门禁策略**：CI 上按平台能力跑；平台不支持时产物标记 `sandbox: unavailable`，**不得**把它当作通过。发布前必须至少有一个平台的完整 Harness 通过。

---

## 4. 与现有手写策略的关系（放开 / 仍 ask 的账）

前提：沙箱 profile 达到“工作区可写、工作区外不可写、`.git` 关键文件不可写、外部二进制不可执行、网络默认禁”。**只有在这个前提下**下表才成立；若首版只做写收敛（不做 exec 收敛），右列要相应收紧。

| 现有判定 | 沙箱在位可否降为 allow | 理由 | 副作用 / 仍 ask 的条件 |
|---|---|---|---|
| `core.fsmonitor` 存在 → 探针命令 ask（husky 等） | ✅ 可降 allow | fsmonitor 脚本即使执行，也写不出工作区外、exec 不到白名单外；`git status/log/diff` 仍能正常出结果 | 若 profile 未做 exec 白名单，脚本可在系统二进制范围内执行；若未收紧读，脚本可读家目录。只有“读也收紧”才完全安全。 |
| `core.hooksPath` 存在 → ask | ✅ 可降 allow | 只读命令（log/show/status）本不触发 hooks；探针 ask 只是保守。即使触发，也在笼子里 | hooks 可在工作区内持久化污染；若 hooksPath 指向工作区外，read/exec 被拒，命令失败但无副作用。 |
| `diff.external` / `filter.*` / `textconv` | ⚠️ 有条件放开 | 外部程序可执行但写/读/网络受限；若允许 `/usr/bin` 内任意程序，仍可能读家目录 | 必须收紧读；否则保留 ask。首版建议：只对“值指向 standard git-lfs / 系统已知二进制”的形态放行，其余 ask（与现有 LFS 值判定一致）。 |
| `core.alternateRefsCommand` | ✅ 可降 allow | 外部命令在笼子里，且只读命令本身不写工作区外 | 命令失败时 `rev-list --alternate-refs` 可能报错；可接受。 |
| `gpg.program` + `%G` | ❌ **仍 ask** | gpg 需要 `~/.gnupg` 读密钥；严格读策略下验证必然失败，放开等于“允许一个注定失败的命令”，体验更差 | 若为了可用性放开家目录读，则密钥暴露面重新打开；不建议。 |
| `format.pretty` / `pretty.*` / `log.showSignature` | ❌ 仍 ask | 同 gpg：签名验证需要密钥环；渲染失败/输出退化会让用户误判 | 除非产品接受“签名验证不可用”，否则 ask。 |
| B：未知配置键（默认 ask） | ⚠️ 部分放开 | 沙箱保证“效果被限制”，但不保证“行为符合用户预期”；未知键可能让命令失败或语义变化 | 建议按键分类：只影响输出格式/排序的键可 allow；会拉起外部程序/网络的键仍 ask。首版不要整体翻转 B。 |
| D1：写 `.git/config` / include 目标 | ✅ OS 层直接关死 | profile 对 `.git/config`、hooks、exclude 单独 deny；对 include 目标所在路径，工作区外的写本来就不允许 | 工作区内被 include 的普通文件仍可写（业务文件），但写它不再能改变 git 配置执行面——因为 `.git/config` 本身不可写。 |
| D1-1：dangling symlink / symlink 终点 | ✅ OS 层按 realpath 判定 | Seatbelt 按真实路径规则匹配；工作区外终点不匹配 allow | 需要在 profile 生成前对工作区做 realpath；实现细节见 §1.2。 |
| Bash 只读命令读工作区外文件 | ⚠️ 需 profile 收紧读才成立 | 现有策略不限制读；沙箱首版若 `allow file-read*`，读面没有改善 | 若要关“读任意路径”，必须做读白名单；这是 C3 的第二阶段，不是首版。 |
| MCP 写工具 / 非标准工具名 | ⚠️ 取决于是否包 MCP server | CLI 沙箱不覆盖宿主 spawn 的 MCP server | 必须把 MCP server spawn 一并包进沙箱；否则 MCP 仍是缺口。工具名本身不需要 D1 识别。 |

**诚实结论**：
- 沙箱真正能“放开体验”的是 **fsmonitor/hooksPath 这类配置存在性 ask**（husky 那批），以及 **alternateRefsCommand / link 类外部命令**。
- **gpg / 签名验证类不能放开**：不是沙箱拦不住，而是放开后功能必然不可用。
- **B 不能整体翻转**：沙箱只保证“坏效果有限”，不保证“命令还能用”；未知键应继续按“是否拉起外部程序”分级。
- **D1 是真正被 OS 层关死的**，比继续加手写规则更可靠；但 D1 绕过的工作区内写入（业务文件）不属于 D1。
- 因此，“沙箱上线后大部分 ask 都能放开”是**不成立**的；可量化的收益主要是 husky 场景 ~17–18 条，以及少数外部命令形态。

---

## 5. Enforcement 位置

**挂在“宿主 spawn 出的、可能执行 agent 工具的进程”入口，而不是 Bash 工具调用处。**

| 入口 | 覆盖 | 做法 |
|---|---|---|
| Claude CLI（SDK spawn 钩子） | Bash、写文件、自定义工具、hooks 子进程 | wrapper 命令：`sandbox-exec -f profile -- <claude>`；`exec` 真 CLI 保持 pgid |
| Codex CLI（shim） | 同上 | 在现有 shim 外层再套 wrapper，或让 shim 自身 `exec sandbox-exec` |
| OpenCode CLI（直接 spawn） | 同上 | `spawn(wrapper, [...])` |
| MCP server（宿主 spawn） | MCP 工具 | 单独包 wrapper；MCP server 通常只需读工作区 + 写少量缓存，profile 要单独调 |
| 旧路径（`BIZGRAPH_AGENT_KERNEL=0`） | 同 Claude/Codex/OpenCode | 与内核路径同一 spawn 点，天然覆盖；这是 C3 相对 D1/B 的优势 |
| 远端后端 / HTTP 执行器 | 不覆盖 | 目前不存在；若未来接入，沙箱不适用，必须单独声明 |

**工具名问题**：C3 不需要识别 `mcp__*` / `write_file`。只要执行进程在笼子里，工具叫什么都逃不出路径/exec/网络限制。**但**这要求 MCP server 也被包；否则 `mcp__*` 仍可写外部路径。

---

## 6. 降级语义

**规则：沙箱不可用 → allow 集整体退回 ask；不允许“沙箱不可用但仍 allow”。**

不可用判定（启动自检 + 每次 spawn 前轻量校验）：

1. 平台二进制/内核能力不存在（旧 macOS、内核 <5.13、Windows 无 AppContainer helper）；
2. canary 自检失败：沙箱内对工作区外写/exec 未被拒绝；
3. 用户/企业安全软件拦截 wrapper（EDR 阻止 `sandbox-exec` 或原生 helper）；
4. 打包/签名导致 wrapper 无法启动（公证后 helper 被 Gatekeeper 拦）。

**影响面**：
- 所有只读 Bash 回到逐条审批（当前默认就是 ask，用户会明显感到“变慢”）；
- husky 仓库的 ask 量回到当前水平（本仓实测 31/44 → 14/44 的收益消失）；
- 不影响写类工具的审批（本来就走网关）；
- 需要在 UI 明示“本机沙箱不可用，只读命令将逐条确认”，并提供诊断日志，避免用户以为是产品退化。

**建议的产品姿态**：沙箱不可用不是错误，是**降级模式**；设置页展示状态与原因，允许用户“复制诊断信息”。不做“用户点一下就在无沙箱下继续 allow”的开关——那会让门禁失效。

---

## 7. 成本与风险

### 7.1 分档工作量（人日，含自测/文档；依据见下）

| 档位 | 范围 | 估算 | 依据 |
|---|---|---|---|
| **Tier 1：POC 单平台** | macOS：静态 profile + wrapper + canary + Harness 骨架；只覆盖 Claude 一个后端 | **3–5 人日** | profile 迭代 1–2d（本机已验证核心规则，仍需处理 dyld/临时目录/路径归一）；spawn 接入 0.5–1d（Claude 钩子现成）；canary/降级 0.5d；Harness 骨架 1–1.5d。 |
| **Tier 2：单平台可用（macOS）** | 三后端 + MCP + gitdir 挖洞 + 审计/UI 降级 + 完整 Harness + CI | **8–12 人日**（含 Tier 1） | 三后端接入各 0.5–1d；MCP profile 0.5–1d；profile 兼容性/回归 2d；Harness 扩到矩阵 2–3d；CI 与发布门禁 1d；文档/回归 1d。 |
| **Tier 2b：Linux 可用** | Landlock 原生 wrapper + 规则枚举 + 发行版兼容 + Harness | **+5–9 人日** | N-API/helper 2–3d；`.git` 可写子路径枚举与验证 2–3d；旧内核/发行版降级 1d；CI 1d。bwrap 方案另加 3–5d（二进制分发/签名）。 |
| **Tier 3：三平台** | Windows AppContainer helper + ACL/profile + CI/自托管验收 | **+8–12 人日** | 原生 helper 3–5d；profile/ACL 与 git 兼容 3–4d；杀软/企业环境验证 1–2d；发布验收 1d。**不含**持续维护成本。 |
| **三平台合计** | — | **22–34 人日**（约 5–7 周单人） | 以本机 POC 与现有 spawn 结构为基准；不含后续 git/OS 版本回归。 |

### 7.2 能关闭哪些已确认的洞

| 洞 | Tier 1（macOS 写收敛） | Tier 2（macOS 完整） | Linux（Landlock/bwrap） | Windows（AppContainer） |
|---|---|---|---|---|
| H7 配置执行面（fsmonitor/hooksPath/gpg 等） | 部分：外部程序可执行但写不出工作区外；**不关 exec** | ✅（exec 白名单 + 写收敛） | ✅（同左，需 helper） | ✅（AppContainer 默认禁网络、ACL 控写） |
| D1-1 / D1-2（gitdir / include 写入） | ✅ 工作区外写 + gitdir 关键文件 deny | ✅ | ✅（枚举 `.git` 可写子路径） | ✅（ACL 只给工作区） |
| B（未知配置键） | 部分：效果被写收敛限制 | ✅（读/exec 收敛后） | ✅（Landlock 同） | ✅（AppContainer） |
| Bash 读工作区外 | ❌（首版 allow file-read*） | ⚠️ 需读白名单 | ⚠️ 需读白名单 | ✅ ACL |
| MCP 工具写外部 | ❌ 未包 MCP | ✅ 需包 MCP | ✅ | ✅ |
| 工作区内持久化污染 | ❌ | ❌ | ❌ | ❌ |
| 依赖投毒 | ❌ | ❌ | ❌ | ❌ |

### 7.3 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| **签名/公证** | 公证后的 wrapper/helper 被 Gatekeeper 拦；Mac App Store 沙箱与子进程 profile 叠加未知 | 独立 helper 走 Developer ID + hardened runtime；发布前在真实公证产物上跑 canary；App Store 发行单独评估。 |
| **杀软误报** | `sandbox-exec`/原生 helper 被 EDR 判为“进程限制工具”并阻断 | 提供诊断码；不可用即 ask；企业白名单文档。 |
| **性能开销** | 每个 turn 新增一次 wrapper 启动；profile 解析/路径归一 | 实测基线（后续）；profile 缓存；wrapper `exec` 不 fork 以减少一层进程。 |
| **SBPL 表达力/绕过** | profile 无法穷举 mach/ioctl/继承 fd；用户可在工作区内写恶意脚本 | 只承诺路径/exec/网络面；不承诺“防同 uid 恶意进程”；seccomp/Job object 补强。 |
| **git 版本行为变化** | 新 git 子命令/新配置键引入新的执行面，profile 未覆盖 | Harness 固定 git 版本矩阵；allow 集新增必须过 Harness（门禁 3）。 |
| **命令失败被误判为通过** | 沙箱拒绝导致 git 直接失败，Harness 只看“无 marker”会假绿 | 断言必须包含“良性仓库输出正确”；失败单独标记。 |
| **降级面过大** | 旧系统/企业机器大量回到 ask，用户认为产品退化 | UI 明示 + 诊断信息 + 设置页状态；发布说明写清。 |
| **MCP 遗漏** | 只包 CLI，MCP 仍可写外部 | MCP spawn 同批接入；未接入前把 MCP 写工具保持 ask。 |

---

## 8. 明确不覆盖

C3 之后仍然存在、且**不应**被“上了沙箱”掩盖的风险：

1. **工作区内合法写入被滥用**：agent 可以在工作区写任意文件、改构建脚本、写 `.git/hooks`（若 profile 未挖）→ 持久化污染；沙箱只限制“写到哪里”，不限制“写什么”。
2. **依赖/工具链投毒**：工作区内已存在的 `node_modules`、`vendor`、恶意 `package.json` scripts 仍可在允许范围内执行；沙箱不做来源/完整性校验。
3. **允许目录内的数据泄露**：若读白名单包含工作区与家目录某些路径，恶意脚本可在笼子里读取并编码进工作区文件/输出；网络禁用能降低外传，但不能阻止“写进工作区再被后续提交”。
4. **社会工程与审批语义**：用户批准一个命令，C3 只保证它“炸不出去”，不保证命令本身可信；写类工具的批准仍需要审批 UI。
5. **同 uid 恶意进程**：C3 不是进程间隔离；同用户的其他进程仍可读写工作区、伪造文件、干扰 agent。
6. **宿主/内核漏洞与 profile 误配**：SBPL/原生 helper 的 bug、路径归一遗漏（`/tmp` vs `/private/tmp`）、大小写折叠都可能造成误放行；需要 canary + Harness 持续验证。
7. **资源耗尽/DoS**：macOS/Linux 首版不做 CPU/内存/进程数限制；Windows job object 可补，但不属于 C3 安全面。
8. **远端/HTTP 后端**：若未来出现，不在本机沙箱覆盖范围。

---

## 9. 决策清单（建议按此拍板）

1. **批准 Tier 2 的 macOS 首版**（8–12 人日），目标是：三后端 + MCP spawn 都在沙箱内；`.git/config`/hooks/exclude 不可写；外部 exec 白名单；canary + Harness 门禁；不可用即 ask。
2. **Linux 排第二**，先做 Landlock 枚举方案；若产品要求“工作区可写但 `.git/config` 只读”的对等表达力，再评估随包 bwrap（+3–5 人日）。
3. **Windows 暂不承诺文件面隔离**；只做 job object 与降级 ask，等有企业客户/合规要求再立 AppContainer 项。
4. **不在 C3 首版放开 gpg/签名验证与 B 的全部未知键**；只放开 fsmonitor/hooksPath 与 alternateRefsCommand 这类“contained but still works”的判定。
5. **门禁写死**：allow 集新增命令必须同时提供 Harness 行；CI/本地发布门禁缺一不可。
