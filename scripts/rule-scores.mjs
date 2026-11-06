// 提交检查与报告共用解析器。展示格式不承载状态；未知/部分命中不会算成功。
//
// [改] 原版把主人名写死在正则和计分表里。现在从 profile.mjs 取，代码里只剩 `OWNER`。
// 教训留在注释里就够：这一侧新增接力方时，必须连识别表一起改——
// 「登记在册 ≠ 接进门禁」这件事，一个人踩过两次。
import {OWNER, HANDOFF_SIDES, ARCHIVED_SIDES, ownerPattern} from './profile.mjs';

// 识别「这是一份接力」时要把**已停用的侧**也算进来：Claude 侧 2026-10-20 就停了，
// 但历史文件还在库里。少了它，开场找「最新一份接力」会跳过 10-20 之前的 claude 文件，
// 把更早的 codex 那份当成最新——错得还很安静。
const sides = [...HANDOFF_SIDES, ...ARCHIVED_SIDES].join('|');
export const HANDOFF_NAME = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})(?:_\\d{4})?_(?:${sides})\\.md$`);

export function plainCell(value) {
  return value.replace(/~~.*?~~/g, '').replace(/[*`_]/g, '').trim();
}

export function classifyHit(value) {
  const text = plainCell(value).replace(/^[🔴🟡🟢⚠️\s]+/u, '').trim();
  if (/^(?:本轮)?无触发/.test(text)) return 'none';
  if (/^(?:部分|险些|差点|未标注|未知|待判)/.test(text)) return 'unknown';
  if (/^(?:否|❌|未命中|没有命中|没命中|漏|违反|实际是否)/.test(text)) return 'miss';
  if (/^(?:是|✅|命中)/.test(text)) return 'hit';
  return 'unknown';
}

// 同一条规则在不同接力里被写成不同名字，汇总因此看不出它反复未命中。
// 别名表只合并逐条核对过的同义写法；认不出的仍按原名单列，不猜。
export const RULE_ALIASES = [
  ['接收方约束', /接收方|要不要\s*(?:他|我)\s*动手|需不需要他动手|需要他动手|他动手|我自己做掉/],
  ['身份与场合要证据', /场景描述|开头那句场景|身份和场合|身份\/场合|身份断言|某某说|说话人/],
  ['改动前检查作用范围', /改动前.*(作用范围|先问|问走法)|作用范围/],
  ['不做回音壁', /回音壁/],
  ['单次观察不许写成绝对句', /单次观察|绝对句/],
  ['一个小节只装一种证据强度', /证据强度/],
  ['接力须有规则计分节', /规则计分|计分.*节/],
  ['功能存不存在要先问', /功能到底存不存在|第三次换写法|连续两次没打中/],
  ['L3 分层写入', /^L3/],
  ['来源标记', /来源标记|记忆规则第十节/],
];

export function normalizeRule(value) {
  const t = plainCell(value).replace(/^[^A-Za-z一-鿿]+/, '');
  const l2 = t.match(/\bL2-\d+\b/);
  if (l2) return l2[0];
  if (/固定条|日期与区间|日期固定/.test(t)) return '固定条';
  if (/硬否决|不许编造事实/.test(t)) return '硬否决';
  for (const [canonical, pattern] of RULE_ALIASES) if (pattern.test(t)) return canonical;
  return t.split(/[：:（(]/)[0].slice(0, 40) || '(未写规则名)';
}

// 「谁发现的」这一列：主人、各接力侧、钩子/脚本、助手自己。
export function classifyFinder(value) {
  const t = plainCell(value);
  if (ownerPattern('i').test(t)) return OWNER;
  if (/codex/i.test(t)) return 'Codex';
  if (/dsh/i.test(t)) return 'dsh';
  if (/workbuddy/i.test(t)) return 'WorkBuddy';
  if (/kimi/i.test(t)) return 'Kimi';
  if (/钩子|hook|memory-check|pre-commit|脚本|回归|gateway|网关/i.test(t)) return '钩子/脚本';
  if (/自己|自检|本轮|我|助手/.test(t)) return '自己';
  return t || '(未写)';
}

// 别名为「接收方约束」的那条规则，历史上用过主人名做判断词；保留兼容。
export function isOwnerFinder(finder) {
  return finder === OWNER;
}

export function parseScores(body) {
  const sections = [...body.matchAll(/^##\s*规则计分[^\n]*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)];
  const rows = [];
  let noTrigger = false;
  for (const section of sections) {
    noTrigger ||= /本轮无触发|一条都没触发/.test(section[1]);
    let columns = [0, 1, 2, 3];
    for (const line of section[1].split(/\r?\n/)) {
      if (!/^\s*\|/.test(line) || /^\s*\|[\s|:-]*\|\s*$/.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(plainCell);
      if (cells.some(c => /^(是否命中|命中|是否遵守)$/.test(c)) &&
          cells.some(c => /谁发现|发现者/.test(c))) {
        columns = [cells.findIndex(c => /触发|规则/.test(c)),
          cells.findIndex(c => /^(是否命中|命中|是否遵守)$/.test(c)),
          cells.findIndex(c => /谁发现|发现者/.test(c)),
          cells.findIndex(c => /拦下|拦截/.test(c))];
        continue;
      }
      if (cells.length < 4 || /触发的?\s*(L2|规则)|触发机会|是否命中/.test(cells[0])) continue;
      const raw = columns.map((column) => cells[column] || '');
      const status = classifyHit(raw[1]);
      if (status === 'none') { noTrigger = true; continue; }
      rows.push({rule: normalizeRule(raw[0]), status,
        hit: status === 'hit' ? true : status === 'miss' ? false : null,
        finder: classifyFinder(raw[2]), blocked: classifyHit(raw[3]) === 'hit', raw});
    }
  }
  return {hasSection: sections.length > 0, rows, noTrigger};
}

export function correctionCoverage(body, regressions) {
  if (!parseScores(body).rows.some(row => isOwnerFinder(row.finder) && row.hit === false)) return [];
  const ids = [...body.matchAll(/回归案例[：:]\s*`?([a-z0-9-]+)/g)].map(m => m[1]);
  if (!ids.length) return [`${OWNER} 发现的未命中须在接力写「回归案例：<id>」并补入回归案例.jsonl`];
  return ids.filter(id => !regressions.some(c => c.id === id)).map(id => `回归案例不存在：${id}`);
}
