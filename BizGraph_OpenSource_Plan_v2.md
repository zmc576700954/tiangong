# BizGraph — 开源 Agent 桌面编排器
## 项目启动方案 v2.0 (开源版)

> **定位**: 开源 Agent CLI 桌面编排器 —— 连接 Claude Code / Codex / OpenCode 等成熟 Agent 工具的可视化业务语义层  
> **日期**: 2026-05-23  
> **目标**: 个人独立开发，16周开源发布  
> **核心原则**: 开源友好 > 生态兼容 > 个人可维护

---

## 一、产品定位修正

### 1.1 不是"带Agent的IDE"，而是"Agent的指挥塔"

**旧定位（错误）**: 内置LLM，自己生成代码，成为另一个Cursor。

**新定位（正确）**: 
- **BizGraph 不生成代码** —— 代码生成交给 Claude Code、Codex CLI、OpenCode 等成熟工具
- **BizGraph 管理业务语义** —— 用思维导图定义"哪里该改、怎么改、改完怎么验证"
- **BizGraph 编排Agent执行** —— 把外部Agent CLI当作"执行引擎"，BizGraph负责"任务分解、范围限定、结果验收"

### 1.2 类比理解

| 组件 | 汽车类比 | 软件类比 |
|------|---------|---------|
| Claude Code / Codex | 发动机 | 代码生成引擎 |
| BizGraph | 方向盘+仪表盘+导航系统 | 业务语义层 + 范围控制 + 验收面板 |
| 思维导图 | 导航地图 | 业务拓扑的可视化 |
| 占位节点→合并 | 目的地设定→到达确认 | 需求定义→开发→测试→验收闭环 |

**用户旅程**:
```
产品经理在BizGraph真实图上画业务拓扑 → 添加占位节点
   ↓
开发者打开BizGraph，派生开发图，点击节点"用Claude Code实现"
   ↓
BizGraph启动Claude Code子进程，注入范围上下文（只改这些文件，遵守这些规则）
   ↓
Claude Code在终端里执行代码修改
   ↓
BizGraph捕获Claude Code的输出，更新开发图状态
   ↓
测试在开发图上挂Bug节点
   ↓
开发者再次点击节点"修复Bug"，Claude Code接收Bug上下文继续修改
   ↓
全部Bug裁剪后，产品经理审查合并 → 真实图更新
```

### 1.3 开源价值主张

**为什么社区需要BizGraph？**

当前Agent CLI工具（Claude Code、Codex、OpenCode）都是**终端黑盒**:
- 开发者说"帮我改退款流程"，Agent会全网搜索、猜测范围、可能改错文件
- 没有业务语义的可视化，产品经理无法参与验收
- 没有Bug追踪机制，改完一轮又一轮，没有收敛感
- 没有版本化的业务蓝图，每次重构都是盲人摸象

BizGraph解决这些痛点，同时**不替代任何Agent工具** —— 它让现有Agent工具变得更好用、更可控、更可协作。

---

## 二、架构重设计：Agent适配器模式

### 2.1 核心架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     BizGraph 桌面应用 (Electron + React)          │
│  ┌─────────────┐  ┌─────────────────────┐  ┌─────────────────┐  │
│  │ 左侧目录树   │  │ 中间思维导图画布      │  │ 右侧Agent面板    │  │
│  │ (文件系统)   │  │ (真实图 + 开发图)    │  │ (任务/日志/配置) │  │
│  └─────────────┘  └─────────────────────┘  └─────────────────┘  │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Node.js 主进程 (Electron Main Process)                     │ │
│  │  ├── 文件系统代理 (fs wrapper)                               │ │
│  │  ├── Git 操作代理 (simple-git)                              │ │
│  │  ├── **Agent 适配器层** (核心创新)                          │ │
│  │  │   ├── Claude Code Adapter                                │ │
│  │  │   ├── Codex CLI Adapter                                  │ │
│  │  │   ├── OpenCode Adapter                                   │ │
│  │  │   └── (可扩展: 任意遵循MCP的Agent)                        │ │
│  │  └── 范围守卫 (ScopeGuard)                                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  数据层: LibSQL (SQLite) —— 本地单文件数据库                   │ │
│  │  ├── production_nodes: 真实图节点                             │ │
│  │  ├── development_nodes: 开发图节点                            │ │
│  │  ├── edges: 节点关系                                         │ │
│  │  ├── bug_nodes: Bug节点                                      │ │
│  │  ├── snapshots: 版本快照                                     │ │
│  │  └── agent_sessions: Agent执行会话日志                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     外部 Agent CLI 工具 (子进程)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ Claude Code  │  │ Codex CLI    │  │ OpenCode     │         │
│  │ (npm全局安装) │  │ (npm全局安装) │  │ (npm全局安装) │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│   BizGraph通过stdin/stdout或MCP与它们通信，注入上下文和指令        │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Agent 适配器层 (核心设计)

