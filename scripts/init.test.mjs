// 安装器自己的测试。
// 为什么单独写一份：别人的第一次体验**完全**发生在这个脚本里。它坏掉的症状是
// 「一堆文件装了一半」「重跑报错」「装完 {owner} 还在文件里」——都不是崩溃，是静默出错。
// 所以这里不测内部函数，直接在一个临时目录里真跑一遍 `node scripts/init.mjs`，
// 只看用户能看到的东西：退出码、装出来的文件、打印出来的报告。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, copyFileSync, cpSync, writeFileSync, rmSync, readdirSync, statSync, chmodSync, existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, '..');

// Windows 上 git 对象文件只读，rmSync 递归删会 EPERM。先把整棵树改成可写再删。
function forceRemove(root) {
  if (!existsSync(root)) return;
  const walk = (p) => {
    let stat;
    try { stat = statSync(p); } catch { return; }
    if (stat.isDirectory()) {
      try { chmodSync(p, 0o700); } catch { /* 权限已经足够 */ }
      for (const name of readdirSync(p)) walk(join(p, name));
    } else {
      try { chmodSync(p, 0o600); } catch { /* 同上 */ }
    }
  };
  walk(root);
  rmSync(root, {recursive: true, force: true});
}

// 造一个「刚 clone 下来」的最小仓库：只有 templates/ 和 scripts/init.mjs。
// 不带 config/profile.json——那正是新用户的状态，安装器的职责就是把它生成出来。
function freshClone(t) {
  const root = mkdtempDir();
  cpSync(join(KIT, 'templates'), join(root, 'templates'), {recursive: true});
  mkdirSync(join(root, 'scripts'), {recursive: true});
  copyFileSync(join(KIT, 'scripts', 'init.mjs'), join(root, 'scripts', 'init.mjs'));
  // 装完还要能跑开场，否则「装好了」是假的。
  copyFileSync(join(KIT, 'scripts', 'profile.mjs'), join(root, 'scripts', 'profile.mjs'));
  copyFileSync(join(KIT, 'scripts', 'memory-startup.mjs'), join(root, 'scripts', 'memory-startup.mjs'));
  copyFileSync(join(KIT, 'scripts', 'turn-rules.mjs'), join(root, 'scripts', 'turn-rules.mjs'));
  copyFileSync(join(KIT, 'scripts', 'rule-scores.mjs'), join(root, 'scripts', 'rule-scores.mjs'));
  copyFileSync(join(KIT, 'scripts', 'memory-gateway.mjs'), join(root, 'scripts', 'memory-gateway.mjs'));
  t.after(() => forceRemove(root));
  return root;
}

function mkdtempDir() {
  return mkdtempSync(join(tmpdir(), 'memory-init-test-'));
}

