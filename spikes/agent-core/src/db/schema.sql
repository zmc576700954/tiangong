-- 最小 schema，表名/列名对齐 AGENT_ARCHITECTURE_DESIGN.md §6.1。
-- agent_steps 是新文档没有显式列出的补表：spike 用它承载「哪些 step 已完成/未知」的恢复判定；
-- 新文档的语义是 steps 可由 event sourcing 重建，见 README 冲突清单。

CREATE TABLE IF NOT EXISTS agent_runs (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL,
  node_id            TEXT NOT NULL,
  graph_id           TEXT,
  backend            TEXT NOT NULL,
  backend_session_id TEXT,
  loop_ownership     TEXT NOT NULL CHECK(loop_ownership IN ('backend','host')),
  status             TEXT NOT NULL
                     CHECK(status IN ('created','running','awaiting_approval','cancelling',
                                      'interrupted','completed','failed','cancelled')),
  budget_json        TEXT,
  idempotency_key    TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_node ON agent_runs(node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

CREATE TABLE IF NOT EXISTS agent_steps (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL
                CHECK(kind IN ('message','reasoning','tool_call','artifact','usage','system')),
  tool_name     TEXT,
  tool_call_id  TEXT,
  status        TEXT NOT NULL
                CHECK(status IN ('requested','awaiting_approval','approved','denied',
                                 'running','done','failed','unknown')),
  args_hash     TEXT,
  fidelity      TEXT NOT NULL CHECK(fidelity IN ('token','turn','session')),
  started_at    INTEGER,
  ended_at      INTEGER,
  UNIQUE(run_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_events (
  event_id     TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  turn_id      TEXT,
  step_id      TEXT,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source       TEXT NOT NULL CHECK(source IN ('backend','kernel','synthetic')),
  fidelity     TEXT NOT NULL CHECK(fidelity IN ('token','turn','session')),
  created_at   INTEGER NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id, seq);

CREATE TABLE IF NOT EXISTS agent_approvals (
  approval_id  TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  input_json   TEXT NOT NULL,
  risk         TEXT NOT NULL CHECK(risk IN ('low','medium','high')),
  decision     TEXT CHECK(decision IN ('allow','deny','allow_session')),
  resolved_by  TEXT CHECK(resolved_by IN ('user','timeout','cancel')),
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_approvals_run ON agent_approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_pending ON agent_approvals(decision, expires_at)
  WHERE decision IS NULL;

CREATE TABLE IF NOT EXISTS agent_snapshots (
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  state_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY(run_id, seq)
);
