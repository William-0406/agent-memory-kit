import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync, statSync, existsSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {extractTurnRules} from './turn-rules.mjs';
import {classifyHit, parseScores, correctionCoverage, HANDOFF_NAME} from './rule-scores.mjs';
import {validateAdmission, checkAdmissions, LONG_TERM_PATH} from './memory-admission.mjs';
import {startupBudget, renderStartup, todoIndex, openingSources} from './memory-startup.mjs';
import {buildIndex} from './memory-gateway.mjs';
import {checkSpeakerMaps} from './speaker-map.mjs';
import {OWNER} from './profile.mjs';

// 模板里的占位符 {owner} 按配置替换掉，测试断言才不用跟着改人名。
const tpl = name => readFileSync(new URL('../templates/' + name, import.meta.url), 'utf8').replace(/\{owner\}/g, OWNER);
// 真实文件存在就用真实的，否则用模板——新装用户没有个人档案也能跑通。
const realOr = (rel, name) => existsSync(new URL('../' + rel, import.meta.url)) ? readFileSync(new URL('../' + rel, import.meta.url), 'utf8') : tpl(name);

// [2026-10-12] 热点每次纠正都会轮换（AGENTS.md 维护协议），三条的开头从 AGENTS.md 现读，不写死某一条的原文。
function hotItemHeads(source) {
  const hot = source.match(/### 🔁[\s\S]*?(?=\n>\s*\*（)/)[0];
  return [...hot.matchAll(/^> ([123])\. (.{1,24})/gm)].map(m => m[1] + '. ' + m[2]);
}

// Windows 上 git 对象文件是只读的，rmSync 递归删直接 EPERM（2026-10-20 实测连挂 4 次，shell rm -rf 正常）。先把整棵树改成可写再删。
function forceRemove(root) {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) forceRemove(p);
    try { chmodSync(p, 0o666); } catch {}
  }
  rmSync(root, {recursive: true, force: true});
}

test('热点提取包含固定条、三条热点和多人说话人动作，引用格式缺失不截断', () => {
  const source = tpl('AGENTS.md');
  const expected = extractTurnRules(source);
  const heads = hotItemHeads(source);
  assert.equal(heads.length, 3);
  for (const value of ['固定条', '说话人编号 ↔ 真人', ...heads]) assert.ok(expected.includes(value), value);
  assert.equal(extractTurnRules(source.replace(/^>    👉/m, '   👉')), expected);
  assert.throws(() => extractTurnRules(source.replace('<!-- TURN_RULES_END -->', '')), /边界/);
  assert.throws(() => extractTurnRules(source.replace(/^> 3\. /m, '> 三. ')), /三条热点/);
});

test('判分支持真实格式且不把失败或不确定当成功', () => {
  for (const cell of ['未命中', '**否，而且是同类再犯**', '~~是~~ **实际是否**', '❌ 没拦下', '🔴 **违反，五次**']) assert.equal(classifyHit(cell), 'miss', cell);
  for (const cell of ['部分命中', '🟡 **险些没命中**', '不确定', '还没有结果']) assert.equal(classifyHit(cell), 'unknown', cell);
  for (const cell of ['是：有依据', '✅ 命中——已核查', '**命中**']) assert.equal(classifyHit(cell), 'hit', cell);
});

test('计分按表头定位、限于计分节，并读取同一接力的多次计分', () => {
  const body = `## 规则计分
| 触发的规则 | 具体场景 | 是否命中 | 谁发现的 | 是否提交前拦下 |
|---|---|---|---|---|
| L2-8 | 身份 | **否，而且是同类再犯** | **${OWNER}** | 否 |
## 后续
| L2-2 | 是 | 自己 | 是 |
## 规则计分 · 续
| 触发机会 | 命中 | 谁发现 | 提交前拦下 |
|---|---|---|---|
| L2-5 | 是 | 助手 | 是 |
| L2-1 | 本轮无触发 | — | — |`;
  const parsed = parseScores(body);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].hit, false);
  assert.equal(parsed.rows[0].finder, OWNER);
  assert.equal(parsed.rows[1].hit, true);
  assert.equal(parsed.noTrigger, true);
  assert.equal(correctionCoverage(body, []).length, 1);
  assert.equal(correctionCoverage(body + '\n回归案例：speaker-identity-correction', []).length, 1);
  assert.deepEqual(correctionCoverage(body + '\n回归案例：speaker-identity-correction', [{id:'speaker-identity-correction'}]), []);
});