这是BizGraph的技术核心。每个Agent CLI工具有不同的交互协议，BizGraph提供统一抽象：

```typescript
// Agent 适配器接口 (开源扩展点)
interface AgentAdapter {
  name: string;                    // "claude-code", "codex", "opencode"
  version: string;

  // 检测用户系统是否已安装该Agent
  checkInstalled(): Promise<boolean>;

  // 启动Agent会话，注入范围上下文
  startSession(config: AgentSessionConfig): Promise<AgentSession>;

  // 发送指令 (自然语言 + 结构化上下文)
  sendCommand(sessionId: string, command: AgentCommand): Promise<void>;

  // 监听输出流 (代码变更、日志、错误)
  onOutput(handler: (output: AgentOutput) => void): void;

  // 终止会话
  terminateSession(sessionId: string): Promise<void>;
}

// 范围上下文 (注入给Agent的约束)
interface AgentSessionConfig {
  workingDirectory: string;        // 项目根目录
  allowedFiles: string[];          // 白名单: 只能改这些文件
  forbiddenFiles: string[];        // 黑名单: 绝对不能碰
  invariantRules: string[];        // 业务不变量提示
  upstreamContext: string;         // 上游节点契约说明
  downstreamContext: string;       // 下游节点契约说明
  nodeTitle: string;               // 当前业务节点名称
  acceptanceCriteria: string[];    // 验收标准
  bugContext?: BugContext[];      // 如果是修复Bug，传入Bug详情
}

// Agent指令
interface AgentCommand {
  type: 'implement' | 'fix_bug' | 'refactor' | 'add_test';
  description: string;             // 自然语言描述
  targetNodeId: string;
}
```

### 2.3 与 Claude Code 的集成示例

Claude Code 支持通过 stdin/stdout 的非交互式模式运行：

```bash
# BizGraph 启动 Claude Code 子进程
claude -p --dangerously-skip-permissions   --allowedTools "Bash,Edit,Read,Write"   --verbose   "请在 src/services/RefundService.ts 中添加风控拦截逻辑。
   约束：
   - 只能修改 RefundService.ts 和 refund.dmn
   - 不能修改 UserService 或 InventoryService
   - 必须遵守：退款金额>1000元时需二次确认
   - 输入：订单ID、退款金额；输出：退款结果+风控标记"
```

BizGraph 会：
1. 解析 Claude Code 的 verbose 输出，提取修改了哪些文件
2. 对比 `allowedFiles`，如果有越界修改，**拦截并回滚**
3. 将修改结果挂载到开发图的对应节点下
4. 更新节点状态为"待测试"

### 2.4 与 Codex CLI 的集成

Codex CLI (OpenAI) 支持类似的非交互模式：

```bash
codex -a auto-edit   --approval-mode auto-edit   -m gpt-4o   "实现风控拦截功能。范围：src/services/RefundService.ts。约束：..."
```

### 2.5 范围守卫 (ScopeGuard)

即使Agent工具本身没有范围限制，BizGraph在系统层面强制执行：

```typescript
class ScopeGuard {
  // Agent执行前：创建临时文件系统视图
  prepareSandbox(allowedFiles: string[], workingDir: string): Sandbox {
    // 1. 备份所有 allowedFiles
    // 2. 监控文件系统变更 (chokidar)
    // 3. 如果Agent试图写入 forbiddenFiles，立即终止进程并恢复备份
  }

  // Agent执行后：验证变更范围
  validateChanges(actualChanges: string[], allowedFiles: string[]): ValidationResult {
    // 检查实际修改的文件是否都在白名单内
    // 返回：合规/越界文件列表/建议回滚
  }

  // 强制回滚
  rollback(sandbox: Sandbox): Promise<void>;
}
```

---

