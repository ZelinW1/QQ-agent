// 权限策略自测（设计 §5.4 A 期：scope / policy / identity）。
//
// 这里测两件事：默认策略是否符合"内置信任、扩展首装 ask、执行命令 deny"，
// 以及 deny 是否永远优先（配置写错顺序也不能绕过）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { checkScopes, scopePolicyFor, DEFAULT_SCOPE_POLICY } = await import(src('src/runtime/permissions.js'));

const builtin = (scopes) => ({ id: 'x', traits: { scopes } });
const extension = (scopes) => ({ id: 'y', skillId: 'some-skill', traits: { scopes } });

// ── 1. 默认策略 ─────────────────────────────────────────────────────────
console.log('\n=== 1. 默认策略 ===');
{
  check(DEFAULT_SCOPE_POLICY['chat.send'] === 'allow', '内置发送默认允许');
  check(DEFAULT_SCOPE_POLICY['sys.exec'] === 'deny', '执行命令默认拒绝');
  check(DEFAULT_SCOPE_POLICY['net.fetch'] === 'allow', '联网默认允许（内置搜索要用）');

  check(checkScopes({ id: 'plain' }, {}).ok === true, '没有声明 scope 的工具不受限');
  check(checkScopes(builtin(['chat.send']), {}).ok === true, '内置工具声明 chat.send → 放行');
  check(checkScopes(builtin(['sys.exec']), {}).ok === false, '内置工具声明 sys.exec → 拒绝');

  const ask = checkScopes(extension(['custom.scope']), {});
  check(ask.ok === false && ask.code === 'scope-ask', '扩展工具遇到未知 scope → 默认 ask');
  check(ask.message.includes('需要主人批准'), '拒绝原因能说人话');
}

// ── 2. 配置覆盖与优先级 ─────────────────────────────────────────────────
console.log('\n=== 2. 覆盖 ===');
{
  const cfg = { tools: { scopePolicy: { 'custom.scope': 'allow' } } };
  check(checkScopes(extension(['custom.scope']), cfg).ok === true, '配置允许后扩展工具可用');

  const denyWins = { tools: { scopePolicy: { 'custom.scope': 'deny', 'chat.send': 'allow' } } };
  const r = checkScopes(extension(['custom.scope', 'chat.send']), denyWins);
  check(r.ok === false && r.code === 'scope-denied', '多个 scope 时 deny 优先');
  check(r.scopes.find((x) => x.scope === 'custom.scope')?.policy === 'deny', '策略表按 scope 逐条生效');

  const asked = checkScopes(extension(['custom.scope']), { tools: { scopePolicy: { 'custom.scope': 'ask' } } });
  check(asked.ok === false && asked.code === 'scope-ask', '显式 ask 也拦');

  // 审批通道接入后：approved 可以放行 ask，但放行不了 deny
  check(checkScopes(extension(['custom.scope']), { tools: { scopePolicy: { 'custom.scope': 'ask' } } }, { approved: ['custom.scope'] }).ok === true,
    '已批准的 ask 放行');
  check(checkScopes(extension(['custom.scope']), { tools: { scopePolicy: { 'custom.scope': 'deny' } } }, { approved: ['custom.scope'] }).ok === false,
    '批准也不能绕过 deny');
}

// ── 3. 策略表形状 ───────────────────────────────────────────────────────
console.log('\n=== 3. 形状 ===');
{
  const entries = scopePolicyFor(extension(['a', 'b']), { tools: { scopePolicy: { a: 'allow' } } });
  check(entries.length === 2, '每个 scope 一条');
  check(entries[0].policy === 'allow' && entries[1].policy === 'ask', '已配置用配置、其余回默认');
  check(scopePolicyFor({ traits: { scopes: [] } }, {}).length === 0, '空 scopes 返回空（不做无谓检查）');
}

console.log(`\n权限：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
