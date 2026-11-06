// 实验 4：CLI 层收尾开销（最后一个事件 → 进程退出）
// 目的：判断上面观察到的 ~10s 空档是 SDK 问题还是 codex 原生二进制自身关机耗时
import { spawn } from 'node:child_process';
import path from 'node:path';
import { HERE, saveJson, prepareDir, CODEX_HOME } from './lib.mjs';

const BIN = path.join(HERE, '../../node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');
const PROMPT = 'Reply with exactly: PONG';
const workdir = await prepareDir('cli-overhead');

const t0 = Date.now();
const child = spawn(
  BIN,
  ['exec', '--experimental-json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', workdir, PROMPT],
  { env: { ...process.env, CODEX_HOME } },
);
// 显式关闭 stdin，否则原生 CLI 会一直等待 stdin EOF（实测会挂住）
child.stdin.end();

const lines = [];
child.stdout.on('data', (buf) => {
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    lines.push({ tMs: Date.now() - t0, line });
  }
});
child.stderr.on('data', () => {});

const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, tMs: Date.now() - t0 })));

const last = lines.at(-1)?.tMs ?? null;
const report = {
  mode: 'raw codex exec --experimental-json',
  bin: BIN,
  prompt: PROMPT,
  lineCount: lines.length,
  lines,
  exit,
  lastEventToExitMs: last !== null && exit ? exit.tMs - last : null,
};
console.log(JSON.stringify({ lineCount: report.lineCount, exit: report.exit, lastEventToExitMs: report.lastEventToExitMs }, null, 2));
console.log('结果文件:', await saveJson('04-cli-overhead.json', report));
