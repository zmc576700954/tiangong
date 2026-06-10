# BizGraph 全面优化实施计划

> **优先级**: P0 → P1 → P2 → P3
> **目标**: 提升系统安全性、稳定性、可扩展性和可维护性

---

## Phase 1: P0 - 内存与进程管理优化（立即执行）

### Task 1.1: ScopeGuard 快照内容哈希
- 修改 `src/main/scope-guard.ts`
- `FileSnapshotEntry` 增加 `contentHash` 字段
- 使用快速哈希（xxhash 或基于内容的前 1KB 采样 hash）
- 更新 `postExecutionValidation` 中的对比逻辑

### Task 1.2: ScopeGuard 忽略模式修复
- 修复 `IGNORED_PATTERNS` 中正则未锚定的问题（如 `/dist/` 匹配 `my-dist-folder`）
- 添加更精确的路径匹配模式

### Task 1.3: BaseAdapter 子进程泄漏防护
- 修改 `src/main/adapters/base.ts`
- 增加会话级进程守护（超时自动 kill）
- 增加 `SIGKILL` 保底机制

### Task 1.4: AgentManager 内存主动监控
- 增加 `getMemoryStats()` 方法
- 当 RSS 超过阈值时触发警告和会话清理

---

## Phase 2: P1 - Agent 系统功能增强

### Task 2.1: 适配器健康评分系统
- 新增 `src/main/agent/adapter-health-monitor.ts`
- 为每个适配器维护 `healthScore`（成功率、响应时间、错误率）
- 提供 `getAdapterHealth()` 接口

### Task 2.2: AgentManager 上下文字段分离
- 修复 `memoryContext` 被注入到 `codeContext` 字段的问题
- AgentSession 增加独立的 `memoryContext` 字段
- 更新 `BaseAdapter` 和 `AgentAdapter` 接口

---

## Phase 3: P1 - 项目记忆机制改进

### Task 3.1: 写入锁超时保护
- 修改 `src/main/mindmap-agent/memory.ts`
- `withWriteLock` 增加超时机制（30秒）
- 防止永久挂起导致后续写入阻塞

### Task 3.2: 记忆乐观锁
- `writeMemory` 增加版本号检查
- 防止多窗口并发写入导致数据丢失

---

## Phase 4: P2 - 架构优化

### Task 4.1: IPC 中间件机制
- 新增 `src/main/ipc/middleware.ts`
- 支持日志、性能监控、错误处理中间件

### Task 4.2: AgentManager 资源配额动态化
- `MAX_SESSIONS` 从硬编码改为基于系统资源动态计算

---

## Phase 5: P2 - 业务逻辑扩展性

### Task 5.1: NodeTypeRegistry 增强
- 增加节点类型验证（允许的上级/下级）
- 支持行为挂载

### Task 5.2: 状态转换基础
- 新增 `NodeStatusTransition` 定义
- 基础的状态转换验证
