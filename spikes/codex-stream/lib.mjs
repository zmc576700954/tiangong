// 实验公共工具：ps 采样（拿真实 argv / 判断进程回收）、目录准备、结果落盘
import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS = path.join(HERE, 'results');

export async function prepareDir(name) {
  const dir = path.join(HERE, 'work', name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveJson(name, data) {
  await mkdir(RESULTS, { recursive: true });
  const file = path.join(RESULTS, name);
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

// 采样当前进程表里与 codex 原生二进制相关的进程（含 argv）
export function listProcesses(pattern) {
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid,ppid,command'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split('\n').filter((line) => pattern.test(line)).map((l) => l.trim()));
    });
  });
}

const CODEX_PROC_RE = /aarch64-apple-darwin\/bin\/codex|\/bin\/codex\.js exec/;
// 只匹配「真正的 sleep 进程」行（pid ppid sleep N），避免把 harness 命令自身也匹配进来
const SLEEP_PROC_RE = /^\d+\s+\d+\s+sleep \d+\s*$/;

export function listCodexProcesses() {
  return listProcesses(CODEX_PROC_RE);
}

export function listRelatedProcesses() {
  return listProcesses(new RegExp(`${CODEX_PROC_RE.source}|${SLEEP_PROC_RE.source}`));
}

// 周期性采样，收集所有出现过的 codex 命令行（用于还原真实 argv）
export function startProcSampler(intervalMs = 100) {
  const seen = new Set();
  let timer = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const line of await listRelatedProcesses()) seen.add(line);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  tick();
  return {
    samples: () => [...seen],
    stop: () => clearInterval(timer),
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 实验用 CODEX_HOME（由 00b-setup-codex-home.sh 生成），不污染 ~/.codex
export const CODEX_HOME = process.env.CODEX_HOME ?? '/tmp/codex-home';

// CodexOptions：env 传参时 SDK 不会继承 process.env，这里补齐并只覆盖 CODEX_HOME
export function codexOptions() {
  return { env: { ...process.env, CODEX_HOME } };
}

// 摘要一个 ThreadEvent，便于报告里读
export function summarizeEvent(ev) {
  const out = { type: ev.type };
  if (ev.item) {
    out.itemId = ev.item.id;
    out.itemType = ev.item.type;
    out.status = ev.item.status;
    if (ev.item.type === 'command_execution') {
      out.command = ev.item.command;
      out.aggregated_output = (ev.item.aggregated_output ?? '').slice(0, 200);
      out.exit_code = ev.item.exit_code;
    }
    if (ev.item.type === 'file_change') out.changes = ev.item.changes;
    if (ev.item.type === 'agent_message') out.text = ev.item.text.slice(0, 300);
    if (ev.item.type === 'reasoning') out.text = ev.item.text.slice(0, 200);
  }
  if (ev.usage) out.usage = ev.usage;
  if (ev.error) out.error = ev.error;
  if (ev.message) out.message = ev.message;
  if (ev.thread_id) out.thread_id = ev.thread_id;
  return out;
}

export function typeDistribution(events) {
  const byEvent = {};
  const byItem = {};
  for (const e of events) {
    byEvent[e.type] = (byEvent[e.type] ?? 0) + 1;
    if (e.item) byItem[e.item.type] = (byItem[e.item.type] ?? 0) + 1;
  }
  return { byEvent, byItem };
}
