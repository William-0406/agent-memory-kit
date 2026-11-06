#!/usr/bin/env node
// 审查台账报告 · 衡量噪音
// 依据：Claude Code 团队 code review 流程（2026-10-15）——「不介意误报的话，提高查 bug 率很容易」，
// 所以噪音必须被记账并设阈值。规则见 自检规则.md「审查交付规格」第二节。
//
// 台账只增不改：记忆网关/审查台账.jsonl，一行一次审查任务。
// 用法：node scripts/review-ledger-report.mjs [--json] [--min 60]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, '记忆网关', '审查台账.jsonl');
const MIN_PRECISION = 60;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const minIdx = args.indexOf('--min');
const min = minIdx >= 0 ? Number(args[minIdx + 1]) : MIN_PRECISION;

function pct(kept, total) {
  if (!total) return null;
  return Math.round((kept / total) * 1000) / 10;
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) return { rows: [], bad: 0 };
  const rows = [];
  let bad = 0;
  for (const [i, line] of fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).entries()) {
    const text = line.trim();
    if (!text) continue;
    try {
      const row = JSON.parse(text);
      if (!row.date || !Number.isFinite(row.reported) || !Number.isFinite(row.withdrawn)) throw new Error('缺字段');
      if (row.withdrawn > row.reported) throw new Error('撤回数大于报出数');
      rows.push({ ...row, kept: row.reported - row.withdrawn });
    } catch (err) {
      bad += 1;
      if (!asJson) console.warn(`⚠️ 第 ${i + 1} 行无法解析，已跳过：${err.message}`);
    }
  }
  return { rows, bad };
}

function summarize(rows) {
  const reported = rows.reduce((s, r) => s + r.reported, 0);
  const withdrawn = rows.reduce((s, r) => s + r.withdrawn, 0);
  const kept = reported - withdrawn;
  return { runs: rows.length, reported, withdrawn, kept, precision: pct(kept, reported) };
}

const { rows, bad } = readLedger();
if (!rows.length) {
  console.log('审查台账还是空的：记忆网关/审查台账.jsonl 里没有可用记录。');
  console.log('有审查类任务产出误报时再追加，不为了填表写空行。');
  process.exit(0);
}

const overall = summarize(rows);
const byTask = new Map();
for (const r of rows) {
  const key = r.task;
  if (!byTask.has(key)) byTask.set(key, []);
  byTask.get(key).push(r);
}

const tasks = [...byTask.entries()]
  .map(([task, list]) => ({ task, ...summarize(list) }))
  .sort((a, b) => (a.precision ?? 100) - (b.precision ?? 100));

const noisy = tasks.filter((t) => t.precision !== null && t.precision < min);

if (asJson) {
  console.log(JSON.stringify({ overall, tasks, noisy, parseErrors: bad }, null, 2));
  process.exit(0);
}

console.log('审查台账 · 噪音核算');
console.log(`台账：记忆网关/审查台账.jsonl${bad ? `（${bad} 行无法解析已跳过）` : ''}\n`);
console.log(`累计 ${overall.runs} 次审查：报出 ${overall.reported} 条，撤回 ${overall.withdrawn} 条，保留 ${overall.kept} 条 → 精确率 ${overall.precision}%\n`);

console.log('按任务：');
console.log('| 精确率 | 报出 | 撤回 | 任务 |');
console.log('|---|---|---|---|');
for (const t of tasks) {
  console.log(`| ${t.precision}% | ${t.reported} | ${t.withdrawn} | ${t.task} |`);
}

console.log('');
if (noisy.length) {
  console.log(`⚠️ 低于 ${min}% 的审查类型共 ${noisy.length} 类，下次先降噪再交：`);
  for (const t of noisy) console.log(`   · ${t.task}（${t.precision}%）`);
  console.log('   动作见 自检规则.md「审查交付规格」第二节：宁可少报，不许靠多报显得认真。');
} else {
  console.log(`✅ 所有类型精确率不低于 ${min}%。`);
}
console.log('\n最近三次：');
for (const r of rows.slice(-3)) {
  console.log(`  ${r.date}  报${r.reported}/撤${r.withdrawn}  ${r.task}`);
}