test('接力发现兼容五种已存在的命名，日期筛选保留', () => {
  assert.ok(HANDOFF_NAME.test('2026-09-20_claude.md'));
  assert.ok(HANDOFF_NAME.test('2026-09-20_1550_codex.md'));
  assert.ok(HANDOFF_NAME.test('2026-10-20_0956_kimi.md'));
  // [2026-10-28] 第四侧。登记在 AGENTS.md 但识别表漏了它 = 我的接力不进汇总、不进提交门禁。
  assert.ok(HANDOFF_NAME.test('2026-10-28_1330_workbuddy.md'));
  // [2026-11-05] 第五侧，同一条教训第二次犯：6 份 dsh 接力从 11-04 写到 11-05，
  // 全部没过过检查 5（不查规则计分、不查回归案例、不查对主人的观察）。
  assert.ok(HANDOFF_NAME.test('2026-11-05_1833_dsh.md'));
  assert.ok(HANDOFF_NAME.test('2026-11-04_1111_dsh.md'));
  assert.equal(HANDOFF_NAME.test('answers.sealed.md'), false);
});

test('同一条接力里的多处未命中都要被计到', () => {
  const source = `## 规则计分
| 触发的规则 | 具体场景 | 是否命中 | 谁发现的 | 是否提交前拦下 |
|---|---|---|---|---|
| L2-8 | 身份 | **否，而且是同类再犯** | **${OWNER}** | 否 |
| L2-5 | 汇报 | 否 | ${OWNER} | 否 |
`;
  const misses = parseScores(source).rows.filter(r => r.finder === OWNER && !r.hit);
  assert.ok(misses.length >= 2);
  assert.ok(misses.every(r => r.hit === false));
});

test('真实注入脚本输出到第三条热点', () => {
  const output = execFileSync(process.execPath, ['scripts/turn-context.mjs'], {encoding:'utf8'});
  assert.ok(output.includes('说话人编号 ↔ 真人'));
  const source = tpl('AGENTS.md');
  assert.ok(output.includes(hotItemHeads(source)[2]));
});

test('长期方法拒绝单例、同日与重复定位，合格证据必须实际可定位', () => {
  const NOW='2026-09-20';
  const e={file:'工作/样本.md',quote:'真实案例一',date:'2026-09-18',case:'case-1'};
  const r={kind:'method',asof:NOW,scope:'测试范围',limitations:'尚需语义审查',counterexamples:'已检查不适用情况',evidence:[e]};
  const read=()=> '真实案例一\n真实案例二\n真实案例三';
  assert.ok(validateAdmission(r,'方法',read,NOW).some(x=>x.includes('三个')));
  const full={...r,evidence:[e,{...e,quote:'真实案例二',case:'case-2'},{...e,quote:'真实案例三',case:'case-3',date:'2026-09-20'}]};
  assert.deepEqual(validateAdmission(full,'方法',read,NOW),[]);
  assert.ok(validateAdmission({...full,evidence:full.evidence.map(x=>({...x,date:'2026-09-20'}))},'方法',read,NOW).length);
  assert.ok(validateAdmission({...full,evidence:full.evidence.map(x=>({...x,quote:e.quote}))},'方法',read,NOW).length);
  assert.ok(validateAdmission({...full,evidence:[{...e,quote:'材料没有这句话'}]},'方法',read,NOW).some(x=>x.includes('原文未找到')));
  assert.ok(validateAdmission({...r,kind:'observation'},'市场规律',read,NOW).length);
  assert.deepEqual(validateAdmission({...r,kind:'observation'},'待验证观察',read,NOW),[]);
  let readCalled=false;
  validateAdmission({...r,evidence:[{...e,file:'工作/answers.sealed.md'}]},'方法',()=>{readCalled=true;return '';},NOW);
  assert.equal(readCalled,false,'封存路径在读取前拒绝');
  // 准入不能是一次性过路费：小节再被改，asof 必须重新写成当天。
  assert.ok(validateAdmission({...full,asof:'2026-09-01'},'方法',read,NOW).some(x=>x.includes('asof')));
  assert.ok(validateAdmission({...full,asof:undefined},'方法',read,NOW).some(x=>x.includes('asof')));
});

