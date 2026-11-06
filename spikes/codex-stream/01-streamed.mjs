// 实验 1：runStreamed() 的事件粒度 / 时序 / argv 完整性
// 任务：在工作目录创建临时文件并读回内容
import { Codex } from '@openai/codex-sdk';
import { readFile } from 'node:fs/promises';
import {
  prepareDir, saveJson, startProcSampler, summarizeEvent,
  typeDistribution, listCodexProcesses, sleep, codexOptions,
} from './lib.mjs';

const PROMPT = [
  'Do exactly this, nothing more:',
  '1) Create a file named stream-probe.txt in the current working directory with the single line: hello-codex',
  '2) Then read that file back with a shell command (cat) and reply with its exact content.',
].join('\n');

const t0 = Date.now();
const workdir = await prepareDir('streamed');
const sampler = startProcSampler(100);

const codex = new Codex(codexOptions());
const thread = codex.startThread({
  workingDirectory: workdir,
  sandboxMode: 'workspace-write',
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
});

// 看门狗：180s 强停，避免实验挂死
const controller = new AbortController();
const watchdog = setTimeout(() => controller.abort(), 180_000);

const events = [];
let error = null;
let finished = false;
let tIteratorDone = null;
try {
  const streamed = await thread.runStreamed(PROMPT, { signal: controller.signal });
  for await (const ev of streamed.events) {
    events.push({ tMs: Date.now() - t0, raw: ev, summary: summarizeEvent(ev) });
    console.log(`[+${String(Date.now() - t0).padStart(6)}ms] ${ev.type}${ev.item ? ' / ' + ev.item.type : ''}`);
  }
  tIteratorDone = Date.now();
  finished = true;
} catch (e) {
  error = { name: e?.name, message: e?.message, stack: e?.stack?.split('\n').slice(0, 4).join('\n') };
  console.error('STREAM ERROR:', error);
} finally {
  clearTimeout(watchdog);
  sampler.stop();
}

// 记录 codex 子进程何时真正消失（流结束 ≠ 进程退出）
let tProcessGone = null;
for (let i = 0; i < 400; i++) {
  if ((await listCodexProcesses()).length === 0) { tProcessGone = Date.now(); break; }
  await sleep(50);
}
const procAfter = await listCodexProcesses();
const gaps = events.slice(1).map((e, i) => e.tMs - events[i].tMs);

const report = {
  mode: 'runStreamed',
  prompt: PROMPT,
  workdir,
  threadId: thread.id,
  finished,
  error,
  totalMs: Date.now() - t0,
  tIteratorDoneMs: tIteratorDone ? tIteratorDone - t0 : null,
  tProcessGoneMs: tProcessGone ? tProcessGone - t0 : null,
  // 最后一个事件 → 迭代器结束 的空档（流结束后的收尾开销）
  lastEventToIteratorDoneMs: tIteratorDone && events.length ? tIteratorDone - t0 - events.at(-1).tMs : null,
  eventCount: events.length,
  distribution: typeDistribution(events.map((e) => e.raw)),
  gapsMs: { min: Math.min(...gaps), max: Math.max(...gaps), values: gaps },
  hasUsage: events.some((e) => e.raw.type === 'turn.completed' && e.raw.usage),
  usage: events.find((e) => e.raw.type === 'turn.completed')?.raw.usage ?? null,
  // 命令是否带完整 argv
  commandExecutions: events
    .filter((e) => e.raw.item?.type === 'command_execution')
    .map((e) => ({
      id: e.raw.item.id,
      status: e.raw.item.status,
      command: e.raw.item.command,
      exit_code: e.raw.item.exit_code,
      aggregated_output: e.raw.item.aggregated_output,
    })),
  fileChanges: events
    .filter((e) => e.raw.item?.type === 'file_change')
    .map((e) => ({ id: e.raw.item.id, status: e.raw.item.status, changes: e.raw.item.changes })),
  spawnedProcesses: sampler.samples(),
  leftoverProcesses: procAfter,
  events,
};

// 校验文件是否真的落盘（任务的副作用）
let fileContent = null;
try {
  fileContent = await readFile(`${workdir}/stream-probe.txt`, 'utf8');
} catch (e) {
  fileContent = `READ_FAILED: ${e.message}`;
}
const reportFile = await saveJson('01-streamed.json', { ...report, fileContent });
console.log('\n=== 摘要 ===');
console.log(JSON.stringify({ ...report, events: undefined, fileContent }, null, 2));
console.log('\n结果文件:', reportFile);
await sleep(200);
