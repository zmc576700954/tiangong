# 快速开始

## 安装 BizGraph

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/yourusername/bizgraph.git
cd bizgraph

# 安装依赖
npm install

# 启动开发模式
npm run dev
```

### 安装 Agent CLI

BizGraph 需要至少一个外部 Agent CLI 工具才能正常工作：

```bash
# Claude Code (推荐)
npm install -g @anthropic-ai/claude-code

# Codex CLI
npm install -g @openai/codex

# OpenCode
npm install -g opencode
```

安装后，BizGraph 会自动检测已安装的 Agent。

## 创建你的第一张图

1. 启动 BizGraph
2. 点击顶部 Tab 栏的 `+` 按钮
3. 选择 "真实图"，输入图名称
4. 在画布上右键，选择 "业务模块" 创建节点
5. 拖拽连接节点，建立业务关系

## 从占位到实现

1. 在真实图上创建灰色虚线的"占位节点"
2. 填写占位节点的标题和验收标准
3. 右键占位节点，选择"派生开发图"
4. 切换到开发图 Tab
5. 选中需要实现的节点
6. 在右侧面板选择 Agent，点击"启动"
7. BizGraph 自动注入范围上下文，Agent 开始执行
