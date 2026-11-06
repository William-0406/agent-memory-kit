import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {OWNER, ownerPattern} from './profile.mjs';

// 「这份材料是谁的」从文字规则改成提交检查。
//   三次实测都由主人发现：编了一顿饭、说话人 1 默认成主人（实为另一个人）、别人的截图当成主人的。
//   规则钉在热点第 1 位也没拦住——犯的时候不觉得自己在断言身份。
//   所以不靠想起来：谁引用了一份转写，谁就得先让那份转写开头有「说话人对照」。
//   `语料/录音转写/` 默认不进 Git（含第三方隐私），对照表写在转写开头，检查在提交时读本机原件。
//   ⚠️ 只管已归档、被引用的转写；对话里当场发来的截图 / 材料，提交检查看不到，仍靠热点第 1 位。

export const TRANSCRIPT_DIR = '语料/录音转写';
const CITE = /\[源:转写\s*(\d{4}-\d{2}-\d{2})(_[^\s\]，,]+)?[^\]]*\]/g;
// 句子把话算在主人头上：这是最容易出错的一种形状。
const OWNER_SAID = new RegExp(
  `${OWNER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:在电话里|当场|电话里|原话|亲口|自己)?\\s*(?:说|问|讲|提到|表示|原话|回)`
);

// 解析开头的「说话人对照」一行：`说话人 1 = 某人 [源:我 2026-09-16] ｜ 说话人 2 / 说话人 3 = 客户方 [待查]`
export function parseSpeakerMap(text) {
  const lines = text.split(/\r?\n/);
  const bodyStart = lines.findIndex(l => /^说话人\s*\d+\s+\d{1,2}:\d{2}/.test(l));
  const head = lines.slice(0, bodyStart < 0 ? 60 : bodyStart);
  const mapLine = head.find(l => l.includes('说话人对照'));
  const speakers = new Set();
  for (const l of lines.slice(Math.max(bodyStart, 0))) {
    const m = l.match(/^说话人\s*(\d+)\s+\d{1,2}:\d{2}/);
    if (m) speakers.add(m[1]);
  }
  if (!mapLine) return {found: false, speakers, entries: new Map()};
  const entries = new Map();
  for (const seg of mapLine.replace(/^.*?说话人对照[^：:]*[：:]/, '').split(/[｜|]/)) {
    const eq = seg.search(/[=＝]/);
    if (eq < 0) continue;
    const who = seg.slice(eq + 1).trim();
    for (const n of seg.slice(0, eq).matchAll(/说话人\s*(\d+)/g)) entries.set(n[1], who);
  }
  return {found: true, speakers, entries};
}

export function mapProblems(name, text) {
  const {found, speakers, entries} = parseSpeakerMap(text);
  if (!found) return [`${name} 开头没有「说话人对照」`];
  const errors = [];
  for (const n of speakers) {
    const who = entries.get(n);
    if (!who) errors.push(`${name}：说话人 ${n} 没写是谁`);
    else if (/\[推:/.test(who)) errors.push(`${name}：说话人 ${n} 是推出来的——身份不许靠推，问不到就写 [待查]`);
    else if (!/\[源:|\[待查\]/.test(who)) errors.push(`${name}：说话人 ${n} = ${who} 没写依据（[源:谁 日期] 或 [待查]）`);
  }
  return errors;
}

const isOwner = who => new RegExp(`^\\**\\s*${OWNER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`).test(who);

// addedByFile: {file: [新增行文本]}。返回需要拦下的问题。
export function checkSpeakerMaps(addedByFile, root = process.cwd()) {
  const dir = join(root, TRANSCRIPT_DIR);
  const all = existsSync(dir) ? readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}_.*\.md$/.test(f)) : [];
  const hard = [], soft = [], seen = new Map();
  const load = name => {
    if (!seen.has(name)) {
      const text = readFileSync(join(dir, name), 'utf8');
      seen.set(name, {problems: mapProblems(name, text), entries: parseSpeakerMap(text).entries});
    }
    return seen.get(name);
  };
  for (const [file, added] of Object.entries(addedByFile)) {
    // 归档是旧记录原样搬家，不是新写的引用（日期检查也豁免 归档/）；拦它等于不许归档。
    if (file.startsWith(TRANSCRIPT_DIR) || file.startsWith('归档/')) continue;
    for (const text of added) {
      // 行内代码里的是在讨论标记本身（规则文件的示例），不算引用；`转写x` 是另一种标记（微信 / ChatGPT 语料），不管。
      const live = text.replace(/`[^`]*`/g, '');
      // 不带日期就对不上是哪份转写，这道检查会被静默绕过（记忆规则本就要求带日期）。
      if (/\[源:转写(?!x)(?!\s*\d{4}-\d{2}-\d{2})/.test(live)) {
        hard.push(`${file}：转写来源没带日期，核不了说话人对照——写成 [源:转写 YYYY-MM-DD]：\n      ${text.trim().slice(0, 120)}`);
      }
      for (const m of live.matchAll(CITE)) {
        const [, date, suffix] = m;
        const targets = all.filter(f => f.startsWith(date + (suffix || '')));
        if (!targets.length) { soft.push(`${file}：引用了 ${date} 的转写，但本机 ${TRANSCRIPT_DIR}/ 里找不到，没法核说话人对照`); continue; }
        const problems = [...new Set(targets.flatMap(t => load(t).problems))];
        if (problems.length) {
          hard.push(`${file} 引用了 ${date} 的转写，先写说话人对照再引用（这份材料是谁的）：\n      ` +
            problems.join('\n      ') +
            `\n      → 在转写开头加一行「> 说话人对照：说话人 1 = 某某 [源:${OWNER} 日期] ｜ 说话人 2 = [待查]」。不知道就写 [待查] 或问 ${OWNER}，不许贴一个合理的人。`);
          continue;
        }
        if (OWNER_SAID.test(text) && !targets.some(t => [...load(t).entries.values()].some(isOwner))) {
          hard.push(`${file}：这句把话算在 ${OWNER} 头上，但 ${date} 转写的说话人对照里没有 ${OWNER}——这类错最常见的形状是把别人的话记成他的：\n      ${text.trim().slice(0, 120)}`);
        }
      }
    }
  }
  return {hard: [...new Set(hard)], soft: [...new Set(soft)]};
}
