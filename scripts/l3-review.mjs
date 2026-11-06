import { execFileSync } from 'node:child_process';

// 记忆网关/L3审阅.json：{ version: 1, reviewedThrough: <已审阅到的完整提交号>,
// handoff: "交接/YYYY-MM/本次接力.md", files: [<实际审阅路径>],
// outcome: "written" | "no-qualified-content", reason: <审阅结论与理由> }
// 与包含「## L3 审阅」的接力一起提交。只读已提交版本，避免未完成审阅熄灭提醒。
export function readCommittedReview(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const path = '记忆网关/L3审阅.json';
  if (!git('ls-tree', '--name-only', 'HEAD', '--', path)) return null;
  const review = JSON.parse(git('show', `HEAD:${path}`));
  if (review.version !== 1 || !/^[a-f0-9]{40}$/.test(review.reviewedThrough) ||
      !/^交接\/\d{4}-\d{2}\/[^/]+\.md$/.test(review.handoff) ||
      !Array.isArray(review.files) || !review.files.length ||
      !['written', 'no-qualified-content'].includes(review.outcome) ||
      typeof review.reason !== 'string' || !review.reason.trim()) {
    throw new Error('审阅记录格式不完整');
  }
  git('merge-base', '--is-ancestor', review.reviewedThrough, 'HEAD');
  for (const file of review.files) {
    if (typeof file !== 'string' || !/^(交接|工作)\/.+\.md$/.test(file) ||
        file.split('/').includes('..') || /(?:answers|key|答案)\.sealed/i.test(file)) {
      throw new Error('审阅文件范围无效');
    }
    git('cat-file', '-e', `${review.reviewedThrough}:${file}`);
  }
  const handoff = git('show', `HEAD:${review.handoff}`);
  if (!/^## L3 审阅\r?$/m.test(handoff) || !handoff.includes(review.reason) ||
      review.files.some(file => !handoff.includes(file))) throw new Error('接力缺少对应审阅依据');
  return {
    through: review.reviewedThrough,
    date: git('log', '-1', '--format=%cI', '--', path),
  };
}
