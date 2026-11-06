/**
 * D1：Agent Runtime 的 9 张表 DDL 与索引。
 *
 * 这些常量同时被 database.ts 的版本化迁移与独立测试使用。
 * 不在此处引入 better-sqlite3 运行时依赖，只做 SQL 定义。
 */

import type BetterSqlite3 from 'better-sqlite3'

export interface AgentTableSchema {
  name: string
  createSql: string
  requiredColumns: string[]
}

/**
 * 9 张表。与 agent-architecture.md §4.2 对齐，并按 M0 任务要求补充：
 * - agent_sessions.executor_pid / executor_pgid / executor_started_at / executor_cmd
 * - agent_sessions.residual_risk（none|possible|unconfirmed，会话级可见状态）
 * - agent_steps.status 含 aborted
 * - agent_usage 含 graph_id / day_key / cost_micros
 * - agent_approvals 含 timeout_ms（重启重推时精确重计时）、cwd / grant_source（会话级授权审计）
 */
export const AGENT_TABLE_SCHEMAS: AgentTableSchema[] = [
  {
    name: 'agent_runs',
    createSql: `
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        node_id TEXT,
        graph_id TEXT,
        executor TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created'
          CHECK(status IN ('created','running','awaiting_approval','cancelling',
                           'interrupted','completed','failed','cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'thread_id', 'executor', 'status', 'created_at', 'updated_at'],
  },
  {
    name: 'agent_sessions',
    createSql: `
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        graph_id TEXT,
        node_id TEXT,
        thread_id TEXT,
        executor TEXT NOT NULL,
        runtime_session_id TEXT,
        executor_handle TEXT,
        executor_pid INTEGER,
        executor_pgid INTEGER,
        -- 跨重启归属校验（pid 复用防护）：pid 必须同时匹配启动时间/命令行
        executor_started_at TEXT,
        executor_cmd TEXT,
        -- 仅同进程轮次关联/日志，不作跨重启凭证（macOS ps 不可见 env）
        executor_env_marker TEXT,
        residual_risk TEXT NOT NULL DEFAULT 'none'
          CHECK(residual_risk IN ('none','possible','unconfirmed')),
        status TEXT NOT NULL DEFAULT 'starting'
          CHECK(status IN ('starting','active','idle','orphaned','closed')),
        workspace_mode TEXT NOT NULL DEFAULT 'shared'
          CHECK(workspace_mode IN ('shared','worktree')),
        workspace_path TEXT,
        last_turn_id TEXT,
        last_recovery_at INTEGER,
        recovery_kills INTEGER NOT NULL DEFAULT 0,
        recovery_note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    requiredColumns: [
      'id', 'executor', 'status', 'workspace_mode', 'created_at', 'updated_at',
      'last_recovery_at', 'recovery_kills', 'recovery_note',
      'executor_started_at', 'executor_cmd', 'residual_risk',
    ],
  },
  {
    name: 'agent_turns',
    createSql: `
      CREATE TABLE agent_turns (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        graph_id TEXT,
        node_id TEXT NOT NULL,
        group_id TEXT,
        parent_turn_id TEXT,
        branch_key TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN (
          'queued','running','waiting_approval','cancelling',
          'completed','failed','cancelled','orphaned')),
        resume_mode TEXT NOT NULL CHECK(resume_mode IN ('native','replay','fresh')),
        idempotency_key TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        failure_class TEXT,
        error_code TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        deadline_at INTEGER,
        created_at INTEGER NOT NULL,
        -- 遗留列：人工 hold 已移除（续接锚点由 run.started 事件类型豁免，不依赖此列）
        retention_hold INTEGER NOT NULL DEFAULT 0, -- 已无生产写入方，保留策略不看它
        UNIQUE(idempotency_key)
      )
    `,
    requiredColumns: [
      'id', 'run_id', 'session_id', 'node_id', 'branch_key', 'attempt', 'status',
      'resume_mode', 'idempotency_key', 'input_json', 'created_at', 'retention_hold',
    ],
  },
  {
    name: 'agent_steps',
    createSql: `
      CREATE TABLE agent_steps (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        tool_name TEXT,
        status TEXT NOT NULL CHECK(status IN (
          'requested','awaiting_approval','approved','denied','running','done','failed','aborted','unknown')),
        args_hash TEXT,
        result_ref TEXT,
        fidelity TEXT NOT NULL CHECK(fidelity IN ('token','turn','session')),
        test_disposition TEXT,
        approved_at INTEGER,
        executing_at INTEGER,
        started_at INTEGER,
        ended_at INTEGER,
        UNIQUE(turn_id, seq)
      )
    `,
    requiredColumns: ['id', 'turn_id', 'seq', 'kind', 'status', 'fidelity'],
  },
  {
    name: 'agent_events',
    createSql: `
      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        turn_seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('backend','kernel','synthetic')),
        fidelity TEXT NOT NULL CHECK(fidelity IN ('token','turn','session')),
        payload_version INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        step_id TEXT,
        UNIQUE(run_id, seq),
        UNIQUE(turn_id, turn_seq)
      )
    `,
    requiredColumns: ['id', 'run_id', 'turn_id', 'seq', 'turn_seq', 'type', 'source', 'fidelity', 'payload_json', 'created_at', 'step_id'],
  },
  {
    name: 'agent_approvals',
    createSql: `
      CREATE TABLE agent_approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        step_id TEXT,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        risk TEXT NOT NULL CHECK(risk IN ('low','medium','high','critical')),
        policy_decision TEXT NOT NULL CHECK(policy_decision IN ('allow','deny','ask')),
        status TEXT NOT NULL CHECK(status IN ('pending','allowed','denied','superseded')),
        decided_by TEXT CHECK(decided_by IN ('user','policy','timeout','system','startup')),
        decided_at INTEGER,
        decision_note TEXT,
        expires_at INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT 'interactive' CHECK(mode IN ('interactive','unattended')),
        timeout_ms INTEGER NOT NULL DEFAULT 120000,
        cwd TEXT,
        grant_source TEXT,
        created_at INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'run_id', 'turn_id', 'tool_name', 'args_json', 'args_hash', 'risk', 'policy_decision', 'status', 'expires_at', 'created_at', 'cwd', 'grant_source', 'decision_note'],
  },
  {
    name: 'agent_artifacts',
    createSql: `
      CREATE TABLE agent_artifacts (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        node_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('diff','file_snapshot','command_output','summary','test_report')),
        path TEXT,
        content_hash TEXT,
        base_hash TEXT,
        storage TEXT NOT NULL CHECK(storage IN ('inline','file','git')),
        storage_ref TEXT,
        created_at INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'turn_id', 'kind', 'storage', 'created_at'],
  },
  {
    // M1 成本账本：字段一次到位。
    // - node_id/model/currency/price_version：额度归属与价格可追溯的最小维度，后补要迁表
    // - token 三列可空（NULL=后端未上报，与 0 区分开）
    // - cost_micros 可空（NULL=缺价 unknown，不产生错误金额）
    // - source: provider=后端真实用量 / estimated=估算 / unknown=未上报
    // - cost_status: 可查的定价分类（priced / missing_price / not_reported），
    //   历史行迁移后为 NULL（不从 attribution_note 反推，避免凭空造值）
    // - tokens_reported: 1=后端上报 token / 0=未上报 / NULL=该调用无 token 概念或历史行未标注
    // - attribution_note：归属/缺价原因的人类可读说明，不参与分类判断
    // - dedupe_key：幂等键（turn:xxx 或 bev:<adapter>:<eventId>），重复上报不重复计费
    // - cost_usd / is_estimate 为兼容列（M0 查询/UI 仍在读）
    name: 'agent_usage',
    createSql: `
      CREATE TABLE agent_usage (
        id TEXT PRIMARY KEY,
        turn_id TEXT,
        session_id TEXT NOT NULL,
        executor TEXT NOT NULL,
        graph_id TEXT,
        node_id TEXT,
        model TEXT,
        day_key TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        currency TEXT NOT NULL DEFAULT 'USD',
        cost_usd REAL NOT NULL DEFAULT 0,
        cost_micros INTEGER,
        price_version TEXT,
        is_estimate INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL CHECK(source IN ('provider','estimated','unknown')),
        cost_status TEXT CHECK(cost_status IN ('priced','missing_price','not_reported')),
        tokens_reported INTEGER,
        attribution_note TEXT,
        dedupe_key TEXT,
        recorded_at INTEGER NOT NULL
      )
    `,
    requiredColumns: [
      'id', 'session_id', 'executor', 'day_key', 'source', 'recorded_at',
      'turn_id', 'node_id', 'model', 'currency', 'cost_micros', 'price_version',
      'cost_status', 'tokens_reported',
      'attribution_note', 'dedupe_key',
      'cache_creation_input_tokens',
    ],
  },
  {
    name: 'agent_snapshots',
    createSql: `
      CREATE TABLE agent_snapshots (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, seq)
      )
    `,
    requiredColumns: ['run_id', 'seq', 'state_json', 'created_at'],
  },
]