## 三、开源项目技术栈 (最终版)

### 3.1 选型原则 (开源项目视角)

| 权重 | 维度 | 说明 |
|------|------|------|
| 30% | 开源协议友好 | MIT/Apache 2.0，无商业限制 |
| 25% | 社区参与度 | 用户能轻松扩展Agent适配器 |
| 20% | 技术栈普适性 | 主流技术，降低贡献门槛 |
| 15% | 与外部Agent兼容 | 能连接Claude/Codex/OpenCode等 |
| 10% | 个人可维护 | 单人能hold住 |

### 3.2 最终技术栈

```
┌─────────────────────────────────────────────────────────────┐
│  呈现层 (Renderer Process)                                   │
│  Electron 34 + React 19 + TypeScript 5.5                    │
│  ├── UI: shadcn/ui + Tailwind CSS 4                         │
│  ├── 状态: Zustand 5 + Immer                                │
│  ├── 画布: @xyflow/react 12.x                               │
│  └── 代码预览: Monaco Editor (VS Code同款)                  │
├─────────────────────────────────────────────────────────────┤
│  主进程 (Main Process) —— Node.js 20+                        │
│  ├── Agent 适配器层 (核心)                                    │
│  │   ├── ClaudeCodeAdapter.ts                               │
│  │   ├── CodexAdapter.ts                                    │
│  │   ├── OpenCodeAdapter.ts                                 │
│  │   └── BaseAdapter.ts (扩展接口)                          │
│  ├── 范围守卫: ScopeGuard.ts                                │
│  ├── 文件系统: fs/promises + chokidar                       │
│  ├── Git操作: simple-git                                     │
│  └── IPC通信: Electron ipcMain/ipcRenderer                  │
├─────────────────────────────────────────────────────────────┤
│  数据层: LibSQL (SQLite超集) —— 本地单文件                   │
│  ├── nodes: 节点表 (生产图/开发图/Bug节点)                   │
│  ├── edges: 边关系                                           │
│  ├── snapshots: 版本快照 (JSON序列化思维导图)                │
│  └── agent_logs: Agent执行日志 (stdout/stderr捕获)           │
├─────────────────────────────────────────────────────────────┤
│  外部依赖 (用户自行安装)                                      │
│  ├── Claude Code: `npm install -g @anthropic-ai/claude-code`│
│  ├── Codex CLI: `npm install -g @openai/codex`               │
│  └── OpenCode: `npm install -g opencode`                     │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 为什么不需要本地LLM

用户明确否定本地LLM，理由充分：

1. **开源项目不应该绑定硬件** —— 要求用户有GPU才能用，门槛太高
2. **开源项目不应该绑定模型** —— 本地LLM能力参差不齐，无法保证体验
3. **成熟Agent CLI已经解决了"生成质量"问题** —— Claude Code、Codex是经过RLHF和大量优化的产品级工具
4. **BizGraph的价值在"编排"而非"生成"** —— 让Agent知道"改哪里、不改哪里"，比让Agent"生成更好的代码"更有价值

### 3.4 为什么不需要Mastra

重新审视后，Mastra对于本项目**过度设计**：

- Mastra的核心价值是内置LLM调用、RAG、持久化Agent记忆
- BizGraph**不需要这些** —— LLM调用交给外部Agent CLI，持久化用LibSQL足够
- 引入Mastra反而增加学习成本和构建复杂度
- **自建轻量工作流引擎** (200行代码的状态机) 更适合本项目

---

## 四、16周开发路线图 (开源版)

### Phase 1: 基础设施与画布 (Week 1-4)

**目标**: 可运行的Electron应用，支持思维导图增删改查，数据持久化

| 周次 | 任务 | 产出 |
|------|------|------|
| W1 | 项目脚手架 + 技术验证 | `electron-vite-react` 跑通，热更新正常，确定目录结构 |
| W1 | 开源项目基建 | GitHub仓库初始化，MIT协议，README模板，Issue模板 |
| W2 | 三栏布局实现 | 左侧目录树(文件浏览) / 中间画布 / 右侧面板，可拖拽调整宽度 |
| W2 | @xyflow画布基座 | 6种业务节点类型渲染，拖拽创建，连线，缩放平移 |
| W3 | LibSQL数据层 | 设计Schema，实现节点CRUD，自动保存到本地SQLite文件 |
| W3 | 节点状态机 | 草稿/已确认/开发中/待测试/待验收/已发布，颜色映射 |
| W4 | 双图切换 | 真实图(Production) vs 开发图(Development) Tab切换 |
| W4 | **Milestone MVP** | **画布可运行，能创建真实图和开发图，数据持久化** |

### Phase 2: 占位节点与派生 (Week 5-7)

**目标**: 产品经理能添加占位，开发者能派生开发图

| 周次 | 任务 | 产出 |
|------|------|------|
| W5 | 占位节点 | 真实图上添加灰色虚线占位节点，填写标题+验收标准 |
| W5 | 开发图派生 | 点击占位节点"开始开发"，自动生成开发图副本 |
| W6 | 开发图隔离 | 开发图只读镜像上游节点，可编辑区域仅限占位节点子树 |
| W6 | 权限模型 | 节点owner_role校验，产品节点开发者不可删 |
| W7 | 节点操作菜单 | 右键：添加子模块/前置流程/后置流程/业务规则 |
| W7 | **Milestone Alpha** | **占位→派生→编辑→隔离 完整流程** |

### Phase 3: Agent适配器层 (Week 8-10)

**目标**: 连接外部Agent CLI，点击节点触发执行

| 周次 | 任务 | 产出 |
|------|------|------|
| W8 | Agent适配器接口 | 设计BaseAdapter抽象类，定义check/start/send/terminate接口 |
| W8 | Claude Code适配器 | 实现ClaudeCodeAdapter，支持非交互模式启动和输出捕获 |
| W9 | 范围上下文注入 | 点击节点时自动生成AgentSessionConfig，注入白名单/黑名单/约束 |
| W9 | 范围守卫 | ScopeGuard实现：文件变更监控，越界写入拦截+自动回滚 |
| W10 | 输出解析与挂载 | 解析Agent输出中的文件变更，自动挂载到开发图节点下 |
| W10 | **Milestone Beta** | **点击节点→启动Claude Code→范围注入→执行→结果挂载** |

### Phase 4: Bug节点与裁剪 (Week 11-13)

**目标**: 测试挂Bug，开发者逐支裁剪，全部完成后提交合并

| 周次 | 任务 | 产出 |
|------|------|------|
| W11 | Bug节点UI | 开发图节点上挂Bug卡片(红色角标)，支持severity分级 |
| W11 | Bug状态机 | open → fixed → verified → 裁剪移除 |
| W12 | Bug修复触发 | 点击Bug卡片"用Agent修复"，注入Bug上下文给Agent CLI |
| W12 | 合并预览 | 开发图全部绿色勾选后，生成真实图变更预览(动画diff) |
| W13 | 真实图合并 | 确认合并后占位节点变实线，开发图实现子节点迁移，Git tag |
| W13 | **Milestone RC** | **完整闭环：占位→开发→Bug→裁剪→合并** |

### Phase 5: 扩展与开源准备 (Week 14-16)

**目标**: 多Agent支持 + 导出 + 文档 + 社区就绪

| 周次 | 任务 | 产出 |
|------|------|------|
| W14 | Codex适配器 | 实现CodexAdapter，支持OpenAI Codex CLI接入 |
| W14 | OpenCode适配器 | 实现OpenCodeAdapter，支持OpenCode接入 |
| W15 | 思维导图导出 | 导出PNG/SVG/PDF (含节点状态图例)，用于演示和验收 |
| W15 | 适配器文档 | 编写《如何为BizGraph添加新的Agent适配器》贡献指南 |
| W16 | 端到端测试 | Playwright测试覆盖核心闭环，GitHub Actions CI |
| W16 | 发布准备 | CHANGELOG, CONTRIBUTING.md, 演示视频, GitHub Release v1.0 |
| W16 | **Milestone v1.0** | **开源发布，支持3种Agent CLI，完整业务闭环** |

---

## 五、开源项目运营建议

### 5.1 代码结构 (吸引贡献者)

```
bizgraph/
├── README.md                    # 中英双语，含演示GIF
├── CONTRIBUTING.md              # 贡献指南，重点：如何添加Agent适配器
├── LICENSE (MIT)
├── .github/
│   ├── ISSUE_TEMPLATE/
│   └── workflows/ci.yml
├── docs/                        # 文档站点 (VitePress)
│   ├── guide/
│   ├── adapters/
│   └── architecture/
├── src/
│   ├── main/                    # Electron主进程
│   │   ├── adapters/            # ⭐ 核心扩展点
│   │   │   ├── base.ts          # BaseAdapter接口
│   │   │   ├── claude-code.ts   # Claude Code适配器
│   │   │   ├── codex.ts         # Codex适配器
│   │   │   ├── opencode.ts      # OpenCode适配器
│   │   │   └── README.md        # 如何添加新适配器
│   │   ├── scope-guard.ts       # 范围守卫
│   │   ├── git-agent.ts         # Git操作代理
│   │   └── ipc-handlers.ts      # IPC通信
│   ├── renderer/                # Electron渲染进程
│   │   ├── components/          # React组件
│   │   ├── canvas/              # 思维导图画布
│   │   ├── panels/              # 左/右侧面板
│   │   └── store/               # Zustand状态
│   └── shared/                  # 共享类型定义
│       ├── types.ts             # 核心类型 (AgentAdapter, GraphNode等)
│       └── constants.ts         # 常量
├── tests/
│   └── e2e/                     # Playwright测试
└── package.json
```

### 5.2 社区扩展点设计

**最重要的扩展点：Agent适配器**

贡献者只需实现4个方法即可接入新的Agent CLI：

```typescript
// 示例：为 GitHub Copilot CLI 添加适配器 (约50行代码)
export class CopilotAdapter extends BaseAdapter {
  name = 'copilot';

