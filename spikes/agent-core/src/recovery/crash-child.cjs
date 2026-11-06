/**
 * 崩溃注入子进程：写入「执行到 step 2」的持久化现场，然后 SIGKILL 自己。
 * 用法：node crash-child.cjs <mode> <dbPath> <workspacePath>
 * mode: approval-not-landed | approval-landed | approval-mismatch
 */
const Database = require('better-sqlite3')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const [mode, dbPath, workspacePath] = process.argv.slice(2)
if (!mode || !dbPath || !workspacePath) {
  console.error('usage: crash-child.cjs <mode> <dbPath> <workspacePath>')
  process.exit(2)
}

const ORIGINAL = 'export function add(a, b) { return a - b }\n'
const FIXED = 'export function add(a, b) { return a + b }\n'
const MISMATCH = 'export function add(a,b){return a+b}\n'

function hashContent(content) {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

const filePath = path.join(workspacePath, 'math.ts')
fs.mkdirSync(workspacePath, { recursive: true })
fs.writeFileSync(filePath, ORIGINAL)

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = FULL')
db.exec(schema)

const now = Date.now()
const runId = 'run-crash-1'
const turnId = 'turn-crash-1'
const approvalId = 'approval-crash-1'
const toolCallId = 'call-crash-1'
const afterHash = hashContent(FIXED)

const step2Status = mode === 'approval-not-landed' ? 'approved' : 'running'
const writeLanded = mode === 'approval-landed'
const mismatch = mode === 'approval-mismatch'

const backendSessionId = mode === 'approval-landed' ? 'claude-session-crash-1' : null

db.prepare(
  `INSERT INTO agent_runs
     (id, thread_id, node_id, graph_id, backend, backend_session_id, loop_ownership,
      status, budget_json, idempotency_key, created_at, updated_at)
   VALUES (?, 'thread-1', 'node-1', 'graph-1', 'claude-code', ?, 'backend',
           'running', NULL, 'idem-crash-1', ?, ?)`,
).run(runId, backendSessionId, now, now)

db.prepare(
  `INSERT INTO agent_steps (id, run_id, turn_id, seq, kind, tool_name, tool_call_id, status,
     args_hash, fidelity, started_at, ended_at)
   VALUES ('step-1', ?, ?, 1, 'message', NULL, NULL, 'done', NULL, 'token', ?, ?)`,
).run(runId, turnId, now, now)

db.prepare(
  `INSERT INTO agent_steps (id, run_id, turn_id, seq, kind, tool_name, tool_call_id, status,
     args_hash, fidelity, started_at, ended_at)
   VALUES ('step-2', ?, ?, 2, 'tool_call', 'Write', ?, ?, 'sha256:args-crash', 'token', ?, NULL)`,
).run(runId, turnId, toolCallId, step2Status, now)

const insertEvent = db.prepare(
  `INSERT INTO agent_events
     (event_id, run_id, seq, turn_id, step_id, type, payload_json, source, fidelity, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'backend', 'token', ?)`,
)

const events = [
  {
    id: 'ev-1',
    seq: 1,
    stepId: null,
    type: 'run.started',
    payload: { attempt: 1, resumeMode: 'fresh' },
  },
  {
    id: 'ev-2',
    seq: 2,
    stepId: 'step-1',
    type: 'message.completed',
    payload: { role: 'assistant', text: 'I will rewrite math.ts.', mode: 'block' },
  },
  {
    id: 'ev-3',
    seq: 3,
    stepId: 'step-2',
    type: 'tool.requested',
    payload: {
      toolCallId,
      toolName: 'Write',
      input: { path: 'math.ts', content: FIXED },
      risk: 'high',
      blocking: true,
    },
  },
  {
    id: 'ev-4',
    seq: 4,
    stepId: 'step-2',
    type: 'tool.approval_required',
    payload: {
      approvalId,
      toolCallId,
      toolName: 'Write',
      input: { path: 'math.ts', content: FIXED },
      risk: 'high',
      blocking: true,
      expiresAt: now + 60_000,
    },
  },
]

if (writeLanded || mismatch) {
  events.push({
    id: 'ev-5',
    seq: 5,
    stepId: 'step-2',
    type: 'artifact.changed',
    payload: {
      path: 'math.ts',
      changeType: 'modify',
      afterHash,
      postHoc: true,
    },
  })
}

const tx = db.transaction(() => {
  for (const event of events) {
    insertEvent.run(
      event.id,
      runId,
      event.seq,
      turnId,
      event.stepId,
      event.type,
      JSON.stringify(event.payload),
      now + event.seq,
    )
  }
  db.prepare(
    `INSERT INTO agent_approvals
       (approval_id, run_id, turn_id, tool_call_id, tool_name, input_json, risk,
        decision, resolved_by, expires_at, created_at, resolved_at)
     VALUES (?, ?, ?, ?, 'Write', ?, 'high', 'allow', 'user', ?, ?, ?)`,
  ).run(
    approvalId,
    runId,
    turnId,
    toolCallId,
    JSON.stringify({ path: 'math.ts', content: FIXED }),
    now + 60_000,
    now,
    now,
  )
})
tx()

if (writeLanded) fs.writeFileSync(filePath, FIXED)
if (mismatch) fs.writeFileSync(filePath, MISMATCH)

// 模拟进程在执行到 step 2 时被杀；WAL + synchronous=FULL 保证已提交事务可恢复
process.kill(process.pid, 'SIGKILL')