// 跑安装器。stdio 走 pipe，isTTY 为 undefined → 安装器自己走非交互分支，
// 这正是 AI 助手代跑时的真实情形（也是悬空等输入的 bug 会藏身的地方）。
function runInit(root, extraArgs = []) {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/init.mjs', ...extraArgs], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60000,
    });
    return {code: 0, out: stdout};
  } catch (error) {
    return {code: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}`};
  }
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

// 装完之后根目录应当出现的 10 个模板。
const ROOT_TEMPLATES = [
  'AGENTS.md', '我是谁.md', '待办与承诺.md', '纠错记录.md', '人物对照表.md',
  '决策记录.md', '助手侧记.md', '记忆规则.md', '自检规则.md', '接力规则.md',
];

test('全新安装：一条命令跑完，装出完整文件树且不留占位符', (t) => {
  const root = freshClone(t);
  const run = runInit(root, ['--owner', '测试甲', '--yes']);
  assert.equal(run.code, 0, run.out);

  const config = JSON.parse(read(root, 'config/profile.json'));
  assert.equal(config.owner, '测试甲');
  assert.ok(Array.isArray(config.handoffSides) && config.handoffSides.length >= 4, JSON.stringify(config.handoffSides));

  for (const name of ROOT_TEMPLATES) {
    assert.ok(existsSync(join(root, name)), `没装出 ${name}`);
    assert.ok(read(root, name).trim().length > 0, `${name} 是空的`);
    // 装完还留着 {owner} 就意味着所有规则里的称呼都是错的，而规则本身看起来正常。
    assert.ok(!read(root, name).includes('{owner}'), `${name} 里还有 {owner}`);
  }

  // 称呼真的替换进去了，不是被删成空字符串。
  assert.ok(read(root, 'AGENTS.md').includes('测试甲'));
  assert.ok(!read(root, 'AGENTS.md').includes('{timezone}'));

  // 网关要的文件必须在，否则装完第一次 --check 就报错。
  assert.ok(existsSync(join(root, '记忆网关/回归案例.jsonl')), '缺回归案例文件');
  assert.equal(read(root, '记忆网关/回归案例.jsonl'), '');
  // 空 seed 是有意的：往里写示例会让每条提交都被 runRegressions 拦下。
  assert.ok(existsSync(join(root, '记忆网关/L3审阅.json')));

  // 目录齐了，开场才不会因为缺路径崩。
  for (const dir of ['交接', '工作', '知识', '生活/日志', '生活/简报', '记忆网关/运行时', '归档', '语料']) {
    assert.ok(existsSync(join(root, dir)), `缺目录 ${dir}`);
  }
});

test('重复安装：不改已装好的内容，也不报错', (t) => {
  const root = freshClone(t);
  assert.equal(runInit(root, ['--owner', '测试乙', '--yes']).code, 0);

  // 模拟用户已经往里写过东西。
  const mine = '# 我的待办\n\n- [ ] 自己加的一条\n';
  writeFileSync(join(root, '待办与承诺.md'), mine, 'utf8');
  const configBefore = read(root, 'config/profile.json');

  const again = runInit(root, ['--owner', '测试乙', '--yes']);
  assert.equal(again.code, 0, again.out);

  assert.equal(read(root, '待办与承诺.md'), mine, '重复安装覆盖了用户内容');
  assert.equal(read(root, 'config/profile.json'), configBefore, '重复安装改了配置');
  assert.ok(again.out.includes('跳过'), '第二次安装应当说明跳过了哪些');
});

test('模板缺失：说清是哪个，继续装其余部分', (t) => {
  const root = freshClone(t);
  rmSync(join(root, 'templates', '记忆规则.md'));

  const run = runInit(root, ['--owner', '测试丙', '--yes']);

  // 缺一个文件是配置/包的问题，应当让自动化能发现，所以退出码非 0。
  assert.equal(run.code, 1, run.out);
  assert.ok(run.out.includes('记忆规则.md'), `报告里没点名缺哪个：${run.out}`);
  assert.ok(run.out.includes('模板缺失'), run.out);
  // 但别的文件要照装——一个模板坏了不该让整个安装停摆。
  assert.ok(existsSync(join(root, '自检规则.md')), '一个模板缺失导致其余模板也没装');
  assert.ok(existsSync(join(root, 'AGENTS.md')));
});

test('--owner 传空：回落到默认称呼，不崩也不留空名', (t) => {
  const root = freshClone(t);
  const run = runInit(root, ['--owner', '', '--yes']);
  assert.equal(run.code, 0, run.out);

  const config = JSON.parse(read(root, 'config/profile.json'));
  assert.equal(config.owner, '我');
  assert.ok(read(root, 'AGENTS.md').includes('我'));
  assert.ok(!read(root, 'AGENTS.md').includes('{owner}'));
});

// [2026-11-06] 这条补的是一个**真实用户必走、但之前完全没测过**的路径。
// 上面所有测试用的 freshClone 都故意不带 config/profile.json（模拟「只有 templates 和 init」），
// 所以「配置已存在时如何合并」那段代码一次都没被执行过。
// 而真实仓库是**带** config/profile.json 的，新用户 clone 下来就有，owner 默认是「我」。
// 修复前的 bug：合并写成 {...configBody, ...prev}，prev 在后把用户刚填的名字吃掉 →
// 装完 config 还是「我」，但模板文件已按新名字渲染 → 配置和内容永久不一致，
// 表现为「文件里叫张三，脚本却认为主人叫『我』」。
test('仓库自带 config 时用 --owner 装：称呼必须盖过自带的默认值「我」', (t) => {
  const root = freshClone(t);
  // 模拟真实 clone：带着仓库自带的 config/profile.json（owner 是我）。
  mkdirSync(join(root, 'config'), {recursive: true});
  writeFileSync(join(root, 'config/profile.json'), JSON.stringify({
    _说明: '这是本记忆库的配置文件。',
    owner: '我', timezone: 'Asia/Shanghai', handoffSides: ['codex', 'kimi', 'workbuddy', 'dsh'], lang: 'zh',
  }, null, 2) + '\n', 'utf8');

  const run = runInit(root, ['--owner', '测试戊', '--yes']);
  assert.equal(run.code, 0, run.out);

  // 配置里必须是新名字，不能还是默认的「我」。
  assert.equal(JSON.parse(read(root, 'config/profile.json')).owner, '测试戊', '配置里的称呼没被 --owner 覆盖');
  // 文件和配置必须一致——这是之前坏掉的地方：文件叫新名字，脚本却读默认值。
  const agents = read(root, 'AGENTS.md');
  assert.ok(agents.includes('测试戊'), 'AGENTS.md 没渲染成新称呼');
  assert.ok(!agents.includes('这是 我 的个人记忆知识库'), 'AGENTS.md 里还留着默认称呼');
  // 不带 owner 重跑：不能把用户已经定下的名字又改回默认值。
  assert.equal(runInit(root, ['--yes']).code, 0);
  assert.equal(JSON.parse(read(root, 'config/profile.json')).owner, '测试戊', '重装时把用户称呼改掉了');
});

test('装完当场能跑开场（不需要再手动补任何文件）', (t) => {
  const root = freshClone(t);
  assert.equal(runInit(root, ['--owner', '测试丁', '--yes']).code, 0);

  let out;
  try {
    out = execFileSync(process.execPath, ['scripts/memory-startup.mjs', '--query', '你好'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000,
    });
  } catch (error) {
    // 这个脚本命中上限时会以 1 退出但仍打印完整开场，所以看输出而不是退出码。
    out = `${error.stdout ?? ''}`;
  }
  assert.ok(out.includes('开场上下文'), out.slice(0, 400));
  assert.ok(out.includes('测试丁'), '开场里没带上主人称呼');
  assert.ok(!out.includes('{owner}'), '开场里还有占位符');
});
