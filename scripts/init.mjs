#!/usr/bin/env node
// 安装器。目标：一条命令跑完，不提问、不卡住、不覆盖已有内容。
//   node scripts/init.mjs --owner "张三"
//   node scripts/init.mjs                  # 没给 --owner 才交互提问
//
// 设计约束（很重要，别改）：
//  1. 幂等：重复跑只跳过，不报错、不破坏已有内容。
//  2. 非破坏：永不删除、永不覆盖已有文件，除非显式 --force。
//  3. 任何一步失败都不中断安装，最后统一汇总。
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(ROOT, 'templates');
const CONFIG = join(ROOT, 'config', 'profile.json');

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

const FORCE = flag('force');
// 用户明确给了 --owner 才算「他要这个名字」。区分它和缺省值很关键：
// 仓库自带的 config/profile.json 里 owner 是 "我"，那是给没填的人兜底的默认值；
// 如果不加区分，合并时旧值会把用户刚填的名字盖掉，装完称呼永远是「我」。
const EXPLICIT_OWNER = Boolean(value('owner'));
const NON_INTERACTIVE = EXPLICIT_OWNER || flag('yes') || !process.stdin.isTTY;

const created = [], skipped = [], failed = [];
const note = (list, msg) => list.push(msg);

function mkdir(rel) {
  const p = join(ROOT, rel);
  if (existsSync(p)) { note(skipped, `目录已存在：${rel}`); return; }
  try { mkdirSync(p, {recursive: true}); note(created, `目录：${rel}`); }
  catch (e) { note(failed, `建目录失败 ${rel}：${e.message}`); }
}

function put(rel, content) {
  const p = join(ROOT, rel);
  if (existsSync(p) && !FORCE) { note(skipped, `已有内容，跳过：${rel}`); return; }
  try {
    mkdirSync(dirname(p), {recursive: true});
    // 生成的占位文件也过一次 fill()：以后往里加带 {owner} 的说明不会被漏掉。
    writeFileSync(p, fill(content), 'utf8');
    note(created, `文件：${rel}`);
  } catch (e) { note(failed, `写文件失败 ${rel}：${e.message}`); }
}

// 模板里用 {owner} / {timezone} 占位，装的时候替换成配置里的值。
function fill(text) {
  return text
    .replace(/\{owner\}/g, () => owner)
    .replace(/\{timezone\}/g, () => timezone);
}

function copyTemplate(name, destRel = name) {
  const src = join(TEMPLATES, name);
  const dest = join(ROOT, destRel);
  if (!existsSync(src)) { note(failed, `模板缺失：templates/${name}`); return; }
  if (existsSync(dest) && !FORCE) { note(skipped, `已有内容，跳过：${destRel}`); return; }
  try {
    mkdirSync(dirname(dest), {recursive: true});
    writeFileSync(dest, fill(readFileSync(src, 'utf8')), 'utf8');
    note(created, `文件：${destRel}`);
  } catch (e) { note(failed, `复制失败 ${destRel}：${e.message}`); }
}

// ── 1. Node 版本 ────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`\n需要 Node.js 18 或更高版本，当前是 ${process.versions.node}。`);
  console.error('去 https://nodejs.org 下载 LTS 版本，装完重开终端再跑这条命令。\n');
  process.exit(2);
}

// ── 2. 主人称呼 ────────────────────────────────────────────────
let owner = value('owner');
if (!owner && existsSync(CONFIG)) {
  try { owner = JSON.parse(readFileSync(CONFIG, 'utf8')).owner; } catch { /* 坏配置当没有 */ }
}
if (!owner && !NON_INTERACTIVE) {
  const {createInterface} = await import('node:readline/promises');
  const rl = createInterface({input: process.stdin, output: process.stdout});
  const answer = (await rl.question('这套记忆库主要给谁用？填一个称呼（如「张三」「老张」，直接回车用「我」）：')).trim();
  rl.close();
  owner = answer || undefined;
}
owner = owner && owner.trim() ? owner.trim() : '我';

// 时区：有配置沿用，否则取系统
let timezone = existsSync(CONFIG) ? (() => { try { return JSON.parse(readFileSync(CONFIG, 'utf8')).timezone; } catch { return undefined; } })() : undefined;
timezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';

let sides = ['codex', 'kimi', 'workbuddy', 'dsh'];
if (existsSync(CONFIG)) {
  try {
    const prev = JSON.parse(readFileSync(CONFIG, 'utf8'));
    if (Array.isArray(prev.handoffSides) && prev.handoffSides.length) sides = prev.handoffSides;
  } catch { /* 坏配置用默认 */ }
}

