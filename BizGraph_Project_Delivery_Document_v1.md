# BizGraph — Agent CLI 桌面编排器
## 项目交付文档 v1.0

> **文档性质**: 技术方案与开发路线图  
> **交付对象**: 项目管理者 / 技术负责人  
> **日期**: 2026-05-25  
> **版本**: v1.0 (Phase 1 聚焦版)  
> **核心理念**: 先让 CLI+MCP 跑起来，开源后再考虑自研引擎

---

## 目录

1. [项目概述](#1-项目概述)
2. [问题定义](#2-问题定义)
3. [产品定位](#3-产品定位)
4. [双图架构](#4-双图架构)
5. [业务流程闭环](#5-业务流程闭环)
6. [技术架构](#6-技术架构)
7. [技术栈选型](#7-技术栈选型)
8. [Agent 适配器层](#8-agent-适配器层)
9. [范围守卫三层防御](#9-范围守卫三层防御)
10. [代码→语义逆向工程](#10-代码语义逆向工程)
11. [16周开发路线图](#11-16周开发路线图)
12. [调试工具链](#12-调试工具链)
13. [MCP 配置方案](#13-mcp-配置方案)
14. [风险与对策](#14-风险与对策)
15. [开源策略](#15-开源策略)
16. [附录：精确路径对照表](#16-附录精确路径对照表)

---

## 1. 项目概述

BizGraph 是一款面向团队的**开源 Agent CLI 桌面编排器**。它以"思维导图"为核心交互层，连接产品经理的业务意图与开发者的代码实现，同时作为外部 Agent 工具（Claude Code、Codex、OpenCode 等）的"桌面指挥塔"，解决当前 AI 编码 Agent 只关心代码逻辑、不关心业务逻辑的结构性缺陷。

**一句话定位**：BizGraph 不是又一个 AI 编码工具，而是第一个"Agent CLI 的桌面指挥塔"——让 Claude Code、Codex、OpenCode 在业务地图上按规矩干活，不乱改、不越界、可验收、可回滚。

---

## 2. 问题定义

### 2.1 当前 AI Agent 编码工具的结构性瓶颈

当前所有主流 Agent 工具（Cursor、Claude Code、Codex、OpenCode）存在一个共同缺陷：

> **Agent 只关心代码逻辑，从不关心用户的业务逻辑。**

具体表现：
- 修复一个 Bug 时，Agent 会在全代码库范围内自由搜索和修改
- 经常把用户的其他代码搞乱（修改了不该改的文件、破坏了业务契约）
- 产品经理无法参与验收过程，因为业务逻辑以隐式形式散落在代码中，没有可视化表达
- 没有版本化的业务蓝图，每次重构都是盲人摸象

### 2.2 根因分析

| 层级 | 问题 | 结果 |
|------|------|------|
| **符号层 vs 语义层** | LLM 擅长符号操作（代码语法），极度薄弱于语义推理（业务意图） | 语法正确，语义跑偏 |
| **上下文诅咒** | 业务逻辑隐式分布在整个代码库，Agent 上下文有限 | 局部修改破坏全局约束 |
| **反馈偏差** | Agent 的奖励函数是"测试通过"，但测试覆盖不了未编码的隐式业务约束 | 测试通过 ≠ 业务正确 |
| **范围蔓延** | Agent 自作主张地"重构"或"清理"超出任务范围的代码 | 引入 unintended side effects |

---

## 3. 产品定位

### 3.1 不是"自带发动机的整车"，而是"方向盘和导航系统"

| 组件 | 汽车类比 | 软件类比 |
|------|---------|---------|
| Claude Code / Codex | 发动机 | 代码生成引擎 |
| BizGraph | 方向盘 + 仪表盘 + 导航 | 业务语义层 + 范围控制 + 验收面板 |
| 思维导图 | 导航地图 | 业务拓扑的可视化 |
| 占位节点→合并 | 目的地设定→到达确认 | 需求定义→开发→测试→验收闭环 |

### 3.2 核心差异化

| 维度 | 传统 Agent 工具 | BizGraph |
|------|--------------|---------|
| 核心对象 | 文件/代码 | 业务模块/流程节点 |
| 交互范式 | 聊天式指令 | 画布式指认（点击即范围） |
| 可视化单元 | 代码 diff | 思维导图节点 |
| 验收方 | 开发者（看测试通过） | 产品经理（看流程图匹配） |
| 状态表示 | Git commit | 思维导图快照版本 |
| 知识沉淀 | 代码注释（易腐烂） | 思维导图（活文档） |

### 3.3 开源价值主张

**为什么社区需要 BizGraph？**

当前 Agent CLI 工具都是**终端黑盒**：
- 开发者说"帮我改退款流程"，Agent 会全网搜索、猜测范围、可能改错文件
- 没有业务语义的可视化，产品经理无法参与验收
- 没有 Bug 追踪机制，改完一轮又一轮，没有收敛感
- 没有版本化的业务蓝图，每次重构都是盲人摸象

BizGraph 解决这些痛点，同时**不替代任何 Agent 工具**——它让现有 Agent 工具变得更好用、更可控、更可协作。

---

## 4. 双图架构

### 4.1 核心概念

BizGraph 引入**两张独立的思维导图**，将业务语义层与代码实现层彻底分离：

| 图谱 | 别名 | 权限 | 作用 |
|------|------|------|------|
| **真实业务流程图** | Production Graph / 业务宪法 | 产品经理主权，只读为主 | 反映线上系统真实运行的业务逻辑，是团队的"单一事实来源" |
| **开发流程图** | Development Graph / 功能分支 | 开发者主权，可编辑 | 从真实图派生的独立副本，用于实现具体功能点 |

**关键原则**：开发图上的所有操作（代码生成、Bug 修复、文件挂载）**绝不直接污染真实图**。只有经过测试验证、产品经理审查确认后，才能通过"合并"操作将开发图的内容同步到真实图。

### 4.2 权限分离模型

```
产品经理 (Product Owner)
├── 拥有：业务语义层
│   - 创建/删除/重命名业务节点（模块、流程、决策点）
│   - 编辑节点间的逻辑关系（连线、层级）
│   - 定义业务规则（挂载到节点的验收标准）
│   - 设置节点验收标准（Acceptance Criteria）
│   - 确认/驳回开发者的实现补充
├── 无权限：
│   - 不能修改代码实现子节点（灰色虚线挂载的文件）
│   - 不能修改技术约束标签
│
开发者 (Developer)
├── 拥有：实现层
│   - 在业务节点下挂载/删除代码实现子节点
│   - 编辑技术约束标签
│   - 标记节点开发状态（开发中/自测通过/代码审查中）
│   - 补充思维导图中缺失的技术节点（如"缓存策略"、"消息队列"）
├── 无权限：
│   - 不能删除已锁定的业务节点
│   - 不能修改业务规则（可建议，需产品经理审批）
│   - 不能将节点标记为"已发布"（需产品经理验收）
│
架构师/技术负责人 (Tech Lead)
├── 拥有：跨层审批权
│   - 审批开发者补充的技术节点是否属于业务范畴
│   - 审批产品经理提出的业务节点在技术上的可行性
│   - 解锁/锁定关键业务路径（防止随意修改核心流程）
```

---

## 5. 业务流程闭环

### 5.1 从需求到发布的完整旅程

```
Step 1: 产品经理定义需求（真实图）
   ↓ 添加"功能占位节点"
Step 2: 开发者派生开发图
   ↓ 节点添加 + 文件挂载 + Agent 代码生成
Step 3: 测试介入，Bug 节点挂载
   ↓ 开发者逐支裁剪（修复→验证→移除）
Step 4: 产品经理合并到真实图
   ↓ 合并预览 → 真实图更新 → 快照版本控制
```

### 5.2 占位节点（Placeholder Node）

产品经理在真实图上添加**灰色虚线占位节点**：
- 仅含需求标题和验收标准
- 不携带任何实现细节
- 作为开发图派生的锚点

```
[退款处理] (已发布)
├── [金额校验] (已发布)
├── [风控拦截] (灰色虚线占位) ← 产品经理添加
│   ├── title: "风控拦截"
│   ├── acceptance_criteria: ["金额>1000需二次确认", "7天内第3次退款自动拦截"]
│   └── status: "pending_development"
└── [库存回退] (已发布)
```

### 5.3 开发图派生

开发者点击占位节点"开始开发"：
1. 系统自动创建独立 Git 分支 `bizgraph-session-{id}`
2. 生成开发流程图副本
3. 上游节点以灰色只读镜像显示
4. 只有占位节点子树为可编辑区域

```
[退款处理-开发视图] (派生自 v3.2.1)
├── [金额校验] (只读镜像，灰色)
├── [风控拦截] (开发中，蓝色) ← 可编辑区域
│   ├── [规则引擎调用] (开发者/Agent 添加)
│   ├── [风控评分计算] (开发者/Agent 添加)
│   └── [审批网关] (开发者/Agent 添加)
└── [库存回退] (只读镜像，灰色)
```

### 5.4 Bug 节点与裁剪

测试人员在开发图节点上挂载 Bug 节点：
- 红色角标 + 详情面板
- 严重程度分级：blocker / critical / major / minor
- 状态机：open → fixed → verified → **裁剪移除**

**裁剪的语义**：不是删除节点，而是删除 Bug 标记。实现节点保留，红色角标数字减一。当所有 Bug 裁剪后，节点显示绿色勾选。

```
开发图 v1.0: [风控拦截] 子节点 🔴3 🔴2 🔴1
开发图 v1.1: [风控拦截] 子节点 ✅  🔴2 🔴1  
开发图 v1.3: [风控拦截] 子节点 ✅  ✅  ✅  → 状态: 待合并
```

### 5.5 合并到真实图

开发图全部绿色勾选后：
1. 系统生成**合并预览**（动画 diff）
2. 产品经理审查：新增节点、修改关系、代码变更摘要、规则引擎验证
3. 确认合并后：
   - 占位节点变实线彩色
   - 实现子节点迁移到真实图
   - 开发图归档（只读）
   - 真实图版本升级（v3.2.1 → v3.3.0）
   - Git 仓库打对应 tag

### 5.6 拒绝流程（独立设计）

产品经理点击"拒绝"，选择类型：

| 拒绝类型 | 含义 | 后续流程 |
|---------|------|---------|
| **需求变更** | 实现符合原需求，但产品经理想改需求 | 修改真实图占位节点的验收标准，开发图自动同步，开发者继续迭代 |
| **实现不符** | 代码逻辑正确，但业务语义理解偏差 | 产品经理在开发图上添加"修正批注"（黄色便签），开发者按批注调整 |
| **技术否决** | 架构师认为实现方案有系统性风险 | 触发技术评审流程，开发图冻结，等待架构师出具替代方案 |

**关键**：拒绝不删除开发图，而是给开发图打上"拒绝标签"，开发者在此标签下继续工作。

---

## 6. 技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│  BizGraph 桌面应用 (Electron + React + TypeScript)                │
│  ┌─────────────┐  ┌─────────────────────┐  ┌─────────────────┐  │
│  │ 左侧目录树   │  │ 中间思维导图画布      │  │ 右侧Agent面板    │  │
│  │ (文件系统)   │  │ (真实图 + 开发图)    │  │ (任务/日志/配置) │  │
│  └─────────────┘  └─────────────────────┘  └─────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  Electron 主进程 (Node.js)                                       │
│  ├── Agent 适配器层 (核心)                                        │
│  │   ├── BaseAdapter.ts         (接口定义)                        │
│  │   ├── ClaudeCodeAdapter.ts   (spawn + stdin/stdout)          │
│  │   └── CodexAdapter.ts        (spawn + stdin/stdout)          │
│  ├── 范围守卫 ScopeGuard.ts    (chokidar + git)                 │
│  └── MCP Client (消费外部工具)                                   │
│      ├── @modelcontextprotocol/server-filesystem (npx)         │
│      ├── @modelcontextprotocol/server-git (npx)               │
│      └── @playwright/mcp (npx)                                  │
├─────────────────────────────────────────────────────────────────┤
│  数据层: LibSQL (SQLite) —— 本地单文件数据库                      │
│  ├── nodes: 节点表 (生产图/开发图/Bug节点)                       │
│  ├── edges: 边关系                                               │
│  ├── snapshots: 版本快照 (JSON序列化思维导图)                    │
│  └── rules: 规则契约表                                           │
├─────────────────────────────────────────────────────────────────┤
│  外部依赖 (用户自行安装)                                          │
│  ├── Claude Code: npm install -g @anthropic-ai/claude-code      │
│  ├── Codex CLI: npm install -g @openai/codex                     │
│  └── OpenCode: npm install -g opencode                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. 技术栈选型

### 7.1 选型方法论

| 权重 | 维度 | 说明 |
|------|------|------|
| 30% | 开源协议友好 | MIT/Apache 2.0，无商业限制 |
| 25% | 维护活跃度 | GitHub 提交频率、Issue 响应速度 |
| 20% | 个人可维护性 | 是否需要额外运维、调试难度 |
| 15% | 文档与上手速度 | 是否有完善文档、示例代码丰富度 |
| 10% | 生态兼容性 | 与 TypeScript/React/Node 生态的整合度 |

### 7.2 最终技术栈

| 层级 | 技术 | 理由 |
|------|------|------|
| **桌面壳** | Electron 34.x | 纯 TS/JS 栈，开发速度快，调试方便（Chrome DevTools）。包体积大但个人项目不 care |
| **画布引擎** | @xyflow/react 12.x | 36.4k+ stars，周下载 166万，2026年5月仍每周多次提交，MIT 协议，Stripe/Typeform 采用 |
| **数据库** | LibSQL (Turso 本地版) | SQLite 超集，零配置单文件，Mastra 原生支持。万级节点应用层递归查询足够 |
| **状态管理** | Zustand 5 + Immer | 轻量，适合桌面应用，不可变更新 |
| **UI 组件** | shadcn/ui + Tailwind CSS 4 | 快速构建专业级界面 |
| **代码分析** | Tree-sitter WASM | 前端直接解析 AST，零后端依赖 |
| **Git 操作** | simple-git | Node.js 原生 Git 操作库 |
| **文件监控** | chokidar | 跨平台文件系统监控 |

### 7.3 刻意不做的事

- ❌ 不引入 Mastra / LangGraph / Temporal（过重，个人项目 hold 不住）
- ❌ 不内置 LLM API 调用（调试成本极高，放到 Phase 3）
- ❌ 不实现 A2A 协议（过早）
- ❌ 不自研 Agent 引擎（放到 Phase 3）
- ❌ 不用本地 LLM（开源项目不应该绑定硬件）

---

## 8. Agent 适配器层

### 8.1 核心接口

```typescript
// src/main/adapters/BaseAdapter.ts
export interface AgentScope {
  workingDirectory: string;
  allowedFiles: string[];
  forbiddenFiles: string[];
  invariantRules: string[];
  upstreamContract: string;
  downstreamContract: string;
  nodeTitle: string;
  acceptanceCriteria: string[];
  bugContext?: BugContext[];
}

export interface AgentTask {
  type: 'implement' | 'fix_bug' | 'refactor' | 'add_test';
  description: string;
  targetNodeId: string;
}

export abstract class BaseAdapter {
  abstract readonly name: string;
  abstract readonly command: string;
  abstract readonly args: string[];

  protected process?: ChildProcess;
  protected scope?: AgentScope;

  async start(scope: AgentScope): Promise<void> {
    this.scope = scope;
    this.process = spawn(this.command, this.args, {
      cwd: scope.workingDirectory,
      env: { ...process.env, BIZGRAPH_SCOPE: JSON.stringify(scope) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  async sendTask(task: AgentTask): Promise<void> {
    const prompt = this.buildPrompt(task);
    this.process!.stdin!.write(prompt + '
');
  }

  abstract buildPrompt(task: AgentTask): string;
  onOutput(handler: (data: string) => void): void;
  terminate(): void;
}
```

### 8.2 Claude Code 适配器

```typescript
// src/main/adapters/ClaudeCodeAdapter.ts
export class ClaudeCodeAdapter extends BaseAdapter {
  readonly name = 'claude-code';
  readonly command = 'claude';
  readonly args = ['-p', '--dangerously-skip-permissions', '--verbose'];

  buildPrompt(task: AgentTask): string {
    const scope = this.scope!;
    return `
[BIZGRAPH_TASK]
${task.description}

[SCOPE_CONSTRAINTS]
Allowed files: ${scope.allowedFiles.join(', ')}
Forbidden files: ${scope.forbiddenFiles.join(', ')}
Invariant rules: ${scope.invariantRules.join(', ')}
Node: ${scope.nodeTitle}
Acceptance criteria: ${scope.acceptanceCriteria.join(', ')}

${task.bugContext ? `[BUG_CONTEXT]
${JSON.stringify(task.bugContext)}` : ''}
[/BIZGRAPH_TASK]
`;
  }
}
```

### 8.3 与 Agent 的双向实时协议

BizGraph 不是"发一个 prompt 等结果"，而是**增量式、可中断、可反馈**的持续对话：

```
T+0ms   BizGraph: [TASK] 实现风控拦截逻辑。范围: RefundService.ts, refund.dmn
        ├─ 注入 BIZGRAPH_SCOPE (JSON)
        └─ 启动 chokidar 监控

T+3s    Claude:  [FILE_WRITE] src/services/RefundService.ts
        BizGraph: [监控] 白名单内 ✓ 允许
        └─ Tree-sitter: 提取新增函数 "riskControlCheck"

T+5s    Claude:  [FILE_WRITE] src/services/UserService.ts (越界！)
        BizGraph: [监控] 黑名单内 ✗ 禁止
        ├─ 执行: git checkout -- src/services/UserService.ts
        └─ 发送 [INTERRUPT] 到 Claude stdin

T+5.1s  BizGraph: [INTERRUPT] 你尝试修改了 UserService.ts，已自动恢复。
        请只修改: RefundService.ts, refund.dmn

T+10s   Claude:  [COMPLETE] 任务完成
        BizGraph: [契约验证] 函数签名 ✓ 匹配
        └─ 节点状态: "风控拦截" → "待测试"
```

---

## 9. 范围守卫三层防御

### 9.1 第一层：Prompt 约束（软约束）

启动 Agent 时，通过环境变量注入结构化上下文：

```bash
BIZGRAPH_SCOPE='{
  "allowed_files": ["src/services/RefundService.ts", "src/rules/refund.dmn"],
  "forbidden_files": ["src/services/UserService.ts", "src/services/InventoryService.ts"],
  "invariant_rules": ["库存不能为负", "退款金额必须小于等于订单金额"]
}'
```

System Message 前置注入：
> "你正在 BizGraph 的受控会话中工作。你的修改范围被严格限制在 allowed_files 内。如果你认为需要修改 forbidden_files 中的文件才能完成任务，你必须停止工作并在输出中发送标记: [BIZGRAPH_PERMISSION_REQUEST] 文件名 原因。任何对 forbidden_files 的直接修改都会被系统自动回滚。"

### 9.2 第二层：文件系统监控 + 自动回滚（硬约束）

```typescript
// ScopeGuard 核心逻辑
class ScopeGuard {
  async createSandbox(repoPath: string, allowedFiles: string[]): Promise<string> {
    // 1. 创建独立 Git 分支
    const branchName = `bizgraph-${Date.now()}`;
    await git.checkoutLocalBranch(branchName);

    // 2. 启动 chokidar 监控 (100ms 轮询)
    const watcher = chokidar.watch(repoPath, {
      ignored: /node_modules|\.git/,
      persistent: true,
      usePolling: true,
      interval: 100
    });

    watcher.on('change', async (filePath) => {
      const relative = path.relative(repoPath, filePath);

      if (!allowedSet.has(relative)) {
        // 越界写入！立即恢复
        await git.checkout(['--', relative]);

        // 通过 stdin 实时通知 Agent
        agentProcess.stdin.write(
          `[BIZGRAPH_INTERRUPT] 你尝试修改了 ${relative}，该文件超出当前任务范围，已被系统自动恢复。
`
        );
      }
    });

    return branchName;
  }
}
```

### 9.3 第三层：契约验证（语义约束）

Tree-sitter 解析修改后的 AST，检查：
- 函数签名是否破坏上下游节点的输入输出契约
- 是否缺少对下游必需的函数调用
- 是否违反业务不变量

**阻断策略**：契约验证失败 → 节点显示红色虚线边框 → Agent 强制修复后才能继续。

---

## 10. 代码→语义逆向工程

### 10.1 变更捕获流水线

```
Agent写入文件
    ↓
chokidar检测到change事件
    ↓
ScopeGuard确认变更在白名单内
    ↓
git diff获取精确变更范围 (行级)
    ↓
Tree-sitter解析变更文件的AST
    ↓
逆向归属算法推断节点归属
    ↓
在开发图上自动创建/更新实现子节点
    ↓
开发者确认或调整归属
```

### 10.2 逆向归属算法（三层评分）

| 维度 | 权重 | 说明 |
|------|------|------|
| **文件路径匹配** | 40% | 历史规律：RefundService.ts 的代码通常属于"退款处理"节点 |
| **命名语义匹配** | 30% | `riskControlCheck` ↔ `风控拦截` 的语义相似度 |
| **调用链归属** | 20% | 新函数被哪个业务节点的已有函数调用 |
| **位置邻近** | 10% | 新函数在文件中与哪个已有实现函数最近 |

**可视化呈现**：
- 自动挂载的实现子节点以**虚线 + 半透明**显示
- 显示归属置信度（如"92%"）和理由
- 开发者可"确认归属"（虚线变实线）、拖拽修正、或标记为孤儿代码

---

## 11. 16周开发路线图

### Phase 1: 基础设施 (Week 1-4)

| 周次 | 任务 | 产出 | 里程碑 |
|------|------|------|--------|
| W1 | 项目脚手架 + 技术验证 | `electron-vite-react` 跑通，热更新正常 | — |
| W2 | Electron 三栏布局 + 左侧目录树 | 左/中/右三栏可拖拽调整 | — |
| W3 | @xyflow 画布基座 + LibSQL 数据层 | 6种节点类型，数据持久化 | — |
| W4 | 双图切换 + 节点状态机 | 真实图/开发图切换，状态颜色映射 | **MVP** |

### Phase 2: 核心画布 (Week 5-7)

| 周次 | 任务 | 产出 | 里程碑 |
|------|------|------|--------|
| W5 | 占位节点 + 开发图派生 | 产品经理添加占位，开发者派生开发图 | — |
| W6 | Mock Agent 适配器 | 不花钱调试 Agent 全流程 | — |
| W7 | 范围守卫 (chokidar + git) | 越界写入自动回滚 | **Alpha** |

### Phase 3: Agent 集成 (Week 8-10)

| 周次 | 任务 | 产出 | 里程碑 |
|------|------|------|--------|
| W8 | Claude Code 适配器 | 真调 Claude Code，双向协议 | — |
| W9 | 逆向挂载算法 (Tree-sitter) | 代码→节点自动挂载 | — |
| W10 | Bug 节点 + 裁剪机制 | 完整 Bug 生命周期 | **Beta** |

### Phase 4: 业务闭环 (Week 11-13)

| 周次 | 任务 | 产出 | 里程碑 |
|------|------|------|--------|
| W11 | 合并预览 + 真实图更新 | 合并闭环 | — |
| W12 | MCP Client 集成 (filesystem/git) | npx 启动外部 MCP | — |
| W13 | 导出 PDF/SVG + 快照版本 | 可演示 | **RC** |

### Phase 5: 扩展与发布 (Week 14-16)

| 周次 | 任务 | 产出 | 里程碑 |
|------|------|------|--------|
| W14 | Codex 适配器 + Playwright E2E | 多 Agent 支持 | — |
| W15 | 性能优化 + 错误处理 | 生产就绪 | — |
| W16 | 文档 + 开源发布 | **v1.0** | **Release** |

### 关键调整说明

- **W6 引入 MockAdapter**：开发期不消耗 Claude API 额度，用本地脚本模拟 Agent 输出
- **W8 才接入真 Claude Code**：此时核心流程已通过 Mock 验证
- **自研 Agent 引擎完全移除**：放到 Phase 3（开源后社区驱动）

---

## 12. 调试工具链

| 工具 | 用途 | 使用场景 |
|------|------|---------|
| **MCP Inspector** | 调试 MCP Server 的工具调用 | `npx @modelcontextprotocol/inspector uvx mcp-server-git` |
| **Claude Code --verbose** | 捕获 Agent 输出标记 | 解析文件写入、命令执行事件 |
| **Playwright + MCP** | E2E 自动化测试 | 截图验证节点渲染、状态变更 |
| **Mock Agent 模式** | 不花钱调试全流程 | `--mock-agent` 标志，固定延迟 + 预设变更 |
| **React DevTools** | 前端状态调试 | Zustand 状态树、@xyflow 节点属性 |
| **DB Browser for SQLite** | 数据库可视化 | 验证 nodes/edges 表结构 |

---

## 13. MCP 配置方案

### 13.1 真实可用的 MCP Server 清单

| MCP Server | 技术栈 | 启动方式 | GitHub 路径 |
|-----------|--------|---------|------------|
| `@modelcontextprotocol/server-filesystem` | Node.js | `npx -y` | `modelcontextprotocol/servers/src/filesystem` |
| `@modelcontextprotocol/server-git` | Node.js | `npx -y` | `modelcontextprotocol/servers/src/git` |
| `@playwright/mcp` | Node.js | `npx -y` | `microsoft/playwright-mcp` |

**注意**：`fetch` 和 `git` 官方推荐 `uvx` 启动（Python 栈），但 `filesystem` 和 `git` 也可用 `npx` 启动 Node.js 版本。

### 13.2 cc-switch 配置

| Name | Transport | Command | Args | Env |
|------|-----------|---------|------|-----|
| `filesystem` | stdio | `npx` | `-y @modelcontextprotocol/server-filesystem /path/to/bizgraph` | — |
| `git` | stdio | `npx` | `-y @modelcontextprotocol/server-git` | — |
| `playwright` | stdio | `npx` | `-y @playwright/mcp` | — |

**Windows 用户**：如果 npx 启动失败，改用 `cmd /c npx ...`。

---

## 14. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| Claude Code / Codex 协议变更 | 中 | 高 | 适配器层抽象隔离，变更只需改适配器文件 |
| Agent CLI 输出格式不稳定 | 高 | 中 | 输出解析用正则+启发式，添加 fallback |
| 16周无法完成全部功能 | 中 | 高 | 严格范围裁剪：Mock→真Agent→MCP→导出，优先级不可动摇 |
| 开源后 Issue 爆炸 | 中 | 高 | 早期明确"个人项目，欢迎 PR"，设置 good-first-issue |
| 用户期望 BizGraph 替代 Agent | 高 | 中 | README 反复强调"BizGraph 不生成代码，它让 Agent 更好用" |
| LLM API 费用超预期 | 低 | 中 | Mock 模式开发，真 Agent 仅 W8 后使用，月度预算 $50-100 |
| 个人动力衰减 | 高 | 高 | 每 2 周录制演示视频发社交媒体，外部反馈驱动 |

### 范围裁剪策略（进度落后时）

1. **不可裁剪（核心）**：双图架构、节点状态机、Agent 代码生成、Bug 裁剪、合并
2. **可延后（重要）**：Tree-sitter AST 分析、导出 PDF、多模型支持
3. **可舍弃（二期）**：Yjs 实时协作、Linear/Jira 同步、Codex 适配器

---

## 15. 开源策略

### 15.1 代码结构（吸引贡献者）

```
bizgraph/
├── README.md                    # 中英双语，含演示 GIF
├── CONTRIBUTING.md              # 贡献指南，重点：如何添加 Agent 适配器
├── LICENSE (MIT)
├── .github/
│   ├── ISSUE_TEMPLATE/
│   └── workflows/ci.yml
├── docs/                        # VitePress 文档站点
│   ├── guide/
│   ├── adapters/
│   └── architecture/
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── adapters/            # 核心扩展点
│   │   │   ├── base.ts
│   │   │   ├── claude-code.ts
│   │   │   ├── codex.ts
│   │   │   └── README.md        # 《如何添加新 Agent 适配器》
│   │   ├── scope-guard.ts
│   │   └── ipc-handlers.ts
│   ├── renderer/                # Electron 渲染进程
│   │   ├── components/
│   │   ├── canvas/              # @xyflow 画布
│   │   └── store/               # Zustand 状态
│   └── shared/                  # 共享类型定义
│       └── types.ts
├── tests/
│   └── e2e/                     # Playwright 测试
└── package.json
```

### 15.2 社区扩展点设计

贡献者只需实现 4 个方法即可接入新的 Agent CLI：

```typescript
export class NewAgentAdapter extends BaseAdapter {
  readonly name = 'new-agent';
  readonly command = 'new-agent-cli';
  readonly args = ['--non-interactive'];

  buildPrompt(task: AgentTask): string {
    // 约 30-50 行代码
  }
}
```

### 15.3 发布节奏

| 阶段 | 时间 | 动作 |
|------|------|------|
| MVP | W4 | Twitter/X、V2EX 发布开发进展 |
| Beta | W10 | 发布演示视频，强调"Agent CLI 的桌面指挥塔" |
| v1.0 | W16 | Product Hunt + Hacker News Show HN + 中文社区 |

### 15.4 差异化话术

- ❌ "BizGraph 是一个 AI 编码工具"（会让人和 Cursor 比较）
- ✅ "BizGraph 是 Agent CLI 的桌面指挥塔"
- ✅ "让 Claude Code 不再乱改你的代码"
- ✅ "产品经理和开发者终于能看同一张业务地图了"

---

## 16. 附录：精确路径对照表

| 资源 | 精确路径 | 状态 |
|------|---------|------|
| @xyflow/react | https://github.com/xyflow/react-flow | 活跃，36.4k+ stars |
| @modelcontextprotocol/server-filesystem | https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem | 活跃 |
| @modelcontextprotocol/server-git | https://github.com/modelcontextprotocol/servers/tree/main/src/git | 活跃 |
| @playwright/mcp | https://github.com/microsoft/playwright-mcp | 活跃 |
| Claude Code | https://github.com/anthropics/claude-code | 活跃 |
| GitHub MCP Server (Go) | https://github.com/github/github-mcp-server | 活跃，无 npm 包 |

---

> **结语**: BizGraph 的壁垒不是技术栈的新颖性，而是"业务语义层"的产品设计创新。Phase 1 的唯一目标是：一个能连 Claude Code 的思维导图指挥塔。开源后，社区将决定它走多远。
