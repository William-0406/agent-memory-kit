#!/usr/bin/env node
// 从原文件即时生成开场入口，不维护第二份事实摘要。
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildIndex, compileContext, formatContext} from './memory-gateway.mjs';
import {extractTurnRules} from './turn-rules.mjs';
import {HANDOFF_NAME} from './rule-scores.mjs';
import {OWNER} from './profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STARTUP_LIMIT = 18000;
export const FOLLOWUP_RESERVE = 2000;
export const STARTUP_GATEWAY_LIMIT = 9000;

// 开场必读的《我是谁》三节。缺了不炸——新人装完第一次跑时这三节通常还是空的。
export const PROFILE_SECTIONS = ['基本', '沟通偏好', '他要这东西成为什么'];

function sections(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  for (let i=0; i<lines.length; i++) {
    if (!/^## /.test(lines[i])) continue;
    let end = i+1;
    while (end < lines.length && !/^## /.test(lines[end])) end++;
    out.push({title:lines[i].slice(3), line:i+1, text:lines.slice(i,end).join('\n').trim()});
  }
  return out;
}

export function todoIndex(body) {
  let heading = '';
  const entries = [];
  for (const [i,line] of body.split(/\r?\n/).entries()) {
    if (/^#{2,3} /.test(line)) heading = line.replace(/^#+ /,'');
    if (!/^- \[ \]/.test(line)) continue;
    // 只认紧跟在日期、标记图标之后的加粗为标题。否则行中间的状态词（「⏰**已逾期**」）
    // 会顶替标题，目录里只剩「已逾期」，看不出是哪件事。
    const rest = line.replace(/^- \[ \]\s*/, '');
    const lead = rest.replace(/^(?:\[\d{4}-\d{2}-\d{2}\]|[^\p{L}\p{N}\s*\[（(`]+|\s)+/u, '');
    const bold = lead.match(/^\*\*(.+?)\*\*/)?.[1];
    const label = (bold || rest.replace(/\*\*/g, '')).replace(/\|/g,'／');
    entries.push(`- 待办与承诺.md:${i+1} · ${heading.split('（')[0].slice(0,25)} · ${label.slice(0,110)}${label.length>110?'…（标题截短）':''}`);
  }
  return `## 待办目录（${entries.length} 项）\n\n仅为定位标题；处理任何事项前打开对应完整条目，确认条件、证据和更新。暂停档不进开场；用户恢复某单时再读取。\n\n${entries.join('\n')}`;
}

function recentNotes(body, file) {
  const lines = body.split(/\r?\n/);
  const starts = [];
  for (let i=0; i<lines.length; i++) {
    if (!/^(?:- |#{2,3} )/.test(lines[i])) continue;
    const date = lines[i].match(/\[?(20\d{2}-\d{2}-\d{2})\]?/)?.[1];
    if (date) starts.push({i,date});
  }
  return starts.sort((a,b)=>b.date.localeCompare(a.date)||b.i-a.i).slice(0,3).map(({i})=> {
    let end = i+1;
    while (end<lines.length && !/^(?:- |#{2,3} )/.test(lines[end])) end++;
    return {file, line:i+1, text:lines.slice(i,end).join('\n').trim()};
  });
}

function latestHandoff(root) {
  const dir = join(root,'交接');
  if (!existsSync(dir)) return undefined;
  const files = [];
  for (const month of readdirSync(dir).filter(x=>/^\d{4}-\d{2}$/.test(x))) {
    for (const name of readdirSync(join(dir,month))) {
      if (HANDOFF_NAME.test(name)) files.push({file:`交接/${month}/${name}`});
    }
  }
  // [2026-11-09] 原按 mtime 排序，会踩一个很隐晦的坑：**改任何旧接力都会让它变成"最新"**，
  // 于是开场读到的是被订正的旧接力，今天那份反倒被顶掉，状态直接过期。
  // 接力文件名本身就带 `YYYY-MM-DD_HHmm`，**按文件名排序才是它真实的写作时序**。
  // mtime 只反映"谁最后被碰过"，不反映"谁是最后写的"。
  return files.sort((a,b)=>b.file.localeCompare(a.file))[0]?.file;
}

// 每日简报原来靠外部定时任务，任务停掉后就断了。改成「当天第一次开场补发」：
// 开场直接把今天发没发摆出来，各侧看到未发就先补一份，不依赖任何定时任务、也不依赖谁记得。
export function dailyStatus(root = ROOT, now = new Date()) {
  const pad = n => String(n).padStart(2,'0');
  const today = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const weekday = '日一二三四五六'[now.getDay()];
  const month = today.slice(0,7);
  const hasToday = file => {
    try { return new RegExp(`^##\\s*${today}`,'m').test(readFileSync(join(root,file),'utf8')); }
    catch { return false; }
  };
  return {
    today, weekday,
    briefFile: `生活/简报/${month}.md`,
    briefSent: hasToday(`生活/简报/${month}.md`),
    logFile: `生活/日志/${month}.md`,
    logWritten: hasToday(`生活/日志/${month}.md`),
  };
}

// 读一个开场源文件；不存在时返回 undefined 而不是抛错。
// 安装前的空仓库、或用户删掉了某一层，都不该让开场整体崩掉。
// [兜底] 还没 init 时，这些文件只存在于 templates/ 里（新克隆下来就是这样）。
//   与 scripts/turn-context.mjs 同一套兜底：读模板而不是崩。
//   只在跑的是本仓库自己（root === ROOT）时兜底，指定了别的 root 时不去猜。
function optional(root, file) {
  const candidates = root === ROOT ? [join(root, file), join(ROOT, 'templates', file)] : [join(root, file)];
  for (const p of candidates) {
    try { if (existsSync(p)) return readFileSync(p,'utf8'); } catch { /* 换下一个候选 */ }
  }
  return undefined;
}

export function openingSources(root = ROOT) {
  const parts = [];
  // 装好之后读根目录的 AGENTS.md；还没装（仓库里只有 templates/）时读模板。
  // 与 scripts/turn-context.mjs 同一套兜底：否则在仓库里试跑、或新克隆还没 init 时，
  // 开场会直接抛错——而这正是别人第一次用它的时刻，最不该崩的地方。
  const agents =
    optional(root, 'AGENTS.md') ??
    (root === ROOT ? optional(ROOT, 'templates/AGENTS.md') : undefined);
  if (agents === undefined) throw new Error('缺 AGENTS.md——这是每轮规则的唯一副本，没有它就没有开场。先运行 node scripts/init.mjs');
  parts.push({file:'AGENTS.md', line:1, text:extractTurnRules(agents)});

  const todo = optional(root,'待办与承诺.md');
  if (todo !== undefined) parts.push({file:'待办与承诺.md', line:1, text:todoIndex(todo)});

  // [改] 三节缺失原来是 throw，导致任何新装的人第一次跑就崩。现在缺哪节就提示哪节，不中断。
  const profileBody = optional(root,'我是谁.md');
  if (profileBody === undefined) {
    parts.push({file:'我是谁.md', line:1, text:`还没有 \`我是谁.md\`。新建一份，写清三节：${PROFILE_SECTIONS.map(s=>`「${s}」`).join('')}。\n内容为空时写 \`[缺：姓名]\` 这类占位，不要编。`});
  } else {
    const profile = sections(profileBody);
    const missing = [];
    for (const title of PROFILE_SECTIONS) {
      const part = profile.find(p=>p.title === title);
      if (part) parts.push({file:'我是谁.md', ...part});
      else missing.push(title);
    }
    if (missing.length) parts.push({file:'我是谁.md', line:1,
      text:`⚠️ 还缺开场小节：${missing.map(s=>`「${s}」`).join('')}。这节空着，${OWNER} 的偏好和长期目标就没法在开场带上——补上再继续，别猜。`});
  }

  const corrections = optional(root,'纠错记录.md');
  if (corrections !== undefined) parts.push(...recentNotes(corrections, '纠错记录.md'));

  // 接力操作约定只读当前原则和写入触发，格式在需要写接力时下钻。
  const handoffRules = optional(root,'接力规则.md');
  if (handoffRules !== undefined) {
    for (const part of sections(handoffRules).filter(p=>/^一、|^三、/.test(p.title))) parts.push({file:'接力规则.md',...part});
  }

  const handoff = latestHandoff(root);
  if (handoff) {
    const all = sections(readFileSync(join(root,handoff),'utf8'));
    const current = all.filter(p=>p.title === '当前状态');
    const selected = current.length ? current : all.filter(p=>/还没解决|下一个助手|下一步/.test(p.title));
    if (!selected.length) parts.push({file:handoff,line:1,text:'最新接力未设状态小节。按目录下钻，不推断已完成或未完成。\n'+all.map(p=>`- ${handoff}:${p.line} ${p.title}`).join('\n')});
    else parts.push(...selected.map(part=>({file:handoff,...part})));
  }
  return parts;
}

export function startupBudget(root = ROOT) {
  const sources = openingSources(root);
  const text = sources.map(p=>`### 原文定位：${p.file}:${p.line}\n\n${p.text}`).join('\n\n');
  // 网关按完整规则优先适配本入口配额；另留 500 字符给包头。
  const ceiling = text.length + STARTUP_GATEWAY_LIMIT + 500;
  return {text, sources, sourceChars:text.length, ceiling, limit:STARTUP_LIMIT, followupReserve:FOLLOWUP_RESERVE};
}

export function renderStartup(query, root = ROOT, index = buildIndex()) {
  const budget = startupBudget(root);
  if (budget.ceiling > STARTUP_LIMIT) throw new Error(`开场上限估算 ${budget.ceiling} 超过 ${STARTUP_LIMIT}；请压缩入口而非整篇追加读取`);
  const context = formatContext(compileContext(index,query,{maxContextChars:STARTUP_GATEWAY_LIMIT}));
  const day = dailyStatus(root);
  const dayline = `**今天 ${day.today}（周${day.weekday}）** · 简报：${day.briefSent ? '已发' : `未发 → 先补一份，写完在 \`${day.briefFile}\` 记一条 \`## ${day.today}\`（规则见 记忆规则.md 第八节）`} · 日志：${day.logWritten ? '已写' : '未写'}\n\n`;
  const text = `# 开场上下文\n\n本包从原文件生成。待办目录为路由，其余按原文保留；引用结论仍须检查当前证据。\n总预算 20000 字符（含标点与格式），本包上限 ${STARTUP_LIMIT}，预留 ${FOLLOWUP_RESERVE} 给项目状态/按需核对；追加读取须计入余量，必要的深查另行说明。\n\n${dayline}${budget.text}\n\n${context}`;
  if (text.length > STARTUP_LIMIT) throw new Error(`实际开场包 ${text.length} 超过 ${STARTUP_LIMIT}`);
  return {text, chars:text.length, ceiling:budget.ceiling, remaining:20000-text.length};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--check')) {
      const {sourceChars,ceiling,limit}=startupBudget();
      console.log(`开场预算：固定读取 ${sourceChars} 字符 + 网关上限 ${STARTUP_GATEWAY_LIMIT} + 包头余量 500 = ${ceiling} / ${limit}；另留 2000 给下钻。`);
      if (ceiling>limit) process.exitCode=1;
    } else {
      const at=process.argv.indexOf('--query');
      if(at<0||!process.argv[at+1]) throw new Error('需要 --query 本轮原话及必要上文');
      const result=renderStartup(process.argv[at+1]);
      console.log(result.text+`\n\n实际 ${result.chars} 字符；开场剩余 ${result.remaining} 字符。`);
    }
  } catch(error) { console.error(`开场检查失败：${error.message}`); process.exitCode=1; }
}
