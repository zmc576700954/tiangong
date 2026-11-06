// 实验 3：TurnOptions.signal 中断行为
// 长任务（sleep 30）→ abort → 测量 a) 抛错时延 b) 子进程回收时延 c) 已产生事件是否保留 d) 是否留下孤儿进程
import { Codex } from '@openai/codex-sdk';
import { prepareDir, saveJson, startProcSampler, summarizeEvent, listCodexProcesses, listRelatedProcesses, sleep, codexOptions } from './lib.mjs';

const PROMPT = 'Run this exact shell command and wait for it to finish: sleep 30. After it finishes, reply with the word DONE.';
const ABORT_AFTER_MS = 6_000;
const RUN_ID = process.argv[2] ?? 'run1';

const workdir = await prepareDir('abort');
const sampler = startProcSampler(100);

const codex = new Codex(codexOptions());
const thread = codex.startThread({
  workingDirectory: workdir,
  sandboxMode: 'workspace-write',
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
});

const controller = new AbortController();
const t0 = Date.now();
const timeline = [];
const events = [];
let tAbort = null;
let tThrow = null;
let thrown = null;

const streamed = await thread.runStreamed(PROMPT, { signal: controller.signal });
const abortTimer = setTimeout(() => {
  tAbort = Date.now();
  timeline.push({ tMs: tAbort - t0, event: 'abort() called' });
  controller.abort();
}, ABORT_AFTER_MS);

try {
  for await (const ev of streamed.events) {
    const t = Date.now() - t0;
    events.push({ tMs: t, summary: summarizeEvent(ev) });
    timeline.push({ tMs: t, event: `${ev.type}${ev.item ? ' / ' + ev.item.type : ''}` });
    console.log(`[+${String(t).padStart(6)}ms] ${ev.type}${ev.item ? ' / ' + ev.item.type : ''}`);
  }
  timeline.push({ tMs: Date.now() - t0, event: 'iterator completed normally' });
} catch (e) {
  tThrow = Date.now();
  thrown = { name: e?.name, message: e?.message, code: e?.code };
  timeline.push({ tMs: tThrow - t0, event: `iterator threw: ${e?.name}: ${e?.message}` });
  console.error('THROWN:', thrown);
} finally {
  clearTimeout(abortTimer);
}

const procAtThrow = await listRelatedProcesses();
// 轮询：分别记录「codex 主进程消失」与「其所有子进程（含 shell 命令的孙子进程）消失」
let tCodexGone = null;
let tAllGone = null;
for (let i = 0; i < 300; i++) {
  const codexNow = await listCodexProcesses();
  const related = await listRelatedProcesses();
  if (tCodexGone === null && codexNow.length === 0) tCodexGone = Date.now();
  if (tAllGone === null && related.length === 0) { tAllGone = Date.now(); break; }
  await sleep(50);
}
sampler.stop();
const procFinal = await listRelatedProcesses();

// 中断时处于 in_progress、但没有对应 item.completed 的条目
const startedIds = new Set(events.filter((e) => e.summary.type === 'item.started').map((e) => e.summary.itemId));
const completedIds = new Set(events.filter((e) => e.summary.type === 'item.completed').map((e) => e.summary.itemId));
const unfinishedItemIds = [...startedIds].filter((id) => !completedIds.has(id));

const report = {
  runId: RUN_ID,
  mode: 'runStreamed + AbortController',
  prompt: PROMPT,
  abortAfterMs: ABORT_AFTER_MS,
  threadId: thread.id,
  tAbortMs: tAbort ? tAbort - t0 : null,
  tThrowMs: tThrow ? tThrow - t0 : null,
  // abort 调用 → 迭代器抛错 的时延
  abortToThrowMs: tAbort && tThrow ? tThrow - tAbort : null,
  // abort 调用 → codex 主进程消失 的时延
  abortToCodexGoneMs: tAbort && tCodexGone ? tCodexGone - tAbort : null,
  // abort 调用 → 所有相关进程（含命令产生的孙子进程）消失 的时延（>15s 记为 null = 未回收）
  abortToAllGoneMs: tAbort && tAllGone ? tAllGone - tAbort : null,
  thrown,
  eventsBeforeAbort: events.filter((e) => tAbort && e.tMs <= tAbort - t0).length,
  eventsAfterAbort: events.filter((e) => tAbort && e.tMs > tAbort - t0).length,
  unfinishedItemIds,
  events,
  processAtThrow: procAtThrow,
  processFinal: procFinal,
  leaked: procFinal.length > 0 ? procFinal : 0,
  spawnedProcesses: sampler.samples(),
  timeline,
};
const reportFile = await saveJson(`03-abort-${RUN_ID}.json`, report);
console.log('\n=== 摘要 ===');
console.log(JSON.stringify({ ...report, events: undefined, timeline: undefined, spawnedProcesses: undefined }, null, 2));
console.log('\n结果文件:', reportFile);
