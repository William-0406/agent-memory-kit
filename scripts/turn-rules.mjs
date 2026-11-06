// 显式边界独立于 Markdown 引用样式；正文唯一副本在 AGENTS.md 的 TURN_RULES 标记块（2026-10-21 自 CLAUDE.md 顶部迁入，Codex / Kimi 各侧共用）。
export function extractTurnRules(markdown) {
  const start = '<!-- TURN_RULES_START -->';
  const end = '<!-- TURN_RULES_END -->';
  const a = markdown.indexOf(start);
  const b = markdown.indexOf(end);
  if (a < 0 || b <= a || markdown.indexOf(start, a + start.length) >= 0 ||
      markdown.indexOf(end, b + end.length) >= 0) throw new Error('每轮规则边界缺失或重复');
  const block = markdown.slice(a + start.length, b).replace(/^> ?/gm, '').trim();
  if (!/固定条/.test(block) || [1, 2, 3].some(n => !new RegExp(`^${n}\\. `, 'm').test(block))) {
    throw new Error('每轮规则须包含固定条和三条热点');
  }
  return block;
}
