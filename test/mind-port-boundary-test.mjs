// 领域边界守门（静态检查）。
//
// 这套不测行为，测的是"谁可以碰什么"。它拦的是那种一次引入、之后再也
// 收不回去的耦合：运行时直接调 store、控制台绕过端口、端口反向依赖领域。
//
// 用正则扫源码即可，不需要 AST —— 规则少而明确时，正则反而更难被绕开。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const listJs = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
};

// ── 1. 端口文件不得反向依赖领域 ─────────────────────────────────────────
console.log('\n=== 1. 端口不反向依赖领域 ===');
{
  const port = read('src/contract/mind-port.js');
  check(!/from\s+['"][^'"]*\/mind\//.test(port), '端口文件不 import src/mind/**');
  check(!/from\s+['"]\.\.\/mind/.test(port), '端口文件不 import ../mind');
  // 端口里出现 store 方法名不算错（它就是包着这些方法的），
  // 但不能出现"自己的实现逻辑被领域代码引用"——这里只需要上面两条。
}

// ── 2. 只有装配根可以 new MindStore ─────────────────────────────────────
console.log('\n=== 2. 只有装配根创建存储 ===');
{
  const offenders = [];
  for (const file of listJs('src')) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    if (!/\bnew\s+MindStore\b/.test(text)) continue;
    if (rel !== 'src/app.js') offenders.push(rel);
  }
  check(offenders.length === 0, 'src/ 下只有 app.js 会 new MindStore', offenders.join('\n'));
  check(/new\s+MindStore/.test(read('src/app.js')), 'app.js 确实在创建（反向确认这条规则不是空转）');
}

// ── 3. 控制台必须经 AdminPort ───────────────────────────────────────────
console.log('\n=== 3. 控制台经 AdminPort ===');
{
  const routes = read('src/routes.js');
  check(/createAdminPort\s*\(/.test(routes), 'routes.js 使用 AdminPort');

  // 真正的约束不是"变量名叫什么"，而是"这个句柄从哪来"：
  // 每一个 mind 句柄都必须由 createAdminPort(...) 包出来，
  // 并且 orchestrator 的裸 store 只出现在这些包装里。
  const handles = [...routes.matchAll(/const mind = ([^;]+);/g)].map((m) => m[1].trim());
  check(handles.length >= 5, `routes.js 里的 mind 句柄都显式声明（${handles.length} 处）`);
  const unwrapped = handles.filter((rhs) => !rhs.includes('createAdminPort('));
  check(unwrapped.length === 0, '每个 mind 句柄都来自 AdminPort', unwrapped.join('\n'));

  const rawRefs = [...routes.matchAll(/orchestrator\?\.mind|orchestrator\.mind/g)].length;
  const wrappedRefs = [...routes.matchAll(/createAdminPort\(\s*orchestrator\?\.mind\s*\|\|\s*null\s*\)/g)].length;
  check(rawRefs === wrappedRefs, '裸 store 只出现在 createAdminPort(...) 里', `裸引用 ${rawRefs} / 包装 ${wrappedRefs}`);
}

// ── 3b. 编排器不再直接调用 store 方法 ───────────────────────────────────
console.log('\n=== 3b. 编排器只经端口 ===');
{
  const orch = read('src/orchestrator.js');
  const calls = [...orch.matchAll(/this\.mind\.(\w+)\s*\(/g)].map((m) => m[1]);
  check(calls.length === 0, 'orchestrator 没有 this.mind.xxx() 直连', [...new Set(calls)].join('、'));
  // 只剩"把 store 当值交出去"也不行：反思/整合/叙事的写回全部收进领域服务，
  // 运行时要改领域只能经端口或服务。
  check(!/const\s+store\s*=\s*this\.mind/.test(orch), 'orchestrator 没有 store 别名');
  check(!/D\.apply(Reflection|Integrate)\s*\(/.test(orch), '领域写回不再由编排器直接调用');
  check(/this\.mindService\(\)/.test(orch), '反思/整合/叙事经领域服务');
  check(/this\.mindPort\./.test(orch), '确实在用端口（反向确认这条不是空转）');

  // 服务本身属于领域层：可以拿 store，但不能 import 运行时。
  const svc = read('src/mind/service.js');
  check(!/from\s+['"]\.\.\/(orchestrator|runtime|contract)/.test(svc), '领域服务不反向依赖运行时');
}
// ── 3c. 运行时不得静态依赖领域 ──────────────────────────────────────────
console.log('\n=== 3c. 领域缺席也能启动 ===');
{
  const orch = read('src/orchestrator.js');
  check(!/from\s+['"]\.\/mind\//.test(orch), 'orchestrator 没有静态 import 领域');
  check(/await import\('\.\/mind\/index\.js'\)/.test(orch), '领域由动态 import 加载（可降级）');
  check(orch.includes('QQ_AGENT_NO_MIND'), '留了"模拟删除"的开关');

  const app = read('src/app.js');
  check(!/^import .*from '\.\/mind\//m.test(app), 'app.js 也没有静态 import 领域');
  check(app.includes('QQ_AGENT_NO_MIND'), 'app.js 认这个开关');

  const tools = read('src/tools.js');
  check(!/^import .*from '\.\/mind\//m.test(tools), 'tools.js 也没有静态 import 领域');
}
// ── 4. 端口的两条硬约束 ─────────────────────────────────────────────────
console.log('\n=== 4. 端口契约 ===');
{
  const port = read('src/contract/mind-port.js');
  check(/createNoopRuntimePort/.test(port) && /createNoopWriterPort/.test(port),
    '三套空实现都在（删掉领域后运行时仍可启动）');
  check(!/import\s+\{[^}]*settleEnergy/.test(port),
    '体力结算公式不在端口里复制（由装配根注入）');
}

console.log(`\n领域边界：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