export const AGENT_INDEX_SQLS: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_agent_turns_node ON agent_turns(node_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_events_kind ON agent_events(type, created_at DESC)`,
  // P3：事件直接带 step_id，可按步骤查询完整序列（历史行 NULL，不进任何 step 结果集）
  `CREATE INDEX IF NOT EXISTS idx_agent_events_step ON agent_events(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_events_turn_step ON agent_events(turn_id, step_id, turn_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_approvals_pending ON agent_approvals(turn_id, status, expires_at) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_steps_turn ON agent_steps(turn_id, seq)`,
  // P0-3：step 主键带 turn 作用域（id 形如 `<turnId>:<localStepId>`），唯一键兜底防跨 turn 覆盖
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_steps_turn_id ON agent_steps(turn_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_usage_graph_day ON agent_usage(graph_id, day_key)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_usage_day ON agent_usage(day_key)`,
  // M1：turn 明细查询 + 幂等去重（dedupe_key 为空不参与唯一约束）
  `CREATE INDEX IF NOT EXISTS idx_agent_usage_turn ON agent_usage(turn_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_usage_dedupe ON agent_usage(dedupe_key) WHERE dedupe_key IS NOT NULL`,
  // D2：节点/分支级活跃 turn 唯一，第二个非终态 turn 插入即 NODE_BUSY
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_turns_active ON agent_turns(node_id, branch_key)
     WHERE status IN ('running','waiting_approval','cancelling')`,
]

export interface AgentSchemaApplier {
  exec(sql: string): unknown
  prepare(sql: string): { get(...params: unknown[]): unknown }
}

/** 独立应用（供 DDL 测试与迁移复用）。生产迁移走 database.ts 的 TABLE_SCHEMAS 循环。 */
export function applyAgentSchema(db: BetterSqlite3.Database): void {
  for (const schema of AGENT_TABLE_SCHEMAS) {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(schema.name)
    if (!exists) {
      db.exec(schema.createSql)
    }
  }
  for (const sql of AGENT_INDEX_SQLS) {
    db.exec(sql)
  }
}