test('[A] 准入只管 知识/，我是谁与决策记录恢复顺手就写', () => {
  for (const file of ['我是谁.md','决策记录.md','人物对照表.md']) {
    assert.equal(LONG_TERM_PATH.test(file), false, `${file} 不该再被准入门拦`);
    assert.deepEqual(checkAdmissions(file,'## 基本\n新写一条事实 [源:某人]\n',[2]),[]);
  }
  assert.ok(LONG_TERM_PATH.test('知识/做单方法.md'));
});

test('L3 检查只管改动小节，真实观察索引有可定位依据', () => {
  const file='知识/样本方法.md';
  const body=tpl('知识/_模板.md').replace(/_模板/g,'样本方法');
  const line=body.split(/\r?\n/).findIndex(x=>x.startsWith('## 待验证观察索引'))+1;
  assert.ok(line>0,'模板里必须有「## 待验证观察索引」小节');
  // 这里验「真实文件的证据可定位」，不验时效：按该小节自己写的 asof 当「今天」，否则过一天就无故变红、卡住所有提交。
  const asof=body.split(/\r?\n/).slice(line).join('\n').match(/memory-admission:[^>]*?"asof":"(\d{4}-\d{2}-\d{2})"/)?.[1];
  assert.ok(asof);
  assert.deepEqual(checkAdmissions(file,body,[line],process.cwd(),asof),[]);
  assert.ok(checkAdmissions(file,'## 新方法\n只看了一例就认定规律',[2]).some(x=>x.includes('准入')));
  assert.deepEqual(checkAdmissions(file,'## 历史方法\n旧内容\n## 新小节\n',[5]),[]);
});

test('开场目录只把行首加粗当标题，行中间的状态词不顶替标题', () => {
  const directory=todoIndex([
    '## 进行中',
    '- [ ] [2026-07-30] 给客户 A 的 HR 写一个测评 —— 截止：2026-08-03 ⏰**已逾期**（08-03 复盘时未完成）',
    '- [ ] 🆕 [2026-09-16] 🔴 **项目 B：第一轮搜完 42 家。** 后面是正文',
    '- [ ] **[问客户 C] 2000 万目标按什么口径考核？** 正文',
    '- [ ] [2026-08-03] **（可选，需搭）做个本地模型体检**：正文',
  ].join('\n'));
  const labels=directory.split('\n').filter(l=>l.startsWith('- 待办与承诺.md:')).map(l=>l.split(' · ').slice(2).join(' · '));
  assert.ok(labels[0].includes('给客户 A 的 HR 写一个测评') && !labels[0].includes('**'), labels[0]);
  assert.equal(labels[1],'项目 B：第一轮搜完 42 家。');
  assert.equal(labels[2],'[问客户 C] 2000 万目标按什么口径考核？');
  assert.equal(labels[3],'（可选，需搭）做个本地模型体检');
});

