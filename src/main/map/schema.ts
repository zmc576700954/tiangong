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

// ============================================================
// S6a（v29,session-map 蓝图 §3.2/§3.5/§3.7 + §7.2 逐字）
// ============================================================

export const MAP_S6A_TABLE_SCHEMAS: MapTableSchema[] = [
  {
    // 证据表：E3/E4 的字段级硬约束写进 CHECK——缺任一条件在库层即被拒。
    // E3 只认 version_binding='commit'（git 代码 hash）;E4 必须 'none' 且无 code hash。
    name: 'node_evidence',
    createSql: `
      CREATE TABLE node_evidence (
        id               TEXT PRIMARY KEY,
        project_path     TEXT,
        graph_id         TEXT NOT NULL,
        graph_type       TEXT NOT NULL CHECK(graph_type IN ('online','dev','test')),
        node_entity_key  TEXT NOT NULL,
        node_id          TEXT,
        evidence_level   TEXT NOT NULL CHECK(evidence_level IN ('E1','E2','E3','E4')),
        evidence_type    TEXT NOT NULL CHECK(evidence_type IN (
          'changed_files','commit','test_run','session_turn',
          'artifact','human_confirm','runtime_observation')),
        ref_json         TEXT NOT NULL,
        summary          TEXT,
        version_binding  TEXT NOT NULL DEFAULT 'commit'
                         CHECK(version_binding IN ('commit','content_hash','snapshot','none')),
        code_version     TEXT,
        code_dirty       INTEGER,
        base_hash        TEXT,
        current_hash     TEXT,
        freshness        TEXT NOT NULL DEFAULT 'fresh'
                         CHECK(freshness IN ('fresh','stale','unknown')),
        produced_by      TEXT NOT NULL
                         CHECK(produced_by IN ('human','agent','test_executor','system')),
        work_item_id     TEXT,
        work_run_id      TEXT,
        session_id       TEXT,
        turn_id          TEXT,
        created_at       TEXT NOT NULL,
        verified_at      TEXT,
        stale_at         TEXT,
        signed_by               TEXT,
        signed_by_display_name  TEXT,
        signed_at               TEXT,
        coverage_json           TEXT,
        basis_ref_json          TEXT,
        reproducible            INTEGER,
        expires_at       TEXT,
        renewed_from_evidence_id TEXT,
        revoked_at       TEXT,
        revoked_by       TEXT,
        revoke_reason    TEXT,
        CHECK (evidence_level <> 'E3' OR (
          version_binding = 'commit'
          AND code_version IS NOT NULL
          AND code_dirty = 0
          AND reproducible = 1
        )),
        CHECK (evidence_level <> 'E4' OR (
          version_binding = 'none'
          AND code_version IS NULL
          AND reproducible = 0
          AND signed_by IS NOT NULL
          AND signed_at IS NOT NULL
          AND coverage_json IS NOT NULL
        ))
      )
    `,
    requiredColumns: ['id', 'graph_id', 'graph_type', 'node_entity_key', 'evidence_level', 'evidence_type', 'ref_json', 'produced_by', 'created_at'],
  },
  {
    // 派生缓存（可整表重建）：nodes.status 永不参与派生、也不被回写（§3.1 双轨）。
    name: 'node_execution_state',
    createSql: `
      CREATE TABLE node_execution_state (
        graph_id           TEXT NOT NULL,
        node_entity_key    TEXT NOT NULL,
        execution_state    TEXT NOT NULL CHECK(execution_state IN (
          'untouched','planned','in_progress','implemented',
          'verified','signed_off','failed','blocked','stale')),
        evidence_level     TEXT NOT NULL CHECK(evidence_level IN ('E0','E1','E2','E3','E4')),
        is_reproducible    INTEGER NOT NULL DEFAULT 0,
        evidence_count     INTEGER NOT NULL DEFAULT 0,
        stale_count        INTEGER NOT NULL DEFAULT 0,
        derivation_version INTEGER NOT NULL DEFAULT 1,
        inputs_hash        TEXT,
        computed_at        INTEGER NOT NULL,
        PRIMARY KEY (graph_id, node_entity_key)
      )
    `,
    requiredColumns: ['graph_id', 'node_entity_key', 'execution_state', 'evidence_level', 'computed_at'],
  },
]

