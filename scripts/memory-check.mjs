#!/usr/bin/env node
/**
 * 记忆库体检 · 提交前的确定性检查
 *
 * 为什么存在：2026-08-14 证明了「规则写在 自检规则.md 里、触发条件也对，但仍然没被执行」。
 * 手工规则表的上限就在这里。这个脚本把其中**能确定性判定**的那几条搬到提交这个动作上——
 * 不用 LLM、不联网、不影响对话速度。
 *
 * 用法：
 *   node scripts/memory-check.mjs              # 检查已暂存的改动（git add 之后）
 *   node scripts/memory-check.mjs --all        # 检查工作区全部改动（未 add 也算）
 *   STRICT=1 node scripts/memory-check.mjs     # 严重项直接退出码 1（挡住提交）
 *
 * 默认只警告不阻断。想让它真的拦住，把 STRICT=1 写进 .githooks/pre-commit。
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { OWNER, HANDOFF_SIDES } from './profile.mjs';
import { parseScores, correctionCoverage } from './rule-scores.mjs';
import { checkAdmissions } from './memory-admission.mjs';
import { readCommittedReview } from './l3-review.mjs';
import { checkSpeakerMaps } from './speaker-map.mjs';

const STRICT = process.env.STRICT === '1';
const ALL = process.argv.includes('--all');

// 侧别列表来自 config/profile.json；新增一侧只改配置，不用动这里。
// ⚠️ 门禁只认**在用的**侧，不含 ARCHIVED_SIDES：Claude 侧 2026-10-20 已停用，
//    不该有人再新建 `*_claude.md`，历史文件也不补规则计分（当时没有这条规矩）。
const sides = HANDOFF_SIDES.join('|');
const relayNameRe = new RegExp(`(\\d{4}-\\d{2}-\\d{2})_[^/]*_(?:${sides})\\.md$`);
const relayFileRe = new RegExp(`^交接/\\d{4}-\\d{2}/.*_(?:${sides})\\.md$`);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- 工具 ----------
// ⚠️ 这个函数以前是「出错就当空字符串」。结果：不是 git 仓库时 `git diff` 报错 → 返回空
// → 上层判定「本次没有 .md 改动」→ 打印「跳过」→ 退出码 0。**体检一行没查，却报告通过。**
// 静默通过比直接报错危险得多，所以这里记下第一次失败的原因，由调用处决定怎么说。
let gitFailure;
// 🔴 `-c core.quotepath=false` 不是可选项，是中文环境的救命开关。
// git 默认开 quotepath，把非 ASCII 路径输出成 `"\344\272\244\346\216\245/..."` 这种八进制转义。
// 后果不是「看不见改动」——改动条数是对的；**后果是所有按文件名匹配的检查全部静默失效**：
//   · 接力文件名日期（检查 1b①）要匹配 `交接/YYYY-MM/...` → 匹配不上 → **差 1 天也不拦**
//   · 规则计分、回归案例关联、对 owner 的新观察（检查 5）都在 `交接/` 下 → 全部当没看见
// 也就是中文文件名越多，门禁越等于不存在，而且**一行提示都不给**。
// 这个坑在纯英文仓库里永远测不出来（`english.md` 不受影响），所以命令里直接钉死，不依赖用户改 git 配置。
const sh = (c) => {
  try {
    return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    if (!gitFailure) gitFailure = (error?.stderr || error?.message || '').toString().trim();
    return '';
  }
};
const GIT = 'git -c core.quotepath=false';
// 兜底：万一某次输出仍带转义引号（老版本 git、或环境变量覆盖），把 `\ooo` 还原成 UTF-8。
// 有了 GIT 前缀这层通常用不上，但少了它就是「悄悄回到失效状态」，所以留着。
const unquoteGitPath = (line) => {
  if (!line.startsWith('"') || !line.endsWith('"')) return line;
  const body = line.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\' && /[0-7]{3}/.test(body.slice(i + 1, i + 4))) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (body[i] === '\\' && (body[i + 1] === '"' || body[i + 1] === '\\')) {
      bytes.push(body.charCodeAt(i + 1));
      i += 1;
    } else {
      bytes.push(...Buffer.from(body[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
};
const today = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = ymd(today);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

const C = { red: '\x1b[31m', yel: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };
const problems = { hard: [], soft: [], info: [] };

// ---------- 取本次改动 ----------
const diffCmd = ALL ? `${GIT} diff --unified=0 --` : `${GIT} diff --cached --unified=0 --`;
const changedCmd = ALL ? `${GIT} diff --name-only --` : `${GIT} diff --cached --name-only --`;
const changed = sh(`${changedCmd} "*.md"`).split('\n').map(s => unquoteGitPath(s.trim())).filter(Boolean);

// 本次**新建**的文件（检查 1b ① 只对新建的接力文件查文件名日期；往旧接力里补内容不算）
// ⚠️ `--diff-filter` 必须放在 `--` 之前，否则会被当成路径参数（08-26 踩过，导致这一层静默失效）
const newFilesCmd = ALL
  ? `${GIT} diff --name-only --diff-filter=A --`
  : `${GIT} diff --cached --name-only --diff-filter=A --`;
const NEW_FILES = new Set(
  sh(`${newFilesCmd} "*.md"`).split('\n').map(s => unquoteGitPath(s.trim())).filter(Boolean)
);

if (!changed.length) {
  // 分不清「真的没改动」和「git 用不了」是最坏的情况：两种都退出 0，用户以为查过了。
  if (gitFailure) {
    if (STRICT) {
      console.error(`${C.red}记忆库体检没有执行：git 用不了，无法判断本次改了什么。${C.off}`);
      console.error(`${C.dim}${gitFailure.split('\n')[0]}${C.off}`);
      console.error(`${C.dim}确认当前目录是 git 仓库（git status），或先 git init。体检没法盲跑——它靠 diff 找新增行。${C.off}`);
      process.exit(1);
    }
    console.log(`${C.yel}记忆库体检跳过了：git 用不了，判断不出本次改了什么。${C.off}`);
    console.log(`${C.dim}${gitFailure.split('\n')[0]}${C.off}`);
    console.log(`${C.dim}这不是「检查通过」，是「没法检查」。装好 git 并 git init 之后再跑一次。${C.off}`);
    process.exit(0);
  }
  console.log(`${C.dim}记忆库体检：本次没有 .md 改动，跳过。${C.off}`);
  process.exit(0);
}

// 解析 diff，拿到「每个文件新增了哪些行」
// [2026-08-26] 同时记录**行号**（`addedLinesWithNo`）——检查 3 要靠它往上找小节标记，
//   否则只能逐行看，会把「整张表在一个已标记的小节里」全报成缺标记（原卡点 3.1）。
//   `addedByFile` 保持只存行内容不变，其它检查照用。
const addedByFile = {};
const addedLinesWithNo = {};   // file -> [{ text, no }]，no 是**新文件**里的 1-indexed 行号
{
  const raw = sh(`${diffCmd} "*.md"`);
  let cur = null;
  let newLineNo = 0;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) {
      cur = m[1];
      addedByFile[cur] = addedByFile[cur] || [];
      addedLinesWithNo[cur] = addedLinesWithNo[cur] || [];
      continue;
    }
    if (!cur) continue;
    // hunk header：`@@ -a,b +c,d @@` —— c 是这一段在新文件里的起始行号
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { newLineNo = parseInt(h[1], 10); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedByFile[cur].push(line.slice(1));
      addedLinesWithNo[cur].push({ text: line.slice(1), no: newLineNo });
      newLineNo++;
    }
  }
}

// ============================================================
// 长期记忆准入：只检查本次新增正文所在小节，旧库按修改处逐步补齐。
for (const [file, added] of Object.entries(addedLinesWithNo)) {
  if (!existsSync(file)) continue;
  problems.hard.push(...checkAdmissions(file, readFileSync(file, 'utf8'), added.map(row => row.no)));
}

// ============================================================
// 检查 0 · 引用转写前，那份转写得有「说话人对照」（2026-09-23，见 speaker-map.mjs）
{
  const {hard, soft} = checkSpeakerMaps(addedByFile);
  problems.hard.push(...hard);
  problems.soft.push(...soft);
}

// ============================================================
// 检查 0b · 助手侧记上限 30 条（记忆规则第七节）。2026-09-23 前没人数，规则静默失效到 74 条 + 9 节。
// 只在本次改了侧记时拦：满了就在写新条目的这一刻把最旧、最没价值的整条搬进 `归档/`。
if (changed.includes('助手侧记.md') && existsSync('助手侧记.md')) {
  const body = readFileSync('助手侧记.md', 'utf8');
  const n = (body.match(/^- .*\[20\d{2}-\d{2}-\d{2}/gm) || []).length +
            (body.match(/^## .*20\d{2}-\d{2}-\d{2}/gm) || []).length;
  if (n > 30) problems.hard.push(`助手侧记.md 有 ${n} 条（带日期的顶层条目 + 带日期的专题节），上限 30：把最旧、最没价值的整条原样搬进 归档/助手侧记_*.md，别改原文。仍是候选规则实例的留着。`);
}

// 检查 1 · 日期漂移（最重要 —— 2026-08-14 跨午夜那次就是它）
// ============================================================
// 只看「新写内容的自我标注日期」：标题行里的日期，或条目行首的 [YYYY-MM-DD]。
// 排除天然携带历史日期的目录。
//
// 🔴 [2026-08-26] `交接/` 已从整体豁免里拿掉（原卡点 3.4）。
//   原来豁免的理由是接力文件天然引用大量历史日期（「上一份 Claude：2026-08-25_…」「08-19 那次」），
//   全查会淹在误报里。**但豁免整个目录代价太大**：接力文件恰恰是每轮都写、最容易跨天的那一类，
//   08-26 当轮实测——本轮 6 个文件日期全标错，其中 `交接/` 下的 2 个**一条都不会被拦**，
//   纯粹是因为同批还改了 `工作/` 下的文件才捞出来。只改接力的轮次就是全漏。
//
//   现在改成**分路径的窄检查**（见下方检查 1b），只查最强的自我标注信号，不查正文引用。
const DATE_EXEMPT = /^(生活\/日志|语料|归档)\//;
const HANDOFF_DIR = /^交接\//;

for (const [file, lines] of Object.entries(addedByFile)) {
  if (DATE_EXEMPT.test(file)) continue;
  if (HANDOFF_DIR.test(file)) continue;   // → 交给检查 1b
  for (const line of lines) {
    const isHeading = /^#{1,6}\s/.test(line);
    const isEntry = /^\s*[-*]\s*\[?\d{4}-\d{2}-\d{2}\]?/.test(line);
    if (!isHeading && !isEntry) continue;
    // [2026-09-23] 来源标记里的日期是在引用旧证据（`[源:某人 2026-09-21]`），不是给新内容标日期，跳过。
    //   否则回填观察时每条引用近三天的原话都会被当成日期漂移硬拦。
    const selfDated = line.replace(/\[(?:源|推|先验|评):[^\]]*\]/g, '');
    for (const d of selfDated.match(/\d{4}-\d{2}-\d{2}/g) || []) {
      if (d === TODAY) continue;
      const diff = daysBetween(d, TODAY);
      if (diff > 0 && diff <= 3) {
        problems.hard.push(
          `${file}\n    这是本次新写的内容，却标着 ${C.bold}${d}${C.off}，而今天是 ${C.bold}${TODAY}${C.off}（差 ${diff} 天）\n    ${C.dim}${line.trim().slice(0, 90)}${C.off}\n    ${C.dim}→ 跨午夜没重新对时？确认一下。若确实在补记旧内容，忽略本条。${C.off}`
        );
      } else if (diff < 0) {
        problems.hard.push(`${file}\n    出现${C.bold}未来日期${C.off} ${d}（今天 ${TODAY}）\n    ${C.dim}${line.trim().slice(0, 90)}${C.off}`);
      }
    }
  }
}

// ============================================================
// 检查 1b · `交接/` 下的日期（2026-08-26 加 —— 补上原卡点 3.4 的漏）
// ============================================================
// 接力文件正文引用旧日期是正常的，不查。只查两个**必然是"今天"**的位置：
//   ① 接力文件名 `交接/YYYY-MM/YYYY-MM-DD_HHmm_claude.md` 的日期 —— 硬拦
//   ② 新增的一级标题 `# YYYY-MM-DD ...`（接力文件的抬头）—— 硬拦
// 以及一个**很可能是今天**的位置，给软警告（不硬拦，避免误报堵住提交）：
//   ③ 新增行里带"今天做了什么"语气的日期标记：[YYYY-MM-DD 新增/订正/补/建/实测/撤销/加]
for (const [file, lines] of Object.entries(addedByFile)) {
  if (!HANDOFF_DIR.test(file)) continue;

  // ① 文件名日期 —— **只查本次新建的文件**。
  //    往一份旧接力里补内容是正常操作（文件名日期本来就不是今天），查了就是误报。
  // [2026-11-05] 加 dsh：登记在册 ≠ 接进门禁（2026-10-28 加 workbuddy 时立的教训，
  //   一周后自己又犯一次——6 份 dsh 接力从头到尾没过过检查 5）。新增一侧必须连脚本过滤一起改。
  const fnm = file.match(new RegExp(`^交接/\\d{4}-\\d{2}/(\\d{4}-\\d{2}-\\d{2})_\\d{4}_(?:${sides})\\.md$`));
  if (fnm && NEW_FILES.has(file) && fnm[1] !== TODAY) {
    const diff = daysBetween(fnm[1], TODAY);
    if (diff > 0 && diff <= 3) {
      problems.hard.push(
        `${file}\n    接力${C.bold}文件名的日期是 ${fnm[1]}${C.off}，而今天是 ${C.bold}${TODAY}${C.off}（差 ${diff} 天）\n    ${C.dim}→ 跨午夜了？接力文件一轮一份，文件名日期必须是当天。若确在补记旧会话，忽略本条。${C.off}`
      );
    }
  }

  for (const line of lines) {
    // ② 一级标题里的日期（接力抬头 `# 2026-08-26 10:45 · Claude`）
    if (/^#\s/.test(line)) {
      for (const d of line.match(/\d{4}-\d{2}-\d{2}/g) || []) {
        if (d === TODAY) continue;
        const diff = daysBetween(d, TODAY);
        if (diff > 0 && diff <= 3) {
          problems.hard.push(
            `${file}\n    接力抬头标着 ${C.bold}${d}${C.off}，而今天是 ${C.bold}${TODAY}${C.off}（差 ${diff} 天）\n    ${C.dim}${line.trim().slice(0, 90)}${C.off}\n    ${C.dim}→ 跨午夜没重新对时？${C.off}`
          );
        } else if (diff < 0) {
          problems.hard.push(`${file}\n    接力抬头出现${C.bold}未来日期${C.off} ${d}（今天 ${TODAY}）\n    ${C.dim}${line.trim().slice(0, 90)}${C.off}`);
        }
      }
      continue;
    }
    // ③ 「我今天做了什么」语气的日期标记 —— 软警告
    for (const m of line.matchAll(/\[(\d{4}-\d{2}-\d{2})\s*(新增|订正|补|建|实测|撤销|加|拍板|定)/g)) {
      const d = m[1];
      if (d === TODAY) continue;
      const diff = daysBetween(d, TODAY);
      if (diff > 0 && diff <= 3) {
        problems.soft.push(
          `${file}\n    ${C.dim}${line.trim().slice(0, 95)}${C.off}\n    ${C.dim}→ 这个标记读起来像"本轮做的"，却标着 ${d}，而今天是 ${TODAY}。跨午夜了？若确在转述旧事，忽略。${C.off}`
        );
      }
    }
  }
}

// ============================================================
// 检查 2 · 项目文件正文改了，但顶部「📍 当前状态」没跟着改
// ============================================================
// 状态头是给下一次开场用的索引。它不同步，索引就会骗人。
for (const file of changed) {
  if (!file.startsWith('工作/') || !file.endsWith('.md')) continue;
  if (!existsSync(file)) continue;
  const body = readFileSync(file, 'utf8');
  if (!body.includes('📍 当前状态')) {
    problems.info.push(`${file} 还没有「📍 当前状态」状态头（大文件建议补一个）`);
    continue;
  }
  const added = addedByFile[file] || [];
  if (!added.length) continue;
  // 状态头区块的行内容
  const headBlock = body.split('📍 当前状态')[1]?.split('\n---')[0] || '';
  const touchedHead = added.some(l => l.trim() && headBlock.includes(l.trim()));
  if (!touchedHead) {
    problems.soft.push(
      `${file}\n    正文新增了 ${added.filter(l => l.trim()).length} 行，但${C.bold}顶部「📍 当前状态」一个字没改${C.off}\n    ${C.dim}→ 下次开场只会读状态头。它不同步，索引就在骗人。${C.off}`
    );
  }
}

// ============================================================
// 检查 2b · 活跃项目文件混入完整历史版本（软警告，先观察）
// ============================================================
// Git 承担精确版本史；工作区只应给下一位读者一个当前结论。
// 若某段历史当前确需可见，在信号附近写「历史可见例外：原因」。
const LEGACY_SIGNAL = /作废|旧版|原文保留|保留作反例|<details>/i;
for (const file of changed) {
  if (!file.startsWith('工作/') || !file.endsWith('.md') || !existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!LEGACY_SIGNAL.test(lines[i])) continue;
    const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n');
    if (/历史可见例外\s*[:：]/.test(nearby)) continue;
    hits.push({ no: i + 1, text: lines[i].trim() });
  }
  if (hits.length) {
    const preview = hits.slice(0, 5).map(({ no, text }) => `L${no} ${text.slice(0, 80)}`).join(' ｜ ');
    problems.soft.push(
      `${file}\n    检出 ${hits.length} 处历史版本信号：${C.dim}${preview}${C.off}\n    ${C.dim}→ 活跃层只留当前结论；精确旧文交给 Git。确需当前可见时，在附近写「历史可见例外：原因」。${C.off}`
    );
  }
}

// ============================================================
// 检查 3 · 事实性断言缺来源标记
// ============================================================
// [2026-08-26] 加 `评:` —— 独立第二方复核（Codex / 对抗评审）的产出，原卡点 7.3。
// 它既不是检索也不是助手推断，此前只能塞进 [推:助手]，丢掉了"这是第二方说的"这个信息。
const MARK = /\[(源:|推:|先验:|评:|待查|缺)/;
const NEEDS_MARK = /^(工作|知识)\/|^(我是谁|待办与承诺|决策记录|人物对照表)\.md$/;
// 只挑「像事实断言」的行：够长 + 含数字量词或"原话"
const LOOKS_FACTUAL = /(\d[\d,.]*\s*(万|亿|台|人|个|年|月|天|%|％|元|轮))|原话|确认为|已定|明说/;

// 🔴 [2026-08-26] 修原卡点 3.1：本检查原来**逐行**扫，看不见小节级标记。
//   实测危害：08-26 一次提交报出 39 条，**全是误报**，助手直接略过了整块警告——
//   而 `memory-check` 是 2.1 结案后**唯一真的会执行的强制点**，误报正在训练人忽略它。
//
//   两条修法，都对着实际误报形态：
//   ① **小节级继承**——`记忆规则.md` 第十节本来就写着「一个小节只装一种证据强度」，
//      所以「标记写在小节标题或其引言块里、正文表格不再逐行重复」是**规则原本的语义**，
//      只是脚本没实现。现在往上找到最近的标题，该范围内有标记就算已标。
//   ② **索引 / 导航行豁免**——「详见 9.3」「见第六节」这类行是指路，不是断言。
const NAV_LINE = /(详见|见\s*[《『「]?[第本]|→\s*[「『]?(见|去)|\bgoto\b)|(第[一二三四五六七八九十\d]+节)|(\d\.\d+\s*[–—-]\s*\d\.\d+)|(`[^`]+\.md`)/;

/**
 * 判断 lineNo 这一行是否落在某个「已标记的作用域」里。
 *
 * 作用域是**逐级向上继承**的（`###` 继承 `##` 继承 `#`），因为实际写法就是这样：
 *   `## 9.4 对抗评审打出的 10 个洞`  ← 来源声明写在这一节的引言块里
 *   `### 缺陷 1 …`                   ← 具体内容在子小节，不会再贴一遍标记
 * 只往上认**祖先**标题（层级更高的），兄弟小节的内容不继承——否则前一节的标记会污染后一节。
 *
 * 每一级祖先的「作用域头」= 标题行本身 + 紧随其后的连续引言行（`>` 开头）。
 * 本小节内部（最近的祖先标题 → lineNo）则整段都算。
 */