test('开场目录保留所有未闭环项、定位与完整边界，最坏预算在上限内', () => {
  const todo=realOr('待办与承诺.md','待办与承诺.md');
  const directory=todoIndex(todo);
  assert.equal((directory.match(/^- 待办与承诺\.md:/gm)||[]).length,(todo.match(/^- \[ \]/gm)||[]).length);
  const budget=startupBudget();
  assert.ok(budget.ceiling<=budget.limit, JSON.stringify({ceiling:budget.ceiling,limit:budget.limit}));
  const parts=openingSources();
  assert.equal(parts.filter(p=>p.file==='纠错记录.md').length,3);
  // 不写死某一天（写死 09-16 会在新纠错进来后无故变红）：开场必须读到纠错记录里最新日期的那条。
  const newest=(realOr('纠错记录.md','纠错记录.md').match(/^- .*?\[(20\d{2}-\d{2}-\d{2})/gm)||[]).map(x=>x.match(/20\d{2}-\d{2}-\d{2}/)[0]).sort().pop();
  assert.ok(newest && parts.filter(p=>p.file==='纠错记录.md').some(p=>p.text.includes(newest)));
  assert.ok(!parts.some(p=>p.file==='待办与承诺-暂停中.md'));
  const index=buildIndex();
  for(const query of ['我最近又改了一些记忆的架构 你看一下有什么问题吗','打开转写，引用材料确认规律，给我类似的筛选方案；没有动作，先挂待查，已验证']) {
    const result=renderStartup(query,undefined,index);
    assert.ok(result.chars<=18000);
    assert.ok(result.text.includes('绝不删除能证伪'));
    assert.ok(result.text.includes('说话人编号 ↔ 真人'));
  }
});

test('真实提交检查拒绝无准入内容与缺回归关联，修正后放行', t => {
  const cwd=mkdtempSync(join(tmpdir(),'memory-architecture-test-'));
  t.after(()=>{
    const target=resolve(cwd), base=resolve(tmpdir())+sep;
    if (!target.startsWith(base) || !target.slice(base.length).startsWith('memory-architecture-test-')) throw new Error('临时测试清理路径异常');
    forceRemove(target);
  });
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const write=(path,body)=>{mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),body);};
  git('init','-q');git('config','core.quotepath','false');
  write('工作/证据.md','# 样本\n页面日期重叠，原因未核。');
  write('记忆网关/回归案例.jsonl','');
  git('add','--','工作/证据.md','记忆网关/回归案例.jsonl');
  git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=NUL','commit','-qm','建立测试基线');
  const script=fileURLToPath(new URL('./memory-check.mjs',import.meta.url));
  const check=()=>{
    try {return {status:0,output:execFileSync(process.execPath,[script],{cwd,encoding:'utf8',env:{...process.env,STRICT:'1'},stdio:['ignore','pipe','pipe']})};}
    catch(e){return {status:e.status,output:String(e.stdout)};}
  };
  write('知识/观察.md','## 单例方法\n直接照做。[推:助手]\n');git('add','--','知识/观察.md');
  let result=check();assert.equal(result.status,1);assert.match(result.output,/缺 memory-admission/);
  const TODAY=new Date().toLocaleDateString('en-CA');
  const admission={kind:'observation',asof:TODAY,scope:'这份材料',limitations:'原因未核',evidence:[{file:'工作/证据.md',quote:'页面日期重叠，原因未核。',date:'2026-09-20',case:'one'}]};
  write('知识/观察.md',`## 待验证观察\n<!-- memory-admission: ${JSON.stringify(admission)} -->\n页面日期重叠，原因未核。[推:助手]\n`);
  git('add','--','知识/观察.md');assert.equal(check().status,0);
  // B：同一小节再被改，asof 过期就必须拦下——否则第一次过关之后永远绿灯。
  write('知识/观察.md',`## 待验证观察
<!-- memory-admission: ${JSON.stringify({...admission,asof:'2026-09-01'})} -->
页面日期重叠，原因未核。[推:助手]
又加了一句新的断言。[推:助手]
`);
  git('add','--','知识/观察.md');
  result=check();assert.equal(result.status,1);assert.match(result.output,/asof/);
  write('知识/观察.md',`## 待验证观察
<!-- memory-admission: ${JSON.stringify(admission)} -->
页面日期重叠，原因未核。[推:助手]
又加了一句新的断言。[推:助手]
`);
  git('add','--','知识/观察.md');assert.equal(check().status,0);
  const date=new Date().toLocaleDateString('en-CA');
  const handoff=`交接/${date.slice(0,7)}/${date}_1200_codex.md`;
  const body=`## 规则计分\n| 触发的 L2 | 是否命中 | 谁发现的 | 是否提交前拦下 |\n|---|---|---|---|\n| L2-8 | 否 | ${OWNER} | 否 |\n\n## 对 ${OWNER} 的新观察\n\n- 本轮没有\n`;
  write(handoff,body);git('add','--',handoff);
  result=check();assert.equal(result.status,1);assert.match(result.output,/回归案例/);
  write(handoff,body+'\n回归案例：identity-correction\n');
  write('记忆网关/回归案例.jsonl',JSON.stringify({id:'identity-correction',query:'这个电话里没有我和 甲 是 乙'})+'\n');
  git('add','--',handoff,'记忆网关/回归案例.jsonl');assert.equal(check().status,0);
});