  async checkInstalled(): Promise<boolean> {
    return commandExists('gh copilot');
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const proc = spawn('gh', ['copilot', 'suggest', '-t', 'shell'], {
      cwd: config.workingDirectory,
      env: { ...process.env, BIZGRAPH_CONTEXT: JSON.stringify(config) }
    });
    return { process: proc, id: generateId() };
  }

  // ... 其他方法
}
```

### 5.3 开源营销策略

**发布节奏**:
- **Week 4 (MVP)**: 在Twitter/X、V2EX、Reddit r/LocalLLaMA 发布开发进展，收集反馈
- **Week 10 (Beta)**: 发布"连接Claude Code的可视化业务编排器"演示视频，强调"不替代，增强"
- **Week 16 (v1.0)**: Product Hunt 发布，Hacker News Show HN，中文社区(掘金/知乎)

**差异化话术**:
- ❌ "BizGraph是一个AI编码工具" (错误，会让人和Cursor比较)
- ✅ "BizGraph是Agent CLI的指挥塔" (正确，强调编排和范围控制)
- ✅ "让Claude Code不再乱改你的代码" (直击痛点)
- ✅ "产品经理和开发者终于能看同一张业务地图了" (强调协作)

---

## 六、风险与对策 (开源版)

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| Claude Code / Codex 协议变更 | 中 | 高 | 适配器层抽象隔离，变更只需改适配器文件 |
| Agent CLI 输出格式不稳定 | 高 | 中 | 输出解析用正则+启发式，而非硬编码，添加fallback |
| 开源后Issue爆炸，个人维护不过来 | 中 | 高 | 早期明确"个人项目，欢迎PR"，设置good-first-issue标签 |
| 用户期望BizGraph替代Agent工具 | 高 | 中 | README反复强调"BizGraph不生成代码，它让Agent工具更好用" |
| 16周无法支持3种Agent | 中 | 中 | 优先保证Claude Code适配器完美，其他延后二期 |
| 范围守卫误杀合法修改 | 中 | 高 | 添加"临时解锁"机制，开发者可手动添加文件到白名单 |

---

## 七、资源需求

### 7.1 开发成本

- **硬件**: 现有开发机即可
- **API费用**: 0 —— BizGraph本身不调用LLM API，调用成本由用户的Agent CLI承担
- **域名/服务器**: 可选，仅用于文档站点 (GitHub Pages免费)

### 7.2 时间投入

- **全职投入**: 16周，每天6-8小时
- **兼职投入**: 如果只有晚上/周末，建议延长至24-28周

---

## 八、一句话总结

**BizGraph 不是又一个AI编码工具，而是第一个"Agent CLI的桌面指挥塔"——让 Claude Code、Codex、OpenCode 在你的业务地图上按规矩干活，不乱改、不越界、可验收、可回滚。**

> 开源，免费，可扩展，一个人就能启动。