function scopeHasMark(fileLines, lineNo) {
  let i = Math.min(lineNo - 1, fileLines.length - 1);   // 转 0-indexed
  let minLevel = 7;                                     // 还没遇到任何标题

  for (; i >= 0; i--) {
    const l = fileLines[i];
    const h = l.match(/^(#{1,6})\s/);

    if (!h) {
      // 非标题行：只有在「还没跨过任何标题」时才算本小节内容
      if (minLevel === 7 && MARK.test(l)) return true;
      continue;
    }

    const lvl = h[1].length;
    if (lvl >= minLevel) continue;        // 兄弟或更深的标题，不是祖先，跳过
    minLevel = lvl;

    if (MARK.test(l)) return true;        // 祖先标题行本身带标记

    // 祖先标题紧随其后的引言块（`>` 行，允许中间夹空行）
    for (let j = i + 1; j < fileLines.length; j++) {
      const g = fileLines[j];
      if (!g.trim()) continue;
      if (!g.startsWith('>')) break;
      if (MARK.test(g)) return true;
    }
    if (lvl === 1) break;                 // 到顶了
  }
  return false;
}

for (const [file, entries] of Object.entries(addedLinesWithNo)) {
  if (!NEEDS_MARK.test(file)) continue;
  let fileLines = null;                  // 懒加载：只有真要判继承时才读文件
  for (const { text, no } of entries) {
    const t = text.trim();
    if (t.length < 25) continue;
    if (/^#{1,6}\s/.test(t) || /^\|?\s*-{3,}/.test(t)) continue; // 标题、表格分隔线
    if (!LOOKS_FACTUAL.test(t)) continue;
    if (MARK.test(t)) continue;
    if (NAV_LINE.test(t)) continue;                              // ② 索引/导航行
    if (fileLines === null) {
      try { fileLines = readFileSync(file, 'utf8').split('\n'); } catch { fileLines = []; }
    }
    if (fileLines.length && scopeHasMark(fileLines, no)) continue; // ① 小节级继承
    problems.soft.push(`${file}:${no}\n    ${C.dim}${t.slice(0, 95)}${C.off}\n    ${C.dim}→ 像事实断言但没有 [源:] / [推:助手] / [先验:助手] / [待查] 标记${C.off}\n    ${C.dim}   （所在小节从标题往下也没有标记；若整节同一来源，把标记写在小节标题或引言里即可，不用逐行贴）${C.off}`);
  }
}

// ============================================================
// 检查 4 · [待查] 盘点：分类了没有、挂了多久
// ============================================================
{
  // [2026-08-18] 除了语料/归档，再排掉「讲规则本身」的五个文件——它们里面的 [待查]
// 全是对这个标记的引用，不是真的待查项（自检规则.md 重构后凭空多出 2 个就是这么来的）。
// ⚠️ 试过更聪明的办法（剥掉行内代码 `...` 再数）——错的：全库真实待查项本来就写成 `[待查]`，
//    一剥就从 70 掉到 1。留这行注释，免得以后有人再改一次。
const RULE_DOCS = /^(自检规则|记忆规则|CLAUDE|AGENTS|接力规则)\.md$/;
const files = sh(`${GIT} ls-files "*.md"`).split('\n').filter(f => f && !/^(语料|归档)\//.test(f) && !RULE_DOCS.test(f));
  let total = 0;
  const perFile = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const n = (readFileSync(f, 'utf8').match(/\[待查/g) || []).length;
    if (n) { total += n; perFile.push([f, n]); }
  }
  if (total) {
    perFile.sort((a, b) => b[1] - a[1]);
    problems.info.push(
      `全库 ${C.bold}${total}${C.off} 处**字面提及** [待查]：` + perFile.slice(0, 5).map(([f, n]) => `${f}(${n})`).join(' · ') +
      `\n    ${C.dim}→ 这是字面出现次数，不是「可执行待查数」——讨论规则、复盘旧问题都会被数进来，别拿它当清理进度。${C.off}` +
      `\n    ${C.dim}→ 自检规则 L2-6：新挂的先分三类——判断类不许挂；能查的当场查；只有 ${OWNER} 知道的当场问。${C.off}`
    );
  }
}

// ============================================================
// 检查 5 · 与汇总共用计分解析；有主人纠错的接力必须关联真实回归案例。
{
  const cases = readFileSync('记忆网关/回归案例.jsonl', 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  for (const file of changed.filter(f => relayFileRe.test(f))) {
    if (!existsSync(file)) continue;
    const body = readFileSync(file, 'utf8');
    const scores = parseScores(body);
    if (!scores.hasSection || (!scores.rows.length && !scores.noTrigger)) {
      problems.hard.push(file + '：缺规则计分或计分为空；无触发时请明确写本轮无触发。');
    }
    for (const row of scores.rows) {
      if (row.hit === null || /^(?:[—–-]+|\(未写\))$/.test(row.finder)) {
        problems.soft.push(file + '：计分需明确状态和发现者：' + row.raw.join(' | '));
      }
    }
    for (const message of correctionCoverage(body, cases)) problems.hard.push(file + '：' + message);
    // 每份接力都要答一问「这轮对主人有没有新观察」。
    // 侧记和纠错混写那段时间，07-29 之后几乎没再记过对他的观察——不是没地方，是没人问。
    // [2026-10-21 决定] 不是「所有侧都要」，是**谁在写谁答、看他在用哪个 agent**：
    // 在用 Kimi / Codex 时两侧都写这一节；Claude 已停用、不再新增接力，历史文件按当时规矩。
    // 所以起点分侧：Claude 侧沿用 09-23；Codex / Kimi 侧从 2026-10-21 起，**10-21 之前的历史接力不追溯**。
    const relay = file.match(relayNameRe);
    // [2026-10-28] workbuddy 侧从 2026-10-26（开放第四侧写入权限）起要求，之前的历史接力不追溯。
    // [2026-11-05] dsh 侧从 2026-11-04 起：那是本目录第一份 dsh 接力
    //   （`交接/2026-11/2026-11-04_*.md`），之前的没有，也不追溯。
    const obsSince =
      relay &&
      (relay[2] === 'claude'
        ? '2026-09-23'
        : relay[2] === 'workbuddy'
          ? '2026-10-26'
          : relay[2] === 'dsh'
            ? '2026-11-04'
            : '2026-10-21');
    if (relay && relay[1] >= obsSince) {
      const obs = body.match(new RegExp('^## 对 ' + escapeRe(OWNER) + ' 的新观察[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))', 'm'));
      if (!obs || !obs[1].replace(/[-\s>|]/g, '')) {
        problems.hard.push(file + `：缺「## 对 ${OWNER} 的新观察」或内容为空——写一条（同时记进 助手侧记.md），没有就写「本轮没有」，别凑数。`);
      }
    }
  }
}

// ============================================================
// 检查 6 · L3 审阅阈值
// ============================================================
// 新增 ≥3 份交接或 ≥7 天触发审阅；合格内容才回写。
// 兼容带 L3 路径变更的历史回写；新审阅须有已提交的结构记录和对应接力。
{
  try {
    // 同样要关 quotepath：这里传了中文路径（我是谁.md 等），不关就匹配不到。
    const git = (...args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const legacy = git('log', '-1', '--grep=L3 回写', '--grep=L3回写', '--format=%H %cI', '--', '我是谁.md', '决策记录.md', '人物对照表.md', '知识');
    let checkpoint = legacy ? { through: legacy.split(' ')[0], date: legacy.split(' ')[1] } : null;
    const review = readCommittedReview();
    if (review && (!checkpoint || review.date >= checkpoint.date)) checkpoint = review;
    if (!checkpoint) {
      problems.soft.push('L3 审阅尚无有效基线：请审阅积累内容并提交审阅记录。');
    } else {
      const addedRaw = git('log', `${checkpoint.through}..HEAD`, '--diff-filter=A', '--name-only', '--format=', '--', '交接/*.md');
      const added = new Set(
        addedRaw.split('\n').map(s => s.trim()).filter(f => /^交接\/\d{4}-\d{2}\/.*\.md$/.test(f))
      );
      const days = daysBetween(checkpoint.date.slice(0, 10), TODAY);
      if (added.size >= 3 || days >= 7) {
        problems.soft.push(
          `L3 审阅已到期：上次 ${checkpoint.date.slice(0, 10)}，此后交接新增 ${C.bold}${added.size}${C.off} 份、已过 ${days} 天（阈值：≥3 份或 ≥7 天）\n` +
          `    ${C.dim}→ 审阅积累内容；三个月后仍有用且能跨项目复用的才回写。无合格内容时记录范围与理由。${C.off}\n` +
          `    ${C.dim}   接力写「## L3 审阅」，更新并提交 记忆网关/L3审阅.json；实际回写仍在提交信息写「L3 回写」。${C.off}`
        );
      }
    }
  } catch (error) {
    problems.soft.push(`L3 审阅检查失败，无法确认是否到期：${error.message}`);
  }
}

// ============================================================
// 检查 7 · 开场总量由 pre-commit 的 memory-startup --check 检查。
// 原文件继续保存完整内容，不以正文体积代替实际读取预算。

// ============================================================
// 检查 8 · 改规则时自动把计分汇总打出来（2026-08-31 加）
// ============================================================
// `rule-score-report.mjs` 自己就是「攒够了要回头读」那一类——只有手动跑这一档，
// 正是 08-31 体检定义的那个病（收集机制没配读回它的执行点）。
// 它该挂的事件很明确：**动规则的时候**。改 L2 或改 AGENTS.md 规则块之前，
// 数据就摆在眼前，不用先想起来去跑。
// 只读、不改任何文件；跑挂了也不影响体检结论。
// ⚠️ 存起来最后打，不在这里直接 console.log —— 检查是按顺序跑的，
//    直接打会出现在体检抬头**之前**，看起来像另一个脚本的输出。
let scoreReport = '';
{
  const touchedRules = changed.some(f => /^(自检规则|CLAUDE|AGENTS)\.md$/.test(f));
  if (touchedRules && existsSync('scripts/rule-score-report.mjs')) {
    const out = sh('node scripts/rule-score-report.mjs --since 2026-08-18');
    if (out.trim()) scoreReport = out.trimEnd();
    else problems.info.push(`本次动了规则文件，但计分汇总没跑出内容 —— 手动查一次 node scripts/rule-score-report.mjs`);
  }
}

// ---------- 输出 ----------
// [2026-08-27] 抬头同时打印「本脚本的时钟」和「上一笔提交的时间」两个具体值。
//   为什么：本脚本的 TODAY 来自沙盒时钟，而沙盒时钟**曾滞后 3 天**（08-17）——
//   也就是说整套日期检查的基准本身是个已知会失效的源。08-19 和 08-27 两次日期漂移
//   都是靠「一个碰巧打印出来的具体值」逮住的（本脚本抬头那行、文件时间戳），
//   不是靠任何规则提醒。所以把 AGENTS.md 固定条的判断动作（对照上一笔提交时间戳）
//   直接印在这里：两个值并排放着，对不上一眼就能看见。只提示，不改变检查结果。
const line = '─'.repeat(60);
// [2026-08-28] 原来是 `git log -1 --date=format:'%Y-%m-%d %H:%M' --format=%cd`。
//   那一串里有**两个 `%` 加一个空格**：Git Bash 认单引号，没事；
//   但 execSync 在 Windows 上默认走 cmd.exe（PowerShell 同理），**单引号不算引号**，
//   整串被空格拆开，git 把 `%H:%M'` 当成版本号 → `fatal: invalid object name '%H'`，
//   然后「上一笔提交」显示成「无」，**体检照常放行**——错得很安静。
//   Codex 2026-08-28 在【未被问到】里报的。
//   改用 `%cI`（单个 `%`、无空格、无引号），任何 shell 都没有解析空间，日期在 JS 里切。
const lastCommitISO = sh(`${GIT} log -1 --format=%cI`).trim();
const lastCommit = lastCommitISO
  ? `${lastCommitISO.slice(0, 10)} ${lastCommitISO.slice(11, 16)}`
  : '';
console.log(`\n${C.bold}记忆库体检${C.off} ${C.dim}(脚本时钟=${TODAY}，上一笔提交=${lastCommit || '无'}，${changed.length} 个 .md 改动)${C.off}\n${line}`);
if (lastCommit && !lastCommit.startsWith(TODAY)) {
  console.log(`${C.yel}⚠️  脚本时钟(${TODAY})和上一笔提交(${lastCommit})不在同一天。${C.off}`);
  console.log(`${C.dim}   跨夜会话或沙盒时钟滞后都会造成这个现象；本脚本的日期检查以自己的时钟为基准，此时可能失真。${C.off}`);
  console.log(`${C.dim}   → 按 AGENTS.md 固定条：两个源对不上就直接问 ${OWNER}「今天几号」，不要自己选一个。${C.off}`);
}

if (problems.hard.length) {
  console.log(`\n${C.red}${C.bold}🔴 需要处理 (${problems.hard.length})${C.off}`);
  problems.hard.forEach((p, i) => console.log(`\n  ${i + 1}. ${p}`));
}
if (problems.soft.length) {
  console.log(`\n${C.yel}${C.bold}⚠️  建议看一眼 (${problems.soft.length})${C.off}`);
  problems.soft.slice(0, 8).forEach((p, i) => console.log(`\n  ${i + 1}. ${p}`));
  if (problems.soft.length > 8) console.log(`\n  ${C.dim}…另有 ${problems.soft.length - 8} 条${C.off}`);
}
if (problems.info.length) {
  console.log(`\n${C.dim}ℹ️  盘点${C.off}`);
  problems.info.forEach(p => console.log(`  · ${p}`));
}
if (!problems.hard.length && !problems.soft.length) {
  console.log(`\n  ✅ 没发现问题。`);
}
if (scoreReport) {
  console.log(`\n${C.bold}📊 本次动了规则文件，自动附上计分汇总${C.off} ${C.dim}(只读；改规则前先看数据，别靠感觉)${C.off}`);
  console.log(scoreReport);
}
console.log(`\n${line}`);

if (STRICT && problems.hard.length) {
  console.log(`${C.red}STRICT 模式：有 ${problems.hard.length} 条需要处理，提交已拦下。${C.off}`);
  console.log(`${C.dim}确认无误要强行提交：git commit --no-verify${C.off}\n`);
  process.exit(1);
}
process.exit(0);