// Kimi 接入为第三侧。命名识别见上方 HANDOFF_NAME 用例；这里走真实提交检查，确认 kimi 接力被读到、缺必填项会被拦。
test('Kimi 接力走真实提交检查：缺规则计分被拦，写「本轮无触发」放行', t => {
  const cwd=mkdtempSync(join(tmpdir(),'memory-architecture-test-'));
  t.after(()=>{
    const target=resolve(cwd), base=resolve(tmpdir())+sep;
    if (!target.startsWith(base) || !target.slice(base.length).startsWith('memory-architecture-test-')) throw new Error('临时测试清理路径异常');
    forceRemove(target);
  });
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const write=(path,body)=>{mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),body);};
  git('init','-q');git('config','core.quotepath','false');
  write('记忆网关/回归案例.jsonl','');
  git('add','--','记忆网关/回归案例.jsonl');
  git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=NUL','commit','-qm','建立测试基线');
  const script=fileURLToPath(new URL('./memory-check.mjs',import.meta.url));
  const check=()=>{
    try {return {status:0,output:execFileSync(process.execPath,[script],{cwd,encoding:'utf8',env:{...process.env,STRICT:'1'},stdio:['ignore','pipe','pipe']})};}
    catch(e){return {status:e.status,output:String(e.stdout)};}
  };
  const date=new Date().toLocaleDateString('en-CA');
  const handoff=`交接/${date.slice(0,7)}/${date}_1200_kimi.md`;
  write(handoff,`# ${date} 12:00 · Kimi\n\n## 当前状态\n- 样本。\n`);
  git('add','--',handoff);
  let result=check();assert.equal(result.status,1);assert.match(result.output,/缺规则计分/);
  write(handoff,`# ${date} 12:00 · Kimi\n\n## 当前状态\n- 样本。\n\n## 规则计分\n| 触发的 L2 | 是否命中 | 谁发现的 | 是否提交前拦下 |\n|---|---|---|---|\n| L2-1 | 本轮无触发 | — | — |\n\n## 对 ${OWNER} 的新观察\n\n- 本轮没有\n`);
  git('add','--',handoff);assert.equal(check().status,0);
});

// [2026-10-28] 第四侧 WorkBuddy。与 Kimi 那条同构：确认 workbuddy 接力也被真实提交检查读到。
test('WorkBuddy 接力走真实提交检查：缺规则计分被拦，写「本轮无触发」放行', t => {
  const cwd=mkdtempSync(join(tmpdir(),'memory-architecture-test-'));
  t.after(()=>{
    const target=resolve(cwd), base=resolve(tmpdir())+sep;
    if (!target.startsWith(base) || !target.slice(base.length).startsWith('memory-architecture-test-')) throw new Error('临时测试清理路径异常');
    forceRemove(target);
  });
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const write=(path,body)=>{mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),body);};
  git('init','-q');git('config','core.quotepath','false');
  write('记忆网关/回归案例.jsonl','');
  git('add','--','记忆网关/回归案例.jsonl');
  git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=NUL','commit','-qm','建立测试基线');
  const script=fileURLToPath(new URL('./memory-check.mjs',import.meta.url));
  const check=()=>{
    try {return {status:0,output:execFileSync(process.execPath,[script],{cwd,encoding:'utf8',env:{...process.env,STRICT:'1'},stdio:['ignore','pipe','pipe']})};}
    catch(e){return {status:e.status,output:String(e.stdout)};}
  };
  const date=new Date().toLocaleDateString('en-CA');
  const handoff=`交接/${date.slice(0,7)}/${date}_1330_workbuddy.md`;
  write(handoff,`# ${date} 13:30 · WorkBuddy\n\n## 当前状态\n- 样本。\n`);
  git('add','--',handoff);
  let result=check();assert.equal(result.status,1);assert.match(result.output,/缺规则计分/);
  write(handoff,`# ${date} 13:30 · WorkBuddy\n\n## 当前状态\n- 样本。\n\n## 规则计分\n| 触发的 L2 | 是否命中 | 谁发现的 | 是否提交前拦下 | 误报（只填审查类任务） |\n|---|---|---|---|---|\n| L2-1 | 本轮无触发 | — | — | — |\n\n## 对 ${OWNER} 的新观察\n\n- 本轮没有\n`);
  git('add','--',handoff);assert.equal(check().status,0);
});

