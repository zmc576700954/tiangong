// 实验 2：非流式 run() 对照
// 同一任务，比较最终结果与流式信息量差异（是否丢字段 / 是否重复计费）
import { Codex } from '@openai/codex-sdk';
import { prepareDir, saveJson, startProcSampler, summarizeEvent, codexOptions } from './lib.mjs';
import { readFile } from 'node:fs/promises';

const PROMPT = [
  'Do exactly this, nothing more:',
  '1) Create a file named stream-probe.txt in the current working directory with the single line: hello-codex',
  '2) Then read that file back with a shell command (cat) and reply with its exact content.',
].join('\n');

const t0 = Date.now();
const workdir = await prepareDir('blocking');
const sampler = startProcSampler(100);

const codex = new Codex(codexOptions());
const thread = codex.startThread({
  workingDirectory: workdir,
  sandboxMode: 'workspace-write',
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
});

const controller = new AbortController();
const watchdog = setTimeout(() => controller.abort(), 180_000);

let result = null;
let error = null;
try {
  result = await thread.run(PROMPT, { signal: controller.signal });
} catch (e) {
  error = { name: e?.name, message: e?.message };
  console.error('RUN ERROR:', error);
} finally {
  clearTimeout(watchdog);
  sampler.stop();
}

let fileContent = null;
try {
  fileContent = await readFile(`${workdir}/stream-probe.txt`, 'utf8');
} catch (e) {
  fileContent = `READ_FAILED: ${e.message}`;
}

const report = {
  mode: 'run (blocking)',
  prompt: PROMPT,
  workdir,
  threadId: thread.id,
  totalMs: Date.now() - t0,
  error,
  usage: result?.usage ?? null,
  finalResponse: result?.finalResponse ?? null,
  itemCount: result?.items?.length ?? 0,
  items: (result?.items ?? []).map((it) => summarizeEvent({ item: it })),
  // 字段完整性：run() 返回的 item 是否保留了 streamed 里的字段
  itemFieldAudit: (result?.items ?? []).map((it) => ({
    type: it.type,
    fields: Object.keys(it).sort(),
  })),
  spawnedProcesses: sampler.samples(),
  fileContent,
};
const reportFile = await saveJson('02-blocking.json', report);
console.log('\n=== 摘要 ===');
console.log(JSON.stringify(report, null, 2));
console.log('\n结果文件:', reportFile);
