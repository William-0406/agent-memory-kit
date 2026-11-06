import {readFileSync} from 'node:fs';
import {resolve, relative, isAbsolute} from 'node:path';

// 覆盖面只留 `知识/`。
//   不收「我是谁 / 人物对照表 / 决策记录」这三个：它们的内容主要是主人口述的事实和决定，
//   证据只能引助手自己刚写的接力——把同一句话抄两遍，第二遍叫「证据」，验证不了任何东西。
//   这道门留在真出过事的地方：把一个四人样本写成市场规律，就发生在 `知识/` 下的方法文件里。
//   那三个文件仍受「来源标记」（记忆规则第十节）和硬否决约束，不是没人管。
export const LONG_TERM_PATH = /^知识\/.*\.md$/;

const ymd = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function validateAdmission(record, heading, readEvidence, today = ymd(new Date())) {
  const errors = [];
  if (!['fact', 'observation', 'method', 'safety', 'index', 'correction'].includes(record.kind)) errors.push('准入类型无效');
  if (!record.scope?.trim() || !record.limitations?.trim()) errors.push('须说明适用范围与局限');
  // B：小节每次被改，asof 必须是当天。没有这一条，准入就是「一次性过路费」——
  // 第一次写 JSON 过关，之后往同一小节里加什么都永远绿灯，而出事的通常是第 N 笔。
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.asof || '')) errors.push('须写 asof（本次改动当天的日期）');
  else if (record.asof !== today) errors.push(`asof 是 ${record.asof}，本次改动在 ${today}：改这一节就要重新看一遍准入依据，把 asof 改成当天`);
  if (!Array.isArray(record.evidence) || !record.evidence.length) return [...errors, '须提供可定位证据'];
  for (const evidence of record.evidence) {
    if (typeof evidence.file !== 'string' || /(?:answers|key|答案)\.sealed/i.test(evidence.file) ||
        !evidence.quote?.trim() || !evidence.case?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.date || '')) {
      errors.push('证据须含安全路径、原文定位、实例编号和日期'); continue;
    }
    try { if (!readEvidence(evidence.file).includes(evidence.quote)) errors.push(`证据原文未找到：${evidence.file}`); }
    catch { errors.push(`无法读取证据：${evidence.file}`); }
  }
  if (record.kind === 'method') {
    if (new Set(record.evidence.map(e => e.case)).size < 3 ||
        new Set(record.evidence.map(e => `${e.file}\n${e.quote}`)).size < 3 ||
        new Set(record.evidence.map(e => e.date)).size < 2) {
      errors.push('方法须至少三个独立实例、跨两个日期；不足时记录为待验证观察');
    }
    if (!record.counterexamples?.trim()) errors.push('方法须说明反例检查');
  }
  if (record.kind === 'observation' && !/观察|待验证|假设/.test(heading)) errors.push('观察标题须明确待验证性质');
  if (record.kind === 'safety' && !record.exception?.trim()) errors.push('安全例外须说明单次高损失理由');
  return errors;
}

// 只验证本次有新增正文的二级小节，不强制重做历史全库。
export function checkAdmissions(file, body, addedLineNumbers, root = process.cwd(), today = ymd(new Date())) {
  if (!LONG_TERM_PATH.test(file)) return [];
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = {heading:'文件开头', start:1, lines:[]};
  for (let i = 0; i < lines.length; i++) {
    if (/^## /u.test(lines[i])) { sections.push(current); current = {heading:lines[i], start:i+1, lines:[]}; }
    current.lines.push(lines[i]);
  }
  sections.push(current);
  const readEvidence = file => {
    const full = resolve(root, file);
    const rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('证据越界');
    return readFileSync(full, 'utf8').replace(/<!-- memory-admission:[\s\S]*?-->/g, '');
  };
  const errors = [];
  for (const section of sections) {
    const end = section.start + section.lines.length;
    const touched = addedLineNumbers.some(n => n >= section.start && n < end && lines[n-1]?.trim() && !/^---\s*$/.test(lines[n-1]));
    if (!touched) continue;
    const metadata = section.lines.join('\n').match(/<!-- memory-admission:\s*(\{[^\n]*\})\s*-->/);
    if (!metadata) { errors.push(`${file} ${section.heading}：缺 memory-admission 准入说明`); continue; }
    try {
      for (const error of validateAdmission(JSON.parse(metadata[1]), section.heading, readEvidence, today)) errors.push(`${file} ${section.heading}：${error}`);
    } catch { errors.push(`${file} ${section.heading}：准入说明不是合法 JSON`); }
  }
  return errors;
}
