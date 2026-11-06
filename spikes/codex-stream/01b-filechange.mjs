// 实验 1b：file_change 事件是否携带 diff 内容
// 上一条任务模型用 shell 重定向写文件，没触发 file_change；这里强制走 apply_patch 路径
import { Codex } from '@openai/codex-sdk';
import { prepareDir, saveJson, summarizeEvent, codexOptions } from './lib.mjs';

const PROMPT = [
  'Use the apply_patch tool (do NOT use shell redirection or echo) to create a file named patch-probe.txt',
  'in the current working directory with exactly two lines:',
  'alpha',
  'beta',
  'Then reply DONE.',
].join('\n');

const t0 = Date.now();
const workdir = await prepareDir('filechange');
const codex = new Codex(codexOptions());
const thread = codex.startThread({
  workingDirectory: workdir,
  sandboxMode: 'workspace-write',
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
});

const controller = new AbortController();
const watchdog = setTimeout(() => controller.abort(), 180_000);

const events = [];
let error = null;
try {
  const streamed = await thread.runStreamed(PROMPT, { signal: controller.signal });
  for await (const ev of streamed.events) {
    events.push({ tMs: Date.now() - t0, raw: ev });
    console.log(`[+${String(Date.now() - t0).padStart(6)}ms] ${ev.type}${ev.item ? ' / ' + ev.item.type : ''}`);
  }
} catch (e) {
  error = { name: e?.name, message: e?.message };
  console.error('ERROR:', error);
} finally {
  clearTimeout(watchdog);
}

const report = {
  mode: 'runStreamed (apply_patch)',
  prompt: PROMPT,
  workdir,
  error,
  totalMs: Date.now() - t0,
  eventCount: events.length,
  byEvent: events.reduce((acc, e) => ({ ...acc, [e.raw.type]: (acc[e.raw.type] ?? 0) + 1 }), {}),
  byItem: events.filter((e) => e.raw.item).reduce((acc, e) => ({ ...acc, [e.raw.item.type]: (acc[e.raw.item.type] ?? 0) + 1 }), {}),
  // 关键：file_change 事件完整 payload（注意它没有 diff 字段）
  fileChangeEvents: events.filter((e) => e.raw.item?.type === 'file_change').map((e) => e.raw),
  commandEvents: events.filter((e) => e.raw.item?.type === 'command_execution').map((e) => e.raw.item),
  itemKeys: Object.fromEntries(
    [...new Set(events.filter((e) => e.raw.item).map((e) => e.raw.item.type))]
      .map((t) => [t, [...new Set(events.filter((e) => e.raw.item?.type === t).flatMap((e) => Object.keys(e.raw.item)))]])
  ),
  events,
};
console.log('\n=== 摘要 ===');
console.log(JSON.stringify({ ...report, events: undefined }, null, 2));
console.log('\n结果文件:', await saveJson('01b-filechange.json', report));