// ── 3. 配置文件 ────────────────────────────────────────────────
const configBody = {
  _说明: '这是本记忆库的配置文件。改这里就能改掉所有脚本里用到的人名和时区，不用动代码。',
  owner, timezone, handoffSides: sides, lang: 'zh',
};
if (existsSync(CONFIG) && !FORCE) {
  // 已存在时只补缺失字段，不覆盖用户改过的值。
  // 🔴 但 --owner 是「用户刚刚亲口说的」，优先级最高，必须盖过旧值：
  //    旧写法 {...configBody, ...prev} 里 prev 在后，会把新 owner 整个吃掉，
  //    于是装完 config 还是「我」，而模板已按新名字渲染，两边永久不一致。
  try {
    const prev = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const merged = {...configBody, ...prev};
    if (EXPLICIT_OWNER) merged.owner = owner;
    if (JSON.stringify(merged, null, 2) !== JSON.stringify(prev, null, 2)) {
      writeFileSync(CONFIG, JSON.stringify(merged, null, 2) + '\n', 'utf8');
      note(created, EXPLICIT_OWNER ? `配置：config/profile.json（owner=${owner}）` : '配置：补齐缺失字段 config/profile.json');
    } else note(skipped, '配置已是最新：config/profile.json');
  } catch {
    writeFileSync(CONFIG, JSON.stringify(configBody, null, 2) + '\n', 'utf8');
    note(created, '配置：修正损坏的 config/profile.json');
  }
} else {
  mkdirSync(dirname(CONFIG), {recursive: true});
  writeFileSync(CONFIG, JSON.stringify(configBody, null, 2) + '\n', 'utf8');
  note(created, `配置：config/profile.json（owner=${owner}，时区=${timezone}）`);
}

// ── 4. 目录 ────────────────────────────────────────────────────
const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
for (const d of [
  '交接', `交接/${month}`, '工作', '知识',
  '生活/日志', '生活/简报', '记忆网关', '记忆网关/运行时', '归档', '语料',
]) mkdir(d);

// ── 5. 模板 ────────────────────────────────────────────────────
const ROOT_TEMPLATES = [
  'AGENTS.md', '我是谁.md', '待办与承诺.md', '纠错记录.md', '人物对照表.md',
  '决策记录.md', '助手侧记.md', '记忆规则.md', '自检规则.md', '接力规则.md',
];
for (const name of ROOT_TEMPLATES) copyTemplate(name);

// 网关需要一个空回归案例文件，否则 --check 会报缺文件
put('记忆网关/回归案例.jsonl', '');
put('记忆网关/L3审阅.json', JSON.stringify({version: 1, reviewedThrough: '', handoff: '', files: [], outcome: 'no-qualified-content', reason: '安装时占位；首次真实 L3 审阅后按格式改写'}, null, 2) + '\n');

// 生活日志/简报当月起一份，让开场能读到
put(`生活/日志/${month}.md`, `# ${month} 日志\n\n> 每次会话收尾写一条，格式 \`## YYYY-MM-DD\`。\n`);
put(`生活/简报/${month}.md`, `# ${month} 简报\n\n> 每天第一次开场时若显示「简报未发」，在这里补一条 \`## YYYY-MM-DD\`。\n`);

// ── 6. 提示 git ───────────────────────────────────────────────
const hasGit = existsSync(join(ROOT, '.git'));

// ── 7. 报告 ────────────────────────────────────────────────────
const line = '─'.repeat(56);
console.log(`\n${line}\n安装完成\n${line}`);
if (created.length) { console.log('\n已创建：'); for (const m of created) console.log(`  + ${m}`); }
if (skipped.length) { console.log('\n已跳过（不覆盖已有内容）：'); for (const m of skipped) console.log(`  · ${m}`); }
if (failed.length) {
  console.log('\n⚠️ 失败：');
  for (const m of failed) console.log(`  ! ${m}`);
  console.log('\n这些失败不会损坏已装好的部分，修掉上面列出的原因后可以重跑本命令。');
}

console.log(`\n${line}\n下一步\n${line}`);
console.log(`1. 验证开场能跑：  node scripts/memory-startup.mjs --check`);
console.log(`2. 看一眼实际开场：node scripts/memory-startup.mjs --query "你好"`);
if (!hasGit) {
  console.log(`3. 建议建个 Git 仓库（提交检查依赖它）：`);
  console.log(`     git init && git add . && git commit -m "初始化记忆库"`);
} else {
  console.log(`3. Git 仓库已存在，启用提交检查：`);
  console.log(`     git config core.hooksPath .githooks`);
}
console.log(`4. 让 AI 助手读一遍 AGENTS.md，之后每次开工它会自己走开场流程。`);
console.log(`\n想改称呼或时区：编辑 config/profile.json，不用改代码。\n`);

if (failed.length) process.exitCode = 1;
