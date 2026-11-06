#!/usr/bin/env node
/**
 * 每轮对时 + 规则回显
 *
 * 干什么：把 AGENTS.md 里 <!-- TURN_RULES_START --> 到 <!-- TURN_RULES_END --> 之间的
 * 那块「每轮都要生效的」原样打印出来，让任何助手在回答之前先看到它。
 *
 * 为什么不是把规则抄一份在这里：一份内容只能有一个家。规则正文只存在 AGENTS.md，
 * 这里**运行时读取**再打印。改规则只改 AGENTS.md，不会出现两份慢慢走偏。
 *
 * 怎么接：
 *   - 手动：node scripts/turn-context.mjs
 *   - 挂到 Claude Code 的 UserPromptSubmit 钩子时加 --from-hook（只影响自证日志里的标记）
 *
 * 硬要求：必须极快，**出错必须静默放行**——绝不能卡住使用者打字。
 *   所以全程 try/catch 吞掉，连日志写失败都不许影响输出。
 */

import {extractTurnRules} from './turn-rules.mjs';
import {readFileSync, appendFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const FROM_HOOK = process.argv.includes('--from-hook');

// ── 地方守卫：不在记忆库里跑就一声不吭退出 ──────────────────────
//    为什么需要：钩子一旦被写进用户级配置（全局生效），在本机任何目录打字都会跑它，
//    于是这套规则会被灌进完全不相关的项目。守卫放在脚本自己身上最稳。
//    ⚠️ 静默退出，不写日志也不输出——写日志本身就是污染的一部分。
try {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  const cwd = norm(process.cwd());
  const base = norm(root);
  if (cwd !== base && !cwd.startsWith(base + '/')) process.exit(0);
} catch { process.exit(0); }

try {
  const here = dirname(fileURLToPath(import.meta.url));

  // ── A. 自证日志：证明本脚本真的被执行了，以及是谁调的 ──────────
  //    写失败一律吞掉，绝不影响主输出。
  try {
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
    appendFileSync(join(here, '.hook-alive.log'),
      `${stamp} from=${FROM_HOOK ? 'hook' : 'manual'} cwd=${process.cwd()}\n`, 'utf8');
  } catch {}

  let out = `[HOOK-ALIVE] 本行由 scripts/turn-context.mjs 输出，来源=${FROM_HOOK ? '钩子自动' : '手动调用'}\n`;

  // ── B. 运行时读 AGENTS.md 的 TURN_RULES 块（唯一副本在 AGENTS.md）──
  //    装好之后读根目录的 AGENTS.md；还没装（仓库里只有 templates/）时读模板，
  //    这样在仓库里试跑也能看到内容，不必先装一遍。
  try {
    const source = ['AGENTS.md', 'templates/AGENTS.md'].map(p => join(here, '..', p)).find(p => existsSync(p));
    const block = extractTurnRules(readFileSync(source, 'utf8'));
    out += '\n（规则唯一副本：AGENTS.md）\n\n' + block + '\n';
  } catch {
    out += '\n（读 AGENTS.md 规则块失败，自己去 AGENTS.md 开头看一眼。）\n';
  }

  process.stdout.write(out);
} catch {
  // 静默放行：宁可这轮没有注入，也绝不阻塞对话
}
process.exit(0);