// [2026-11-05] 第五侧 dsh。与 WorkBuddy 那条同构——只是把后缀换成 dsh。
// 这条测试存在的理由：光改正则不算接进门禁，得证明 memory-check 真的会读它。
test('dsh 接力走真实提交检查：缺规则计分被拦，写「本轮无触发」放行', t => {
  const cwd=mkdtempSync(join(tmpdir(),'memory-architecture-test-'));
  t.after(()=>{
    const target=resolve(cwd), base=resolve(tmpdir())+sep;
    if (!target.startsWith(base) || !target.slice(base.length).startsWith('memory-architecture-test-')) throw new Error('临时测试清理路径异常');
    forceRemove(target);
  });
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const write=(path,body)=>{mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),body);};
  git('init','-q');git('config','core.quotepath','false');
  write('记忆网关/回归案例.jsonl','');
  git('add','--','记忆网关/回归案例.jsonl');
  git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=NUL','commit','-qm','建立测试基线');
  const script=fileURLToPath(new URL('./memory-check.mjs',import.meta.url));
  const check=()=>{
    try {return {status:0,output:execFileSync(process.execPath,[script],{cwd,encoding:'utf8',env:{...process.env,STRICT:'1'},stdio:['ignore','pipe','pipe']})};}
    catch(e){return {status:e.status,output:String(e.stdout)};}
  };
  const date=new Date().toLocaleDateString('en-CA');
  const handoff=`交接/${date.slice(0,7)}/${date}_1833_dsh.md`;
  write(handoff,`# ${date} 18:33 · dsh\n\n## 当前状态\n- 样本。\n`);
  git('add','--',handoff);
  let result=check();
  // 先证明「它真的被读了」——没被读的接力不会报缺规则计分，而是被静默跳过。
  assert.equal(result.status,1);
  assert.match(result.output,/缺规则计分/);
  write(handoff,`# ${date} 18:33 · dsh\n\n## 当前状态\n- 样本。\n\n## 规则计分\n| 触发的 L2 | 是否命中 | 谁发现的 | 是否提交前拦下 | 误报（只填审查类任务） |\n|---|---|---|---|---|\n| L2-1 | 本轮无触发 | — | — | — |\n\n## 对 ${OWNER} 的新观察\n\n- 本轮没有\n`);
  git('add','--',handoff);assert.equal(check().status,0);
});

