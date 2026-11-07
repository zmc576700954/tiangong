/**
 * S5a 六表 DDL（session-map 蓝图 §7.2 逐字对齐）。
 *
 * 独立模块（不依赖 electron）供 database.ts 消费与真库测试复用——
 * 单一权威在本文件；改动须 bump CURRENT_SCHEMA_VERSION 并遵守 §8.7
 * "状态值域一次建齐,不得留 ALTER/重建"。
 */

export interface MapTableSchema {
  name: string
  createSql: string
  requiredColumns: string[]
}

export const MAP_S5A_TABLE_SCHEMAS: MapTableSchema[] = [
  {
    // 任务对象：status 13 值一次建齐（D2+一次性修正,含 failed 支持父任务失败聚合 §5.5.1）。
    name: 'work_items',
    createSql: `
      CREATE TABLE work_items (
        id                   TEXT PRIMARY KEY,
        lineage_id           TEXT NOT NULL,
        revision             INTEGER NOT NULL DEFAULT 1,
        supersedes_id        TEXT,
        is_current           INTEGER NOT NULL DEFAULT 1,
        project_path         TEXT,
        graph_id             TEXT NOT NULL,
        anchor_entity_key    TEXT,
        anchor_node_id       TEXT,
        parent_work_item_id  TEXT REFERENCES work_items(id),
        depth                INTEGER NOT NULL DEFAULT 0,
        title                TEXT NOT NULL,
        goal                 TEXT,
        scope_files          TEXT NOT NULL DEFAULT '[]',
        out_of_scope_files   TEXT,
        acceptance_json      TEXT NOT NULL DEFAULT '[]',
        verification_hint    TEXT,
        status               TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
          'draft','awaiting_confirm','queued','running','blocked',
          'needs_input','needs_human','paused','interrupted',
          'done','failed','cancelled','superseded')),
        gate_status          TEXT NOT NULL DEFAULT 'incomplete'
                             CHECK(gate_status IN ('incomplete','pass','waived')),
        gate_missing_json    TEXT,
        gate_waived_by       TEXT,
        gate_waived_at       INTEGER,
        gate_waive_reason    TEXT,
        depends_on_json      TEXT NOT NULL DEFAULT '[]',
        origin               TEXT NOT NULL CHECK(origin IN ('human','derived_plan','imported')),
        plan_id              TEXT,
        candidate_id         TEXT,
        created_by           TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        archived_at          TEXT,
        UNIQUE(lineage_id, revision)
      )
    `,
    requiredColumns: ['id', 'lineage_id', 'revision', 'graph_id', 'title', 'status', 'gate_status', 'origin', 'created_at', 'updated_at'],
  },
  {
    // 编排步（D2 独立建表）：步专属字段只在此表;状态 12 值一次建齐（§4.7.4）。
    name: 'work_steps',
    createSql: `
      CREATE TABLE work_steps (
        id                   TEXT PRIMARY KEY,
        work_item_id         TEXT NOT NULL REFERENCES work_items(id),
        work_item_revision   INTEGER NOT NULL,
        seq                  INTEGER NOT NULL,
        title                TEXT NOT NULL,
        step_kind            TEXT NOT NULL CHECK(step_kind IN ('agent','test','human')),
        scope_files_json     TEXT NOT NULL DEFAULT '[]',
        depends_on_step_ids_json TEXT,
        output_schema_json   TEXT,
        consults_json        TEXT,
        checker_work_item_id TEXT REFERENCES work_items(id),
        deadline_at          INTEGER,
        attempt              INTEGER NOT NULL DEFAULT 1,
        invocation_id        TEXT,
        input_request_json   TEXT,
        status               TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
          'planning','pending','waiting_approval','running','review',
          'needs_input','paused','succeeded','failed','timed_out',
          'cancelled','skipped')),
        started_at           INTEGER,
        ended_at             INTEGER,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        UNIQUE(work_item_id, work_item_revision, seq)
      )
    `,
    requiredColumns: ['id', 'work_item_id', 'work_item_revision', 'seq', 'title', 'step_kind', 'status', 'created_at', 'updated_at'],
  },
  {
    // 执行事实（一次尝试一行）：status 与 agent_runs 不共用——本表任务视角。
    name: 'work_runs',
    createSql: `
      CREATE TABLE work_runs (
        id                   TEXT PRIMARY KEY,
        work_item_id         TEXT NOT NULL REFERENCES work_items(id),
        work_item_lineage_id TEXT NOT NULL,
        work_item_revision   INTEGER NOT NULL,
        step_id              TEXT REFERENCES work_steps(id),
        run_seq              INTEGER NOT NULL,
        attempt              INTEGER NOT NULL DEFAULT 1,
        idempotency_key      TEXT NOT NULL,
        executor_kind        TEXT NOT NULL CHECK(executor_kind IN ('agent','test','human')),
        adapter_name         TEXT,
        route_decision_id    TEXT,
        status               TEXT NOT NULL CHECK(status IN (
          'queued','running','awaiting_approval','blocked',
          'completed','failed','cancelled','superseded',
          'interrupted','timed_out')),
        session_id           TEXT,
        thread_id            TEXT,
        agent_run_id         TEXT,
        invocation_id        TEXT,
        started_at           INTEGER,
        deadline_at          INTEGER,
        ended_at             INTEGER,
        result_summary       TEXT,
        outputs_json         TEXT,
        output_parse         TEXT CHECK(output_parse IN ('ok','fallback')),
        output_extra_keys    TEXT,
        partial_output_ref   TEXT,
        failure_class        TEXT CHECK(failure_class IN (
          'infra','busy','turn_fail','verify_fail','test_fail',
          'env_fail','timeout','cancel','denied')),
        cancel_requested_at  INTEGER,
        cancel_reason        TEXT CHECK(cancel_reason IN (
          'user','upstream_cancelled','deadline','shutdown','approval_denied')),
        created_at           INTEGER NOT NULL,
        UNIQUE(work_item_id, run_seq),
        UNIQUE(idempotency_key)
      )
    `,
    requiredColumns: ['id', 'work_item_id', 'work_item_lineage_id', 'work_item_revision', 'run_seq', 'attempt', 'idempotency_key', 'executor_kind', 'status', 'created_at'],
  },
  {
    // 会话↔节点↔任务多对多引用（会话本体仍在 chat_threads）。
    name: 'node_session_links',
    createSql: `
      CREATE TABLE node_session_links (
        id               TEXT PRIMARY KEY,
        project_path     TEXT NOT NULL,
        graph_id         TEXT NOT NULL,
        node_entity_key  TEXT,
        node_id          TEXT,
        work_item_id     TEXT,
        work_run_id      TEXT,
        thread_id        TEXT NOT NULL,
        session_id       TEXT,
        agent_run_id     TEXT,
        turn_id          TEXT,
        link_role        TEXT NOT NULL CHECK(link_role IN (
          'primary','supporting','review','test','investigation')),
        session_origin   TEXT NOT NULL CHECK(session_origin IN (
          'map_task','manual_panel','subagent','test')),
        started_at       INTEGER,
        ended_at         INTEGER,
        created_at       INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'project_path', 'graph_id', 'thread_id', 'link_role', 'session_origin', 'created_at'],
  },
  {
    // 变更面快照：§4.6 filesTouched 的唯一来源（change_sets 进 L1,5b26715 裁决）。
    name: 'change_sets',
    createSql: `
      CREATE TABLE change_sets (
        id              TEXT PRIMARY KEY,
        project_path    TEXT NOT NULL,
        graph_id        TEXT,
        work_run_id     TEXT,
        session_id      TEXT,
        base_commit     TEXT,
        head_commit     TEXT,
        dirty           INTEGER NOT NULL DEFAULT 0,
        dirty_tree_hash TEXT,
        files_json      TEXT NOT NULL,
        file_count      INTEGER NOT NULL DEFAULT 0,
        line_additions  INTEGER NOT NULL DEFAULT 0,
        line_deletions  INTEGER NOT NULL DEFAULT 0,
        captured_at     INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'project_path', 'files_json', 'captured_at'],
  },
  {
    // 单 Agent 路由决策记录：可解释、可复盘,不做自动重路由;chosen_adapter 不允许空串。
    name: 'routing_decisions',
    createSql: `
      CREATE TABLE routing_decisions (
        id                TEXT PRIMARY KEY,
        work_item_id      TEXT,
        work_run_id       TEXT,
        chosen_adapter    TEXT NOT NULL,
        candidate_json    TEXT NOT NULL,
        reason            TEXT,
        policy            TEXT NOT NULL CHECK(policy IN ('single_agent','manual_override','fallback')),
        confidence        REAL,
        created_at        INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'chosen_adapter', 'candidate_json', 'policy', 'created_at'],
  },
]

/** S5a 索引（§7.2）。 */
export const MAP_S5A_INDEX_SQLS: string[] = [
  // ux_work_items_current 是部分唯一索引：同一 lineage 只允许一行 is_current=1。
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_work_items_current ON work_items(lineage_id) WHERE is_current = 1`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_graph ON work_items(graph_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_anchor ON work_items(graph_id, anchor_entity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_parent ON work_items(parent_work_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_work_steps_item ON work_steps(work_item_id, work_item_revision, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_work_steps_status ON work_steps(status)`,
  `CREATE INDEX IF NOT EXISTS idx_work_runs_lineage ON work_runs(work_item_lineage_id, run_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_work_runs_status ON work_runs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_work_runs_session ON work_runs(session_id)`,
  // 会话级链接：同一 thread+节点+role 一条；项目级（node_entity_key IS NULL）
  // 不参与普通 UNIQUE,必须用部分唯一索引。
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_node_session_links_node ON node_session_links(thread_id, node_entity_key, link_role)
     WHERE node_entity_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_node_session_links_project ON node_session_links(thread_id, link_role)
     WHERE node_entity_key IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_node_session_links_node ON node_session_links(graph_id, node_entity_key, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_node_session_links_work ON node_session_links(work_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_node_session_links_thread ON node_session_links(thread_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_change_sets_run ON change_sets(work_run_id) WHERE work_run_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_change_sets_project ON change_sets(project_path, captured_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_routing_decisions_run ON routing_decisions(work_run_id) WHERE work_run_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_routing_decisions_item ON routing_decisions(work_item_id, created_at DESC)`,
]

/** 真库测试建表助手（DDL 与生产同源）。 */
export function applyMapS5aSchema(db: { exec(sql: string): unknown }): void {
  for (const schema of MAP_S5A_TABLE_SCHEMAS) {
    db.exec(schema.createSql)
  }
  for (const sql of MAP_S5A_INDEX_SQLS) {
    db.exec(sql)
  }
}
