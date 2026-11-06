#!/usr/bin/env node
// 提交前体检。被 .githooks/pre-commit 调用，也可以手动跑：node scripts/hook-run.mjs
//
// 为什么单独抽一个文件：钩子本体写成 shell 时，Windows / macOS / Linux 三处的
// 换行和路径规则容易踩坑，而且报错信息很难看懂。这里用 Node 统一跑，输出人话。
//
// 顺序是有讲究的：先跑最快的、最能指出问题在哪的，最后跑最慢的测试。
// 任何一步失败就停，不继续往下跑。
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;

const STEPS = [
  {name: '开场预算', args: ['scripts/memory-startup.mjs', '--check'],
   hint: '开场要读的东西超过 20000 字符了。删内容或缩短入口，不要靠抬高阈值蒙过去。'},
  {name: '记忆库体检', args: ['scripts/memory-check.mjs'],
   needEnv: {STRICT: '1'},
   hint: '上面每条都写了文件名和该怎么改。改完再提交。'},
  {name: '回归案例', args: ['scripts/memory-gateway.mjs', 'test', '--quiet'],
   hint: '旧错误重新出现了。看它报的是哪条案例，别删案例绕着走。'},
  // 别写成 ['--test', 'scripts/']：从 Node 21 起传目录会被当成模块入口去解析，
  // 直接 Cannot find module，一个测试都不跑——每次提交都会因为这个被拦下。
  {name: '自动化测试', args: ['--test'], hint: '代码改坏了。看具体哪个测试挂了。'},
];

let failed = 0;
for (const step of STEPS) {
  // 脚本真存在才跑——刚装好的库可能还没这些文件
  const target = step.args[0] === '--test' ? join(ROOT, 'scripts') : join(ROOT, step.args[0]);
  if (!existsSync(target)) {
    const missing = step.args[0] === '--test' ? 'scripts/' : step.args[0];
    console.log(`— 跳过「${step.name}」：还没有 ${missing}`);
    continue;
  }
  process.stdout.write(`— ${step.name} … `);
  const res = spawnSync(node, step.args, {
    cwd: ROOT, encoding: 'utf8', env: {...process.env, ...(step.needEnv || {})},
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status === 0) { console.log('通过'); continue; }
  console.log('没过\n');
  console.log(output.trim() || `（没有输出，退出码 ${res.status}）`);
  console.log(`\n👉 ${step.hint}\n`);
  failed = 1;
  break;
}

if (failed) {
  console.log('这次提交被拦下了。改完再提交；确实要跳过可以 git commit --no-verify，但要在提交信息里写明原因。');
}
process.exit(failed);