// [2026-11-06] 中文文件名必须能被体检认出来。
// 为什么单独立一条：git 默认 core.quotepath=true，把中文路径输出成 `"\344\272\244..."`。
// 旧代码拿这种字符串去匹配 `交接/YYYY-MM/...`，一律匹配不上 → 差 1 天的日期漂移**拦不住**，
// 而且不报错、不提示，门禁等于不存在。
// 🔴 上面两条测试里都有一句 `git config core.quotepath false`——正是它把这个问题盖住了，
//    所以本条**故意不设**，让 git 保持默认，才能证明脚本自己扛得住。
test('中文文件名的接力照样被认出：不靠 git 配置也能拦下差一天的日期漂移', t => {
  const cwd=mkdtempSync(join(tmpdir(),'memory-architecture-test-'));
  t.after(()=>{
    const target=resolve(cwd), base=resolve(tmpdir())+sep;
    if (!target.startsWith(base) || !target.slice(base.length).startsWith('memory-architecture-test-')) throw new Error('临时测试清理路径异常');
    forceRemove(target);
  });
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const write=(path,body)=>{mkdirSync(dirname(join(cwd,path)),{recursive:true});writeFileSync(join(cwd,path),body);};
  git('init','-q');
  // 故意把 quotepath 显式设成 true，模拟最坏情况（默认值，且不受宿主全局配置影响）。
  git('config','core.quotepath','true');
  write('记忆网关/回归案例.jsonl','');
  git('add','--','记忆网关/回归案例.jsonl');
  git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=NUL','commit','-qm','建立测试基线');
  const script=fileURLToPath(new URL('./memory-check.mjs',import.meta.url));
  const check=()=>{
    try {return {status:0,output:execFileSync(process.execPath,[script],{cwd,encoding:'utf8',env:{...process.env,STRICT:'1'},stdio:['ignore','pipe','pipe']})};}
    catch(e){return {status:e.status,output:String(e.stdout)};}
  };
  // 接力文件名日期比今天早一天 = 跨午夜没重新对时。正文写得完全合规，只让文件名有问题，
  // 这样命中的只能是「文件名日期」那条检查，不会被缺规则计分之类的干扰。
  const yesterday=new Date(Date.now()-86400000).toLocaleDateString('en-CA');
  const handoff=`交接/${yesterday.slice(0,7)}/${yesterday}_2350_codex.md`;
  write(handoff,`# ${yesterday} 23:50 · Codex\n\n## 规则计分\n| 触发的 L2 | 是否命中 | 谁发现的 | 是否提交前拦下 | 误报（只填审查类任务） |\n|---|---|---|---|---|\n| L2-1 | 本轮无触发 | — | — | — |\n\n## 对 ${OWNER} 的新观察\n\n- 本轮没有\n`);
  git('add','--',handoff);
  const result=check();
  // 被拦下
  assert.equal(result.status,1,String(result.output));
  // 而且拦的理由是**文件名日期**，说明中文路径被正确解析了（旧代码这里会是 0 = 放行）
  assert.match(result.output,/文件名的日期/);
  assert.match(result.output,/差 1 天/);
});

// [2026-11-09] 回归案例：改旧接力不能让旧接力变成「最新一份」。
// 起因：订正一份 11-06 的接力后，那份旧接力的 mtime 变成最新，开场 `latestHandoff`
// 按 mtime 取「最新」，于是读到了被订正的旧接力，今天那份反被顶掉，状态直接过期。
// 正确口径：文件名里就带 `YYYY-MM-DD_HHmm`，**写作时序应看文件名，不是 mtime**。
test('开场取最新接力看文件名日期，不因改动旧接力而读到过期状态', t => {
  const root = mkdtempSync(join(tmpdir(), 'latest-handoff-'));
  t.after(() => { rmSync(root, {recursive: true, force: true}); });
  writeFileSync(join(root, 'AGENTS.md'), [
    '<!-- TURN_RULES_START -->', '> ## 规则', '> ### 固定条', '> 固定条正文。',
    '> 1. 热点一', '> 2. 热点二', '> 3. 热点三', '<!-- TURN_RULES_END -->', '',
  ].join('\n'));
  writeFileSync(join(root, '待办与承诺.md'), '## 待办目录\n\n- [ ] **唯一一条**\n');
  writeFileSync(join(root, '我是谁.md'),
    '## 基本\n\n- 称呼 我\n\n## 沟通偏好\n\n- 简洁\n\n## 他要这东西成为什么\n\n- 能跑\n');
  writeFileSync(join(root, '纠错记录.md'), '- [2026-11-06] 样例纠错一条\n');
  writeFileSync(join(root, '接力规则.md'), '## 一、共同原则\n\n- 只此一份\n\n## 三、什么时候写\n\n- 有后续价值时\n');

  const dir = join(root, '交接', '2026-11');
  mkdirSync(dir, { recursive: true });
  const older = join(dir, '2026-11-06_1805_dsh.md');
  const newer = join(dir, '2026-11-09_1028_dsh.md');
  writeFileSync(older, '## 当前状态\n\n- 旧的那份，状态已过期\n');
  writeFileSync(newer, '## 当前状态\n\n- 今天这份才是现行状态\n');
  // 关键动作：把旧接力的 mtime 顶到比新接力更晚，模拟「订正历史接力」。
  const future = new Date(Date.now() + 3600_000);
  utimesSync(older, future, future);

  const text = openingSources(root).map(p => p.text).join('\n');
  assert.ok(text.includes('今天这份才是现行状态'), '必须读到按文件名最新的那份');
  assert.ok(!text.includes('旧的那份，状态已过期'), '不能因为改过旧接力就读到过期状态');
});