// ============================================================
// S7(v31,session-map 蓝图 §5.2/§5.5/§5.7 + §7.2 逐字)
// ============================================================

export const MAP_S7_TABLE_SCHEMAS: MapTableSchema[] = [
  {
    // 候选边界：一次推导 = 一个 derivation_run_id 批次;node_keys 存键不存 id。
    name: 'boundary_candidates',
    createSql: `
      CREATE TABLE boundary_candidates (
        id                 TEXT PRIMARY KEY,
        derivation_run_id  TEXT NOT NULL,
        derivation_version TEXT NOT NULL,
        project_path       TEXT,
        graph_id           TEXT NOT NULL,
        anchor_entity_key  TEXT,
        anchor_node_id     TEXT,
        node_keys_json     TEXT NOT NULL,
        files_json         TEXT NOT NULL,
        signals_json       TEXT,
        score              REAL NOT NULL,
        confidence         REAL,
        reason             TEXT,
        status             TEXT NOT NULL DEFAULT 'proposed'
                           CHECK(status IN ('proposed','chosen','rejected','merged')),
        created_at         TEXT NOT NULL
      )
    `,
    requiredColumns: ['id', 'derivation_run_id', 'derivation_version', 'graph_id', 'node_keys_json', 'files_json', 'score', 'status', 'created_at'],
  },
  {
    // 计划草稿:revision/lineage 与 work_items 同构;confirm 时生成 work_items(C1 强制)。
    name: 'plan_drafts',
    createSql: `
      CREATE TABLE plan_drafts (
        id                     TEXT PRIMARY KEY,
        lineage_id             TEXT NOT NULL,
        revision               INTEGER NOT NULL DEFAULT 1,
        supersedes_id          TEXT,
        is_current             INTEGER NOT NULL DEFAULT 1,
        project_path           TEXT,
        graph_id               TEXT NOT NULL,
        anchor_entity_key      TEXT,
        anchor_node_id         TEXT,
        derivation_run_id      TEXT,
        items_json             TEXT NOT NULL,
        model_choice_json      TEXT,
        rejected_boundaries_json TEXT,
        status                 TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
          'draft','awaiting_confirm','confirmed','rejected','superseded')),
        confirmed_by           TEXT,
        confirmed_at           TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        UNIQUE(lineage_id, revision)
      )
    `,
    requiredColumns: ['id', 'lineage_id', 'revision', 'graph_id', 'items_json', 'status', 'created_at', 'updated_at'],
  },
  {
    // 偏差度量:一次 work_run 终态写一行;归因=derivation_version+observed_rule_version
    // +task_type/agent_type(§5.7 已定口径);file_domain 由视图展开不存单值。
    name: 'plan_deviations',
    createSql: `
      CREATE TABLE plan_deviations (
        id                    TEXT PRIMARY KEY,
        work_item_id          TEXT,
        work_item_lineage_id  TEXT,
        work_item_revision    INTEGER,
        work_run_id           TEXT,
        derivation_version    TEXT NOT NULL,
        observed_rule_version TEXT NOT NULL,
        task_type             TEXT NOT NULL,
        agent_type            TEXT,
        planned_file_count    INTEGER,
        actual_file_count     INTEGER,
        planned_subtask_count INTEGER,
        actual_subtask_count  INTEGER,
        turns_used            INTEGER,
        tool_calls            INTEGER,
        rework_count          INTEGER NOT NULL DEFAULT 0,
        test_failures         INTEGER NOT NULL DEFAULT 0,
        replan_count          INTEGER NOT NULL DEFAULT 0,
        scope_violation       INTEGER NOT NULL DEFAULT 0,
        boundary_changed      INTEGER NOT NULL DEFAULT 0,
        duration_ms           INTEGER,
        computed_at           INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'derivation_version', 'observed_rule_version', 'task_type', 'computed_at'],
  },
]

export const MAP_S7_INDEX_SQLS: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_boundary_candidates_run ON boundary_candidates(derivation_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_boundary_candidates_anchor ON boundary_candidates(graph_id, anchor_entity_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_drafts_current ON plan_drafts(lineage_id) WHERE is_current = 1`,
  `CREATE INDEX IF NOT EXISTS idx_plan_drafts_anchor ON plan_drafts(graph_id, anchor_entity_key, is_current)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_deviations_rule ON plan_deviations(derivation_version, observed_rule_version)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_deviations_item ON plan_deviations(work_item_lineage_id)`,
]

export const MAP_S6A_INDEX_SQLS: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_node_evidence_node ON node_evidence(graph_id, node_entity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_node_evidence_level ON node_evidence(evidence_level, freshness)`,
  `CREATE INDEX IF NOT EXISTS idx_node_evidence_run ON node_evidence(work_run_id)`,
  // 同一 run 对同一节点产出的同类证据只落一条（重试幂等）;E4 人工签收不在此约束内
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_node_evidence_run_type
     ON node_evidence(work_run_id, evidence_type, node_entity_key)
     WHERE work_run_id IS NOT NULL AND evidence_level IN ('E2','E3')`,
  `CREATE INDEX IF NOT EXISTS idx_node_execution_state_value ON node_execution_state(execution_state)`,
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
// ============================================================
// S8 前置(v32,session-map 蓝图 §6/§7.2 逐字;S4 的 CHECK 值域扩展未含在此)
// ============================================================

export const MAP_S8_TABLE_SCHEMAS: MapTableSchema[] = [
  {
    // 测试资产绑定:kind='flow' 时 steps_json 承载有序步骤(§6.5.1)。
    name: 'test_specs',
    createSql: `
      CREATE TABLE test_specs (
        id                 TEXT PRIMARY KEY,
        project_path       TEXT NOT NULL,
        graph_id           TEXT,
        test_node_entity_key TEXT NOT NULL,
        test_node_id       TEXT,
        name               TEXT NOT NULL,
        kind               TEXT NOT NULL CHECK(kind IN ('unit','integration','e2e','flow')),
        command            TEXT NOT NULL,
        cwd                TEXT,
        env_json           TEXT,
        timeout_ms         INTEGER NOT NULL DEFAULT 300000,
        runner             TEXT,
        file_globs_json    TEXT,
        steps_json         TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      )
    `,
    requiredColumns: ['id', 'project_path', 'test_node_entity_key', 'name', 'kind', 'command', 'timeout_ms', 'created_at', 'updated_at'],
  },
  {
    name: 'test_plans',
    createSql: `
      CREATE TABLE test_plans (
        id               TEXT PRIMARY KEY,
        project_path     TEXT NOT NULL,
        graph_id         TEXT,
        work_item_id     TEXT,
        work_run_id      TEXT,
        node_keys_json   TEXT NOT NULL,
        base_commit      TEXT,
        worktree_path    TEXT,
        plan_hash        TEXT NOT NULL,
        approval_id      TEXT,
        status           TEXT NOT NULL CHECK(status IN (
          'draft','awaiting_approval','approved','running',
          'completed','failed','cancelled','expired')),
        created_by       TEXT,
        created_at       INTEGER NOT NULL,
        approved_at      INTEGER,
        started_at       INTEGER,
        ended_at         INTEGER
      )
    `,
    requiredColumns: ['id', 'project_path', 'node_keys_json', 'plan_hash', 'status', 'created_at'],
  },
  {
    name: 'test_plan_items',
    createSql: `
      CREATE TABLE test_plan_items (
        id                TEXT PRIMARY KEY,
        plan_id           TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
        spec_id           TEXT,
        seq               INTEGER NOT NULL,
        command           TEXT NOT NULL,
        cwd               TEXT,
        selected_by       TEXT NOT NULL DEFAULT 'plan'
                          CHECK(selected_by IN ('plan','targeted','rerun')),
        targeted_reason   TEXT,
        policy_decision   TEXT CHECK(policy_decision IN ('allow','deny','ask')),
        status            TEXT NOT NULL CHECK(status IN (
          'pending','running','passed','failed','skipped','error','timed_out')),
        exit_code         INTEGER,
        duration_ms       INTEGER,
        output_ref        TEXT,
        started_at        INTEGER,
        ended_at          INTEGER,
        UNIQUE(plan_id, seq)
      )
    `,
    requiredColumns: ['id', 'plan_id', 'seq', 'command', 'status'],
  },
  {
    name: 'test_runs',
    createSql: `
      CREATE TABLE test_runs (
        id               TEXT PRIMARY KEY,
        plan_id          TEXT NOT NULL,
        project_path     TEXT NOT NULL,
        graph_id         TEXT,
        work_item_id     TEXT,
        work_run_id      TEXT,
        base_commit      TEXT,
        head_commit      TEXT,
        worktree_commit  TEXT,
        dirty            INTEGER NOT NULL DEFAULT 0,
        dirty_tree_hash  TEXT,
        status           TEXT NOT NULL CHECK(status IN (
          'pending','running','passed','failed','error','cancelled','stale')),
        total            INTEGER NOT NULL DEFAULT 0,
        passed           INTEGER NOT NULL DEFAULT 0,
        failed           INTEGER NOT NULL DEFAULT 0,
        skipped          INTEGER NOT NULL DEFAULT 0,
        report_ref       TEXT,
        started_at       INTEGER,
        ended_at         INTEGER,
        created_at       INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'plan_id', 'project_path', 'status', 'created_at'],
  },
  {
    name: 'test_results',
    createSql: `
      CREATE TABLE test_results (
        id                     TEXT PRIMARY KEY,
        test_run_id            TEXT NOT NULL,
        plan_item_id           TEXT,
        spec_id                TEXT,
        test_node_entity_key   TEXT,
        target_node_entity_key TEXT,
        status                 TEXT NOT NULL CHECK(status IN (
          'passed','failed','skipped','error','timed_out')),
        exit_code              INTEGER,
        duration_ms            INTEGER,
        failure_summary        TEXT,
        failure_class          TEXT CHECK(failure_class IN (
          'assertion','timeout','env_fail','infra','cancelled')),
        output_ref             TEXT,
        created_at             INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'test_run_id', 'status', 'created_at'],
  },
]

export const MAP_S8_INDEX_SQLS: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_test_specs_node ON test_specs(graph_id, test_node_entity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_test_plans_status ON test_plans(status)`,
  `CREATE INDEX IF NOT EXISTS idx_test_plans_item ON test_plans(work_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_test_runs_plan ON test_runs(plan_id)`,
  `CREATE INDEX IF NOT EXISTS idx_test_runs_item ON test_runs(work_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_test_results_run ON test_results(test_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_test_results_target ON test_results(target_node_entity_key, status)`,
]

export function applyMapS8Schema(db: { exec(sql: string): unknown }): void {
  for (const schema of MAP_S8_TABLE_SCHEMAS) {
    db.exec(schema.createSql)
  }
  for (const sql of MAP_S8_INDEX_SQLS) {
    db.exec(sql)
  }
}

export function applyMapS7Schema(db: { exec(sql: string): unknown }): void {
  for (const schema of MAP_S7_TABLE_SCHEMAS) {
    db.exec(schema.createSql)
  }
  for (const sql of MAP_S7_INDEX_SQLS) {
    db.exec(sql)
  }
}

export function applyMapS5aSchema(db: { exec(sql: string): unknown }): void {
  for (const schema of MAP_S5A_TABLE_SCHEMAS) {
    db.exec(schema.createSql)
  }
  for (const sql of MAP_S5A_INDEX_SQLS) {
    db.exec(sql)
  }
}