test('引用转写前必须有说话人对照：把别人的话记成主人说的要被拦下', () => {
  const root=mkdtempSync(join(tmpdir(),'speaker-'));
  try {
    const dir=join(root,'语料','录音转写');mkdirSync(dir,{recursive:true});
    const body='\n\n说话人 1 00:00:01\n哈喽。\n\n说话人 2 00:00:06\n你出差去哪？\n';
    const put=(head)=>writeFileSync(join(dir,'2026-09-15_样本.md'),'# 文字记录\n'+head+body);
    const cite={'工作/样本.md':['客户说先不用找。[源:转写 2026-09-15]']};
    const mine={'工作/样本.md':[`${OWNER} 在电话里说我们搭过市场团队。[源:转写 2026-09-15]`]};
    put('');
    assert.match(checkSpeakerMaps(cite,root).hard.join(),/没有「说话人对照」/);
    // 靠推贴一个合理的人
    put(`> 说话人对照：说话人 1 = ${OWNER} [推:助手] ｜ 说话人 2 = 客户 [待查]`);
    assert.match(checkSpeakerMaps(cite,root).hard.join(),/不许靠推/);
    put('> 说话人对照：说话人 1 = 旁人甲 [源:助手 2026-09-16]');
    assert.match(checkSpeakerMaps(cite,root).hard.join(),/说话人 2 没写是谁/);
    put('> 说话人对照：说话人 1 = 旁人甲 [源:助手 2026-09-16] ｜ 说话人 2 = [待查]');
    assert.deepEqual(checkSpeakerMaps(cite,root).hard,[]);
    // 对照表里没有主人，正文却写「主人说」
    assert.match(checkSpeakerMaps(mine,root).hard.join(),new RegExp(`没有 ${OWNER}`));
    put(`> 说话人对照：说话人 1 = ${OWNER} [源:助手 2026-09-16] ｜ 说话人 2 = [待查]`);
    assert.deepEqual(checkSpeakerMaps(mine,root).hard,[]);
    // 不带日期 = 绕过检查，拦；讨论标记本身（行内代码）与 [源:转写x] 不拦
    assert.match(checkSpeakerMaps({'工作/样本.md':[`${OWNER} 说先不用找。[源:转写]`]},root).hard.join(),/没带日期/);
    assert.deepEqual(checkSpeakerMaps({'记忆规则.md':['写成 `[源:转写 YYYY-MM-DD]`，只写 `[源:转写]` 算错，例 `[源:转写 2026-01-01]`'],'我是谁.md':['口头禅 [源:转写x 语料]']},root),{hard:[],soft:[]});
    assert.equal(checkSpeakerMaps({'a.md':['x [源:转写 2026-01-01]']},root).soft.length,1);
    // 原样搬进归档的旧引用不拦
    put('');
    assert.deepEqual(checkSpeakerMaps({'归档/旧.md':[`${OWNER} 说 [源:转写 2026-09-15]`]},root),{hard:[],soft:[]});
    assert.ok(checkSpeakerMaps({'工作/新.md':[`${OWNER} 说 [源:转写 2026-09-15]`]},root).hard.length);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
